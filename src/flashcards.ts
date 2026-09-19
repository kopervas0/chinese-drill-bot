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

export interface Deck {
  id: string;
  name: string;
  cards: Card[];
}

export type Mode = "cards" | "quiz" | "quizrev" | "tones" | "listen" | "match";

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
    const raw = readFileSync(join(decksDir, file), "utf-8");
    const parsed = JSON.parse(raw) as { name: string; cards: Card[] };
    const id = file.replace(/\.json$/, "");
    decks.set(id, { id, name: parsed.name, cards: parsed.cards });
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

export function eligibleCards(deck: Deck, mode: Mode): number[] {
  return deck.cards.flatMap((card, i) => {
    if (mode === "listen") return card.audio ? [i] : [];
    if (mode === "tones") return hasTones(card.pinyin) ? [i] : [];
    return [i];
  });
}

export function canStart(deck: Deck, mode: Mode): boolean {
  const n = eligibleCards(deck, mode).length;
  if (mode === "cards" || mode === "tones") return n >= 1;
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

  const eligible = eligibleCards(deck, mode);
  const known = getKnown(userId, deckId) ?? new Set<number>();
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
  if (mode === "match") {
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

export function checkAnswer(
  session: Session,
  optionIndex: number,
): { correct: boolean; card: Card } | undefined {
  const option = session.options?.[optionIndex];
  if (!option || session.answered) return undefined;
  session.answered = true;
  record(session, option.correct);
  return { correct: option.correct, card: currentCard(session) };
}

export function finishSession(
  userId: number,
): { session: Session; known: Set<number>; missedCards: Card[] } | undefined {
  const session = sessions.get(userId);
  if (!session) return undefined;
  sessions.delete(userId);

  const known = new Set(getKnown(userId, session.deckId) ?? []);
  for (const i of session.missed) known.delete(i);
  for (const i of session.right) known.add(i);
  setKnown(userId, session.deckId, known);

  const deck = decks.get(session.deckId)!;
  return { session, known, missedCards: [...session.missed].map((i) => deck.cards[i]) };
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
