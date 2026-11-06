// Pulls past relayer activity from Tatum's Sui gateway into data/history/.
// Deliberately keyless: this script never reads TATUM_API_KEY, so it can't spend credits.
// Tatum allows 5 anonymous requests per minute, so it paces itself below that.
// It resumes from data/history/state.json if stopped.
//
// Usage: node scripts/pull-history.mjs [--days 7] [--pages N]
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import grpc from "@grpc/grpc-js";
import protoLoader from "@grpc/proto-loader";

const HOST = "sui-mainnet-grpc.gateway.tatum.io:443";
const MEMWAL_PACKAGE = "0xe7c16fbea0560e7057e2bf7422feaa4fb313749fc69c9e9092fac7a33b81d7f5";
const FUNCTION = `${MEMWAL_PACKAGE}::account::seal_encrypt_fence`;
const PAGE_SIZE = 500;
const PACE_MS = 13_000;
const BACKOFF_MS = 65_000;
const CHECKPOINTS_PER_SECOND = 4.12; // Measured 2026-11-06; only used to pick the start point.

const DIR = "data/history";
const OUT = `${DIR}/seal-fence-calls.jsonl`;
const STATE = `${DIR}/state.json`;

const { values } = parseArgs({
  options: { days: { type: "string", default: "7" }, pages: { type: "string" } },
});
const maxPages = values.pages ? Number(values.pages) : Infinity;

const definition = protoLoader.loadSync(["sui/rpc/v2/ledger_service.proto"], {
  keepCase: true,
  longs: String,
  enums: String,
  defaults: false,
  oneofs: true,
  includeDirs: [".tools/sui-apis/proto"],
});
const { sui } = grpc.loadPackageDefinition(definition);
const ledger = new sui.rpc.v2.LedgerService(HOST, grpc.credentials.createSsl());
const anonymous = () => new grpc.Metadata();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function serviceInfo() {
  return new Promise((resolve, reject) =>
    ledger.GetServiceInfo({}, anonymous(), { deadline: Date.now() + 30_000 }, (error, info) =>
      error ? reject(error) : resolve(info),
    ),
  );
}

function fetchPage(state) {
  return new Promise((resolve, reject) => {
    const rows = [];
    let cursor;
    let reason;
    const stream = ledger.ListTransactions(
      {
        read_mask: { paths: ["digest", "checkpoint", "timestamp", "transaction.sender"] },
        start_checkpoint: state.start,
        end_checkpoint: state.end,
        filter: { terms: [{ literals: [{ move_call: { function: FUNCTION } }] }] },
        options: {
          limit: PAGE_SIZE,
          ...(state.cursor ? { after: Buffer.from(state.cursor, "base64") } : {}),
        },
      },
      anonymous(),
      { deadline: Date.now() + 60_000 },
    );
    stream.on("data", (frame) => {
      if (frame.transaction) {
        const t = frame.transaction;
        rows.push({
          digest: t.digest,
          checkpoint: Number(t.checkpoint),
          time: new Date(Number(t.timestamp?.seconds) * 1000).toISOString(),
          sender: t.transaction?.sender,
        });
      }
      if (frame.watermark?.cursor?.length) cursor = Buffer.from(frame.watermark.cursor).toString("base64");
      if (frame.end?.reason) reason = frame.end.reason;
    });
    stream.on("error", reject);
    stream.on("end", () => resolve({ rows, cursor, reason }));
  });
}

mkdirSync(DIR, { recursive: true });

let state;
if (existsSync(STATE)) {
  state = JSON.parse(readFileSync(STATE, "utf8"));
} else {
  const info = await serviceInfo();
  const tip = Number(info.checkpoint_height);
  const back = Math.round(Number(values.days) * 86_400 * CHECKPOINTS_PER_SECOND);
  state = { start: String(tip - back), end: String(tip), cursor: null, rows: 0, done: false };
  writeFileSync(STATE, JSON.stringify(state, null, 2));
  await sleep(PACE_MS);
}

let pages = 0;
while (!state.done && pages < maxPages) {
  let page;
  try {
    page = await fetchPage(state);
  } catch (error) {
    console.log(`${grpc.status[error.code] ?? error.code}: ${String(error.details ?? error.message).slice(0, 160)}; waiting`);
    await sleep(BACKOFF_MS);
    continue;
  }
  if (page.rows.length) appendFileSync(OUT, `${page.rows.map((r) => JSON.stringify(r)).join("\n")}\n`);
  state.rows += page.rows.length;
  if (page.cursor) state.cursor = page.cursor;
  state.done = page.reason === "QUERY_END_REASON_CHECKPOINT_BOUND" || page.reason === "QUERY_END_REASON_LEDGER_TIP";
  writeFileSync(STATE, JSON.stringify(state, null, 2));
  pages += 1;
  console.log(`page ${pages}: ${page.rows.length} rows, total ${state.rows}, up to ${page.rows.at(-1)?.time ?? "n/a"}, ended ${page.reason}`);
  if (!state.done) await sleep(PACE_MS);
}

console.log(state.done ? `Finished: ${state.rows} rows in ${OUT}` : `Paused: ${state.rows} rows so far`);
ledger.close();
