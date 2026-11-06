// Every memory is one readable sentence plus a machine-readable trailer, so a fresh
// install can rebuild its trust in each forecaster from recall alone.
import { FORECASTER_NAMES } from "./forecast.mjs";
import { clockTime, describeWindow, weekdayName } from "./windows.mjs";

const TRAILER = /\s*\[understudy:(\{[^\r\n]*\})\]\s*$/;
const MAX_MEMORY_LENGTH = 4096;
const MAX_LOG_MISS = 20;
const KINDS = new Set(["forecast", "grade", "lesson"]);
export const GRADE_QUERY = "Graded window: how each forecaster did against the relayer count";
export const LESSON_QUERY = "Lesson: now trusting one forecaster over another";
const CLEAR_MARGIN = 0.05;

const withTrailer = (sentence, data) => `${sentence} [understudy:${JSON.stringify(data)}]`;
const rounded = (values) => Object.fromEntries(Object.entries(values).map(([key, v]) => [key, Number(v.toFixed(3))]));
const percentMiss = (logMiss) => Math.round((Math.exp(logMiss) - 1) * 100);

export const sentenceOf = (text) => text.replace(TRAILER, "");

// Recalled memories are checked before they can touch trust: a malformed or non-finite grade
// would otherwise turn every weight into NaN and stall the agent.
export function parseMemory(text) {
  if (typeof text !== "string" || text.length > MAX_MEMORY_LENGTH) return null;
  const match = TRAILER.exec(text);
  if (!match) return null;
  let data;
  try {
    data = JSON.parse(match[1]);
  } catch {
    return null;
  }
  if (!data || typeof data !== "object" || !KINDS.has(data.kind) || !Number.isFinite(data.window)) return null;
  if (data.kind === "grade") {
    if (!data.errs || typeof data.errs !== "object") return null;
    for (const name of Object.keys(FORECASTER_NAMES)) {
      const miss = data.errs[name];
      if (!Number.isFinite(miss) || miss < 0 || miss > MAX_LOG_MISS) return null;
    }
  }
  if (data.kind === "lesson" && !(data.to in FORECASTER_NAMES)) return null;
  return data;
}

export function forecastMemory(forecast) {
  const { window, expected, low, high, noMemory, leader, evidence, weights } = forecast;
  const trusted = leader ? `Trusting ${FORECASTER_NAMES[leader].toLowerCase()} most` : "Trusting every forecaster equally";
  return withTrailer(
    `Forecast for ${describeWindow(window)}: ${expected} memories expected, range ${low} to ${high}. ` +
      `${trusted}, from ${evidence} graded windows. With no memory I would have said ${noMemory}.`,
    { kind: "forecast", window, expected, low, high, noMemory, weights: rounded(weights) },
  );
}

export function gradeMemory(forecast, grade) {
  const outcome = grade.hit ? "inside" : "outside";
  return withTrailer(
    `Graded window ${describeWindow(grade.window)}: ${grade.actual} memories, ${outcome} my range of ` +
      `${forecast.low} to ${forecast.high}. Forecast error ${grade.errors.forecast}, no-memory error ${grade.errors.noMemory}.`,
    { kind: "grade", window: grade.window, actual: grade.actual, hit: grade.hit, alert: grade.alert, errs: rounded(grade.errs) },
  );
}

// Written when memory changes which forecaster the agent trusts most at this time of day.
export function trustLesson(forecast, previousLeader) {
  const { leader, typicalMiss, window } = forecast;
  if (!leader || !previousLeader || leader === previousLeader) return null;
  // Close contests flip back and forth, and that isn't something learned.
  if (typicalMiss[previousLeader] - typicalMiss[leader] < CLEAR_MARGIN) return null;
  const now = FORECASTER_NAMES[leader].toLowerCase();
  const before = FORECASTER_NAMES[previousLeader].toLowerCase();
  return withTrailer(
    `Lesson for ${weekdayName(window)} around ${clockTime(window)} UTC: now trusting ${now} over ${before}. ` +
      `Its typical recent miss is ${percentMiss(typicalMiss[leader])}%, against ${percentMiss(typicalMiss[previousLeader])}%.`,
    { kind: "lesson", window, from: previousLeader, to: leader },
  );
}
