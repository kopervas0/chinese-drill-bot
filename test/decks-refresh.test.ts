import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { decks, refreshDecksFromSite } from "../src/flashcards.js";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function site(files: Record<string, unknown>) {
  const asked: string[] = [];
  globalThis.fetch = (async (url: URL | string) => {
    const path = new URL(String(url)).pathname;
    asked.push(path);
    const body = files[path];
    return { ok: body !== undefined, status: body === undefined ? 404 : 200, json: async () => body } as Response;
  }) as typeof fetch;
  return asked;
}

const mini = (name: string) => ({ name, tests: [{ question: "q", options: ["a", "b"], answer: 0 }] });

test("обновление с сайта: новые колоды добавляются, пропавшие удаляются", async () => {
  const base = "/app/";
  site({ [`${base}decks/index.json`]: [{ id: "old-only" }], [`${base}decks/old-only.json`]: mini("Old") });
  await refreshDecksFromSite("https://site.example" + base);
  assert.equal(decks.get("old-only")?.name, "Old");
  site({
    [`${base}decks/index.json`]: [{ id: "fresh" }, { id: "../evil" }],
    [`${base}decks/fresh.json`]: mini("Свежая"),
  });
  await refreshDecksFromSite("https://site.example" + base);
  assert.equal(decks.get("fresh")?.name, "Свежая");
  assert.equal(decks.has("old-only"), false);
  assert.equal(decks.has("../evil"), false);
  decks.delete("fresh");
});

test("недоступный сайт или пустой список: встроенные колоды остаются", async () => {
  const before = [...decks.keys()].sort();
  globalThis.fetch = (async () => {
    throw new Error("offline");
  }) as typeof fetch;
  await refreshDecksFromSite("https://site.example/");
  assert.deepEqual([...decks.keys()].sort(), before);
  site({ "/decks/index.json": [] });
  await refreshDecksFromSite("https://site.example/");
  assert.deepEqual([...decks.keys()].sort(), before);
});
