// Копирует колоды из data/decks в webapp/decks и пишет index.json.
// Источник правды для колод один: и бот, и мини-приложение читают data/decks.
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const src = join(root, "data", "decks");
const dst = join(root, "webapp", "decks");

const strokesDst = join(root, "webapp", "strokes");
rmSync(dst, { recursive: true, force: true });
rmSync(strokesDst, { recursive: true, force: true });
mkdirSync(dst, { recursive: true });

const index = [];
const chars = new Set();
for (const file of readdirSync(src).filter((f) => f.endsWith(".json")).sort()) {
  copyFileSync(join(src, file), join(dst, file));
  const deck = JSON.parse(readFileSync(join(src, file), "utf-8"));
  const count = ["cards", "tests", "pairs", "cloze"].reduce((n, key) => n + (Array.isArray(deck[key]) ? deck[key].length : 0), 0);
  for (const card of Array.isArray(deck.cards) ? deck.cards : []) {
    for (const ch of String(card?.hanzi ?? "")) chars.add(ch);
  }
  index.push({ id: file.replace(/\.json$/, ""), name: deck.name, count });
}
writeFileSync(join(dst, "index.json"), JSON.stringify(index));
console.log(`webapp/decks: ${index.length} колод`);

// Режим «Письмо»: библиотека Hanzi Writer (MIT) и данные о чертах только для иероглифов из колод.
// Данные черт (hanzi-writer-data, Arphic Public License) лежат в node_modules, в репозиторий не попадают.
const vendor = join(root, "webapp", "vendor");
mkdirSync(vendor, { recursive: true });
copyFileSync(join(root, "node_modules", "hanzi-writer", "dist", "hanzi-writer.min.js"), join(vendor, "hanzi-writer.min.js"));
const dataDir = join(root, "node_modules", "hanzi-writer-data");
mkdirSync(strokesDst, { recursive: true });
let strokes = 0;
for (const ch of chars) {
  const from = join(dataDir, ch + ".json");
  if (!/^[一-鿿㐀-䶿]$/u.test(ch) || !existsSync(from)) continue;
  copyFileSync(from, join(strokesDst, ch.codePointAt(0).toString(16) + ".json"));
  strokes++;
}
console.log(`webapp/strokes: ${strokes} из ${chars.size} иероглифов`);
