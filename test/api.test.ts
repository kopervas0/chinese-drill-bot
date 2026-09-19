import assert from "node:assert/strict";
import { createServer, Server } from "node:http";
import { after, before, describe, test } from "node:test";
import { createApiHandler } from "../src/api.js";
import type { DeckFile } from "../src/deckValidate.js";
import { BOT_TOKEN, fakeGithub, signInitData } from "./helpers.js";

const ORIGIN = "https://app.example.com";
const TEACHER = 1001;
const STRANGER = 2002;

const deckJson = (deck: object) => JSON.stringify(deck, null, 2) + "\n";
const seedDeck = { name: "HSK 1", cards: [{ hanzi: "你", pinyin: "nǐ", translation: "ты" }] };

let server: Server;
let base: string;
let gh: ReturnType<typeof fakeGithub>;
let changes: [string, DeckFile | null][];
let clock = Date.now();

function setup(seed: Record<string, string | Buffer> = {}) {
  gh = fakeGithub({ "data/decks/hsk1.json": deckJson(seedDeck), "data/decks/broken.json": "{ не json", ...seed });
  changes = [];
  const handler = createApiHandler({
    botToken: BOT_TOKEN,
    teacherIds: new Set([TEACHER]),
    github: gh,
    allowedOrigin: ORIGIN,
    onDeckChange: (id, deck) => changes.push([id, deck]),
    now: () => clock,
  });
  return createServer((req, res) => void handler(req, res));
}

const auth = (id = TEACHER) => ({ Authorization: `tma ${signInitData({ id })}`, Origin: ORIGIN });
const api = (path: string, init: RequestInit & { headers?: Record<string, string> } = {}) => fetch(base + path, init);
const putDeck = (id: string, deck: unknown, sha?: string, headers = auth()) =>
  api(`/api/decks/${id}`, {
    method: "PUT",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ deck, sha }),
  });

