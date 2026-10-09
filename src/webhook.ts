import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, Server } from "node:http";
import { Bot, webhookCallback } from "grammy";

const MAX_BODY_BYTES = 1_000_000;
export const WEBHOOK_PATH = "/telegram";

// Telegram допускает в secret_token только A-Z a-z 0-9 _ -, поэтому из
// произвольной строки (например, сгенерированной хостингом) берём хэш.
export function deriveSecretToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

function safeEqual(a: string | undefined, b: string): boolean {
  if (a === undefined) return false;
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

// HTTP-сервер для вебхука. Секрет и размер тела проверяются до разбора запроса.
export function createWebhookServer(bot: Bot, secretToken: string): Server {
  const handle = webhookCallback(bot, "http", { secretToken });

  return createServer((req, res) => {
    if (req.method === "GET" && (req.url === "/" || req.url === "/healthz")) {
      res.writeHead(200, { "Content-Type": "text/plain" }).end("ok");
      return;
    }
    if (req.method === "POST" && req.url === WEBHOOK_PATH) {
      if (!safeEqual(req.headers["x-telegram-bot-api-secret-token"] as string | undefined, secretToken)) {
        res.writeHead(401).end();
        return;
      }
      if (Number(req.headers["content-length"] ?? 0) > MAX_BODY_BYTES) {
        res.writeHead(413).end();
        return;
      }
      handle(req, res).catch((err: unknown) => {
        // без контекста запроса: в нём есть id пользователя
        console.error("Ошибка вебхука:", err instanceof Error ? err.message : String(err));
        if (!res.headersSent) res.writeHead(500).end();
      });
      return;
    }
    res.writeHead(404).end();
  });
}
