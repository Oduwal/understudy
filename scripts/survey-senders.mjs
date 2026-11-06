// Read-only survey of recent Mainnet activity, used to choose a wallet to shadow.
// Usage: npm run survey -- [checkpoints back, default 300]
import grpc from "@grpc/grpc-js";
import protoLoader from "@grpc/proto-loader";

const HOST = "sui-mainnet-grpc.gateway.tatum.io:443";
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
// Keyless on purpose: a full page costs 1,000 credits with a key.
const metadata = new grpc.Metadata();

const info = await new Promise((resolve, reject) =>
  ledger.GetServiceInfo({}, metadata, (error, value) => (error ? reject(error) : resolve(value))),
);
const span = Number(process.argv[2] ?? 300);
const tip = Number(info.checkpoint_height);

const transactions = await new Promise((resolve, reject) => {
  const found = [];
  const stream = ledger.ListTransactions(
    {
      read_mask: { paths: ["digest", "checkpoint", "timestamp", "transaction.sender", "transaction.kind"] },
      start_checkpoint: String(tip - span),
      end_checkpoint: String(tip),
      options: { limit: 5000, ordering: "ORDERING_DESCENDING" },
    },
    metadata,
    { deadline: Date.now() + 60_000 },
  );
  stream.on("data", (frame) => frame.transaction && found.push(frame.transaction));
  stream.on("error", reject);
  stream.on("end", () => resolve(found));
});

const senders = new Map();
for (const t of transactions) {
  const sender = t.transaction?.sender;
  if (!sender || /^0x0+$/.test(sender)) continue;
  const entry = senders.get(sender) ?? { count: 0, calls: new Map() };
  entry.count += 1;
  const commands = t.transaction?.kind?.programmable_transaction?.commands ?? [];
  for (const command of commands) {
    const call = command.move_call;
    if (!call) continue;
    const name = `${call.package?.slice(0, 10)}…::${call.module}::${call.function}`;
    entry.calls.set(name, (entry.calls.get(name) ?? 0) + 1);
  }
  senders.set(sender, entry);
}

const ranked = [...senders].sort((a, b) => b[1].count - a[1].count).slice(0, 12);
console.log(`Checkpoints ${tip - span} to ${tip}: ${transactions.length} transactions, ${senders.size} senders`);
for (const [address, { count, calls }] of ranked) {
  const top = [...calls].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([n, c]) => `${n} x${c}`);
  console.log(`${String(count).padStart(5)}  ${address}\n       ${top.join("  ") || "no Move calls"}`);
}
ledger.close();
