// Тренажёр. Колоды читаются из data/decks/*.json при старте.
// Сессии и прогресс живут только в памяти процесса, ключ — telegram user id.
// Id используется исключительно как ключ в памяти, никуда не пишется (ни в
// файлы, ни в лог), а неактивные записи удаляются по таймеру.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { hasTones, toneVariants } from "./pinyin.js";
import { shuffle } from "./util.js";

export interface Card {
  hanzi: string;
  pinyin: string;
  translation: string;
  // file_id голосового сообщения в Telegram (загружается преподавателем
  // заранее), используется только режимом "на слух"
  audio?: string;
}

// Задание с вариантами ответа. audio: file_id голосового в Telegram (только для
// бота) или путь вида audio/name.mp3 относительно сайта мини-приложения.
export interface TestItem {
  question: string;
  options: string[];
  answer: number;
  explain?: string;
  audio?: string;
}

export interface PairItem {
  left: string;
  right: string;
}

// Предложение с пропуском "___".
export interface ClozeItem {
  text: string;
  options: string[];
  answer: number;
  translation?: string;
}

export interface Deck {
  id: string;
  name: string;
  cards: Card[];
  tests: TestItem[];
  pairs: PairItem[];
  cloze: ClozeItem[];
}

export type Mode =
  | "cards"
  | "quiz"
  | "quizrev"
  | "tones"
  | "listen"
  | "match"
  | "tests"
  | "pairs"
  | "cloze";

// Свои задания учителя: прогресс "выучено" по ним не ведётся.
export const isTaskMode = (mode: Mode): boolean => mode === "tests" || mode === "pairs" || mode === "cloze";

export interface Option {
  label: string;
  correct: boolean;
}

export interface MatchState {
  rounds: number[][];
  round: number;
  // индексы карточек в порядке отображения левой (иероглифы) и правой (переводы) колонок
  left: number[];
  right: number[];
  done: Set<number>;
  picked?: { side: "l" | "r"; card: number };
  mistakes: number;
}

export interface Session {
  deckId: string;
  mode: Mode;
  // очередь карточек (индексы в deck.cards); ошибочные добавляются в конец
  order: number[];
  position: number;
  total: number;
  missed: Set<number>;
  right: Set<number>;
  requeues: Map<number, number>;
  answered: boolean;
  options?: Option[];
  match?: MatchState;
  touched: number;
}

const decksDir = join(process.cwd(), "data", "decks");

const isText = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";
const AUDIO_RE = /^(?:[A-Za-z0-9_-]{20,}|audio\/[A-Za-z0-9._-]+\.(?:mp3|ogg|oga|opus|m4a|wav))$/;

function validOptions(item: { options?: unknown; answer?: unknown }): boolean {
  const { options, answer } = item;
  return (
    Array.isArray(options) &&
    options.length >= 2 &&
    options.length <= 6 &&
    options.every(isText) &&
    new Set(options).size === options.length &&
    Number.isInteger(answer) &&
    (answer as number) >= 0 &&
    (answer as number) < options.length
  );
}

function keep<T>(file: string, section: string, items: unknown, ok: (x: any) => boolean): T[] {
  if (items === undefined) return [];
  if (!Array.isArray(items)) {
    console.error(`Колода ${file}: "${section}" должен быть списком, раздел пропущен`);
    return [];
  }
  return items.filter((item, i) => {
    const good = item !== null && typeof item === "object" && ok(item);
    if (!good) console.error(`Колода ${file}: пропущено задание ${section} №${i + 1} (неверный формат)`);
    return good;
  });
}

