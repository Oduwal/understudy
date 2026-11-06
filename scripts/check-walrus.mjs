// Read-only check of the Walrus Memory account and mainnet relayer. Writes nothing.
import { MemWal } from "@mysten-incubation/memwal";

const RELAYER = "https://relayer.memory.walrus.xyz";
const { MEMWAL_KEY: key, MEMWAL_ACCOUNT_ID: accountId } = process.env;

const config = await (await fetch(`${RELAYER}/config`)).json();
console.log(`Relayer network: ${config.network}, package: ${config.packageId}`);

if (!key || !accountId) {
  console.log("MEMWAL_KEY or MEMWAL_ACCOUNT_ID is missing, so the account checks were skipped.");
  process.exitCode = 1;
} else {
  const memwal = MemWal.create({ key, accountId, serverUrl: RELAYER, namespace: "understudy" });
  const health = await memwal.health();
  console.log(`Relayer status: ${health.status}, writes: ${health.writes}`);
  console.log(`MEMWAL_AGENT_ID for the form (public key): ${await memwal.getPublicKeyHex()}`);
  const { memories } = await memwal.listMemories({ limit: 5 });
  console.log(`Signed request accepted. Memories on this page: ${memories.length}`);
  const { namespaces } = await memwal.listNamespaces();
  console.log(`Namespaces: ${JSON.stringify(namespaces)}`);
}
