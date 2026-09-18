import "dotenv/config";
import { Bot } from "grammy";

const token = process.env.BOT_TOKEN;
if (!token) throw new Error("BOT_TOKEN не задан в .env");

const bot = new Bot(token);

bot.command("start", (ctx) => ctx.reply("Бот на связи."));

bot.start();
console.log("Бот запущен в режиме polling");
