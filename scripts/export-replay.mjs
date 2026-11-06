// Writes the replay's dashboard state to public-data/replay.json, which is committed so the
// hosted dashboard can show it without the local history files.
import { mkdirSync, writeFileSync } from "node:fs";
import { state } from "../src/state.mjs";

const { windows, lessons, alerts, writes, score } = state("replay", ["replay"]);
if (!windows?.length) throw new Error("No replay found: run npm run backtest first");
mkdirSync("public-data", { recursive: true });
writeFileSync("public-data/replay.json", JSON.stringify({ windows, lessons, alerts, writes, score }));
console.log(`public-data/replay.json: ${windows.length} windows`);
