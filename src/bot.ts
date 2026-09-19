import "dotenv/config";
import { createBot } from "./handlers.js";

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

bot.start();
console.log("Бот запущен в режиме polling");
