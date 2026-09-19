import assert from "node:assert/strict";
import { test } from "node:test";
import { AUDIO_RE, DECK_ID_RE, sanitizeDeck } from "../src/deckValidate.js";

const okDeck = {
  name: "  Пример  ",
  cards: [{ hanzi: "你好", pinyin: "nǐ hǎo", translation: "привет", extra: "лишнее" }],
  tests: [{ question: "Вопрос?", options: ["a", "b", "c"], answer: 1, explain: "почему" }],
  pairs: [
    { left: "一", right: "один" },
    { left: "二", right: "два" },
  ],
  cloze: [{ text: "我 ___ 水。", options: ["喝", "吃"], answer: 0, translation: "Я пью воду." }],
  hacked: true,
};

function errorsOf(raw: unknown): string[] {
  const r = sanitizeDeck(raw);
  assert.equal(r.ok, false);
  return r.ok ? [] : r.errors;
}

test("верная колода проходит, лишние поля отбрасываются, тексты очищаются", () => {
  const r = sanitizeDeck(okDeck);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.deck.name, "Пример");
  assert.deepEqual(r.deck.cards, [{ hanzi: "你好", pinyin: "nǐ hǎo", translation: "привет" }]);
  assert.equal("hacked" in r.deck, false);
  assert.deepEqual(Object.keys(r.deck), ["name", "cards", "tests", "pairs", "cloze"]);
});

test("управляющие символы заменяются, пробелы схлопываются", () => {
  const r = sanitizeDeck({ name: "A\u0000\tB\n  C", cards: [{ hanzi: "x", pinyin: "y", translation: "z" }] });
  assert.equal(r.ok && r.deck.name, "A B C");
});

test("пустые разделы не сохраняются, порядок полей стабильный", () => {
  const r = sanitizeDeck({ name: "N", cards: [], tests: [{ question: "q", options: ["a", "b"], answer: 0 }] });
  assert.equal(r.ok, true);
  if (r.ok) assert.deepEqual(Object.keys(r.deck), ["name", "tests"]);
});

test("название обязательно и ограничено", () => {
  assert.ok(errorsOf({ cards: [{ hanzi: "a", pinyin: "b", translation: "c" }] }).some((e) => e.includes("Название")));
  assert.ok(errorsOf({ name: "x".repeat(81), cards: [{ hanzi: "a", pinyin: "b", translation: "c" }] }).length > 0);
});

test("колода без заданий отклоняется", () => {
  assert.ok(errorsOf({ name: "N" }).some((e) => e.includes("ни одного задания")));
  assert.ok(errorsOf({ name: "N", cards: [] }).length > 0);
});

test("ответ теста: номер в пределах, варианты уникальны, 2–6 штук", () => {
  const bad = (t: object) => errorsOf({ name: "N", tests: [t] });
  assert.ok(bad({ question: "q", options: ["a", "b"], answer: 2 }).length > 0);
  assert.ok(bad({ question: "q", options: ["a", "b"], answer: -1 }).length > 0);
  assert.ok(bad({ question: "q", options: ["a", "b"], answer: "0" }).length > 0);
  assert.ok(bad({ question: "q", options: ["a", "a"], answer: 0 }).length > 0);
  assert.ok(bad({ question: "q", options: ["a"], answer: 0 }).length > 0);
  assert.ok(bad({ question: "q", options: ["a", "b", "c", "d", "e", "f", "g"], answer: 0 }).length > 0);
  assert.ok(bad({ question: "", options: ["a", "b"], answer: 0 }).length > 0);
});

test("пропуск: ровно одно ___", () => {
  const bad = (text: string) => errorsOf({ name: "N", cloze: [{ text, options: ["a", "b"], answer: 0 }] });
  assert.ok(bad("нет пропуска").length > 0);
  assert.ok(bad("два ___ пропуска ___").length > 0);
});

test("одна пара в режиме пар — ошибка, две — можно", () => {
  assert.ok(errorsOf({ name: "N", pairs: [{ left: "a", right: "b" }] }).some((e) => e.includes("минимум 2")));
});

test("аудио: путь на сайте или file_id, чужие адреса запрещены", () => {
  for (const good of ["audio/hello.mp3", "audio/a-b_c.ogg", "AwACAgIAAxkBAAIBQ2dexampleFileId123"]) assert.equal(AUDIO_RE.test(good), true, good);
  for (const bad of ["http://evil.example/x.mp3", "//evil/x.mp3", "audio/../x.mp3", "../audio/x.mp3", "audio/x.exe", "/etc/passwd", "audio/a b.mp3"]) {
    assert.equal(AUDIO_RE.test(bad), false, bad);
  }
  assert.ok(errorsOf({ name: "N", tests: [{ question: "q", options: ["a", "b"], answer: 0, audio: "http://evil.example/x.mp3" }] }).length > 0);
});

test("лимиты на количество заданий", () => {
  const many = Array.from({ length: 2001 }, () => ({ hanzi: "a", pinyin: "b", translation: "c" }));
  assert.ok(errorsOf({ name: "N", cards: many }).some((e) => e.includes("не больше")));
});

test("не объект и мусор отклоняются", () => {
  for (const raw of [null, undefined, 5, "x", []]) assert.equal(sanitizeDeck(raw).ok, false);
  assert.ok(errorsOf({ name: "N", cards: "нет" }).length > 0);
  assert.ok(errorsOf({ name: "N", cards: [null] }).length > 0);
});

test("мягкий режим пропускает битое и считает пропущенное", () => {
  const r = sanitizeDeck(
    { cards: [{ hanzi: "a", pinyin: "b", translation: "c" }, { hanzi: "" }], tests: [{ question: "q", options: ["a"], answer: 0 }] },
    { lenient: true },
  );
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.deck.name, "Без названия");
    assert.equal(r.deck.cards?.length, 1);
    assert.equal(r.dropped, 2);
  }
});

test("код колоды: только латиница, цифры, - и _", () => {
  for (const good of ["hsk4", "a_b-c", "X"]) assert.equal(DECK_ID_RE.test(good), true);
  for (const bad of ["", "a.b", "../x", "a b", "x".repeat(31), "колода"]) assert.equal(DECK_ID_RE.test(bad), false);
});
