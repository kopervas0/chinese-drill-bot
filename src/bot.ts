import "dotenv/config";
import { createBot } from "./handlers.js";

const token = process.env.BOT_TOKEN;
if (!token) throw new Error("BOT_TOKEN не задан в .env");

const threshold = Number(process.env.TOPIC_WORK_THRESHOLD ?? "");
if (!threshold || threshold <= 0) {
  throw new Error("TOPIC_WORK_THRESHOLD не задан или некорректен в .env");
}

const bot = createBot(token, threshold);

bot.start();
console.log("Бот запущен в режиме polling");
