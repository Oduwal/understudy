// All counts and grades in this file are stand-in test values, not chain data.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildForecast,
  calibrateBand,
  computeTrust,
  createActivity,
  gradeForecast,
  runForecasters,
} from "../src/forecast.mjs";
import { forecastMemory, gradeMemory, parseMemory, sentenceOf, trustLesson } from "../src/lessons.mjs";
import { DAY_MS, WINDOW_MS } from "../src/windows.mjs";

const TARGET = Date.UTC(2026, 10, 6, 12, 0);
const AS_OF = TARGET - 5 * 60_000;
const BAND = { q10: -0.2, q90: 0.2 };

function flatActivity(perWindow, days = 8) {
  const counts = new Map();
  const from = TARGET - days * DAY_MS;
  for (let t = from; t < TARGET; t += WINDOW_MS) counts.set(t, perWindow);
  return createActivity(counts, from, TARGET);
}

const gradeAt = (window, errs) => ({ window, errs: { lastHour: 0.3, usual: 0.3, average: 0.3, blend: 0.3, ...errs } });

test("a window outside the covered range is unknown, and one inside with no rows is zero", () => {
  const activity = createActivity(new Map(), TARGET, TARGET + 2 * WINDOW_MS);
  assert.equal(activity.get(TARGET - WINDOW_MS), null);
  assert.equal(activity.get(TARGET), 0);
  assert.equal(activity.get(TARGET + 2 * WINDOW_MS), null);
});

test("forecasters agree when activity is flat", () => {
  const estimates = runForecasters(flatActivity(80), TARGET, AS_OF);
  assert.deepEqual(estimates, { lastHour: 80, usual: 80, average: 80, blend: 80 });
});

test("forecasters return nothing without enough history", () => {
  assert.equal(runForecasters(createActivity(new Map(), TARGET, TARGET), TARGET, AS_OF), null);
});

test("last hour ignores the window still in progress", () => {
  const counts = new Map();
  const from = TARGET - 8 * DAY_MS;
  for (let t = from; t < TARGET; t += WINDOW_MS) counts.set(t, 60);
  counts.set(TARGET - WINDOW_MS, 9999);
  const { lastHour } = runForecasters(createActivity(counts, from, TARGET), TARGET, AS_OF);
  assert.equal(lastHour, 60);
});

test("with no memory, every forecaster is trusted equally", () => {
  const trust = computeTrust([], TARGET, AS_OF);
  assert.equal(trust.evidence, 0);
  assert.equal(trust.leader, null);
  for (const weight of Object.values(trust.weights)) assert.equal(weight, 0.25);
});

test("the forecaster with the smaller misses earns the most trust", () => {
  const grades = [gradeAt(TARGET - 2 * WINDOW_MS, { lastHour: 0.05 }), gradeAt(TARGET - 3 * WINDOW_MS, { lastHour: 0.05 })];
  const trust = computeTrust(grades, TARGET, AS_OF);
  assert.equal(trust.leader, "lastHour");
  assert.ok(trust.weights.lastHour > 0.5);
  const total = Object.values(trust.weights).reduce((sum, v) => sum + v, 0);
  assert.ok(Math.abs(total - 1) < 1e-9);
});

test("a grade for a window not yet closed is ignored", () => {
  assert.equal(computeTrust([gradeAt(TARGET - WINDOW_MS / 2, { lastHour: 0 })], TARGET, AS_OF).evidence, 0);
});

test("recent grades outweigh old ones", () => {
  const grades = [gradeAt(TARGET - 2 * WINDOW_MS, { usual: 0.05 }), gradeAt(TARGET - DAY_MS * 2, { lastHour: 0.05 })];
  assert.equal(computeTrust(grades, TARGET, AS_OF).leader, "usual");
});

test("memory changes the forecast, and the no-memory figure stays the equal-trust one", () => {
  const counts = new Map();
  const from = TARGET - 8 * DAY_MS;
  for (let t = from; t < TARGET; t += WINDOW_MS) counts.set(t, t >= TARGET - 8 * WINDOW_MS ? 160 : 60);
  const activity = createActivity(counts, from, TARGET);
  const none = buildForecast({ activity, target: TARGET, asOf: AS_OF, grades: [], band: BAND });
  const grades = [gradeAt(TARGET - 2 * WINDOW_MS, { lastHour: 0.01 }), gradeAt(TARGET - 3 * WINDOW_MS, { lastHour: 0.01 })];
  const taught = buildForecast({ activity, target: TARGET, asOf: AS_OF, grades, band: BAND });
  assert.equal(none.expected, none.noMemory);
  assert.equal(taught.noMemory, none.noMemory);
  assert.ok(taught.expected > none.expected);
});

test("grading separates hits, misses and alerts", () => {
  const estimates = { lastHour: 80, usual: 80, average: 80, blend: 80 };
  const forecast = { window: TARGET, expected: 80, low: 65, high: 98, noMemory: 80, estimates };
  assert.equal(gradeForecast(forecast, 80, BAND).hit, true);
  const miss = gradeForecast(forecast, 105, BAND);
  assert.equal(miss.hit, false);
  assert.equal(miss.alert, null);
  assert.equal(gradeForecast(forecast, 300, BAND).alert, "busy");
  assert.equal(gradeForecast(forecast, 5, BAND).alert, "quiet");
  assert.ok(gradeForecast(forecast, 160, BAND).errs.lastHour > 0);
});

