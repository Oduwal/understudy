// The Understudy loop: forecast the next window, wait for the chain to grade it, learn from misses.
//
// Dry run is the default and writes only to data/agent/dry-run/. Writing to Walrus Mainnet
// takes the explicit --live flag, because those memories are permanent.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { LIVE_FILE, activityFromRows, readRows } from "./activity.mjs";
import { KEYLESS_PACE_MS, createChain, createCreditMeter } from "./chain.mjs";
import { buildForecast, calibrateBand, gradeForecast, recentResiduals } from "./forecast.mjs";
import { GRADE_QUERY, forecastMemory, gradeMemory, parseMemory, sentenceOf, trustLesson } from "./lessons.mjs";
import { createLocalMemory, createWalrusMemory } from "./memory.mjs";
import { WINDOW_MS, describeWindow, windowStart } from "./windows.mjs";

const FORECAST_LEAD_MS = 5 * 60_000;
const GRADE_GRACE_MS = 90_000;
const TICK_MS = 20_000;
const BACKOFF_MS = 65_000;
const WRITE_ATTEMPTS = 3;
const HISTORY_STATE = "data/history/state.json";
const SYNC_STATE = "data/activity/state.json";

const { values: flags } = parseArgs({
  options: { live: { type: "boolean", default: false }, "use-key": { type: "boolean", default: false } },
});

const mode = flags.live ? "live" : "dry-run";
const DIR = `data/agent/${mode}`;
const EVENTS = `${DIR}/events.jsonl`;
mkdirSync(DIR, { recursive: true });
mkdirSync("data/activity", { recursive: true });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const log = (message) => console.log(`${new Date().toISOString()} [${mode}] ${message}`);

const memory = flags.live
  ? await createWalrusMemory({ key: process.env.MEMWAL_KEY, accountId: process.env.MEMWAL_ACCOUNT_ID })
  : createLocalMemory(`${DIR}/memories.jsonl`);
const chain = flags["use-key"]
  ? createChain({ apiKey: process.env.TATUM_API_KEY, meter: createCreditMeter("data/agent/credits.json") })
  : createChain();

const forecasts = new Map();
const graded = new Set();
const ownWrites = [];
let trustedLeader = null;
if (existsSync(EVENTS)) {
  for (const line of readFileSync(EVENTS, "utf8").split("\n")) {
    if (!line) continue;
    const event = JSON.parse(line);
    if (event.type === "forecast") {
      forecasts.set(event.window, event);
      trustedLeader ??= event.leader;
    }
    if (event.type === "grade") graded.add(event.window);
    if (event.type === "write") ownWrites.push(event);
    if (event.type === "lesson") trustedLeader = event.to;
  }
}

function record(event) {
  appendFileSync(EVENTS, `${JSON.stringify({ ...event, mode, at: new Date().toISOString() })}\n`);
}

function loadSyncState() {
  if (existsSync(SYNC_STATE)) return JSON.parse(readFileSync(SYNC_STATE, "utf8"));
  if (!existsSync(HISTORY_STATE)) throw new Error("Run scripts/pull-history.mjs first");
  const history = JSON.parse(readFileSync(HISTORY_STATE, "utf8"));
  if (!history.done) throw new Error("History pull hasn't finished");
  return { checkpoint: Number(history.end), time: null };
}

let synced = loadSyncState();

