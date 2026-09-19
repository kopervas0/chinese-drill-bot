import "dotenv/config";
import { Bot, Context, InlineKeyboard } from "grammy";
import { increment, reset } from "./counter.js";
import {
  advance,
  buildOptions,
  canListen,
  canQuiz,
  cardAt,
  currentCard,
  decks,
  endSession,
  getSession,
  Mode,
  Session,
  startSession,
  totalCards,
} from "./flashcards.js";

const token = process.env.BOT_TOKEN;
if (!token) throw new Error("BOT_TOKEN не задан в .env");

const threshold = Number(process.env.TOPIC_WORK_THRESHOLD ?? "");
if (!threshold || threshold <= 0) {
  throw new Error("TOPIC_WORK_THRESHOLD не задан или некорректен в .env");
}

const bot = new Bot(token);

bot.command("start", (ctx) =>
  ctx.reply(
    "Привет! Я помогаю запоминать китайские слова. 🇨🇳\n\n" +
      "/train — начать тренировку (карточки, квиз или на слух)\n" +
      "/stop — остановить занятие\n\n" +
      "Удачи в учёбе!"
  )
);

async function sendModePicker(ctx: Context, deckId: string) {
  const deck = decks.get(deckId);
  if (!deck) {
    await ctx.reply("Колода не найдена.");
    return;
  }
  const keyboard = new InlineKeyboard().text("Карточки", `mode:cards:${deckId}`).row();
  if (canQuiz(deck)) {
    keyboard.text("Квиз (варианты)", `mode:quiz:${deckId}`).row();
  }
  if (canListen(deck)) {
    keyboard.text("На слух", `mode:listen:${deckId}`).row();
  }
  await ctx.reply(`Колода «${deck.name}». Выберите формат тренировки:`, {
    reply_markup: keyboard,
  });
}

async function beginTraining(ctx: Context, userId: number, deckId: string, mode: Mode) {
  const session = startSession(userId, deckId, mode);
  if (!session) {
    await ctx.reply("Эта колода пуста.");
    return;
  }
  await renderQuestion(ctx, session);
}

async function renderQuestion(ctx: Context, session: Session) {
  const card = currentCard(session);
  const progress = `[${session.position + 1}/${totalCards(session)}]`;

  if (session.mode === "cards") {
    const keyboard = new InlineKeyboard()
      .text("Показать ответ", "flip")
      .row()
      .text("Закончить", "stop");
    await ctx.reply(`${progress} ${card.hanzi}`, { reply_markup: keyboard });
    return;
  }

  const options = buildOptions(session);
  const keyboard = new InlineKeyboard();
  options.forEach((cardIndex, pos) => {
    keyboard.text(cardAt(session, cardIndex).translation, `answer:${pos}`).row();
  });
  keyboard.text("Закончить", "stop");

  if (session.mode === "listen") {
    if (card.audio) {
      await ctx.replyWithVoice(card.audio);
    }
    await ctx.reply(`${progress} Что вы услышали? Выберите перевод:`, {
      reply_markup: keyboard,
    });
  } else {
    await ctx.reply(`${progress} ${card.hanzi} (${card.pinyin})\nВыберите перевод:`, {
      reply_markup: keyboard,
    });
  }
}

bot.command("train", async (ctx) => {
  if (decks.size === 0) {
    await ctx.reply("Колоды не найдены — добавьте JSON-файлы в data/decks/.");
    return;
  }
  if (decks.size === 1) {
    const deckId = decks.keys().next().value as string;
    await sendModePicker(ctx, deckId);
    return;
  }
  const keyboard = new InlineKeyboard();
  for (const deck of decks.values()) {
    keyboard.text(deck.name, `deck:${deck.id}`).row();
  }
  await ctx.reply("Выберите колоду:", { reply_markup: keyboard });
});

bot.command("stop", async (ctx) => {
  endSession(ctx.from!.id);
  await ctx.reply("Тренировка остановлена (если была активна).");
});

bot.callbackQuery(/^deck:(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  await sendModePicker(ctx, ctx.match[1]);
});

bot.callbackQuery(/^mode:(cards|quiz|listen):(.+)$/, async (ctx) => {
  const mode = ctx.match[1] as Mode;
  const deckId = ctx.match[2];
  await ctx.answerCallbackQuery();
  await beginTraining(ctx, ctx.from.id, deckId, mode);
});

bot.callbackQuery("flip", async (ctx) => {
  const session = getSession(ctx.from.id);
  await ctx.answerCallbackQuery();
  if (!session) {
    await ctx.reply("Сессия истекла. Наберите /train, чтобы начать заново.");
    return;
  }
  const card = currentCard(session);
  const keyboard = new InlineKeyboard().text("Дальше", "next").row().text("Закончить", "stop");
  await ctx.reply(`${card.hanzi}\n${card.pinyin}\n${card.translation}`, {
    reply_markup: keyboard,
  });
});

bot.callbackQuery(/^answer:(\d+)$/, async (ctx) => {
  const session = getSession(ctx.from.id);
  const pos = Number(ctx.match[1]);
  await ctx.answerCallbackQuery();
  if (!session || !session.options) {
    await ctx.reply("Сессия истекла. Наберите /train, чтобы начать заново.");
    return;
  }
  const chosenIndex = session.options[pos];
  const correctIndex = session.order[session.position];
  const correctCard = cardAt(session, correctIndex);
  const correct = chosenIndex === correctIndex;
  if (correct) session.score += 1;

  const feedback = correct
    ? "✅ Верно!"
    : `❌ Неверно. Правильный ответ: ${correctCard.translation}`;
  const keyboard = new InlineKeyboard().text("Дальше", "next").row().text("Закончить", "stop");
  await ctx.reply(feedback, { reply_markup: keyboard });
});

bot.callbackQuery("next", async (ctx) => {
  const userId = ctx.from.id;
  const session = advance(userId);
  await ctx.answerCallbackQuery();
  if (!session) {
    await ctx.reply("Сессия истекла. Наберите /train, чтобы начать заново.");
    return;
  }
  if (session.position >= totalCards(session)) {
    const total = totalCards(session);
    const score = session.score;
    const mode = session.mode;
    endSession(userId);
    const summary =
      mode === "cards" ? `Тренировка окончена: ${total} карточек.` : `Тренировка окончена: ${score}/${total} правильных ответов.`;
    await ctx.reply(`${summary} Наберите /train, чтобы повторить.`);
    return;
  }
  await renderQuestion(ctx, session);
});

bot.callbackQuery("stop", async (ctx) => {
  endSession(ctx.from.id);
  await ctx.answerCallbackQuery();
  await ctx.reply("Тренировка остановлена. Наберите /train, чтобы начать заново.");
});

bot.on("message", async (ctx) => {
  const msg = ctx.message;
  const topicId = msg.message_thread_id;

  // Считаем только сообщения внутри тем форума (не общий чат/General),
  // и не команды (например /start), и не сообщения самого бота.
  if (!topicId || !msg.is_topic_message) return;
  if (msg.text?.startsWith("/")) return;
  if (msg.from?.is_bot) return;

  const count = increment(topicId);

  if (count >= threshold) {
    reset(topicId);
    await ctx.api.closeForumTopic(ctx.chat.id, topicId);
    await ctx.reply(`Тема закрыта: набрано ${threshold} работ.`, {
      message_thread_id: topicId,
    });
  }
});

bot.start();
console.log("Бот запущен в режиме polling");
