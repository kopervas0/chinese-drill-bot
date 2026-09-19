import { createHmac, timingSafeEqual } from "node:crypto";

export type AuthResult = { ok: true; userId: number } | { ok: false; reason: string };

// Проверка подписи данных мини-приложения (initData), которые Telegram выдаёт при
// запуске: https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
// Возвращает id пользователя только для сверки со списком учителей, id не сохраняется.
export function verifyInitData(
  initData: string,
  botToken: string,
  maxAgeSec = 24 * 60 * 60,
  nowMs = Date.now(),
): AuthResult {
  if (!initData || initData.length > 4096) return { ok: false, reason: "нет данных входа" };

  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash || !/^[0-9a-f]{64}$/.test(hash)) return { ok: false, reason: "нет подписи" };

  const secret = createHmac("sha256", "WebAppData").update(botToken).digest();
  const matches = (exclude: string[]): boolean => {
    const entries = [...params.entries()].filter(([k]) => !exclude.includes(k));
    entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    const calc = createHmac("sha256", secret)
      .update(entries.map(([k, v]) => `${k}=${v}`).join("\n"))
      .digest("hex");
    return timingSafeEqual(Buffer.from(calc), Buffer.from(hash));
  };
  // в новых версиях Telegram добавляет поле signature: пробуем оба варианта состава строки
  if (!matches(["hash"]) && !(params.has("signature") && matches(["hash", "signature"]))) {
    return { ok: false, reason: "подпись не сошлась" };
  }

  const authDate = Number(params.get("auth_date"));
  if (!Number.isInteger(authDate)) return { ok: false, reason: "нет даты входа" };
  const age = nowMs / 1000 - authDate;
  if (age > maxAgeSec || age < -300) return { ok: false, reason: "данные входа устарели, откройте редактор заново" };

  let user: unknown;
  try {
    user = JSON.parse(params.get("user") ?? "");
  } catch {
    return { ok: false, reason: "нет данных пользователя" };
  }
  const id = (user as { id?: unknown } | null)?.id;
  if (typeof id !== "number" || !Number.isSafeInteger(id)) return { ok: false, reason: "нет данных пользователя" };
  return { ok: true, userId: id };
}
