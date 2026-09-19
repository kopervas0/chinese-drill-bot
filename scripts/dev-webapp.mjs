// Локальный сервер для мини-приложения: собирает колоды и отдаёт webapp/ по HTTP.
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";

const root = join(import.meta.dirname, "..");
const dir = join(root, "webapp");
const port = Number(process.env.PORT ?? 5173);

execFileSync(process.execPath, [join(root, "scripts", "build-webapp.mjs")], { stdio: "inherit" });

const types = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};

createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const rel = normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, "");
  const file = join(dir, rel === "" ? "index.html" : rel);
  if (!file.startsWith(dir)) {
    res.writeHead(403).end();
    return;
  }
  try {
    const body = await readFile(file);
    res.writeHead(200, { "Content-Type": types[extname(file)] ?? "application/octet-stream", "Cache-Control": "no-store" });
    res.end(body);
  } catch {
    res.writeHead(404).end("Not found");
  }
}).listen(port, () => console.log(`Мини-приложение: http://localhost:${port}`));
