// Код прогресса: битовая маска "выучено" по карточкам колоды. Хранится у ученика,
// на сервере не хранится и не содержит идентификатора пользователя.
// Формат: <deckId>.<подпись колоды>.<маска base64url>.<контрольная сумма>
import { createHash } from "node:crypto";
import { Deck, decks } from "./flashcards.js";

function hash(s: string): string {
  return createHash("sha256").update(s).digest("hex").slice(0, 4);
}

// Подпись по списку иероглифов: если преподаватель добавит/уберёт карточки,
// старые коды перестанут подходить, а не будут указывать на чужие слова.
function deckSignature(deck: Deck): string {
  return hash(deck.cards.map((c) => c.hanzi).join("|"));
}

export function encodeProgress(deck: Deck, known: Set<number>): string {
  const bytes = Buffer.alloc(Math.ceil(deck.cards.length / 8));
  for (const i of known) {
    if (i >= 0 && i < deck.cards.length) bytes[i >> 3] |= 1 << (i & 7);
  }
  const body = `${deck.id}.${deckSignature(deck)}.${bytes.toString("base64url")}`;
  return `${body}.${hash(body)}`;
}

export type DecodeResult =
  | { ok: true; deck: Deck; known: Set<number> }
  | { ok: false; reason: string };

export function decodeProgress(code: string): DecodeResult {
  const parts = code.trim().split(".");
  if (parts.length < 4) return { ok: false, reason: "Неверный формат кода." };

  const check = parts.pop()!;
  const payload = parts.pop()!;
  const signature = parts.pop()!;
  const deckId = parts.join(".");

  if (hash(`${deckId}.${signature}.${payload}`) !== check) {
    return { ok: false, reason: "Код повреждён. Скопируйте его целиком." };
  }
  const deck = decks.get(deckId);
  if (!deck) return { ok: false, reason: "Колода из этого кода не найдена." };
  if (deckSignature(deck) !== signature) {
    return { ok: false, reason: "Колода изменилась после выдачи кода, он больше не подходит." };
  }
  const bytes = Buffer.from(payload, "base64url");
  if (bytes.length !== Math.ceil(deck.cards.length / 8)) {
    return { ok: false, reason: "Код не подходит к этой колоде." };
  }

  const known = new Set<number>();
  for (let i = 0; i < deck.cards.length; i++) {
    if (bytes[i >> 3] & (1 << (i & 7))) known.add(i);
  }
  return { ok: true, deck, known };
}