function parseDeck(id: string, file: string, raw: unknown): Deck | undefined {
  const d = raw as Record<string, unknown>;
  if (d === null || typeof d !== "object" || !isText(d.name)) {
    console.error(`Колода ${file}: нет поля "name", файл пропущен`);
    return undefined;
  }
  const cards = keep<Card>(file, "cards", d.cards, (c) => isText(c.hanzi) && isText(c.pinyin) && isText(c.translation));
  const tests = keep<TestItem>(
    file,
    "tests",
    d.tests,
    (t) => isText(t.question) && validOptions(t) && (t.audio === undefined || (typeof t.audio === "string" && AUDIO_RE.test(t.audio))),
  );
  const pairs = keep<PairItem>(file, "pairs", d.pairs, (p) => isText(p.left) && isText(p.right));
  const cloze = keep<ClozeItem>(file, "cloze", d.cloze, (c) => isText(c.text) && c.text.includes("___") && validOptions(c));
  if (cards.length + tests.length + pairs.length + cloze.length === 0) {
    console.error(`Колода ${file}: нет ни одного корректного задания, файл пропущен`);
    return undefined;
  }
  return { id, name: d.name, cards, tests, pairs, cloze };
}

function loadDecks(): Map<string, Deck> {
  const decks = new Map<string, Deck>();
  let files: string[];
  try {
    files = readdirSync(decksDir)
      .filter((f) => f.endsWith(".json"))
      .sort();
  } catch {
    return decks;
  }
  for (const file of files) {
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(join(decksDir, file), "utf-8"));
    } catch (e) {
      throw new Error(`Колода ${file} не читается как JSON: ${e instanceof Error ? e.message : String(e)}`);
    }
    const id = file.replace(/\.json$/, "");
    const deck = parseDeck(id, file, raw);
    if (deck) decks.set(id, deck);
  }
  return decks;
}

export const decks = loadDecks();

const MAX_OPTIONS = 4;
const MATCH_PAIRS = 5;
const MAX_REQUEUES = 2;
const SESSION_TTL_MS = 60 * 60 * 1000;
const PROGRESS_TTL_MS = 6 * 60 * 60 * 1000;

const sessions = new Map<number, Session>();
const progress = new Map<number, { deckId: string; known: Set<number>; touched: number }>();

setInterval(() => {
  const now = Date.now();
  for (const [id, s] of sessions) if (now - s.touched > SESSION_TTL_MS) sessions.delete(id);
  for (const [id, p] of progress) if (now - p.touched > PROGRESS_TTL_MS) progress.delete(id);
}, 10 * 60 * 1000).unref();

export function getKnown(userId: number, deckId: string): Set<number> | undefined {
  const p = progress.get(userId);
  if (!p || p.deckId !== deckId) return undefined;
  p.touched = Date.now();
  return p.known;
}

export function setKnown(userId: number, deckId: string, known: Set<number>): void {
  progress.set(userId, { deckId, known, touched: Date.now() });
}

export function clearProgress(userId: number): void {
  progress.delete(userId);
}

// Индексы заданий, доступных в режиме (в массиве, который режим использует).
export function eligibleItems(deck: Deck, mode: Mode): number[] {
  if (mode === "tests") return deck.tests.map((_, i) => i);
  if (mode === "pairs") return deck.pairs.map((_, i) => i);
  if (mode === "cloze") return deck.cloze.map((_, i) => i);
  return deck.cards.flatMap((card, i) => {
    if (mode === "listen") return card.audio ? [i] : [];
    if (mode === "tones") return hasTones(card.pinyin) ? [i] : [];
    return [i];
  });
}

export function canStart(deck: Deck, mode: Mode): boolean {
  const n = eligibleItems(deck, mode).length;
  if (mode === "cards" || mode === "tones" || mode === "tests" || mode === "cloze") return n >= 1;
  if (mode === "listen") return n >= 1 && deck.cards.length >= 2;
  return n >= 2;
}

export function startSession(
  userId: number,
  deckId: string,
  mode: Mode,
  limit: number | null,
): Session | undefined {
  const deck = decks.get(deckId);
  if (!deck || !canStart(deck, mode)) return undefined;

  const eligible = eligibleItems(deck, mode);
  const known = isTaskMode(mode) ? new Set<number>() : (getKnown(userId, deckId) ?? new Set<number>());
  // сначала невыученные, потом выученные — чтобы ограничение по длине
  // отрезало именно повторение уже известного
  let picked = [
    ...shuffle(eligible.filter((i) => !known.has(i))),
    ...shuffle(eligible.filter((i) => known.has(i))),
  ];
  if (limit !== null) picked = picked.slice(0, limit);
  const order = shuffle(picked);

  const session: Session = {
    deckId,
    mode,
    order,
    position: 0,
    total: order.length,
    missed: new Set(),
    right: new Set(),
    requeues: new Map(),
    answered: false,
    touched: Date.now(),
  };
  if (mode === "match" || mode === "pairs") {
    session.match = {
      rounds: buildRounds(order),
      round: 0,
      left: [],
      right: [],
      done: new Set(),
      mistakes: 0,
    };
    setupRound(session.match);
  }
  sessions.set(userId, session);
  return session;
}

