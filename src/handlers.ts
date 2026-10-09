import { Bot, Context, InlineKeyboard, InputFile } from "grammy";
import { increment, reset } from "./counter.js";
import {
  advance,
  buildQuestion,
  canStart,
  checkAnswer,
  clearProgress,
  currentCard,
  decks,
  eligibleItems,
  finishSession,
  getKnown,
  getSession,
  isFinished,
  isTaskMode,
  matchPick,
  MatchState,
  matchTexts,
  Mode,
  nextRound,
  record,
  roundComplete,
  Session,
  setKnown,
  startSession,
} from "./flashcards.js";
import { decodeProgress, encodeProgress } from "./progress.js";

const MODE_LABELS: Record<Mode, string> = {
  cards: "Карточки",
  quiz: "Квиз: иероглиф → перевод",
  quizrev: "Квиз: перевод → иероглиф",
  tones: "Тоны: выбери пиньинь",
  match: "Матч-игра (найди пары)",
  listen: "На слух",
  tests: "Тесты",
  pairs: "Найди пары (задания)",
  cloze: "Заполни пропуск",
};
const MODE_ORDER: Mode[] = ["cards", "quiz", "quizrev", "tones", "match", "listen", "tests", "pairs", "cloze"];
const MODE_RE = "cards|quiz|quizrev|tones|listen|match|tests|pairs|cloze";
const EXPIRED = "Сессия истекла. Наберите /train, чтобы начать заново.";

// Адрес сайта мини-приложения: от него считаются пути к аудио заданий.
let audioBase: string | undefined;

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// audio задания: file_id голосового или путь audio/name.mp3 на сайте приложения.
async function sendAudio(ctx: Context, audio: string) {
  if (/^[A-Za-z0-9_-]+$/.test(audio)) {
    await ctx.replyWithVoice(audio);
    return;
  }
  if (!audioBase) {
    await ctx.reply("(К этому заданию есть аудио, но адрес мини-приложения не настроен.)");
    return;
  }
  await ctx.replyWithAudio(new InputFile(new URL(audio, audioBase)));
}

async function sendModePicker(ctx: Context, deckId: string) {
  const deck = decks.get(deckId);
  if (!deck) {
    await ctx.reply("Колода не найдена.");
    return;
  }
  const keyboard = new InlineKeyboard();
  for (const mode of MODE_ORDER) {
    if (canStart(deck, mode)) keyboard.text(MODE_LABELS[mode], `mode:${mode}:${deckId}`).row();
  }
  await ctx.reply(`Колода «${deck.name}». Выберите формат тренировки:`, {
    reply_markup: keyboard,
  });
}

async function sendLengthPicker(ctx: Context, deckId: string, mode: Mode) {
  const deck = decks.get(deckId);
  if (!deck || !canStart(deck, mode)) {
    await ctx.reply("Этот формат недоступен для колоды.");
    return;
  }
  const total = eligibleItems(deck, mode).length;
  const keyboard = new InlineKeyboard();
  for (const n of [10, 20]) {
    if (n < total) keyboard.text(String(n), `len:${n}:${mode}:${deckId}`);
  }
  keyboard.text(`Все (${total})`, `len:all:${mode}:${deckId}`);

  const known = ctx.from && !isTaskMode(mode) ? getKnown(ctx.from.id, deckId) : undefined;
  const note = known?.size
    ? `\nВыучено: ${known.size} из ${deck.cards.length}. Сначала пойдут новые слова.`
    : "";
  await ctx.reply(`Сколько ${isTaskMode(mode) ? "заданий" : "карточек"}?${note}`, { reply_markup: keyboard });
}

function matchLabel(session: Session, m: MatchState, side: "l" | "r", card: number): string {
  const t = matchTexts(session, card);
  const text = side === "l" ? t.left : t.right;
  if (m.done.has(card)) return `✅ ${text}`;
  if (m.picked?.side === side && m.picked.card === card) return `👉 ${text}`;
  return text;
}

function matchKeyboard(session: Session): InlineKeyboard {
  const m = session.match!;
  const keyboard = new InlineKeyboard();
  m.left.forEach((leftCard, i) => {
    keyboard
      .text(matchLabel(session, m, "l", leftCard), `ml:${i}`)
      .text(matchLabel(session, m, "r", m.right[i]), `mr:${i}`)
      .row();
  });
  keyboard.text("Закончить", "stop");
  return keyboard;
}

