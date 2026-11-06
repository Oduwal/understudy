// Read-only local server for the dashboard.
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";
import { state } from "./state.mjs";

const PORT = Number(process.env.PORT ?? 4173);
const WEB = "web";
const TYPES = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".svg": "image/svg+xml" };

function json(response, body) {
  response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
  response.end(JSON.stringify(body));
}

createServer((request, response) => {
  const url = new URL(request.url, "http://localhost");
  try {
    if (url.pathname === "/api/state") return json(response, state(url.searchParams.get("source")));
    const relative = normalize(url.pathname === "/" ? "index.html" : url.pathname.slice(1));
    const file = join(WEB, relative);
    if (relative.startsWith("..") || !existsSync(file)) {
      response.writeHead(404).end("Not found");
      return undefined;
    }
    response.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" });
    response.end(readFileSync(file));
  } catch (error) {
    response.writeHead(500, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: error.message }));
  }
  return undefined;
}).listen(PORT, "127.0.0.1", () => console.log(`Understudy dashboard: http://127.0.0.1:${PORT}`));
