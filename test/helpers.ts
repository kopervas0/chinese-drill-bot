import { createHash, createHmac } from "node:crypto";
import { Github, GithubError } from "../src/github.js";

export const BOT_TOKEN = "123456:TEST-TOKEN";

// Подпись данных мини-приложения так, как её делает Telegram.
export function signInitData(
  user: { id: number; first_name?: string },
  opts: { token?: string; authDate?: number; withSignatureField?: boolean; signatureInHash?: boolean } = {},
): string {
  const token = opts.token ?? BOT_TOKEN;
  const params: Record<string, string> = {
    auth_date: String(opts.authDate ?? Math.floor(Date.now() / 1000)),
    query_id: "AAHtest",
    user: JSON.stringify({ first_name: "T", ...user }),
  };
  if (opts.withSignatureField) params.signature = "sig-value-not-checked-here";
  const secret = createHmac("sha256", "WebAppData").update(token).digest();
  const inHash = { ...params };
  if (opts.withSignatureField && opts.signatureInHash === false) delete inHash.signature;
  const check = Object.entries(inHash)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
  const hash = createHmac("sha256", secret).update(check).digest("hex");
  return new URLSearchParams({ ...params, hash }).toString();
}

// GitHub в памяти: те же правила sha, что у настоящего Contents API.
export function fakeGithub(seed: Record<string, string | Buffer> = {}): Github & {
  files: Map<string, { content: Buffer; sha: string }>;
  calls: string[];
} {
  const sha = (b: Buffer) => createHash("sha1").update(b).digest("hex");
  const files = new Map<string, { content: Buffer; sha: string }>();
  const calls: string[] = [];
  for (const [path, content] of Object.entries(seed)) {
    const buf = Buffer.isBuffer(content) ? content : Buffer.from(content);
    files.set(path, { content: buf, sha: sha(buf) });
  }
  return {
    files,
    calls,
    async list(dir) {
      calls.push(`list ${dir}`);
      return [...files.entries()]
        .filter(([p]) => p.startsWith(`${dir}/`) && !p.slice(dir.length + 1).includes("/"))
        .map(([p, f]) => ({ name: p.slice(dir.length + 1), sha: f.sha, type: "file" }));
    },
    async get(path) {
      calls.push(`get ${path}`);
      const f = files.get(path);
      return f ? { text: f.content.toString("utf-8"), sha: f.sha } : null;
    },
    async getBinaryExists(path) {
      calls.push(`exists ${path}`);
      return files.has(path);
    },
    async put(path, content, _message, expectedSha) {
      calls.push(`put ${path}`);
      const cur = files.get(path);
      if (cur && !expectedSha) throw new GithubError(422);
      if (cur && cur.sha !== expectedSha) throw new GithubError(409);
      if (!cur && expectedSha) throw new GithubError(422);
      const entry = { content, sha: sha(content) };
      files.set(path, entry);
      return { sha: entry.sha };
    },
    async remove(path, expectedSha) {
      calls.push(`remove ${path}`);
      const cur = files.get(path);
      if (!cur) throw new GithubError(404);
      if (cur.sha !== expectedSha) throw new GithubError(409);
      files.delete(path);
    },
  };
}
