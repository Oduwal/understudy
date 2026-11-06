// Read-only local server for the dashboard. Binds to this machine only.
import { existsSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, resolve, sep } from "node:path";
import { state } from "./state.mjs";

const PORT = Number(process.env.PORT ?? 4173);
const WEB_ROOT = resolve("web");
const TYPES = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".svg": "image/svg+xml" };

function send(response, status, type, body) {
  response.writeHead(status, { "content-type": type, "cache-control": "no-store" });
  response.end(body);
}

// Only regular files inside web/ are served, checked on the fully resolved path.
function webFile(pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname === "/" ? "/index.html" : pathname);
  } catch {
    return null;
  }
  const file = resolve(WEB_ROOT, `.${decoded}`);
  if (!file.startsWith(WEB_ROOT + sep) || !existsSync(file) || !statSync(file).isFile()) return null;
  return file;
}

createServer((request, response) => {
  const url = new URL(request.url, "http://localhost");
  try {
    if (url.pathname === "/api/state") {
      return send(response, 200, "application/json", JSON.stringify(state(url.searchParams.get("source"))));
    }
    const file = webFile(url.pathname);
    if (!file) return send(response, 404, "text/plain", "Not found");
    return send(response, 200, TYPES[extname(file)] ?? "application/octet-stream", readFileSync(file));
  } catch (error) {
    console.error(error);
    return send(response, 500, "text/plain", "Something went wrong reading the agent's record.");
  }
}).listen(PORT, "127.0.0.1", () => console.log(`Understudy dashboard: http://127.0.0.1:${PORT}`));
