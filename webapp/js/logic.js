// Чистая логика мини-приложения (без DOM): выбор карточек, вопросы, тоны,
// матч-игра и код прогресса. Формат кода совместим с ботом (src/progress.ts).

export const MODES = {
  cards: { label: "Карточки", hint: "Переверните и оцените себя", glyph: "卡" },
  quiz: { label: "Квиз", hint: "Иероглиф → перевод", glyph: "问" },
  quizrev: { label: "Обратный квиз", hint: "Перевод → иероглиф", glyph: "反" },
  tones: { label: "Тоны", hint: "Выберите верный пиньинь", glyph: "声" },
  match: { label: "Найди пары", hint: "Иероглиф ↔ перевод", glyph: "配" },
  listen: { label: "На слух", hint: "Услышьте и выберите перевод", glyph: "听" },
  tests: { label: "Тесты", hint: "Вопросы с вариантами ответа", glyph: "测" },
  pairs: { label: "Свои пары", hint: "Соедините подходящие", glyph: "对" },
  cloze: { label: "Заполни пропуск", hint: "Выберите пропущенное слово", glyph: "填" },
};
export const MODE_ORDER = ["cards", "quiz", "quizrev", "tones", "match", "listen", "tests", "pairs", "cloze"];

// Свои задания учителя: прогресс «выучено» по ним не ведётся.
export const isTaskMode = (mode) => mode === "tests" || mode === "pairs" || mode === "cloze";

const MAX_OPTIONS = 4;
const MATCH_PAIRS = 5;
const MAX_REQUEUES = 2;