// Brings stored activity up to the chain tip. Paced for the anonymous limit.
async function sync() {
  const tip = await chain.tip();
  let cursor;
  let finished = false;
  while (!finished) {
    await sleep(KEYLESS_PACE_MS);
    const page = await chain.fencePage({ fromCheckpoint: synced.checkpoint, toCheckpoint: tip.checkpoint, cursor });
    if (page.rows.length) appendFileSync(LIVE_FILE, `${page.rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
    cursor = page.cursor;
    finished = page.finished;
  }
  synced = { checkpoint: tip.checkpoint, time: tip.time };
  writeFileSync(SYNC_STATE, JSON.stringify(synced));
  return activityFromRows(readRows(), tip.time);
}

async function write(text, kind, key) {
  for (let attempt = 1; ; attempt++) {
    try {
      const result = await memory.remember(text, kind, key);
      record({ type: "write", key, id: result.id, startedAt: result.startedAt, doneAt: result.doneAt });
      ownWrites.push(result);
      return result;
    } catch (error) {
      log(`write ${key} failed (attempt ${attempt}): ${error.message}`);
      // Retrying is safe: the idempotency key stops a duplicate memory.
      if (attempt >= WRITE_ATTEMPTS) throw error;
      await sleep(BACKOFF_MS);
    }
  }
}

// Trust comes only from what memory returns, never from local files, so a clean machine
// with the same Walrus account picks up where the last one stopped.
async function recallGrades() {
  const found = await memory.recallRecent(GRADE_QUERY, "grade");
  const byWindow = new Map();
  for (const item of found) {
    const data = parseMemory(item.text);
    if (data?.kind === "grade" && !byWindow.has(data.window)) byWindow.set(data.window, data);
  }
  return [...byWindow.values()];
}

async function makeForecast(target) {
  const activity = await sync();
  const asOf = Date.now();
  const band = calibrateBand(recentResiduals(activity, asOf));
  const grades = await recallGrades();
  const forecast = buildForecast({ activity, target, asOf, grades, band });
  if (!forecast) {
    log(`no forecast for ${describeWindow(target)}: not enough history`);
    return;
  }
  const saved = await write(forecastMemory(forecast), "forecast", `forecast-${target}`);
  // A forecast that finished writing after its window opened proves nothing, so it isn't scored.
  const late = saved.doneAt >= target;
  const event = { type: "forecast", ...forecast, band, memoryId: saved.id, writtenAt: saved.doneAt, late };
  forecasts.set(target, event);
  record(event);
  log(`forecast ${describeWindow(target)}: ${forecast.expected} (${forecast.low}-${forecast.high}), no-memory ${forecast.noMemory}, from ${forecast.evidence} grades${late ? ", LATE" : ""}`);

  const lesson = trustLesson(forecast, trustedLeader);
  if (lesson) {
    const savedLesson = await write(lesson, "lesson", `lesson-${target}`);
    const data = parseMemory(lesson);
    record({ type: "lesson", window: target, from: data.from, to: data.to, sentence: sentenceOf(lesson), memoryId: savedLesson.id });
    log(sentenceOf(lesson));
  }
  if (lesson || !trustedLeader) trustedLeader = forecast.leader;
}

// In live mode our own memories pass through the relayer, so they're removed from its count.
function ownWritesIn(start) {
  if (memory.mode !== "live") return 0;
  return ownWrites.filter((w) => windowStart(w.startedAt) === start).length;
}

async function grade(forecast) {
  const activity = await sync();
  const raw = activity.get(forecast.window);
  if (raw === null) return;
  const own = ownWritesIn(forecast.window);
  const result = gradeForecast(forecast, Math.max(0, raw - own), forecast.band);
  const saved = await write(gradeMemory(forecast, result), "grade", `grade-${forecast.window}`);
  graded.add(forecast.window);
  record({ type: "grade", ...result, raw, own, late: forecast.late, memoryId: saved.id });
  log(`graded ${describeWindow(forecast.window)}: ${result.actual}, ${result.hit ? "hit" : "miss"}, error ${result.errors.forecast} vs no-memory ${result.errors.noMemory}`);
  if (result.alert) {
    record({ type: "alert", window: forecast.window, kind: result.alert, actual: result.actual, low: forecast.low, high: forecast.high });
    log(`ALERT ${result.alert}: ${result.actual} against ${forecast.low}-${forecast.high}`);
  }
}

log(`started. Memory: ${memory.mode}. Chain: ${flags["use-key"] ? "keyed, metered" : "keyless"}.`);

// Runs until stopped. Failures are logged and retried on the next tick.
for (;;) {
  try {
    const now = Date.now();
    const target = windowStart(now) + WINDOW_MS;
    if (target - now <= FORECAST_LEAD_MS && !forecasts.has(target)) await makeForecast(target);
    for (const forecast of forecasts.values()) {
      const closed = forecast.window + WINDOW_MS + GRADE_GRACE_MS <= Date.now();
      if (closed && !graded.has(forecast.window)) await grade(forecast);
    }
  } catch (error) {
    log(`error: ${error.details ?? error.message}`);
    await sleep(BACKOFF_MS);
  }
  await sleep(TICK_MS);
}
