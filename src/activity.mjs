// Stored chain activity: one JSON line per seal_encrypt_fence call, written by
// scripts/pull-history.mjs (history) and the agent (live).
import { existsSync, readFileSync } from "node:fs";
import { createActivity } from "./forecast.mjs";
import { WINDOW_MS, windowStart } from "./windows.mjs";

export const HISTORY_FILE = "data/history/seal-fence-calls.jsonl";
export const LIVE_FILE = "data/activity/seal-fence-calls.jsonl";

export function readRows(paths = [HISTORY_FILE, LIVE_FILE]) {
  const byDigest = new Map();
  for (const path of paths) {
    if (!existsSync(path)) continue;
    for (const line of readFileSync(path, "utf8").split("\n")) {
      if (!line) continue;
      const row = JSON.parse(line);
      byDigest.set(row.digest, row);
    }
  }
  return [...byDigest.values()].sort((a, b) => a.checkpoint - b.checkpoint);
}

export function activityFromRows(rows, coveredTo) {
  const counts = new Map();
  let first = Infinity;
  let last = 0;
  for (const row of rows) {
    const time = Date.parse(row.time);
    first = Math.min(first, time);
    last = Math.max(last, time);
    const start = windowStart(time);
    counts.set(start, (counts.get(start) ?? 0) + 1);
  }
  // The first window may be partial, so coverage starts at the next one.
  const coveredFrom = rows.length ? windowStart(first) + WINDOW_MS : 0;
  return createActivity(counts, coveredFrom, coveredTo ?? last);
}