test("the band falls back to a default until there are enough samples", () => {
  assert.deepEqual(calibrateBand([0.1]), { q10: -0.45, q90: 0.45 });
  const band = calibrateBand(Array.from({ length: 100 }, (_, i) => (i - 50) / 100));
  assert.ok(band.q10 < 0 && band.q90 > 0);
});

test("a grade survives a round trip through memory text, so trust can be rebuilt", () => {
  const estimates = { lastHour: 80, usual: 70, average: 60, blend: 75 };
  const forecast = { window: TARGET, expected: 80, low: 65, high: 98, noMemory: 72, estimates, weights: { lastHour: 1, usual: 0, average: 0, blend: 0 }, leader: "lastHour", evidence: 3 };
  const grade = gradeForecast(forecast, 90, BAND);
  const parsed = parseMemory(gradeMemory(forecast, grade));
  assert.equal(parsed.kind, "grade");
  assert.equal(parsed.window, TARGET);
  assert.equal(computeTrust([parsed], TARGET + 2 * WINDOW_MS, TARGET + 2 * WINDOW_MS).evidence, 1);
  assert.equal(parseMemory(forecastMemory(forecast)).kind, "forecast");
  assert.ok(!sentenceOf(gradeMemory(forecast, grade)).includes("understudy:"));
});

test("a lesson is written only when the most trusted forecaster changes", () => {
  const forecast = { window: TARGET, leader: "usual", typicalMiss: { usual: 0.2, lastHour: 0.4 } };
  assert.equal(trustLesson(forecast, "usual"), null);
  assert.equal(trustLesson(forecast, null), null);
  assert.equal(parseMemory(trustLesson(forecast, "lastHour")).to, "usual");
});

test("unrelated memory text doesn't parse", () => {
  assert.equal(parseMemory("Understudy connection test, 6 Nov 2026"), null);
});

test("recalled memories that could break trust are rejected", () => {
  const good = { kind: "grade", window: TARGET, errs: { lastHour: 0.1, usual: 0.2, average: 0.3, blend: 0.1 } };
  const wrap = (data) => `Graded window. [understudy:${JSON.stringify(data)}]`;
  assert.equal(parseMemory(wrap(good)).kind, "grade");
  assert.equal(parseMemory(wrap({ ...good, errs: { ...good.errs, usual: "NaN" } })), null);
  assert.equal(parseMemory(wrap({ ...good, errs: { lastHour: 0.1 } })), null);
  assert.equal(parseMemory(wrap({ ...good, errs: { ...good.errs, average: -1 } })), null);
  assert.equal(parseMemory(wrap({ ...good, window: "soon" })), null);
  assert.equal(parseMemory(wrap({ ...good, kind: "instruction" })), null);
  assert.equal(parseMemory(wrap({ kind: "lesson", window: TARGET, to: "somethingElse" })), null);
  assert.equal(parseMemory(`${"x".repeat(5000)} ${wrap(good)}`), null);
  assert.equal(parseMemory(42), null);
});

test("the live state is rebuilt from recalled Walrus memories alone", async () => {
  const { stateFromMemories } = await import("../src/walrus-state.mjs");
  const estimates = { lastHour: 80, usual: 70, average: 60, blend: 75 };
  const forecast = { window: TARGET, expected: 80, low: 65, high: 98, noMemory: 72, estimates, weights: { lastHour: 0.7, usual: 0.1, average: 0.1, blend: 0.1 }, leader: "lastHour", evidence: 3 };
  const grade = gradeForecast(forecast, 90, BAND);
  const item = (text, id, at) => ({ text, blob_id: id, created_at: new Date(at).toISOString() });
  const state = stateFromMemories({
    forecasts: [item(forecastMemory(forecast), "f1", TARGET - 3 * 60_000), item(forecastMemory({ ...forecast, window: TARGET + WINDOW_MS }), "f2", TARGET + WINDOW_MS + 1000)],
    grades: [item(gradeMemory(forecast, grade), "g1", TARGET + 17 * 60_000), item("not a memory of ours", "x", TARGET)],
    lessons: [item(trustLesson({ window: TARGET, leader: "usual", typicalMiss: { usual: 0.1, lastHour: 0.4 } }, "lastHour"), "l1", TARGET)],
  });
  assert.equal(state.windows.length, 2);
  const [first, second] = state.windows;
  assert.equal(first.actual, 90);
  assert.equal(first.memoryId, "f1");
  assert.equal(first.late, false);
  assert.equal(first.estimates.lastHour, 80);
  assert.equal(second.late, true);
  assert.equal(second.actual, null);
  assert.equal(state.lessons.length, 1);
  assert.equal(state.score.graded, 1);
  assert.equal(state.score.meanError, 10);
});
