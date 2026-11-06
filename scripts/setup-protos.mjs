// Fetches Sui's gRPC definitions at a pinned commit into .tools/sui-apis.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";

const COMMIT = "79485a8328e2f58fa047e4ce1327704b412e958a";
const DIR = ".tools/sui-apis";
const git = (...args) => execFileSync("git", args, { stdio: "inherit" });

if (!existsSync(DIR)) git("clone", "--quiet", "https://github.com/MystenLabs/sui-apis.git", DIR);
else git("-C", DIR, "fetch", "--quiet", "origin", COMMIT);
git("-C", DIR, "checkout", "--quiet", COMMIT);
console.log(`sui-apis at ${COMMIT}`);
