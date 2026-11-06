// Walk-forward replay over real relayer history: each forecast only sees what was known
// at the time. It answers one question: does remembering each forecaster's record beat
// trusting them all equally, which is what an agent with no memory has to do?
//
// This is a replay, not a live record. It uses the same forecast code as the agent, but
// keeps grades in a plain array instead of recalling them from Walrus.
import { mkdirSync, writeFileSync } from "node:fs";
import { activityFromRows, readRows } from "../src/activity.mjs";
import { FORECASTER_NAMES, buildForecast, calibrateBand, gradeForecast, recentResiduals } from "../src/forecast.mjs";
import { gradeMemory, parseMemory, sentenceOf, trustLesson } from "../src/lessons.mjs";
import { DAY_MS, WINDOW_MS, windowStart } from "../src/windows.mjs";

const LEAD_MS = 5 * 60_000;
const WARMUP_DAYS = 2;
const BAND_REFRESH_WINDOWS = 8;

const rows = readRows();
const last = Date.parse(rows.at(-1).time);
const activity = activityFromRows(rows, last);
const end = windowStart(last);

const grades = [];
const results = [];
const lessons = [];
let band;
let leader = null;
let index = 0;
for (let target = activity.coveredFrom + WARMUP_DAYS * DAY_MS; target < end; target += WINDOW_MS) {
  const asOf = target - LEAD_MS;
  const actual = activity.get(target);
  if (actual === null) continue;
  if (index++ % BAND_REFRESH_WINDOWS === 0) band = calibrateBand(recentResiduals(activity, asOf));
  const forecast = buildForecast({ activity, target, asOf, grades, band });
  if (!forecast) continue;
  const lesson = trustLesson(forecast, leader);
  if (lesson) lessons.push({ ...parseMemory(lesson), sentence: sentenceOf(lesson) });
  if (lesson || !leader) leader = forecast.leader;
  const grade = gradeForecast(forecast, actual, band);
  results.push({ ...forecast, ...grade });
  // The same memory text the agent writes, parsed back, so the replay can't cheat on precision.
  grades.push(parseMemory(gradeMemory(forecast, grade)));
}

const mean = (values) => (values.length ? values.reduce((sum, v) => sum + v, 0) / values.length : null);
const errorOf = (name) => (r) => Math.abs(r.actual - r.estimates[name]);
function summarize(list) {
  const alone = Object.fromEntries(Object.keys(FORECASTER_NAMES).map((name) => [name, mean(list.map(errorOf(name)))]));
  return {
    windows: list.length,
    meanActual: mean(list.map((r) => r.actual)),
    errorWithMemory: mean(list.map((r) => r.errors.forecast)),
    errorNoMemory: mean(list.map((r) => r.errors.noMemory)),
    errorEachForecasterAlone: alone,
    rangeHitRate: mean(list.map((r) => (r.hit ? 1 : 0))),
    alerts: list.filter((r) => r.alert).length,
    closerWithMemory: list.filter((r) => r.errors.forecast < r.errors.noMemory).length,
    closerWithout: list.filter((r) => r.errors.forecast > r.errors.noMemory).length,
  };
}

const half = results.length >> 1;
const report = {
  note: "Walk-forward replay over real Mainnet history. Not a live record.",
  from: new Date(results[0].window).toISOString(),
  to: new Date(results.at(-1).window).toISOString(),
  rowsRead: rows.length,
  trustChanges: lessons.length,
  overall: summarize(results),
  firstHalf: summarize(results.slice(0, half)),
  secondHalf: summarize(results.slice(half)),
};
mkdirSync("data", { recursive: true });
writeFileSync("data/backtest.json", JSON.stringify({ ...report, lessons, results }));
console.log(JSON.stringify(report, null, 2));
