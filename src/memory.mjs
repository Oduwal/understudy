// Two stores with one interface. Walrus writes permanently to Mainnet. The local store is
// for dry runs: nothing leaves this machine and every record is marked as a dry run.
//
// Each kind of memory has its own namespace. Recall with sort "recent" only orders semantic
// candidates, so keeping grades apart guarantees the newest grades are the ones returned.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

const RELAYER = "https://relayer.memory.walrus.xyz";
export const NAMESPACES = {
  forecast: "understudy-forecasts",
  grade: "understudy-grades",
  lesson: "understudy-lessons",
};

export async function createWalrusMemory({ key, accountId }) {
  if (!key || !accountId) throw new Error("MEMWAL_KEY and MEMWAL_ACCOUNT_ID are required for live mode");
  const { MemWal } = await import("@mysten-incubation/memwal");
  const memwal = MemWal.create({ key, accountId, serverUrl: RELAYER, namespace: NAMESPACES.forecast });
  return {
    mode: "live",
    // The idempotency key makes a retry after a timeout return the same memory, not a duplicate.
    async remember(text, kind, idempotencyKey) {
      const startedAt = Date.now();
      const job = await memwal.remember(text, NAMESPACES[kind], { idempotencyKey });
      const done = await memwal.waitForRememberJob(job.job_id);
      return { id: done.blob_id, startedAt, doneAt: Date.now() };
    },
    // The relayer caps a recall at 100, which is plenty: trust halves in weight every 3 hours.
    async recallRecent(query, kind, limit = 100) {
      const { results } = await memwal.recall({ query, limit, namespace: NAMESPACES[kind], sort: "recent" });
      return results.map((r) => ({ id: r.blob_id, text: r.text }));
    },
  };
}

export function createLocalMemory(path) {
  mkdirSync(dirname(path), { recursive: true });
  const read = () =>
    existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
  return {
    mode: "dry-run",
    async remember(text, kind, idempotencyKey) {
      const now = Date.now();
      const id = `dry-run-${idempotencyKey}`;
      if (!read().some((m) => m.id === id)) appendFileSync(path, `${JSON.stringify({ id, kind, text, at: now })}\n`);
      return { id, startedAt: now, doneAt: now };
    },
    // Newest first within the kind. Unlike the real recall, this doesn't rank by meaning first.
    async recallRecent(_query, kind, limit = 100) {
      return read()
        .filter((m) => (m.kind ?? kind) === kind)
        .slice(-limit)
        .reverse()
        .map((m) => ({ id: m.id, text: m.text }));
    },
  };
}
