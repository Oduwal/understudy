// Vercel function: the dashboard's state, read straight from Walrus Memory.
//
// Uses MEMWAL_DASHBOARD_KEY, a delegate key kept only for the dashboard so it can be revoked
// without touching the agent. Responses are cached at the edge for five minutes, so visitors
// can't use up the account's relayer rate limit that the agent depends on.
import { readFileSync } from "node:fs";
import { MemWal } from "@mysten-incubation/memwal";
import { GRADE_QUERY, LESSON_QUERY } from "../src/lessons.mjs";
import { NAMESPACES } from "../src/memory.mjs";
import { LIVE_NOTE, RECALL_LIMIT, stateFromMemories } from "../src/walrus-state.mjs";

const RELAYER = "https://relayer.memory.walrus.xyz";
const LIVE_DEFAULT_MIN_GRADED = 24;
const REPLAY_NOTE = "Replay: this forecast code run over past Mainnet activity. It is a test of the method, not a live record.";
const FORECAST_QUERY = "Forecast for the next window: memories expected and range";

let replayCache;
function replay() {
  replayCache ??= JSON.parse(readFileSync(new URL("../public-data/replay.json", import.meta.url), "utf8"));
  return replayCache;
}

async function live() {
  const { MEMWAL_DASHBOARD_KEY: key, MEMWAL_ACCOUNT_ID: accountId } = process.env;
  if (!key || !accountId) throw new Error("MEMWAL_DASHBOARD_KEY and MEMWAL_ACCOUNT_ID are not set");
  const memwal = MemWal.create({ key, accountId, serverUrl: RELAYER, namespace: NAMESPACES.forecast });
  const recall = (query, namespace, limit = RECALL_LIMIT) =>
    memwal.recall({ query, limit, namespace, sort: "recent", timeoutMs: 20_000 }).then((r) => r.results);
  const [forecasts, grades, lessons] = await Promise.all([
    recall(FORECAST_QUERY, NAMESPACES.forecast),
    recall(GRADE_QUERY, NAMESPACES.grade),
    recall(LESSON_QUERY, NAMESPACES.lesson, 30),
  ]);
  return stateFromMemories({ forecasts, grades, lessons });
}

export default async function handler(request, response) {
  const requested = new URL(request.url, "http://localhost").searchParams.get("source");
  const sources = ["live", "replay"];
  let liveState = null;
  let liveError = null;
  if (requested !== "replay") {
    try {
      liveState = await live();
    } catch (error) {
      liveError = error;
      console.error("Walrus recall failed:", error);
    }
  }

  const liveReady = (liveState?.score.graded ?? 0) >= LIVE_DEFAULT_MIN_GRADED;
  const source = requested === "live" || (requested !== "replay" && liveReady) ? "live" : "replay";
  let body;
  if (source === "live" && liveState) {
    body = { sources, source, note: LIVE_NOTE, readFromWalrus: true, generatedAt: Date.now(), ...liveState };
  } else if (source === "live") {
    response.setHeader("cache-control", "no-store");
    response.status(502).json({ error: "Couldn't read the live record from Walrus just now." });
    return;
  } else {
    const note = liveError ? `${REPLAY_NOTE} The live record couldn't be read from Walrus just now.` : REPLAY_NOTE;
    body = { sources, source, note, generatedAt: Date.now(), ...replay() };
  }
  response.setHeader("cache-control", "public, s-maxage=300, stale-while-revalidate=600");
  response.status(200).json(body);
}
