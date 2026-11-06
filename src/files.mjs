// State files are replaced in one step, so a crash mid-write can't leave half a JSON file.
import { renameSync, writeFileSync } from "node:fs";

export function writeJsonAtomic(path, value) {
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(value));
  renameSync(temporary, path);
}