async function renderQuestion(ctx: Context, session: Session) {
  if (session.mode === "match" || session.mode === "pairs") {
    const m = session.match!;
    const what = session.mode === "match" ? "иероглиф ↔ перевод" : "соедините подходящие";
    await ctx.reply(`[Раунд ${m.round + 1}/${m.rounds.length}] Найдите пары: ${what}`, {
      reply_markup: matchKeyboard(session),
    });
    return;
  }

  const p = session.position;
  const progress = `[${p + 1}/${session.order.length}]`;

  if (session.mode === "cards") {
    const keyboard = new InlineKeyboard()
      .text("Показать ответ", `flip:${p}`)
      .row()
      .text("Закончить", "stop");
    await ctx.reply(`${progress} ${currentCard(session).hanzi}`, { reply_markup: keyboard });
    return;
  }

  const q = buildQuestion(session);
  const keyboard = new InlineKeyboard();
  q.labels.forEach((label, i) => keyboard.text(label, `answer:${p}:${i}`).row());
  keyboard.text("Закончить", "stop");
  if (q.voice) await sendAudio(ctx, q.voice);
  await ctx.reply(`${progress} ${q.prompt}`, { reply_markup: keyboard });
}

async function finish(ctx: Context, userId: number) {
  const res = finishSession(userId);
  if (!res) {
    await ctx.reply("Сейчас нет активной тренировки. Наберите /train.");
    return;
  }
  const { session, known, missedLines } = res;
  const deck = decks.get(session.deckId)!;
  const answered = session.right.size + session.missed.size;
  if (answered === 0) {
    await ctx.reply("Тренировка остановлена. Ответов не было, прогресс не изменился.");
    return;
  }

  const lines = ["Тренировка окончена.", `С первого раза: ${session.right.size} из ${answered}.`];
  if (session.match) lines.push(`Ошибок в матч-игре: ${session.match.mistakes}.`);
  if (missedLines.length > 0) {
    lines.push("", "Стоит повторить:");
    for (const line of missedLines.slice(0, 10)) lines.push(esc(line));
    if (missedLines.length > 10) lines.push(`…и ещё ${missedLines.length - 10}`);
  }
  if (known) {
    lines.push(
      "",
      `Выучено в колоде: ${known.size} из ${deck.cards.length}.`,
      "Код прогресса (нажмите, чтобы скопировать):",
      `<code>${esc(encodeProgress(deck, known))}</code>`,
      "Чтобы продолжить с этого места в другой раз, отправьте боту /code и этот код.",
      "Сам бот ничего не сохраняет: код хранится только у вас.",
    );
  }
  await ctx.reply(lines.join("\n"), { parse_mode: "HTML" });
}

async function afterAdvance(ctx: Context, userId: number, session: Session) {
  if (isFinished(session)) {
    await finish(ctx, userId);
    return;
  }
  await renderQuestion(ctx, session);
}

