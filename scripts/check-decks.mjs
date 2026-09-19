// Проверка колод в data/decks/*.json (или в папке из аргумента).
// Ошибки (код выхода 1) ломают бота или мини-приложение, предупреждения — нет.
// Использование: npm run decks:check [-- <папка>]
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const dir = process.argv[2] ?? join(import.meta.dirname, "..", "data", "decks");
const ID_RE = /^[A-Za-z0-9_-]{1,30}$/;
// буквы, знаки тонов, пробел, апостроф, дефис
const PINYIN_RE = /^[A-Za-zāáǎàēéěèīíǐìōóǒòūúǔùǖǘǚǜüÜ' -]+$/;
const TONE_RE = /[āáǎàēéěèīíǐìōóǒòūúǔùǖǘǚǜ]/;
// file_id голосового в Telegram или путь к файлу на сайте приложения
const AUDIO_RE = /^(?:[A-Za-z0-9_-]{20,}|audio\/[A-Za-z0-9._-]+\.(?:mp3|ogg|oga|opus|m4a|wav))$/;

let errors = 0;
let warnings = 0;
const err = (file, msg) => {
  errors++;
  console.log(`  ОШИБКА    ${file}: ${msg}`);
};
const note = (file, msg) => console.log(`  заметка   ${file}: ${msg}`);
const warn = (file, msg) => {
  warnings++;
  console.log(`  внимание  ${file}: ${msg}`);
};
const isText = (v) => typeof v === "string" && v.trim() !== "";

function checkOptions(file, at, item) {
  const { options, answer } = item;
  if (!Array.isArray(options) || options.length < 2 || options.length > 6) {
    err(file, `${at}: "options" — список из 2–6 вариантов ответа`);
    return;
  }
  if (!options.every(isText)) err(file, `${at}: пустой вариант ответа в "options"`);
  else if (new Set(options).size !== options.length) err(file, `${at}: варианты ответа повторяются`);
  if (!Number.isInteger(answer) || answer < 0 || answer >= options.length) {
    err(file, `${at}: "answer" — номер верного варианта, начиная с 0 (от 0 до ${options.length - 1})`);
  }
}

function checkAudio(file, at, audio) {
  if (audio !== undefined && !(typeof audio === "string" && AUDIO_RE.test(audio))) {
    err(file, `${at}: "audio" — file_id голосового или путь вида audio/имя.mp3 (mp3, ogg, m4a, wav)`);
  }
}

function checkCards(file, cards) {
  const seen = new Map();
  cards.forEach((card, i) => {
    const at = `карточка №${i + 1}`;
    for (const key of ["hanzi", "pinyin", "translation"]) {
      if (!isText(card?.[key])) err(file, `${at}: пустое или отсутствует поле "${key}"`);
    }
    checkAudio(file, at, card?.audio);
    if (isText(card?.pinyin)) {
      if (/\d/.test(card.pinyin)) warn(file, `${at} (${card.hanzi}): цифры в пиньине «${card.pinyin}», нужны знаки тонов: nǐ, а не ni3`);
      else if (!PINYIN_RE.test(card.pinyin)) warn(file, `${at} (${card.hanzi}): необычные символы в пиньине «${card.pinyin}»`);
      else if (!TONE_RE.test(card.pinyin)) {
        note(file, `${at} (${card.hanzi}): «${card.pinyin}» без знаков тонов. Для безударных слогов (ma, de) это нормально, в режим «Тоны» такая карточка не попадёт`);
      }
    }
    if (isText(card?.hanzi)) {
      if (seen.has(card.hanzi)) warn(file, `${at}: иероглиф «${card.hanzi}» уже был в карточке №${seen.get(card.hanzi)}`);
      else seen.set(card.hanzi, i + 1);
    }
  });
  if (cards.length < 4) warn(file, "меньше 4 карточек: в квизах будет мало вариантов ответа");
}

function checkTests(file, tests) {
  tests.forEach((t, i) => {
    const at = `тест №${i + 1}`;
    if (!isText(t?.question)) err(file, `${at}: пустое или отсутствует поле "question"`);
    checkOptions(file, at, t ?? {});
    checkAudio(file, at, t?.audio);
    if (t?.explain !== undefined && !isText(t.explain)) err(file, `${at}: "explain" должно быть непустым текстом или отсутствовать`);
  });
}

function checkPairs(file, pairs) {
  const left = new Set();
  pairs.forEach((p, i) => {
    const at = `пара №${i + 1}`;
    if (!isText(p?.left)) err(file, `${at}: пустое или отсутствует поле "left"`);
    if (!isText(p?.right)) err(file, `${at}: пустое или отсутствует поле "right"`);
    if (isText(p?.left)) {
      if (left.has(p.left)) warn(file, `${at}: левая часть «${p.left}» уже есть в другой паре`);
      left.add(p.left);
    }
  });
  if (pairs.length < 2) err(file, "для режима «Найди пары» нужно минимум 2 пары");
}

function checkCloze(file, cloze) {
  cloze.forEach((c, i) => {
    const at = `пропуск №${i + 1}`;
    if (!isText(c?.text)) err(file, `${at}: пустое или отсутствует поле "text"`);
    else if (!c.text.includes("___")) err(file, `${at}: в "text" нужно место пропуска из трёх подчёркиваний ___`);
    checkOptions(file, at, c ?? {});
    if (c?.translation !== undefined && !isText(c.translation)) err(file, `${at}: "translation" должно быть непустым текстом или отсутствовать`);
  });
}

const SECTIONS = [
  ["cards", "карточек", checkCards],
  ["tests", "тестов", checkTests],
  ["pairs", "пар", checkPairs],
  ["cloze", "пропусков", checkCloze],
];

const files = readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
if (files.length === 0) {
  console.log(`В папке ${dir} нет файлов .json`);
  process.exit(1);
}

for (const file of files) {
  console.log(`\n${file}`);
  const id = file.replace(/\.json$/, "");
  if (!ID_RE.test(id)) {
    err(file, "имя файла: только латиница, цифры, - и _, до 30 символов (например, hsk4.json)");
  }

  let deck;
  try {
    deck = JSON.parse(readFileSync(join(dir, file), "utf-8"));
  } catch (e) {
    err(file, `файл не читается как JSON (${e.message}). Проверьте запятые и кавычки`);
    continue;
  }

  if (!isText(deck?.name)) err(file, 'нет поля "name" (название колоды)');

  const counts = [];
  for (const [key, label, check] of SECTIONS) {
    if (deck?.[key] === undefined) continue;
    if (!Array.isArray(deck[key])) {
      err(file, `"${key}" должен быть списком`);
      continue;
    }
    check(file, deck[key]);
    counts.push(`${label}: ${deck[key].length}`);
  }
  if (counts.length === 0 || SECTIONS.every(([key]) => !(Array.isArray(deck?.[key]) && deck[key].length > 0))) {
    err(file, 'в колоде нет заданий: добавьте хотя бы один из разделов "cards", "tests", "pairs", "cloze"');
  } else {
    console.log(`  ${counts.join(", ")}`);
  }
}

console.log(
  errors === 0
    ? `\nГотово: ошибок нет${warnings ? `, предупреждений: ${warnings}` : ""}.`
    : `\nНайдено ошибок: ${errors}. Исправьте их перед публикацией.`,
);
process.exit(errors === 0 ? 0 : 1);