before(async () => {
  server = setup();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
after(() => server.close());

// перед каждым тестом чистое хранилище
function reset(seed: Record<string, string | Buffer> = {}) {
  gh = fakeGithub({ "data/decks/hsk1.json": deckJson(seedDeck), "data/decks/broken.json": "{ не json", ...seed });
  changes = [];
  clock += 120_000; // сбрасывает окно ограничения частоты
  server.removeAllListeners("request");
  const handler = createApiHandler({
    botToken: BOT_TOKEN,
    teacherIds: new Set([TEACHER]),
    github: gh,
    allowedOrigin: ORIGIN,
    onDeckChange: (id, deck) => changes.push([id, deck]),
    now: () => clock,
  });
  server.on("request", (req, res) => void handler(req, res));
}

describe("доступ", () => {
  test("без входа, с мусором и с просроченными данными — 401", async () => {
    reset();
    assert.equal((await api("/api/decks")).status, 401);
    assert.equal((await api("/api/decks", { headers: { Authorization: "tma garbage" } })).status, 401);
    assert.equal((await api("/api/decks", { headers: { Authorization: "Bearer x" } })).status, 401);
    const old = signInitData({ id: TEACHER }, { authDate: Math.floor(clock / 1000) - 48 * 3600 });
    assert.equal((await api("/api/decks", { headers: { Authorization: `tma ${old}` } })).status, 401);
    assert.deepEqual(gh.calls, []);
  });

  test("подпись чужого бота — 401", async () => {
    reset();
    const other = signInitData({ id: TEACHER }, { token: "555:OTHER" });
    assert.equal((await api("/api/decks", { headers: { Authorization: `tma ${other}` } })).status, 401);
  });

  test("аккаунт не из списка учителей — 403 и GitHub не трогаем", async () => {
    reset();
    const r = await api("/api/decks", { headers: auth(STRANGER) });
    assert.equal(r.status, 403);
    assert.deepEqual(gh.calls, []);
    const w = await putDeck("hack", seedDeck, undefined, auth(STRANGER));
    assert.equal(w.status, 403);
    assert.equal(gh.files.has("data/decks/hack.json"), false);
  });

  test("ответ об ошибке не содержит id и подписи", async () => {
    reset();
    const r = await api("/api/decks", { headers: auth(STRANGER) });
    const text = await r.text();
    assert.equal(text.includes(String(STRANGER)), false);
  });
});

describe("колоды", () => {
  test("список: считает задания, битые файлы не роняют", async () => {
    reset();
    const r = await api("/api/decks", { headers: auth() });
    assert.equal(r.status, 200);
    const { decks } = (await r.json()) as { decks: { id: string; name: string; cards: number }[] };
    assert.deepEqual(decks.find((d) => d.id === "hsk1"), { id: "hsk1", name: "HSK 1", cards: 1, tests: 0, pairs: 0, cloze: 0 });
    assert.ok(decks.find((d) => d.id === "broken"));
  });

  test("чтение колоды и 404", async () => {
    reset();
    const r = await api("/api/decks/hsk1", { headers: auth() });
    const body = (await r.json()) as { deck: DeckFile; sha: string; dropped: number };
    assert.equal(body.deck.name, "HSK 1");
    assert.match(body.sha, /^[0-9a-f]{40}$/);
    assert.equal((await api("/api/decks/nope", { headers: auth() })).status, 404);
  });

  test("небезопасные коды колод отклоняются до обращения к GitHub", async () => {
    reset();
    for (const id of ["a.b", "..", "%2e%2e", "a%2Fb", "x".repeat(31), "%D0%BA"]) {
      const r = await api(`/api/decks/${id}`, { headers: auth() });
      assert.ok([400, 404].includes(r.status), `${id}: ${r.status}`);
    }
    assert.equal(gh.calls.filter((c) => c.startsWith("get") || c.startsWith("put")).length, 0);
  });

  test("создание: коммит с очищенным JSON и уведомление бота", async () => {
    reset();
    const r = await putDeck("hsk4", { name: " Новая ", cards: [{ hanzi: "经验", pinyin: "jīngyàn", translation: "опыт", evil: 1 }], evil: true });
    assert.equal(r.status, 200);
    const stored = JSON.parse(gh.files.get("data/decks/hsk4.json")!.content.toString());
    assert.deepEqual(stored, { name: "Новая", cards: [{ hanzi: "经验", pinyin: "jīngyàn", translation: "опыт" }] });
    assert.equal(gh.files.get("data/decks/hsk4.json")!.content.toString().endsWith("\n"), true);
    assert.deepEqual(changes[0], ["hsk4", stored]);
  });

  test("повторное создание без sha — 409, с чужим sha — 409, с верным — 200", async () => {
    reset();
    assert.equal((await putDeck("hsk1", seedDeck)).status, 409);
    assert.equal((await putDeck("hsk1", seedDeck, "0".repeat(40))).status, 409);
    const sha = gh.files.get("data/decks/hsk1.json")!.sha;
    const ok = await putDeck("hsk1", { ...seedDeck, name: "HSK 1 (новое)" }, sha);
    assert.equal(ok.status, 200);
    assert.equal(JSON.parse(gh.files.get("data/decks/hsk1.json")!.content.toString()).name, "HSK 1 (новое)");
    // устаревший sha после чужого сохранения
    assert.equal((await putDeck("hsk1", seedDeck, sha)).status, 409);
  });

  test("неверная колода — 400 со списком ошибок и без коммита", async () => {
    reset();
    const r = await putDeck("bad", { name: "X", tests: [{ question: "q", options: ["a", "b"], answer: 7 }] });
    assert.equal(r.status, 400);
    const body = (await r.json()) as { errors: string[] };
    assert.ok(body.errors.some((e) => e.includes("Тест №1")));
    assert.equal(gh.files.has("data/decks/bad.json"), false);
    assert.equal(changes.length, 0);
  });

  test("тип содержимого и размер запроса", async () => {
    reset();
    const wrong = await api("/api/decks/x", { method: "PUT", headers: { ...auth(), "Content-Type": "text/plain" }, body: "{}" });
    assert.equal(wrong.status, 415);
    const huge = await putDeck("huge", { name: "N", cards: [{ hanzi: "a", pinyin: "b", translation: "c".repeat(600_000) }] });
    assert.equal(huge.status, 413);
    const notJson = await api("/api/decks/x", { method: "PUT", headers: { ...auth(), "Content-Type": "application/json" }, body: "{ oops" });
    assert.equal(notJson.status, 400);
  });

  test("удаление требует актуальный sha", async () => {
    reset();
    const sha = gh.files.get("data/decks/hsk1.json")!.sha;
    assert.equal((await api("/api/decks/hsk1?sha=bad", { method: "DELETE", headers: auth() })).status, 409);
    assert.equal(gh.files.has("data/decks/hsk1.json"), true);
    assert.equal((await api(`/api/decks/hsk1?sha=${sha}`, { method: "DELETE", headers: auth() })).status, 200);
    assert.equal(gh.files.has("data/decks/hsk1.json"), false);
    assert.deepEqual(changes.at(-1), ["hsk1", null]);
    assert.equal((await api(`/api/decks/hsk1?sha=${sha}`, { method: "DELETE", headers: auth() })).status, 404);
  });

  test("неизвестный маршрут и метод", async () => {
    reset();
    assert.equal((await api("/api/unknown", { headers: auth() })).status, 404);
    assert.equal((await api("/api/decks", { method: "POST", headers: auth() })).status, 405);
  });
});

describe("аудио", () => {
  const mp3 = Buffer.concat([Buffer.from("ID3"), Buffer.alloc(40, 1)]);
  const upload = (name: string, body: Buffer, headers = auth()) =>
    api(`/api/audio?name=${encodeURIComponent(name)}`, { method: "POST", headers: { ...headers, "Content-Type": "audio/mpeg" }, body });

  test("загрузка mp3 и список", async () => {
    reset();
    const r = await upload("hello-1.mp3", mp3);
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { ok: true, path: "audio/hello-1.mp3" });
    assert.equal(gh.files.has("webapp/audio/hello-1.mp3"), true);
    const list = (await (await api("/api/audio", { headers: auth() })).json()) as { files: string[] };
    assert.deepEqual(list.files, ["audio/hello-1.mp3"]);
  });

  test("файл, не похожий на аудио, и запрещённые имена отклоняются", async () => {
    reset();
    assert.equal((await upload("x.mp3", Buffer.from("<html>not audio at all</html>"))).status, 400);
    assert.equal((await upload("x.wav", mp3)).status, 400);
    for (const name of ["../x.mp3", "X.mp3", "a b.mp3", "x.exe", "x.mp3.exe", "", ".mp3", "a/b.mp3"]) {
      assert.equal((await upload(name, mp3)).status, 400, name);
    }
    assert.equal([...gh.files.keys()].filter((k) => k.startsWith("webapp/")).length, 0);
  });

  test("существующий файл не перезаписывается, большой — 413", async () => {
    reset({ "webapp/audio/taken.mp3": mp3 });
    assert.equal((await upload("taken.mp3", mp3)).status, 409);
    assert.equal((await upload("big.mp3", Buffer.concat([Buffer.from("ID3"), Buffer.alloc(3_100_000)]))).status, 413);
  });

  test("загрузка только для учителя", async () => {
    reset();
    assert.equal((await upload("a.mp3", mp3, auth(STRANGER))).status, 403);
    assert.equal(gh.files.has("webapp/audio/a.mp3"), false);
  });
});

describe("CORS и ограничения", () => {
  test("предварительный запрос: разрешённый источник — 204, чужой — 403", async () => {
    reset();
    const ok = await api("/api/decks", { method: "OPTIONS", headers: { Origin: ORIGIN } });
    assert.equal(ok.status, 204);
    assert.equal(ok.headers.get("access-control-allow-origin"), ORIGIN);
    assert.match(ok.headers.get("access-control-allow-headers") ?? "", /authorization/);
    const bad = await api("/api/decks", { method: "OPTIONS", headers: { Origin: "https://evil.example" } });
    assert.equal(bad.status, 403);
    assert.equal(bad.headers.get("access-control-allow-origin"), null);
  });

  test("заголовок CORS только для разрешённого источника, ответы не кешируются", async () => {
    reset();
    const good = await api("/api/decks", { headers: auth() });
    assert.equal(good.headers.get("access-control-allow-origin"), ORIGIN);
    assert.equal(good.headers.get("cache-control"), "no-store");
    const evil = await api("/api/decks", { headers: { ...auth(), Origin: "https://evil.example" } });
    assert.equal(evil.headers.get("access-control-allow-origin"), null);
  });

  test("ограничение частоты: после 120 запросов учителя в минуту — 429, через минуту снимается", async () => {
    reset();
    let last = 0;
    for (let i = 0; i < 125; i++) last = (await api("/api/decks", { headers: auth() })).status;
    assert.equal(last, 429);
    clock += 61_000;
    assert.equal((await api("/api/decks", { headers: auth() })).status, 200);
  });

  test("посторонние запросы не съедают лимит учителя", async () => {
    reset();
    for (let i = 0; i < 300; i++) await api("/api/decks", { headers: {} });
    for (let i = 0; i < 50; i++) await api("/api/decks", { headers: auth(STRANGER) });
    assert.equal((await api("/api/decks", { headers: auth() })).status, 200);
  });
});