export function createBot(
  token: string,
  threshold: number,
  webAppUrl?: string,
  allowedChats?: Set<number>,
): Bot {
  const bot = new Bot(token);
  audioBase = webAppUrl;

  bot.catch((err) => {
    // Логируем только текст ошибки: контекст апдейта содержит id пользователя.
    console.error("Ошибка обработчика:", err.error instanceof Error ? err.error.message : String(err.error));
  });

  // Приветствие с кнопками. Главная кнопка красная (style: "danger"): так Telegram
  // позволяет выделить кнопку цветом, свой оттенок задать нельзя.
  const WELCOME =
    "Привет! Я помогаю запоминать китайские слова. 🇨🇳\n\n" +
    "Выберите действие кнопками ниже или командами из меню.";
  const welcomeKeyboard = () => {
    const rows: Record<string, unknown>[][] = [
      [{ text: "📚 Начать тренировку", callback_data: "menu:train", style: "danger" }],
      [{ text: "🔑 Код прогресса", callback_data: "menu:code" }],
    ];
    if (webAppUrl) rows.push([{ text: "📱 Открыть приложение", web_app: { url: webAppUrl } }]);
    rows.push([{ text: "⏹ Закончить занятие", callback_data: "menu:stop" }]);
    return { inline_keyboard: rows } as unknown as InlineKeyboard;
  };
  const sendWelcome = (ctx: Context) => ctx.reply(WELCOME, { reply_markup: welcomeKeyboard() });

  bot.command("start", sendWelcome);

  if (webAppUrl) {
    bot.command("app", (ctx) =>
      ctx.reply("Откройте тренажёр в приложении:", {
        reply_markup: new InlineKeyboard().webApp("Открыть тренажёр", webAppUrl),
      }),
    );
  }

  const sendTrain = async (ctx: Context) => {
    if (decks.size === 0) {
      await ctx.reply("Колоды не найдены — добавьте JSON-файлы в data/decks/.");
      return;
    }
    if (decks.size === 1) {
      await sendModePicker(ctx, decks.keys().next().value as string);
      return;
    }
    const keyboard = new InlineKeyboard();
    for (const deck of decks.values()) {
      keyboard.text(deck.name, `deck:${deck.id}`).row();
    }
    await ctx.reply("Выберите колоду:", { reply_markup: keyboard });
  };
  bot.command("train", sendTrain);

  bot.command("stop", async (ctx) => {
    if (ctx.from) await finish(ctx, ctx.from.id);
  });

  bot.command("code", async (ctx) => {
    if (!ctx.from) return;
    const arg = ctx.match.trim();
    if (!arg) {
      await ctx.reply(
        "Отправьте /code и код прогресса, который бот выдал в конце занятия, например:\n/code hsk1.ab12.…\n" +
          "Тогда выученные слова уйдут в конец очереди. /code сброс — забыть загруженный прогресс.",
      );
      return;
    }
    if (arg === "сброс" || arg === "reset") {
      clearProgress(ctx.from.id);
      await ctx.reply("Прогресс сброшен.");
      return;
    }
    const res = decodeProgress(arg);
    if (!res.ok) {
      await ctx.reply(res.reason);
      return;
    }
    setKnown(ctx.from.id, res.deck.id, res.known);
    await ctx.reply(
      `Загружено: выучено ${res.known.size} из ${res.deck.cards.length} в колоде «${res.deck.name}». ` +
        "Наберите /train — сначала пойдут новые слова.",
    );
  });

  bot.callbackQuery("menu:train", async (ctx) => {
    await ctx.answerCallbackQuery();
    await sendTrain(ctx);
  });
  bot.callbackQuery("menu:code", async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.reply(
      "Отправьте /code и код прогресса, который бот выдал в конце занятия, например:\n/code hsk1.ab12.…\n" +
        "Тогда выученные слова уйдут в конец очереди. /code сброс — забыть загруженный прогресс.",
    );
  });
  bot.callbackQuery("menu:stop", async (ctx) => {
    await ctx.answerCallbackQuery();
    await finish(ctx, ctx.from.id);
  });

  bot.callbackQuery(/^deck:(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    await sendModePicker(ctx, ctx.match[1]);
  });

  bot.callbackQuery(new RegExp(`^mode:(${MODE_RE}):(.+)$`), async (ctx) => {
    await ctx.answerCallbackQuery();
    await sendLengthPicker(ctx, ctx.match[2], ctx.match[1] as Mode);
  });

  bot.callbackQuery(new RegExp(`^len:(\\d+|all):(${MODE_RE}):(.+)$`), async (ctx) => {
    await ctx.answerCallbackQuery();
    const limit = ctx.match[1] === "all" ? null : Number(ctx.match[1]);
    const session = startSession(ctx.from.id, ctx.match[3], ctx.match[2] as Mode, limit);
    if (!session) {
      await ctx.reply("Не удалось начать: колода пуста или формат недоступен.");
      return;
    }
    await renderQuestion(ctx, session);
  });

  bot.callbackQuery(/^flip:(\d+)$/, async (ctx) => {
    const session = getSession(ctx.from.id);
    await ctx.answerCallbackQuery();
    if (!session) {
      await ctx.reply(EXPIRED);
      return;
    }
    const p = Number(ctx.match[1]);
    if (session.mode !== "cards" || p !== session.position) return;
    const card = currentCard(session);
    const keyboard = new InlineKeyboard()
      .text("✅ Знаю", `know:${p}`)
      .text("🔁 Повторить", `dunno:${p}`)
      .row()
      .text("Закончить", "stop");
    await ctx.reply(`${card.hanzi}\n${card.pinyin}\n${card.translation}`, { reply_markup: keyboard });
  });

  bot.callbackQuery(/^(know|dunno):(\d+)$/, async (ctx) => {
    const session = getSession(ctx.from.id);
    await ctx.answerCallbackQuery();
    if (!session) {
      await ctx.reply(EXPIRED);
      return;
    }
    if (session.mode !== "cards" || Number(ctx.match[2]) !== session.position) return;
    record(session, ctx.match[1] === "know");
    advance(session);
    await afterAdvance(ctx, ctx.from.id, session);
  });

  bot.callbackQuery(/^answer:(\d+):(\d+)$/, async (ctx) => {
    const session = getSession(ctx.from.id);
    await ctx.answerCallbackQuery();
    if (!session) {
      await ctx.reply(EXPIRED);
      return;
    }
    if (Number(ctx.match[1]) !== session.position) return;
    const result = checkAnswer(session, Number(ctx.match[2]));
    if (!result) return;

    const head = result.correct ? "✅ Верно!" : "❌ Неверно.";
    const keyboard = new InlineKeyboard()
      .text("Дальше", `next:${session.position}`)
      .row()
      .text("Закончить", "stop");
    await ctx.reply(`${head}\n${result.feedback}`, {
      reply_markup: keyboard,
    });
  });

  bot.callbackQuery(/^next:(\d+)$/, async (ctx) => {
    const session = getSession(ctx.from.id);
    await ctx.answerCallbackQuery();
    if (!session) {
      await ctx.reply(EXPIRED);
      return;
    }
    if (Number(ctx.match[1]) !== session.position || !session.answered) return;
    advance(session);
    await afterAdvance(ctx, ctx.from.id, session);
  });

  bot.callbackQuery("stop", async (ctx) => {
    await ctx.answerCallbackQuery();
    await finish(ctx, ctx.from.id);
  });

  bot.callbackQuery(/^m([lr]):(\d+)$/, async (ctx) => {
    const session = getSession(ctx.from.id);
    if (!session?.match) {
      await ctx.answerCallbackQuery();
      await ctx.reply(EXPIRED);
      return;
    }
    const m = session.match;
    const result = matchPick(session, ctx.match[1] as "l" | "r", Number(ctx.match[2]));
    if (result === "ignored") {
      await ctx.answerCallbackQuery();
      return;
    }
    await ctx.answerCallbackQuery(result === "wrong" ? { text: "Не пара, попробуйте ещё" } : undefined);

    if (roundComplete(session)) {
      await ctx.editMessageText(`Раунд ${m.round + 1}/${m.rounds.length} пройден ✅`);
      if (nextRound(session)) {
        await renderQuestion(ctx, session);
        return;
      }
      await finish(ctx, ctx.from.id);
      return;
    }
    await ctx.editMessageReplyMarkup({ reply_markup: matchKeyboard(session) });
  });

  bot.on("message", async (ctx) => {
    const msg = ctx.message;
    const topicId = msg.message_thread_id;

    // В личке любое не командное сообщение открывает приветствие с кнопками.
    if (ctx.chat.type === "private") {
      if (!msg.text?.startsWith("/") && !msg.from?.is_bot) await sendWelcome(ctx);
      return;
    }

    // Считаем только сообщения внутри тем форума (не общий чат/General),
    // и не команды (например /start), и не сообщения самого бота.
    // Темы бывают только в супергруппах; список чатов, если задан, ограничивает,
    // где бот вообще что-то считает и закрывает.
    if (ctx.chat.type !== "supergroup") return;
    if (allowedChats && !allowedChats.has(ctx.chat.id)) return;
    if (!topicId || !msg.is_topic_message) return;
    if (msg.text?.startsWith("/")) return;
    if (msg.from?.is_bot) return;

    const count = increment(ctx.chat.id, topicId);

    if (count >= threshold) {
      reset(ctx.chat.id, topicId);
      await ctx.api.closeForumTopic(ctx.chat.id, topicId);
      await ctx.reply(`Тема закрыта: набрано ${threshold} работ.`, {
        message_thread_id: topicId,
      });
    }
  });

  return bot;
}