export function getSession(userId: number): Session | undefined {
  const session = sessions.get(userId);
  if (session) session.touched = Date.now();
  return session;
}

export function cardAt(session: Session, cardIndex: number): Card {
  return decks.get(session.deckId)!.cards[cardIndex];
}

export function currentCard(session: Session): Card {
  return cardAt(session, session.order[session.position]);
}

export function isFinished(session: Session): boolean {
  return session.position >= session.order.length;
}

export function advance(session: Session): void {
  session.position += 1;
  session.answered = false;
  session.options = undefined;
}

// Фиксирует результат по текущей карточке. Ошибочная карточка возвращается
// в конец очереди (не более MAX_REQUEUES раз), чтобы повторить её в этом же занятии.
export function record(session: Session, correct: boolean): void {
  const card = session.order[session.position];
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

function pickDistinct(pool: string[], exclude: string, count: number): string[] {
  return shuffle([...new Set(pool)].filter((label) => label !== exclude)).slice(0, count);
}

export function buildQuestion(session: Session): { prompt: string; voice?: string; labels: string[] } {
  const deck = decks.get(session.deckId)!;
  const cardIndex = session.order[session.position];

  if (session.mode === "tests" || session.mode === "cloze") {
    const isTest = session.mode === "tests";
    const item = isTest ? deck.tests[cardIndex] : deck.cloze[cardIndex];
    const options = shuffle<Option>(item.options.map((label, i) => ({ label, correct: i === item.answer })));
    session.options = options;
    session.answered = false;
    return {
      prompt: isTest ? (item as TestItem).question : `${(item as ClozeItem).text}
Выберите пропущенное:`,
      voice: isTest ? (item as TestItem).audio : undefined,
      labels: options.map((o) => o.label),
    };
  }

  const card = deck.cards[cardIndex];
  const others = deck.cards.filter((_, i) => i !== cardIndex);
  const distractors = MAX_OPTIONS - 1;

  let prompt: string;
  let voice: string | undefined;
  let correct: string;
  let wrong: string[];

  switch (session.mode) {
    case "quizrev":
      prompt = `${card.translation}\nВыберите иероглиф:`;
      correct = card.hanzi;
      wrong = pickDistinct(others.map((c) => c.hanzi), correct, distractors);
      break;
    case "tones":
      prompt = `${card.hanzi} — ${card.translation}\nВыберите правильный пиньинь:`;
      correct = card.pinyin;
      wrong = toneVariants(card.pinyin, distractors);
      break;
    case "listen":
      prompt = "Что вы услышали? Выберите перевод:";
      voice = card.audio;
      correct = card.translation;
      wrong = pickDistinct(others.map((c) => c.translation), correct, distractors);
      break;
    default:
      prompt = `${card.hanzi} (${card.pinyin})\nВыберите перевод:`;
      correct = card.translation;
      wrong = pickDistinct(others.map((c) => c.translation), correct, distractors);
  }

  const options = shuffle<Option>([
    { label: correct, correct: true },
    ...wrong.map((label) => ({ label, correct: false })),
  ]);
  session.options = options;
  session.answered = false;
  return { prompt, voice, labels: options.map((o) => o.label) };
}

function cardLine(card: Card): string {
  return `${card.hanzi} ${card.pinyin} — ${card.translation}`;
}

function fillBlank(item: ClozeItem): string {
  return item.text.replace("___", item.options[item.answer]);
}

// Разбор ответа на текущее задание: правильный ответ и пояснение.
function feedbackText(session: Session): string {
  const deck = decks.get(session.deckId)!;
  const i = session.order[session.position];
  if (session.mode === "tests") {
    const t = deck.tests[i];
    return `Правильный ответ: ${t.options[t.answer]}` + (t.explain ? `
${t.explain}` : "");
  }
  if (session.mode === "cloze") {
    const c = deck.cloze[i];
    return fillBlank(c) + (c.translation ? `
${c.translation}` : "");
  }
  return cardLine(deck.cards[i]);
}

export function checkAnswer(
  session: Session,
  optionIndex: number,
): { correct: boolean; feedback: string } | undefined {
  const option = session.options?.[optionIndex];
  if (!option || session.answered) return undefined;
  session.answered = true;
  record(session, option.correct);
  return { correct: option.correct, feedback: feedbackText(session) };
}

function missedLine(deck: Deck, mode: Mode, i: number): string {
  if (mode === "tests") return deck.tests[i].question;
  if (mode === "pairs") return `${deck.pairs[i].left} — ${deck.pairs[i].right}`;
  if (mode === "cloze") return fillBlank(deck.cloze[i]);
  return cardLine(deck.cards[i]);
}

// Итог занятия. known (выученные карточки) считается только для режимов по карточкам.
export function finishSession(
  userId: number,
): { session: Session; known?: Set<number>; missedLines: string[] } | undefined {
  const session = sessions.get(userId);
  if (!session) return undefined;
  sessions.delete(userId);

  let known: Set<number> | undefined;
  if (!isTaskMode(session.mode)) {
    known = new Set(getKnown(userId, session.deckId) ?? []);
    for (const i of session.missed) known.delete(i);
    for (const i of session.right) known.add(i);
    setKnown(userId, session.deckId, known);
  }

  const deck = decks.get(session.deckId)!;
  return { session, known, missedLines: [...session.missed].map((i) => missedLine(deck, session.mode, i)) };
}

// Подписи левой и правой плитки матч-игры для задания с индексом i.
export function matchTexts(session: Session, i: number): { left: string; right: string } {
  const deck = decks.get(session.deckId)!;
  if (session.mode === "pairs") return deck.pairs[i];
  const card = deck.cards[i];
  return { left: card.hanzi, right: card.translation };
}

function buildRounds(order: number[]): number[][] {
  const rounds: number[][] = [];
  for (let i = 0; i < order.length; i += MATCH_PAIRS) {
    rounds.push(order.slice(i, i + MATCH_PAIRS));
  }
  const last = rounds[rounds.length - 1];
  if (rounds.length > 1 && last.length === 1) {
    rounds.pop();
    rounds[rounds.length - 1].push(last[0]);
  }
  return rounds;
}

function setupRound(m: MatchState): void {
  const cards = m.rounds[m.round];
  m.left = shuffle(cards);
  m.right = shuffle(cards);
  m.done = new Set();
  m.picked = undefined;
}

export type PickResult = "ignored" | "selected" | "matched" | "wrong";

export function matchPick(session: Session, side: "l" | "r", pos: number): PickResult {
  const m = session.match;
  if (!m) return "ignored";
  const card = (side === "l" ? m.left : m.right)[pos];
  if (card === undefined || m.done.has(card)) return "ignored";
  const p = m.picked;
  if (!p || p.side === side) {
    if (p && p.card === card) return "ignored";
    m.picked = { side, card };
    return "selected";
  }
  m.picked = undefined;
  if (p.card === card) {
    m.done.add(card);
    if (!session.missed.has(card)) session.right.add(card);
    return "matched";
  }
  m.mistakes += 1;
  for (const c of [p.card, card]) {
    session.missed.add(c);
    session.right.delete(c);
  }
  return "wrong";
}

export function roundComplete(session: Session): boolean {
  const m = session.match;
  return !!m && m.done.size === m.left.length;
}

export function nextRound(session: Session): boolean {
  const m = session.match!;
  m.round += 1;
  if (m.round >= m.rounds.length) return false;
  setupRound(m);
  return true;
}
