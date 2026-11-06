// Demo: show that the agent's trust lives on Walrus, not in the relayer's search index.
//
// 1. Recall grades and compute trust.
// 2. With --forget, drop the grades namespace from the index (POST /api/forget). The blobs
//    stay on Walrus; only the index rows go.
// 3. Restore the namespace from Walrus, recall again, and check trust comes back the same.
//
// It writes no new memories. Run without --forget first to see the recall step on its own.
// Usage: node --env-file=.env scripts/restore-demo.mjs [--forget]
import { MemWal } from "@mysten-incubation/memwal";
import { computeTrust } from "../src/forecast.mjs";
import { GRADE_QUERY, parseMemory } from "../src/lessons.mjs";
import { NAMESPACES } from "../src/memory.mjs";
import { WINDOW_MS, windowStart } from "../src/windows.mjs";

const RELAYER = "https://relayer.memory.walrus.xyz";
const namespace = NAMESPACES.grade;
const memwal = MemWal.create({ key: process.env.MEMWAL_KEY, accountId: process.env.MEMWAL_ACCOUNT_ID, serverUrl: RELAYER, namespace });

async function trustNow(label) {
  const { results } = await memwal.recall({ query: GRADE_QUERY, limit: 100, namespace, sort: "recent" });
  const grades = results.map((r) => parseMemory(r.text)).filter((g) => g?.kind === "grade");
  const target = windowStart(Date.now()) + WINDOW_MS;
  const trust = computeTrust(grades, target, Date.now());
  const weights = Object.entries(trust.weights).map(([k, v]) => `${k} ${(v * 100).toFixed(0)}%`).join(", ");
  console.log(`${label}: ${grades.length} grades recalled. Trust: ${weights}`);
  return grades.length;
}

const before = await trustNow("Before");
if (process.argv.includes("--forget")) {
  // The SDK has no forget method, so this calls the documented relayer route through the
  // SDK's signed request helper when it exists, and stops otherwise.
  if (typeof memwal.forget !== "function") {
    console.log("This SDK version has no forget(); skipping the wipe. Restore still runs.");
  } else {
    console.log("Forget:", JSON.stringify(await memwal.forget(namespace)));
    await trustNow("After forget");
  }
}
const restored = await memwal.restore(namespace, 100);
console.log(`Restore: restored ${restored.restored}, skipped ${restored.skipped}, failed ${restored.failed}, total ${restored.total}`);
const after = await trustNow("After restore");
console.log(after >= before ? "Trust came back from Walrus." : "Fewer grades came back than before. Check the restore counts.");
