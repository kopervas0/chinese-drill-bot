import "dotenv/config";
import { refreshDecksFromSite } from "./flashcards.js";
import { createBot } from "./handlers.js";
import { createWebhookServer, deriveSecretToken, WEBHOOK_PATH } from "./webhook.js";

const token = process.env.BOT_TOKEN;
if (!token) throw new Error("BOT_TOKEN не задан в .env");

const threshold = Number(process.env.TOPIC_WORK_THRESHOLD ?? "");
if (!threshold || threshold <= 0) {
  throw new Error("TOPIC_WORK_THRESHOLD не задан или некорректен в .env");
}

// Адрес мини-приложения (обязательно https). Не задан — бот работает без него.
const webAppUrl = process.env.WEBAPP_URL?.trim() || undefined;
if (webAppUrl && !webAppUrl.startsWith("https://")) {
  throw new Error("WEBAPP_URL должен начинаться с https://");
}

// Чаты, где работает счётчик тем (id групп через запятую). Не задан — во всех.
// Это id чатов, а не пользователей.
const allowedRaw = process.env.ALLOWED_CHAT_IDS?.trim();
let allowedChats: Set<number> | undefined;
if (allowedRaw) {
  const ids = allowedRaw.split(",").map((s) => Number(s.trim()));
  if (ids.some((n) => !Number.isSafeInteger(n) || n >= 0)) {
    throw new Error("ALLOWED_CHAT_IDS: ожидаются id групп (отрицательные числа) через запятую");
  }
  allowedChats = new Set(ids);
}

const bot = createBot(token, threshold, webAppUrl, allowedChats);

if (webAppUrl) {
  bot.api
    .setChatMenuButton({
      menu_button: { type: "web_app", text: "Тренажёр", web_app: { url: webAppUrl } },
    })
    .catch((err: unknown) =>
      console.error("Не удалось выставить кнопку меню:", err instanceof Error ? err.message : String(err)),
    );
}

// Режим вебхука нужен для хостингов, которые «засыпают» без входящих запросов:
// Telegram сам стучится на адрес бота и будит его. Включается, если задан
// WEBHOOK_URL (или RENDER_EXTERNAL_URL, его выставляет Render). Иначе — polling.
const webhookBase = (process.env.WEBHOOK_URL?.trim() || process.env.RENDER_EXTERNAL_URL?.trim() || "").replace(
  /\/+$/,
  "",
);

if (webhookBase) {
  if (!webhookBase.startsWith("https://")) throw new Error("WEBHOOK_URL должен начинаться с https://");
  const secret = process.env.WEBHOOK_SECRET?.trim();
  if (!secret || secret.length < 16) throw new Error("WEBHOOK_SECRET не задан или короче 16 символов");
  const secretToken = deriveSecretToken(secret);

  const server = createWebhookServer(bot, secretToken);
  const port = Number(process.env.PORT ?? 8080);
  await bot.init();
  await new Promise<void>((resolve) => server.listen(port, "0.0.0.0", resolve));
  await bot.api.setWebhook(`${webhookBase}${WEBHOOK_PATH}`, {
    secret_token: secretToken,
    allowed_updates: ["message", "callback_query"],
  });
  process.on("SIGTERM", () => {
    server.close();
    process.exit(0);
  });
  console.log("Бот запущен в режиме вебхука");
} else {
  bot.start();
  console.log("Бот запущен в режиме polling");
}

// Свежие колоды с сайта (бот пересобирается только при изменении кода); не блокирует запуск.
if (webAppUrl) void refreshDecksFromSite(webAppUrl);
