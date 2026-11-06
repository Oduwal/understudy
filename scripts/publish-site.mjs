// Rebuilds the static dashboard and force-pushes it to the gh-pages branch, which only ever
// holds the latest snapshot. Never touches main.
import { execFileSync } from "node:child_process";

const REPO = "https://github.com/Oduwal/understudy.git";
const run = (cmd, args, cwd = ".") => execFileSync(cmd, args, { cwd, stdio: ["ignore", "pipe", "pipe"] }).toString().trim();

run(process.execPath, ["scripts/export-site.mjs"]);
const stamp = new Date().toISOString().slice(0, 16).replace("T", " ");
const name = run("git", ["config", "user.name"]);
const email = run("git", ["config", "user.email"]);
run("git", ["init", "-q", "-b", "gh-pages"], "site");
run("git", ["-c", `user.name=${name}`, "-c", `user.email=${email}`, "add", "-A"], "site");
run("git", ["-c", `user.name=${name}`, "-c", `user.email=${email}`, "-c", "core.autocrlf=false", "commit", "-q", "-m", `Dashboard snapshot ${stamp} UTC`], "site");
run("git", ["push", "-q", "-f", REPO, "gh-pages"], "site");
console.log(`${stamp} UTC published dashboard snapshot to gh-pages`);
