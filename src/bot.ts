import "dotenv/config";
import { refreshDecksFromSite } from "./flashcards.js";
import { createBot } from "./handlers.js";
import { createWebhookServer, deriveSecretToken, WEBHOOK_PATH } from "./webhook.js";

const token = process.env.BOT_TOKEN;
if (!token) throw new Error("BOT_TOKEN не задан в .env");

// Адрес мини-приложения (обязательно https). Не задан — бот работает без него.
const webAppUrl = process.env.WEBAPP_URL?.trim() || undefined;
if (webAppUrl && !webAppUrl.startsWith("https://")) {
  throw new Error("WEBAPP_URL должен начинаться с https://");
}

const bot = createBot(token, webAppUrl);

// Меню команд (кнопка «Меню» рядом с полем ввода) и описание бота.
const report = (what: string) => (err: unknown) =>
  console.error(`${what}:`, err instanceof Error ? err.message : String(err));
bot.api
  .setMyCommands([
    { command: "start", description: "Главное меню" },
    { command: "train", description: "Начать тренировку" },
    { command: "code", description: "Продолжить по коду прогресса" },
    ...(webAppUrl ? [{ command: "app", description: "Открыть тренажёр в приложении" }] : []),
    { command: "stop", description: "Закончить занятие" },
  ])
  .catch(report("Не удалось выставить команды"));
bot.api
  .setMyShortDescription("Тренажёр китайских слов: карточки, квизы, тоны, письмо. HSK 3.0.")
  .catch(report("Не удалось выставить краткое описание"));
bot.api
  .setMyDescription(
    "Помогаю запоминать китайские слова по программе HSK 3.0: карточки, квизы, тоны, пары, аудирование и письмо. " +
      "Ничего не собираю: прогресс хранится у вас, а продолжить можно по коду.",
  )
  .catch(report("Не удалось выставить описание"));

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