export function shuffle(items) {
  const arr = [...items];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// ---------- пиньинь и тоны ----------

const TONE_MARKS = {
  a: ["ā", "á", "ǎ", "à"],
  e: ["ē", "é", "ě", "è"],
  i: ["ī", "í", "ǐ", "ì"],
  o: ["ō", "ó", "ǒ", "ò"],
  u: ["ū", "ú", "ǔ", "ù"],
  ü: ["ǖ", "ǘ", "ǚ", "ǜ"],
};
const MARKED = new Map();
for (const [base, marks] of Object.entries(TONE_MARKS)) {
  marks.forEach((ch, tone) => MARKED.set(ch, { base, tone }));
}

export function hasTones(pinyin) {
  return [...pinyin].some((ch) => MARKED.has(ch));
}

export function toneVariants(pinyin, count) {
  const chars = [...pinyin];
  const marked = chars.flatMap((ch, i) => (MARKED.has(ch) ? [i] : []));
  if (marked.length === 0) return [];

  if (marked.length === 1) {
    const i = marked[0];
    const { base, tone } = MARKED.get(chars[i]);
    return shuffle([0, 1, 2, 3].filter((t) => t !== tone))
      .slice(0, count)
      .map((t) => {
        const copy = [...chars];
        copy[i] = TONE_MARKS[base][t];
        return copy.join("");
      });
  }

  const seen = new Set([pinyin]);
  const result = [];
  for (let attempt = 0; attempt < 60 && result.length < count; attempt++) {
    const copy = [...chars];
    const changes = Math.random() < 0.4 ? 2 : 1;
    for (const i of shuffle(marked).slice(0, changes)) {
      const { base, tone } = MARKED.get(copy[i]);
      let next;
      do {
        next = Math.floor(Math.random() * 4);
      } while (next === tone);
      copy[i] = TONE_MARKS[base][next];
    }
    const variant = copy.join("");
    if (!seen.has(variant)) {
      seen.add(variant);
      result.push(variant);
    }
  }
  return result;
}

const V = "aeiouüāáǎàēéěèīíǐìōóǒòūúǔùǖǘǚǜ";
const SYLLABLE = new RegExp(
  `[^${V}\\s']*[${V}]+(?:ng(?![${V}])|n(?![${V}])|r(?![${V}]))?|[^${V}\\s']+`,
  "gi",
);

function toneOfSyllable(text) {
  let tone = 0;
  for (const ch of text) {
    const m = MARKED.get(ch);
    if (m) tone = m.tone + 1;
  }
  return tone;
}

// Слоги пиньиня с тоном каждого (0 — нейтральный).
export function syllables(pinyin) {
  return (pinyin.match(SYLLABLE) ?? []).map((text) => ({ text, tone: toneOfSyllable(text) }));
}

// То же, но с сохранением пробелов и апострофов между слогами (tone: null).
export function pinyinTokens(pinyin) {
  const out = [];
  let last = 0;
  for (const m of pinyin.matchAll(SYLLABLE)) {
    if (m.index > last) out.push({ text: pinyin.slice(last, m.index), tone: null });
    out.push({ text: m[0], tone: toneOfSyllable(m[0]) });
    last = m.index + m[0].length;
  }
  if (last < pinyin.length) out.push({ text: pinyin.slice(last), tone: null });
  return out;
}

// ---------- колода ----------

const isText = (v) => typeof v === "string" && v.trim() !== "";

function okOptions(item) {
  const { options, answer } = item;
  return (
    Array.isArray(options) &&
    options.length >= 2 &&
    options.length <= 6 &&
    options.every(isText) &&
    new Set(options).size === options.length &&
    Number.isInteger(answer) &&
    answer >= 0 &&
    answer < options.length
  );
}

// Те же правила отбора, что и в боте (src/flashcards.ts): битые задания отбрасываются,
// поэтому номера карточек (а с ними и код прогресса) в боте и в приложении совпадают.
export function normalizeDeck(raw) {
  const arr = (v) => (Array.isArray(v) ? v : []);
  return {
    id: raw.id,
    name: raw.name,
    cards: arr(raw.cards).filter((c) => c && isText(c.hanzi) && isText(c.pinyin) && isText(c.translation)),
    tests: arr(raw.tests).filter((t) => t && isText(t.question) && okOptions(t)),
    pairs: arr(raw.pairs).filter((p) => p && isText(p.left) && isText(p.right)),
    cloze: arr(raw.cloze).filter((c) => c && isText(c.text) && c.text.includes("___") && okOptions(c)),
  };
}

// ---------- сессия ----------

// Индексы заданий, доступных в режиме (в массиве, который режим использует).
export function eligible(deck, mode) {
  if (mode === "tests") return deck.tests.map((_, i) => i);
  if (mode === "pairs") return deck.pairs.map((_, i) => i);
  if (mode === "cloze") return deck.cloze.map((_, i) => i);
  return deck.cards.flatMap((card, i) => {
    if (mode === "tones") return hasTones(card.pinyin) ? [i] : [];
    return [i];
  });
}

export function canStart(deck, mode, opts = {}) {
  const n = eligible(deck, mode).length;
  if (mode === "listen") return !!opts.tts && n >= 2;
  if (mode === "cards" || mode === "tones" || mode === "tests" || mode === "cloze") return n >= 1;
  return n >= 2;
}

function buildRounds(order) {
  const rounds = [];
  for (let i = 0; i < order.length; i += MATCH_PAIRS) rounds.push(order.slice(i, i + MATCH_PAIRS));
  const last = rounds[rounds.length - 1];
  if (rounds.length > 1 && last.length === 1) {
    rounds.pop();
    rounds[rounds.length - 1].push(last[0]);
  }
  return rounds;
}

function setupRound(m) {
  const cards = m.rounds[m.round];
  m.left = shuffle(cards);
  m.right = shuffle(cards);
  m.done = new Set();
  m.picked = null;
}

export function createSession(deck, mode, limit, known) {
  const elig = eligible(deck, mode);
  let picked = [
    ...shuffle(elig.filter((i) => !known.has(i))),
    ...shuffle(elig.filter((i) => known.has(i))),
  ];
  if (limit) picked = picked.slice(0, limit);
  const order = shuffle(picked);
  const session = {
    deckId: deck.id,
    mode,
    order,
    position: 0,
    total: order.length,
    missed: new Set(),
    right: new Set(),
    requeues: new Map(),
    mistakes: 0,
    match: null,
  };
  if (mode === "match" || mode === "pairs") {
    session.match = { rounds: buildRounds(order), round: 0, left: [], right: [], done: new Set(), picked: null };
    setupRound(session.match);
  }
  return session;
}

export function currentIndex(session) {
  return session.order[session.position];
}

export function isFinished(session) {
  return session.position >= session.order.length;
}

// Ошибочная карточка возвращается в конец очереди (не более MAX_REQUEUES раз).
export function record(session, correct) {
  const card = currentIndex(session);
  if (correct) {
    if (!session.missed.has(card)) session.right.add(card);
    return;
  }
  session.missed.add(card);
  session.right.delete(card);
  const n = session.requeues.get(card) ?? 0;
  if (n < MAX_REQUEUES) {
    session.requeues.set(card, n + 1);
    session.order.push(card);
  }
}

function pickDistinct(pool, exclude, count) {
  return shuffle([...new Set(pool)].filter((label) => label !== exclude)).slice(0, count);
}

// Возвращает варианты ответа для текущего вопроса (квиз, тоны, на слух, тесты, пропуски).
export function buildOptions(session, deck) {
  const index = currentIndex(session);
  if (session.mode === "tests" || session.mode === "cloze") {
    const item = session.mode === "tests" ? deck.tests[index] : deck.cloze[index];
    return shuffle(item.options.map((label, i) => ({ label, correct: i === item.answer })));
  }
  const card = deck.cards[index];
  const others = deck.cards.filter((_, i) => i !== index);
  const n = MAX_OPTIONS - 1;
  let correct;
  let wrong;
  if (session.mode === "quizrev") {
    correct = card.hanzi;
    wrong = pickDistinct(others.map((c) => c.hanzi), correct, n);
  } else if (session.mode === "tones") {
    correct = card.pinyin;
    wrong = toneVariants(card.pinyin, n);
  } else {
    correct = card.translation;
    wrong = pickDistinct(others.map((c) => c.translation), correct, n);
  }
  return shuffle([{ label: correct, correct: true }, ...wrong.map((label) => ({ label, correct: false }))]);
}

// ---------- матч-игра ----------

export function matchPick(session, side, pos) {
  const m = session.match;
  const card = (side === "l" ? m.left : m.right)[pos];
  if (card === undefined || m.done.has(card)) return { result: "ignored" };
  const p = m.picked;
  if (!p || p.side === side) {
    if (p && p.card === card) {
      m.picked = null;
      return { result: "deselected" };
    }
    m.picked = { side, card };
    return { result: "selected" };
  }
  m.picked = null;
  if (p.card === card) {
    m.done.add(card);
    if (!session.missed.has(card)) session.right.add(card);
    return { result: "matched", card };
  }
  session.mistakes += 1;
  for (const c of [p.card, card]) {
    session.missed.add(c);
    session.right.delete(c);
  }
  return { result: "wrong", first: p, second: { side, card } };
}

export function roundComplete(session) {
  const m = session.match;
  return m.done.size === m.left.length;
}

export function nextRound(session) {
  const m = session.match;
  m.round += 1;
  if (m.round >= m.rounds.length) return false;
  setupRound(m);
  return true;
}

// Подписи левой и правой плитки матч-игры для задания с индексом i.
export function matchTexts(session, deck, i) {
  if (session.mode === "pairs") return deck.pairs[i];
  const card = deck.cards[i];
  return { left: card.hanzi, right: card.translation };
}

export function fillBlank(item) {
  return item.text.replace("___", item.options[item.answer]);
}

// Что показать в итоге про ошибочное задание i: карточка или короткая строка.
export function missedInfo(session, deck, i) {
  if (session.mode === "tests") {
    const t = deck.tests[i];
    return { title: t.question, sub: `Ответ: ${t.options[t.answer]}` };
  }
  if (session.mode === "pairs") return { title: `${deck.pairs[i].left} — ${deck.pairs[i].right}` };
  if (session.mode === "cloze") return { title: fillBlank(deck.cloze[i]), sub: deck.cloze[i].translation };
  return deck.cards[i];
}

// Итог занятия: выученное = прежнее − ошибочные + отвеченные верно с первого раза.
// Для своих заданий выученное не меняется.
export function finishSession(session, prevKnown) {
  const answered = session.right.size + session.missed.size;
  const known = new Set(prevKnown);
  if (isTaskMode(session.mode)) return { known, answered };
  for (const i of session.missed) known.delete(i);
  for (const i of session.right) known.add(i);
  return { known, answered };
}

// ---------- код прогресса (совместим с ботом) ----------

async function hash4(s) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 4);
}

