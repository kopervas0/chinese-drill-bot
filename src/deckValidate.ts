// Строгая проверка и очистка колоды из редактора. Сохраняются только известные поля
// (лишние отбрасываются), тексты очищаются от управляющих символов и ограничены по длине.

export interface CardFile {
  hanzi: string;
  pinyin: string;
  translation: string;
  audio?: string;
}
export interface TestFile {
  question: string;
  options: string[];
  answer: number;
  explain?: string;
  audio?: string;
}
export interface PairFile {
  left: string;
  right: string;
}
export interface ClozeFile {
  text: string;
  options: string[];
  answer: number;
  translation?: string;
}
export interface DeckFile {
  name: string;
  cards?: CardFile[];
  tests?: TestFile[];
  pairs?: PairFile[];
  cloze?: ClozeFile[];
}

export const DECK_ID_RE = /^[A-Za-z0-9_-]{1,30}$/;
// file_id голосового в Telegram или путь к файлу на сайте приложения
export const AUDIO_RE = /^(?:[A-Za-z0-9_-]{20,}|audio\/[A-Za-z0-9._-]+\.(?:mp3|ogg|oga|opus|m4a|wav))$/;

export const LIMITS = {
  name: 80,
  hanzi: 30,
  pinyin: 60,
  translation: 120,
  question: 300,
  option: 100,
  explain: 400,
  text: 300,
  pairText: 100,
  cards: 2000,
  tests: 500,
  pairs: 200,
  cloze: 500,
} as const;

export type SanitizeResult =
  | { ok: true; deck: DeckFile; dropped: number }
  | { ok: false; errors: string[] };

function clean(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  const s = v
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return s === "" || s.length > max ? null : s;
}

// lenient: битые задания пропускаются и считаются в dropped (для открытия старых файлов);
// строгий режим (по умолчанию) собирает ошибки для показа учителю.
export function sanitizeDeck(raw: unknown, opts: { lenient?: boolean } = {}): SanitizeResult {
  const lenient = opts.lenient === true;
  const errors: string[] = [];
  let dropped = 0;

  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, errors: ["Колода должна быть объектом"] };
  }
  const r = raw as Record<string, unknown>;

  let name = clean(r.name, LIMITS.name);
  if (name === null) {
    if (lenient) name = "Без названия";
    else errors.push(`Название колоды: обязательное, до ${LIMITS.name} символов`);
  }

  // общий обход раздела: fn возвращает элемент или строку с ошибкой
  function section<T>(key: string, label: string, max: number, fn: (item: Record<string, unknown>) => T | string): T[] | undefined {
    const v = r[key];
    if (v === undefined || v === null) return undefined;
    if (!Array.isArray(v)) {
      errors.push(`«${label}»: должен быть списком`);
      return undefined;
    }
    if (v.length > max) errors.push(`«${label}»: не больше ${max} заданий`);
    const out: T[] = [];
    v.slice(0, max).forEach((item, i) => {
      const res = item !== null && typeof item === "object" && !Array.isArray(item) ? fn(item as Record<string, unknown>) : "неверный формат";
      if (typeof res === "string") {
        if (lenient) dropped++;
        else if (errors.length < 30) errors.push(`${label} №${i + 1}: ${res}`);
      } else out.push(res);
    });
    return out;
  }

  const options = (item: Record<string, unknown>): { options: string[]; answer: number } | string => {
    const o = item.options;
    if (!Array.isArray(o) || o.length < 2 || o.length > 6) return "нужно от 2 до 6 вариантов ответа";
    const opts = o.map((x) => clean(x, LIMITS.option));
    if (opts.some((x) => x === null)) return `варианты ответа: непустые, до ${LIMITS.option} символов`;
    if (new Set(opts).size !== opts.length) return "варианты ответа не должны повторяться";
    const answer = item.answer;
    if (typeof answer !== "number" || !Number.isInteger(answer) || answer < 0 || answer >= opts.length) {
      return "не выбран верный вариант";
    }
    return { options: opts as string[], answer };
  };

  const audioOf = (item: Record<string, unknown>): { audio?: string } | string => {
    const a = item.audio;
    if (a === undefined || a === null || a === "") return {};
    if (typeof a !== "string" || !AUDIO_RE.test(a)) return "аудио: путь audio/имя.mp3 или file_id голосового";
    return { audio: a };
  };

  const cards = section<CardFile>("cards", "Карточка", LIMITS.cards, (c) => {
    const hanzi = clean(c.hanzi, LIMITS.hanzi);
    const pinyin = clean(c.pinyin, LIMITS.pinyin);
    const translation = clean(c.translation, LIMITS.translation);
    if (hanzi === null) return `иероглифы: обязательные, до ${LIMITS.hanzi} символов`;
    if (pinyin === null) return `пиньинь: обязательный, до ${LIMITS.pinyin} символов`;
    if (translation === null) return `перевод: обязательный, до ${LIMITS.translation} символов`;
    const a = audioOf(c);
    if (typeof a === "string") return a;
    return { hanzi, pinyin, translation, ...a };
  });

  const tests = section<TestFile>("tests", "Тест", LIMITS.tests, (t) => {
    const question = clean(t.question, LIMITS.question);
    if (question === null) return `вопрос: обязательный, до ${LIMITS.question} символов`;
    const o = options(t);
    if (typeof o === "string") return o;
    const a = audioOf(t);
    if (typeof a === "string") return a;
    const out: TestFile = { question, options: o.options, answer: o.answer };
    if (t.explain !== undefined && t.explain !== null && t.explain !== "") {
      const explain = clean(t.explain, LIMITS.explain);
      if (explain === null) return `пояснение: до ${LIMITS.explain} символов`;
      out.explain = explain;
    }
    return { ...out, ...a };
  });

  const pairs = section<PairFile>("pairs", "Пара", LIMITS.pairs, (p) => {
    const left = clean(p.left, LIMITS.pairText);
    const right = clean(p.right, LIMITS.pairText);
    if (left === null || right === null) return `обе части пары обязательны, до ${LIMITS.pairText} символов`;
    return { left, right };
  });

  const cloze = section<ClozeFile>("cloze", "Пропуск", LIMITS.cloze, (c) => {
    const text = clean(c.text, LIMITS.text);
    if (text === null) return `предложение: обязательное, до ${LIMITS.text} символов`;
    if (text.split("___").length !== 2) return "в предложении должно быть ровно одно место пропуска ___";
    const o = options(c);
    if (typeof o === "string") return o;
    const out: ClozeFile = { text, options: o.options, answer: o.answer };
    if (c.translation !== undefined && c.translation !== null && c.translation !== "") {
      const translation = clean(c.translation, LIMITS.translation);
      if (translation === null) return `перевод: до ${LIMITS.translation} символов`;
      out.translation = translation;
    }
    return out;
  });

  if (pairs && pairs.length === 1 && !lenient) errors.push("Пары: для режима нужно минимум 2 пары");

  const total = (cards?.length ?? 0) + (tests?.length ?? 0) + (pairs?.length ?? 0) + (cloze?.length ?? 0);
  if (total === 0 && !lenient) errors.push("В колоде нет ни одного задания");

  if (errors.length > 0) return { ok: false, errors };

  // порядок полей стабильный, пустые разделы не пишем
  const deck: DeckFile = { name: name as string };
  if (cards?.length) deck.cards = cards;
  if (tests?.length) deck.tests = tests;
  if (pairs?.length) deck.pairs = pairs;
  if (cloze?.length) deck.cloze = cloze;
  return { ok: true, deck, dropped };
}
