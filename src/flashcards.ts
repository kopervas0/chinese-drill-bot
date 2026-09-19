// Тренажёр карточек. Колоды читаются из data/decks/*.json при старте.
// Сессия тренировки живёт только в памяти, ключ — telegram user id,
// используется исключительно "в моменте" (пока идёт сессия) и никуда
// не пишется на диск/в лог; при рестарте бота все сессии пропадают.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

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

export type Mode = "cards" | "quiz" | "listen" | "match";

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
  order: number[];
  position: number;
  score: number;
  // индексы карточек, показанные как варианты ответа для текущего
  // вопроса (quiz/listen), в порядке отображения
  options?: number[];
  match?: MatchState;
}

const decksDir = join(process.cwd(), "data", "decks");

function loadDecks(): Map<string, Deck> {
  const decks = new Map<string, Deck>();
  let files: string[];
  try {
    files = readdirSync(decksDir).filter((f) => f.endsWith(".json"));
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

function shuffle<T>(items: T[]): T[] {
  const arr = [...items];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

const sessions = new Map<number, Session>();
const MAX_OPTIONS = 4;
const MATCH_PAIRS = 5;

export function startSession(userId: number, deckId: string, mode: Mode): Session | undefined {
  const deck = decks.get(deckId);
  if (!deck || deck.cards.length === 0) return undefined;
  const session: Session = {
    deckId,
    mode,
    order: shuffle(deck.cards.map((_, i) => i)),
    position: 0,
    score: 0,
  };
  if (mode === "match") {
    session.match = {
      rounds: buildRounds(session.order),
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
    return "matched";
  }
  m.mistakes += 1;
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

export function getSession(userId: number): Session | undefined {
  return sessions.get(userId);
}

export function endSession(userId: number): void {
  sessions.delete(userId);
}

export function advance(userId: number): Session | undefined {
  const session = sessions.get(userId);
  if (!session) return undefined;
  session.position += 1;
  session.options = undefined;
  return session;
}

export function totalCards(session: Session): number {
  return session.order.length;
}

export function cardAt(session: Session, cardIndex: number): Card {
  const deck = decks.get(session.deckId)!;
  return deck.cards[cardIndex];
}

export function currentCard(session: Session): Card {
  return cardAt(session, session.order[session.position]);
}

// Формирует варианты ответа для текущего вопроса (правильный + отвлекающие)
// и запоминает их в сессии, чтобы callback "answer:<pos>" мог их проверить.
export function buildOptions(session: Session): number[] {
  const deck = decks.get(session.deckId)!;
  const correctIndex = session.order[session.position];
  const pool = deck.cards.map((_, i) => i).filter((i) => i !== correctIndex);
  const distractorCount = Math.min(MAX_OPTIONS - 1, pool.length);
  const distractors = shuffle(pool).slice(0, distractorCount);
  const options = shuffle([correctIndex, ...distractors]);
  session.options = options;
  return options;
}

export function canQuiz(deck: Deck): boolean {
  return deck.cards.length >= 2;
}

export function canMatch(deck: Deck): boolean {
  return deck.cards.length >= 2;
}

export function canListen(deck: Deck): boolean {
  return deck.cards.some((c) => c.audio) && deck.cards.length >= 2;
}
