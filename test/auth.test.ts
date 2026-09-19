import assert from "node:assert/strict";
import { test } from "node:test";
import { verifyInitData } from "../src/telegramAuth.js";
import { BOT_TOKEN, signInitData } from "./helpers.js";

test("верная подпись принимается и отдаёт id", () => {
  const r = verifyInitData(signInitData({ id: 4242 }), BOT_TOKEN);
  assert.deepEqual(r, { ok: true, userId: 4242 });
});

test("подпись с полем signature принимается в обоих вариантах состава строки", () => {
  assert.equal(verifyInitData(signInitData({ id: 1 }, { withSignatureField: true }), BOT_TOKEN).ok, true);
  assert.equal(
    verifyInitData(signInitData({ id: 1 }, { withSignatureField: true, signatureInHash: false }), BOT_TOKEN).ok,
    true,
  );
});

test("подпись чужого бота отклоняется", () => {
  const r = verifyInitData(signInitData({ id: 1 }, { token: "999:OTHER" }), BOT_TOKEN);
  assert.equal(r.ok, false);
});

test("подмена id пользователя ломает подпись", () => {
  const data = new URLSearchParams(signInitData({ id: 1 }));
  data.set("user", JSON.stringify({ id: 2 }));
  assert.equal(verifyInitData(data.toString(), BOT_TOKEN).ok, false);
});

test("нет подписи, пустая строка и мусор отклоняются", () => {
  assert.equal(verifyInitData("", BOT_TOKEN).ok, false);
  assert.equal(verifyInitData("auth_date=1&user={}", BOT_TOKEN).ok, false);
  assert.equal(verifyInitData("hash=" + "0".repeat(64), BOT_TOKEN).ok, false);
  assert.equal(verifyInitData("x".repeat(5000), BOT_TOKEN).ok, false);
});

test("устаревшие и «из будущего» данные отклоняются", () => {
  const now = Date.now();
  const old = signInitData({ id: 1 }, { authDate: Math.floor(now / 1000) - 25 * 3600 });
  const future = signInitData({ id: 1 }, { authDate: Math.floor(now / 1000) + 3600 });
  assert.equal(verifyInitData(old, BOT_TOKEN, 24 * 3600, now).ok, false);
  assert.equal(verifyInitData(future, BOT_TOKEN, 24 * 3600, now).ok, false);
  const fresh = signInitData({ id: 1 }, { authDate: Math.floor(now / 1000) - 3600 });
  assert.equal(verifyInitData(fresh, BOT_TOKEN, 24 * 3600, now).ok, true);
});
