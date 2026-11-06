// Builds a static copy of the dashboard in site/ for GitHub Pages: the web files plus one
// snapshot of the state per source. Only the live record and the replay are published;
// the dry run was a local rehearsal.
import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { state } from "../src/state.mjs";

const PUBLISHED = ["live", "replay"];
const OUT = "site";

rmSync(OUT, { recursive: true, force: true });
mkdirSync(`${OUT}/state`, { recursive: true });
cpSync("web", OUT, { recursive: true });
writeFileSync(`${OUT}/.nojekyll`, "");

const first = state(null, PUBLISHED);
if (!first.source) throw new Error("Nothing to publish: no live record or replay found");
writeFileSync(`${OUT}/state/default.json`, JSON.stringify(first));
for (const source of first.sources) {
  writeFileSync(`${OUT}/state/${source}.json`, JSON.stringify(state(source, PUBLISHED)));
  console.log(`${source}: ${state(source, PUBLISHED).windows.length} windows`);
}
console.log(`Static site written to ${OUT}/ (default source: ${first.source})`);
