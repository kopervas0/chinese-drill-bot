import assert from "node:assert/strict";
import { test } from "node:test";
import { AUDIO_RE, DECK_ID_RE } from "../src/deckValidate.js";

test("аудио: путь на сайте или file_id, чужие адреса запрещены", () => {
  for (const good of ["audio/hello.mp3", "audio/a-b_c.ogg", "AwACAgIAAxkBAAIBQ2dexampleFileId123"]) assert.equal(AUDIO_RE.test(good), true, good);
  for (const bad of ["http://evil.example/x.mp3", "//evil/x.mp3", "audio/../x.mp3", "../audio/x.mp3", "audio/x.exe", "/etc/passwd", "audio/a b.mp3"]) {
    assert.equal(AUDIO_RE.test(bad), false, bad);
  }
});

test("код колоды: только латиница, цифры, - и _", () => {
  for (const good of ["hsk4", "a_b-c", "X"]) assert.equal(DECK_ID_RE.test(good), true);
  for (const bad of ["", "a.b", "../x", "a b", "x".repeat(31), "колода"]) assert.equal(DECK_ID_RE.test(bad), false);
});
