import assert from "node:assert/strict";
import { test } from "node:test";
import { createBot } from "../src/handlers.js";

const APP = "https://app.example.com/";

async function harness(teacherIds?: Set<number>) {
  const calls: { method: string; payload: any }[] = [];
  const bot = createBot("123:fake", 3, APP, undefined, teacherIds);
  bot.api.config.use(async (_p, method, payload) => {
    calls.push({ method, payload });
    if (method === "getMe") return { ok: true, result: { id: 1, is_bot: true, first_name: "t", username: "t_bot" } } as any;
    return { ok: true, result: { message_id: 1, date: 0, chat: { id: 1, type: "private" }, text: "" } } as any;
  });
  await bot.init();
  let n = 1;
  const send = (userId: number, text: string, chatType = "private") =>
    bot.handleUpdate({
      update_id: n++,
      message: {
        message_id: n,
        date: 0,
        chat: { id: chatType === "private" ? userId : -100, type: chatType },
        from: { id: userId, is_bot: false, first_name: "u" },
        text,
        entities: [{ type: "bot_command", offset: 0, length: text.length }],
      },
    } as any);
  const replies = () => calls.filter((c) => c.method === "sendMessage");
  return { send, replies };
}

test("/teacher: учителю приходит кнопка редактора, адрес строится от адреса приложения", async () => {
  const h = await harness(new Set([7]));
  await h.send(7, "/teacher");
  const r = h.replies();
  assert.equal(r.length, 1);
  assert.equal(r[0].payload.reply_markup.inline_keyboard[0][0].web_app.url, "https://app.example.com/teacher.html");
});

test("/teacher: чужому аккаунту и в группе бот не отвечает вообще", async () => {
  const h = await harness(new Set([7]));
  await h.send(8, "/teacher");
  await h.send(7, "/teacher", "supergroup");
  assert.equal(h.replies().length, 0);
});

test("/teacher не существует, пока список учителей пуст", async () => {
  const h = await harness(undefined);
  await h.send(7, "/teacher");
  assert.equal(h.replies().length, 0);
});

test("/myid отвечает только в личке и только своим id", async () => {
  const h = await harness(undefined);
  await h.send(4242, "/myid");
  assert.match(h.replies()[0].payload.text, /4242/);
  await h.send(4242, "/myid", "supergroup");
  assert.equal(h.replies().length, 1);
});

test("/start не рекламирует /teacher", async () => {
  const h = await harness(new Set([7]));
  await h.send(7, "/start");
  assert.equal(h.replies()[0].payload.text.includes("/teacher"), false);
});
