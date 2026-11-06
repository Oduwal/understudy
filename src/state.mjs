// Builds the dashboard state from files the agent and backtest wrote. Read-only: it never
// calls the chain or Walrus. Used by the local server and by the static site export.
import { existsSync, readFileSync } from "node:fs";

export const LIVE_DEFAULT_MIN_GRADED = 24;

const SOURCES = {
  live: "Live record: forecasts and lessons written to Walrus Mainnet before each window opened.",
  "dry-run": "Dry run: real chain counts, but memories are stored only on this machine and nothing is on Walrus.",
  replay: "Replay: this forecast code run over past Mainnet activity. It is a test of the method, not a live record.",
};

const mean = (values) => (values.length ? values.reduce((sum, v) => sum + v, 0) / values.length : null);

export function score(windows) {
  const graded = windows.filter((w) => w.actual !== null && !w.late);
  const withLastHour = graded.filter((w) => Number.isFinite(w.estimates?.lastHour));
  return {
    graded: graded.length,
    late: windows.filter((w) => w.late).length,
    meanError: mean(graded.map((w) => Math.abs(w.actual - w.expected))),
    meanErrorNoMemory: mean(graded.map((w) => Math.abs(w.actual - w.noMemory))),
    meanErrorLastHour: mean(withLastHour.map((w) => Math.abs(w.actual - w.estimates.lastHour))),
    hitRate: mean(graded.map((w) => (w.hit ? 1 : 0))),
  };
}

function readAgent(mode) {
  const path = `data/agent/${mode}/events.jsonl`;
  if (!existsSync(path)) return null;
  const events = readFileSync(path, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
  const windows = new Map();
  const lessons = [];
  const alerts = [];
  let writes = 0;
  for (const event of events) {
    if (event.type === "forecast") {
      windows.set(event.window, {
        window: event.window, expected: event.expected, low: event.low, high: event.high,
        noMemory: event.noMemory, estimates: event.estimates, weights: event.weights,
        typicalMiss: event.typicalMiss, evidence: event.evidence, leader: event.leader,
        memoryId: event.memoryId, writtenAt: event.writtenAt, late: event.late,
        actual: null, hit: null, alert: null, gradeId: null,
      });
    } else if (event.type === "grade") {
      const w = windows.get(event.window);
      if (w) Object.assign(w, { actual: event.actual, hit: event.hit, alert: event.alert, gradeId: event.memoryId, own: event.own });
    } else if (event.type === "lesson") {
      lessons.push({ window: event.window, sentence: event.sentence, memoryId: event.memoryId });
    } else if (event.type === "alert") {
      alerts.push({ window: event.window, kind: event.kind, actual: event.actual, low: event.low, high: event.high });
    } else if (event.type === "write") {
      writes += 1;
    }
  }
  const list = [...windows.values()].sort((a, b) => a.window - b.window);
  return { windows: list, lessons: lessons.reverse(), alerts: alerts.reverse(), writes, score: score(list) };
}

function readReplay() {
  const path = "data/backtest.json";
  if (!existsSync(path)) return null;
  const report = JSON.parse(readFileSync(path, "utf8"));
  const windows = report.results.map((r) => ({ ...r, late: false, memoryId: null }));
  const alerts = windows.filter((w) => w.alert).map((w) => ({ window: w.window, kind: w.alert, actual: w.actual, low: w.low, high: w.high })).reverse();
  return { windows, lessons: [...report.lessons].reverse(), alerts, writes: 0, score: score(windows) };
}

export function state(requested, only = null) {
  const available = {
    live: readAgent("live"),
    "dry-run": readAgent("dry-run"),
    replay: readReplay(),
  };
  const sources = Object.keys(SOURCES).filter((key) => available[key] && (!only || only.includes(key)));
  // A visitor lands on the live record only once it has enough grades to say something;
  // before that the replay is the default view and the live tab stays one click away.
  const liveReady = (available.live?.score.graded ?? 0) >= LIVE_DEFAULT_MIN_GRADED;
  const fallback = sources.find((key) => key !== "live" || liveReady) ?? sources[0] ?? null;
  const source = sources.includes(requested) ? requested : fallback;
  return { sources, source, note: SOURCES[source] ?? null, generatedAt: Date.now(), ...(source ? available[source] : {}) };
}
