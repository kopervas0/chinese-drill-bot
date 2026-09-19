// Копирует колоды из data/decks в webapp/decks и пишет index.json.
// Источник правды для колод один: и бот, и мини-приложение читают data/decks.
import { copyFileSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const src = join(root, "data", "decks");
const dst = join(root, "webapp", "decks");

rmSync(dst, { recursive: true, force: true });
mkdirSync(dst, { recursive: true });

const index = [];
for (const file of readdirSync(src).filter((f) => f.endsWith(".json")).sort()) {
  copyFileSync(join(src, file), join(dst, file));
  const deck = JSON.parse(readFileSync(join(src, file), "utf-8"));
  const count = ["cards", "tests", "pairs", "cloze"].reduce((n, key) => n + (Array.isArray(deck[key]) ? deck[key].length : 0), 0);
  index.push({ id: file.replace(/\.json$/, ""), name: deck.name, count });
}
writeFileSync(join(dst, "index.json"), JSON.stringify(index));
console.log(`webapp/decks: ${index.length} колод`);
