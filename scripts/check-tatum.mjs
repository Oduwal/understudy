// Read-only check of Tatum's Sui gateways. Prints results, never the key.
// Usage: npm run check:tatum -- [sender address]
import grpc from "@grpc/grpc-js";
import protoLoader from "@grpc/proto-loader";

const KEY = process.env.TATUM_API_KEY ?? "";
const HOST = "sui-mainnet-grpc.gateway.tatum.io:443";
const JSON_RPC = "https://sui-mainnet.gateway.tatum.io";
const ROOT = ".tools/sui-apis/proto";
const V2 = "sui/rpc/v2";

const definition = protoLoader.loadSync(
  [`${V2}/ledger_service.proto`, `${V2}/subscription_service.proto`],
  { keepCase: true, longs: String, enums: String, defaults: false, oneofs: true, includeDirs: [ROOT] },
);
const { sui } = grpc.loadPackageDefinition(definition);
const credentials = grpc.credentials.createSsl();
const ledger = new sui.rpc.v2.LedgerService(HOST, credentials);
const subscriptions = new sui.rpc.v2.SubscriptionService(HOST, credentials);

const metadata = () => {
  const m = new grpc.Metadata();
  if (KEY) m.set("x-api-key", KEY);
  return m;
};
const deadline = (seconds) => ({ deadline: Date.now() + seconds * 1000 });
const describe = (error) => `${grpc.status[error.code] ?? error.code}: ${error.details ?? error.message}`;

function serviceInfo() {
  return new Promise((resolve, reject) =>
    ledger.GetServiceInfo({}, metadata(), deadline(20), (error, info) => (error ? reject(error) : resolve(info))),
  );
}

// ListTransactions is a server stream: one frame per transaction, then an end frame.
function listBySender(address, limit = 5) {
  return new Promise((resolve, reject) => {
    const found = [];
    const stream = ledger.ListTransactions(
      {
        read_mask: { paths: ["digest", "checkpoint", "timestamp", "transaction.sender"] },
        filter: { terms: [{ literals: [{ sender: { address } }] }] },
        options: { limit, ordering: "ORDERING_DESCENDING" },
      },
      metadata(),
      deadline(30),
    );
    stream.on("data", (frame) => frame.transaction && found.push(frame.transaction));
    stream.on("error", reject);
    stream.on("end", () => resolve(found));
  });
}

// Reads the checkpoint stream briefly, then cancels it.
function sampleCheckpoints(seconds = 10) {
  return new Promise((resolve, reject) => {
    let frames = 0;
    let last;
    const stream = subscriptions.SubscribeCheckpoints(
      { read_mask: { paths: ["sequence_number"] } },
      metadata(),
    );
    const stop = setTimeout(() => stream.cancel(), seconds * 1000);
    stream.on("data", (frame) => {
      frames += 1;
      last = frame.cursor;
    });
    stream.on("error", (error) => {
      clearTimeout(stop);
      if (error.code === grpc.status.CANCELLED) resolve({ frames, last, seconds });
      else reject(error);
    });
    stream.on("end", () => {
      clearTimeout(stop);
      resolve({ frames, last, seconds });
    });
  });
}

async function jsonRpc() {
  const response = await fetch(JSON_RPC, {
    method: "POST",
    headers: { "content-type": "application/json", ...(KEY ? { "x-api-key": KEY } : {}) },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "sui_getChainIdentifier", params: [] }),
  });
  return `HTTP ${response.status}: ${(await response.text()).slice(0, 160)}`;
}

async function step(name, run) {
  try {
    console.log(`PASS ${name}:`, await run());
    return true;
  } catch (error) {
    console.log(`FAIL ${name}:`, error.code === undefined ? error.message : describe(error));
    return false;
  }
}

console.log(`API key: ${KEY ? "present" : "MISSING, calls run without one"}`);
const results = [await step("gRPC GetServiceInfo", serviceInfo)];

const address = process.argv[2];
if (address) {
  results.push(
    await step(`gRPC ListTransactions by sender ${address}`, async () => {
      const list = await listBySender(address);
      return list.map((t) => ({ digest: t.digest, checkpoint: t.checkpoint, sender: t.transaction?.sender }));
    }),
  );
} else {
  console.log("SKIP gRPC ListTransactions by sender: pass an address to test it");
}
results.push(await step("gRPC SubscribeCheckpoints", sampleCheckpoints));
// The app doesn't depend on JSON-RPC, so this only reports what the gateway returns.
console.log("INFO JSON-RPC sui_getChainIdentifier:", await jsonRpc().catch((error) => error.message));

ledger.close();
subscriptions.close();
process.exitCode = results.every(Boolean) ? 0 : 1;
