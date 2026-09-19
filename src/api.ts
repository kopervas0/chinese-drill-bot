// API редактора для учителя: колоды и аудио хранятся в репозитории GitHub (каждое
// сохранение — коммит). Доступ только у Telegram-аккаунтов из списка учителей.
// Идентификатор учителя используется лишь для сверки со списком и не сохраняется и не логируется.
import type { IncomingMessage, ServerResponse } from "node:http";
import { DECK_ID_RE, DeckFile, sanitizeDeck } from "./deckValidate.js";
import { Github, GithubError } from "./github.js";
import { verifyInitData } from "./telegramAuth.js";

export interface ApiConfig {
  botToken: string;
  teacherIds: Set<number>;
  github: Github;
  // Origin мини-приложения (CORS): запросы браузера принимаются только оттуда
  allowedOrigin: string;
  // Вызывается после успешного сохранения (null — колода удалена)
  onDeckChange?: (id: string, deck: DeckFile | null) => void;
  now?: () => number;
}

const DECKS_DIR = "data/decks";
const AUDIO_DIR = "webapp/audio";
const MAX_JSON_BYTES = 500_000;
const MAX_AUDIO_BYTES = 3_000_000;
const RATE_LIMIT = 120; // запросов в минуту на весь API
const AUDIO_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,40}\.(mp3|ogg|oga|opus|m4a|wav)$/;

class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public extra?: Record<string, unknown>,
  ) {
    super(message);
  }
}

function looksLikeAudio(buf: Buffer, ext: string): boolean {
  if (buf.length < 12) return false;
  const head = buf.subarray(0, 4).toString("latin1");
  if (ext === "mp3") return head.startsWith("ID3") || (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0);
  if (ext === "wav") return head === "RIFF" && buf.subarray(8, 12).toString("latin1") === "WAVE";
  if (ext === "m4a") return buf.subarray(4, 8).toString("latin1") === "ftyp";
  return head === "OggS"; // ogg, oga, opus
}

async function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  const declared = Number(req.headers["content-length"] ?? 0);
  if (declared > limit) throw new HttpError(413, "Слишком большой запрос");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new HttpError(413, "Слишком большой запрос");
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

