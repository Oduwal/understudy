// Rebuilds the dashboard's live state from memories recalled from Walrus, with no local files.
// Pure: it takes recall results and returns state, so it can be tested without the network.
import { parseMemory, sentenceOf } from "./lessons.mjs";
import { score } from "./state.mjs";

export const LIVE_NOTE =
  "Live record, read from Walrus Mainnet: every forecast below was saved before its window opened, and graded by the chain afterwards.";
export const RECALL_LIMIT = 100;

const written = (item) => {
  const time = Date.parse(item.created_at ?? "");
  return Number.isFinite(time) ? time : null;
};

// Each argument is a list of recall results: { blob_id, text, created_at }.
export function stateFromMemories({ forecasts, grades, lessons }) {
  const byWindow = new Map();
  for (const item of forecasts) {
    const data = parseMemory(item.text);
    if (data?.kind !== "forecast" || byWindow.has(data.window)) continue;
    const writtenAt = written(item);
    byWindow.set(data.window, {
      window: data.window,
      expected: data.expected,
      low: data.low,
      high: data.high,
      noMemory: data.noMemory,
      weights: data.weights ?? {},
      estimates: data.estimates ?? {},
      evidence: data.evidence ?? null,
      memoryId: item.blob_id,
      writtenAt,
      // The relayer's write time is the independent clock here, not the agent's.
      late: writtenAt !== null && writtenAt >= data.window,
      actual: null,
      hit: null,
      alert: null,
      gradeId: null,
    });
  }

  const alerts = [];
  for (const item of grades) {
    const data = parseMemory(item.text);
    const w = data?.kind === "grade" ? byWindow.get(data.window) : null;
    if (!w || w.gradeId) continue;
    Object.assign(w, { actual: data.actual, hit: data.hit === true, alert: data.alert ?? null, gradeId: item.blob_id });
    if (w.alert) alerts.push({ window: w.window, kind: w.alert, actual: w.actual, low: w.low, high: w.high });
  }

  const lessonList = lessons
    .map((item) => ({ item, data: parseMemory(item.text) }))
    .filter(({ data }) => data?.kind === "lesson")
    .map(({ item, data }) => ({ window: data.window, sentence: sentenceOf(item.text), memoryId: item.blob_id }))
    .sort((a, b) => b.window - a.window);

  const windows = [...byWindow.values()].sort((a, b) => a.window - b.window);
  return {
    windows,
    lessons: lessonList,
    alerts: alerts.sort((a, b) => b.window - a.window),
    writes: forecasts.length + grades.length + lessons.length,
    score: score(windows),
  };
}