function toB64Url(bytes) {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromB64Url(str) {
  const b64 = str.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (str.length % 4)) % 4);
  const bin = atob(b64);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

export function deckSignature(deck) {
  return hash4(deck.cards.map((c) => c.hanzi).join("|"));
}

export async function encodeProgress(deck, known) {
  const bytes = new Uint8Array(Math.ceil(deck.cards.length / 8));
  for (const i of known) {
    if (i >= 0 && i < deck.cards.length) bytes[i >> 3] |= 1 << (i & 7);
  }
  const body = `${deck.id}.${await deckSignature(deck)}.${toB64Url(bytes)}`;
  return `${body}.${await hash4(body)}`;
}

export async function decodeProgress(code, decks) {
  const parts = code.trim().split(".");
  if (parts.length < 4) return { ok: false, reason: "Неверный формат кода." };
  const check = parts.pop();
  const payload = parts.pop();
  const signature = parts.pop();
  const deckId = parts.join(".");
  if ((await hash4(`${deckId}.${signature}.${payload}`)) !== check) {
    return { ok: false, reason: "Код повреждён. Скопируйте его целиком." };
  }
  const deck = decks.get(deckId);
  if (!deck) return { ok: false, reason: "Колода из этого кода не найдена." };
  if ((await deckSignature(deck)) !== signature) {
    return { ok: false, reason: "Колода изменилась после выдачи кода, он больше не подходит." };
  }
  let bytes;
  try {
    bytes = fromB64Url(payload);
  } catch {
    return { ok: false, reason: "Неверный формат кода." };
  }
  if (bytes.length !== Math.ceil(deck.cards.length / 8)) {
    return { ok: false, reason: "Код не подходит к этой колоде." };
  }
  const known = new Set();
  for (let i = 0; i < deck.cards.length; i++) {
    if (bytes[i >> 3] & (1 << (i & 7))) known.add(i);
  }
  return { ok: true, deck, known };
}
