// Reads relayer activity from Tatum's Sui gRPC gateway.
//
// Keyless by default: anonymous access is capped at 5 requests a minute and uses no credits.
// With a key, Tatum charged 2 credits per transaction returned (measured from the dashboard
// on 2026-11-06), so keyed reads are metered here and refused past a hard limit.
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { writeJsonAtomic } from "./files.mjs";
import { dirname } from "node:path";
import grpc from "@grpc/grpc-js";
import protoLoader from "@grpc/proto-loader";

const HOST = "sui-mainnet-grpc.gateway.tatum.io:443";
const MEMWAL_PACKAGE = "0xe7c16fbea0560e7057e2bf7422feaa4fb313749fc69c9e9092fac7a33b81d7f5";
export const FENCE_FUNCTION = `${MEMWAL_PACKAGE}::account::seal_encrypt_fence`;
export const PAGE_SIZE = 500;
export const KEYLESS_PACE_MS = 13_000;

const CREDITS_PER_ROW = 2;
const CREDITS_ALREADY_USED = 12_528; // Dashboard total on 2026-11-06 before metering began.
export const CREDIT_HARD_STOP = 80_000;

export function createCreditMeter(path) {
  mkdirSync(dirname(path), { recursive: true });
  let used = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")).used : CREDITS_ALREADY_USED;
  return {
    get used() {
      return used;
    },
    allows: (rows) => used + rows * CREDITS_PER_ROW <= CREDIT_HARD_STOP,
    charge(rows) {
      used += rows * CREDITS_PER_ROW;
      writeJsonAtomic(path, { used });
    },
  };
}

const isRateLimited = (error) => /\b429\b/.test(`${error?.details ?? ""} ${error?.message ?? ""}`);

// keyMode: "never" reads keyless only; "fallback" reads keyless and retries a rate-limited
// call once with the key, metered; "always" uses the key for every call, metered.
export function createChain({ apiKey, meter, keyMode = apiKey ? "fallback" : "never", onKeyed = () => {} } = {}) {
  if (keyMode !== "never" && (!apiKey || !meter)) throw new Error("Keyed access needs an API key and a credit meter");
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

  const canUseKey = () => keyMode !== "never" && meter.allows(PAGE_SIZE);
  const metadata = (keyed) => {
    const m = new grpc.Metadata();
    if (keyed) m.set("x-api-key", apiKey);
    return m;
  };

  // Runs a call keyless (unless keyMode is "always"), and on a rate limit retries it once
  // with the key while the credit meter allows.
  async function withPolicy(call, label) {
    const keyFirst = keyMode === "always" && canUseKey();
    try {
      return await call(keyFirst);
    } catch (error) {
      if (keyFirst || keyMode !== "fallback" || !isRateLimited(error) || !canUseKey()) throw error;
      onKeyed(label, meter.used);
      return call(true);
    }
  }

  function tipWith(keyed) {
    return new Promise((resolve, reject) =>
      ledger.GetServiceInfo({}, metadata(keyed), { deadline: Date.now() + 30_000 }, (error, info) =>
        error
          ? reject(error)
          : resolve({
              checkpoint: Number(info.checkpoint_height),
              time: Number(info.timestamp?.seconds) * 1000,
            }),
      ),
    );
  }

  function pageWith({ fromCheckpoint, toCheckpoint, cursor }, keyed) {
      return new Promise((resolve, reject) => {
        const rows = [];
        let next = cursor;
        let reason;
        const stream = ledger.ListTransactions(
          {
            read_mask: { paths: ["digest", "checkpoint", "timestamp", "transaction.sender"] },
            start_checkpoint: String(fromCheckpoint),
            end_checkpoint: String(toCheckpoint),
            filter: { terms: [{ literals: [{ move_call: { function: FENCE_FUNCTION } }] }] },
            options: { limit: PAGE_SIZE, ...(cursor ? { after: Buffer.from(cursor, "base64") } : {}) },
          },
          metadata(keyed),
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
          if (frame.watermark?.cursor?.length) next = Buffer.from(frame.watermark.cursor).toString("base64");
          if (frame.end?.reason) reason = frame.end.reason;
        });
        stream.on("error", reject);
        stream.on("end", () => {
          if (keyed) meter.charge(rows.length);
          resolve({ rows, cursor: next, finished: reason !== "QUERY_END_REASON_ITEM_LIMIT" && reason !== "QUERY_END_REASON_SCAN_LIMIT" });
        });
      });
  }

  return {
    tip: () => withPolicy(tipWith, "tip"),
    // One page of fence calls, oldest first, from `fromCheckpoint` up to but excluding `toCheckpoint`.
    fencePage: (range) => withPolicy((keyed) => pageWith(range, keyed), "page"),
    close: () => ledger.close(),
  };
}
