// The Understudy loop: forecast the next window, wait for the chain to grade it, learn from misses.
//
// Dry run is the default and writes only to data/agent/dry-run/. Writing to Walrus Mainnet
// takes the explicit --live flag, because those memories are permanent.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { LIVE_FILE, activityFromRows, readRows } from "./activity.mjs";
import { KEYLESS_PACE_MS, createChain, createCreditMeter } from "./chain.mjs";
import { buildForecast, calibrateBand, gradeForecast, recentResiduals } from "./forecast.mjs";
import { GRADE_QUERY, LESSON_QUERY, forecastMemory, gradeMemory, parseMemory, sentenceOf, trustLesson } from "./lessons.mjs";
import { writeJsonAtomic } from "./files.mjs";
import { createLocalMemory, createWalrusMemory } from "./memory.mjs";
import { WINDOW_MS, describeWindow, windowStart } from "./windows.mjs";

const FORECAST_LEAD_MS = 5 * 60_000;
const GRADE_GRACE_MS = 90_000;
const TICK_MS = 20_000;
const BACKOFF_MS = 65_000;
// A dropped connection usually clears at once; waiting a full minute cost forecast lead time.
const TRANSIENT_BACKOFF_MS = 15_000;
const errorText = (error) => `${error.details ?? ""} ${error.message ?? ""}`;
// A rate limit is not a glitch: retrying quickly keeps the gateway refusing, so it gets the long wait.
const isRateLimited = (error) => /\b429\b|rate limit/i.test(errorText(error));
const isTransient = (error) =>
  !isRateLimited(error) && (/ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up|Name resolution/i.test(errorText(error)) || error.code === 14);
const describeError = (error) => `${error.code === undefined ? "" : `${error.code} `}${error.details ?? error.message}`;
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
// With a Tatum key present, reads stay keyless and fall back to the metered key only when the
// anonymous limit refuses a call. --use-key makes every read keyed.
const apiKey = process.env.TATUM_API_KEY || null;
const keyMode = !apiKey ? "never" : flags["use-key"] ? "always" : "fallback";
const chain = createChain({
  apiKey,
  meter: apiKey ? createCreditMeter("data/agent/credits.json") : null,
  keyMode,
  onKeyed: (label, used) => log(`keyless ${label} was rate limited; retrying with the Tatum key (about ${used} credits used so far)`),
});

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

// Every keyless request shares one pace, so the agent stays under the gateway's anonymous
// limit of 5 requests a minute however its calls are interleaved.
let lastRequestAt = 0;
async function paced(request) {
  const wait = lastRequestAt + KEYLESS_PACE_MS - Date.now();
  if (wait > 0) await sleep(wait);
  lastRequestAt = Date.now();
  return request();
}

const SYNC_FRESH_MS = 90_000;
const saveSync = () => writeJsonAtomic(SYNC_STATE, synced);

// Brings stored activity up to the chain tip. Progress is saved after every page, so a
// failure resumes where it stopped instead of restarting a long catch-up from scratch.
async function sync() {
  do {
    if (!synced.pending) {
      const tip = await paced(() => chain.tip());
      synced.pending = { to: tip.checkpoint, time: tip.time, cursor: null };
      saveSync();
    }
    const { pending } = synced;
    for (;;) {
      const page = await paced(() =>
        chain.fencePage({ fromCheckpoint: synced.checkpoint, toCheckpoint: pending.to, cursor: pending.cursor }),
      );
      // A page re-read after a crash may repeat rows; readRows drops duplicates by digest.
      if (page.rows.length) appendFileSync(LIVE_FILE, `${page.rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
      pending.cursor = page.cursor ?? pending.cursor;
      saveSync();
      if (page.finished) break;
    }
    synced = { checkpoint: pending.to, time: pending.time };
    saveSync();
  } while (Date.now() - synced.time > SYNC_FRESH_MS);
  return activityFromRows(readRows(), synced.time);
}

async function write(text, kind, key) {
  for (let attempt = 1; ; attempt++) {
    try {
      const result = await memory.remember(text, kind, key);
      record({ type: "write", key, id: result.id, startedAt: result.startedAt, doneAt: result.doneAt });
      ownWrites.push(result);
      return result;
    } catch (error) {
      log(`write ${key} failed (attempt ${attempt}): ${describeError(error)}`);
      // Retrying is safe: the idempotency key stops a duplicate memory.
      if (attempt >= WRITE_ATTEMPTS) throw error;
      await sleep(isTransient(error) ? TRANSIENT_BACKOFF_MS : BACKOFF_MS);
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

// On a machine with no local record, which forecaster was last trusted is read back from the
// newest lesson in memory, so the next lesson continues the same story rather than restarting it.
let leaderRecalled = false;
async function recallTrustedLeader() {
  leaderRecalled = true;
  const found = await memory.recallRecent(LESSON_QUERY, "lesson", 10);
  const lessons = found.map((item) => parseMemory(item.text)).filter((data) => data?.kind === "lesson");
  const newest = lessons.sort((a, b) => b.window - a.window)[0];
  if (newest) {
    trustedLeader = newest.to;
    log(`recalled from memory: currently trusting ${newest.to}`);
  }
}

async function makeForecast(target) {
  const activity = await sync();
  const asOf = Date.now();
  const band = calibrateBand(recentResiduals(activity, asOf));
  const grades = await recallGrades();
  if (!trustedLeader && !leaderRecalled) await recallTrustedLeader();
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

log(`started. Memory: ${memory.mode}. Chain: ${{ never: "keyless", fallback: "keyless, key on rate limit", always: "keyed, metered" }[keyMode]}.`);

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
    log(`error: ${describeError(error)}`);
    await sleep(isTransient(error) ? TRANSIENT_BACKOFF_MS : BACKOFF_MS);
    // The wait counts as spacing, so the next request isn't fired the instant it ends.
    if (isRateLimited(error)) lastRequestAt = Date.now();
  }
  await sleep(TICK_MS);
}
