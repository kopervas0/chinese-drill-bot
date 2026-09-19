import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { applyDeckChange, decks, getSession, refreshDecksFromSite, startSession } from "../src/flashcards.js";

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

test("правка колоды сбрасывает занятия по ней, чужие занятия остаются", () => {
  applyDeckChange("t-live", mini("A"));
  applyDeckChange("t-other", mini("B"));
  startSession(1, "t-live", "tests", null);
  startSession(2, "t-other", "tests", null);
  assert.ok(getSession(1) && getSession(2));
  applyDeckChange("t-live", mini("A2"));
  assert.equal(getSession(1), undefined);
  assert.ok(getSession(2));
  applyDeckChange("t-live", null);
  applyDeckChange("t-other", null);
});

test("занятие по удалённой колоде считается истёкшим, а не роняет бота", () => {
  applyDeckChange("t-gone", mini("G"));
  startSession(5, "t-gone", "tests", null);
  decks.delete("t-gone"); // колоду убрали, минуя applyDeckChange
  assert.equal(getSession(5), undefined);
});

test("обновление с сайта: новые колоды добавляются, пропавшие удаляются", async () => {
  applyDeckChange("old-only", mini("Old"));
  const base = "/app/";
  site({
    [`${base}decks/index.json`]: [{ id: "fresh" }, { id: "../evil" }],
    [`${base}decks/fresh.json`]: mini("Свежая"),
  });
  await refreshDecksFromSite("https://site.example" + base);
  assert.equal(decks.get("fresh")?.name, "Свежая");
  assert.equal(decks.has("old-only"), false);
  assert.equal(decks.has("../evil"), false);
  applyDeckChange("fresh", null);
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