export function createApiHandler(cfg: ApiConfig): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const now = cfg.now ?? (() => Date.now());
  const hits: number[] = [];
  const gh = cfg.github;

  const rateLimited = (): boolean => {
    const t = now();
    while (hits.length && hits[0] < t - 60_000) hits.shift();
    if (hits.length >= RATE_LIMIT) return true;
    hits.push(t);
    return false;
  };

  function send(res: ServerResponse, status: number, body: unknown, origin?: string) {
    const headers: Record<string, string> = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" };
    if (origin === cfg.allowedOrigin) {
      headers["Access-Control-Allow-Origin"] = origin;
      headers["Vary"] = "Origin";
    }
    res.writeHead(status, headers).end(JSON.stringify(body));
  }

  async function readDeck(id: string): Promise<{ raw: unknown; sha: string } | null> {
    const file = await gh.get(`${DECKS_DIR}/${id}.json`);
    if (!file) return null;
    try {
      return { raw: JSON.parse(file.text), sha: file.sha };
    } catch {
      throw new HttpError(422, "Файл колоды не читается как JSON");
    }
  }

  function commitMessage(action: string, id: string): string {
    return `Редактор: ${action} ${id}`;
  }

  return async (req, res) => {
    const origin = typeof req.headers.origin === "string" ? req.headers.origin : undefined;
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const parts = url.pathname.split("/").filter(Boolean); // ["api", ...]

      if (req.method === "OPTIONS") {
        if (origin !== cfg.allowedOrigin) throw new HttpError(403, "Источник не разрешён");
        res
          .writeHead(204, {
            "Access-Control-Allow-Origin": origin,
            "Access-Control-Allow-Methods": "GET, PUT, POST, DELETE, OPTIONS",
            "Access-Control-Allow-Headers": "authorization, content-type",
            "Access-Control-Max-Age": "600",
            Vary: "Origin",
          })
          .end();
        return;
      }

      const auth = /^tma (.+)$/.exec(String(req.headers.authorization ?? ""));
      const who = verifyInitData(auth?.[1] ?? "", cfg.botToken, undefined, now());
      if (!who.ok) throw new HttpError(401, `Нет доступа: ${who.reason}`);
      if (!cfg.teacherIds.has(who.userId)) throw new HttpError(403, "Нет доступа: этот аккаунт не в списке учителей");
      // Лимит считаем только для вошедших учителей, чтобы посторонние не могли занять его
      // (проверка подписи для чужих запросов дешёвая и до тела запроса не доходит).
      if (rateLimited()) throw new HttpError(429, "Слишком много запросов, подождите минуту");

      // GET /api/decks
      if (parts[1] === "decks" && parts.length === 2) {
        if (req.method !== "GET") throw new HttpError(405, "Метод не поддерживается");
        const files = (await gh.list(DECKS_DIR)).filter((f) => f.type === "file" && f.name.endsWith(".json"));
        const decks = await Promise.all(
          files.map(async (f) => {
            const id = f.name.replace(/\.json$/, "");
            const d = await readDeck(id).catch(() => null);
            const s = d ? sanitizeDeck(d.raw, { lenient: true }) : null;
            const deck = s && s.ok ? s.deck : null;
            return {
              id,
              name: deck?.name ?? id,
              cards: deck?.cards?.length ?? 0,
              tests: deck?.tests?.length ?? 0,
              pairs: deck?.pairs?.length ?? 0,
              cloze: deck?.cloze?.length ?? 0,
            };
          }),
        );
        send(res, 200, { decks }, origin);
        return;
      }

      // /api/decks/:id
      if (parts[1] === "decks" && parts.length === 3) {
        const id = parts[2];
        if (!DECK_ID_RE.test(id)) throw new HttpError(400, "Код колоды: латиница, цифры, - и _, до 30 символов");

        if (req.method === "GET") {
          const d = await readDeck(id);
          if (!d) throw new HttpError(404, "Колода не найдена");
          const s = sanitizeDeck(d.raw, { lenient: true });
          if (!s.ok) throw new HttpError(422, "Файл колоды не читается");
          send(res, 200, { deck: s.deck, sha: d.sha, dropped: s.dropped }, origin);
          return;
        }

        if (req.method === "PUT") {
          if (!String(req.headers["content-type"] ?? "").startsWith("application/json")) {
            throw new HttpError(415, "Ожидается application/json");
          }
          let body: { deck?: unknown; sha?: unknown };
          try {
            body = JSON.parse((await readBody(req, MAX_JSON_BYTES)).toString("utf-8"));
          } catch (e) {
            if (e instanceof HttpError) throw e;
            throw new HttpError(400, "Тело запроса не читается как JSON");
          }
          const s = sanitizeDeck(body.deck);
          if (!s.ok) throw new HttpError(400, "Колода не прошла проверку", { errors: s.errors });

          const sha = typeof body.sha === "string" && /^[0-9a-f]{40}$/.test(body.sha) ? body.sha : undefined;
          if (!sha && (await readDeck(id).catch(() => ({ exists: true })))) {
            throw new HttpError(409, "Колода с таким кодом уже есть, выберите другой код");
          }
          const text = JSON.stringify(s.deck, null, 2) + "\n";
          const saved = await gh.put(`${DECKS_DIR}/${id}.json`, Buffer.from(text, "utf-8"), commitMessage(sha ? "колода" : "новая колода", id), sha);
          cfg.onDeckChange?.(id, s.deck);
          send(res, 200, { ok: true, sha: saved.sha }, origin);
          return;
        }

        if (req.method === "DELETE") {
          const sha = url.searchParams.get("sha") ?? "";
          const current = await readDeck(id);
          if (!current) throw new HttpError(404, "Колода не найдена");
          if (sha !== current.sha) throw new HttpError(409, "Колода изменилась, обновите страницу");
          await gh.remove(`${DECKS_DIR}/${id}.json`, current.sha, commitMessage("удалена колода", id));
          cfg.onDeckChange?.(id, null);
          send(res, 200, { ok: true }, origin);
          return;
        }
        throw new HttpError(405, "Метод не поддерживается");
      }

      // /api/audio
      if (parts[1] === "audio" && parts.length === 2) {
        if (req.method === "GET") {
          const files = (await gh.list(AUDIO_DIR)).filter((f) => f.type === "file" && AUDIO_NAME_RE.test(f.name));
          send(res, 200, { files: files.map((f) => `audio/${f.name}`) }, origin);
          return;
        }
        if (req.method === "POST") {
          const name = url.searchParams.get("name") ?? "";
          const m = AUDIO_NAME_RE.exec(name);
          if (!m) throw new HttpError(400, "Имя файла: строчные латинские буквы, цифры, - и _, расширение mp3, ogg, m4a или wav");
          const buf = await readBody(req, MAX_AUDIO_BYTES);
          if (!looksLikeAudio(buf, m[1])) throw new HttpError(400, "Файл не похож на аудио выбранного формата");
          if (await gh.getBinaryExists(`${AUDIO_DIR}/${name}`)) throw new HttpError(409, "Файл с таким именем уже есть, выберите другое имя");
          await gh.put(`${AUDIO_DIR}/${name}`, buf, commitMessage("аудио", name));
          send(res, 200, { ok: true, path: `audio/${name}` }, origin);
          return;
        }
        throw new HttpError(405, "Метод не поддерживается");
      }

      throw new HttpError(404, "Не найдено");
    } catch (e) {
      if (e instanceof HttpError) {
        send(res, e.status, { error: e.message, ...e.extra }, origin);
        return;
      }
      if (e instanceof GithubError) {
        const status = e.status === 409 || e.status === 422 ? 409 : 502;
        const msg =
          status === 409
            ? "Файл изменился на сервере, обновите страницу и повторите"
            : e.status === 401 || e.status === 403
              ? "Сервер не смог обратиться к GitHub: проверьте токен и его права"
              : "GitHub временно недоступен, повторите позже";
        console.error("Ошибка GitHub:", e.status);
        send(res, status, { error: msg }, origin);
        return;
      }
      console.error("Ошибка API:", e instanceof Error ? e.message : String(e));
      if (!res.headersSent) send(res, 500, { error: "Ошибка сервера" }, origin);
    }
  };
}
