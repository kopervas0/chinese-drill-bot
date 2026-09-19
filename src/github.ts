// Минимальный клиент GitHub Contents API: чтение, запись и удаление файлов в репозитории.
// Токен нигде не логируется и не попадает в ответы.
export interface GithubConfig {
  token: string;
  repo: string; // owner/name
  branch: string;
  fetchImpl?: typeof fetch;
}

export class GithubError extends Error {
  constructor(public status: number) {
    super(`GitHub ответил ${status}`);
  }
}

export interface Github {
  list(dir: string): Promise<{ name: string; sha: string; type: string }[]>;
  get(path: string): Promise<{ text: string; sha: string } | null>;
  getBinaryExists(path: string): Promise<boolean>;
  put(path: string, content: Buffer, message: string, sha?: string): Promise<{ sha: string }>;
  remove(path: string, sha: string, message: string): Promise<void>;
}

export function createGithub(cfg: GithubConfig): Github {
  if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/(?!\.{1,2}$)[A-Za-z0-9_.-]{1,100}$/.test(cfg.repo)) {
    throw new Error("GITHUB_REPO: ожидается owner/name");
  }
  const doFetch = cfg.fetchImpl ?? fetch;
  const base = `https://api.github.com/repos/${cfg.repo}/contents`;
  const url = (path: string) => `${base}/${path.split("/").map(encodeURIComponent).join("/")}`;

  async function call(method: string, path: string, body?: unknown, query = ""): Promise<any> {
    const res = await doFetch(`${url(path)}${query}`, {
      method,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${cfg.token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "chinese-drill-bot",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new GithubError(res.status);
    return res.status === 204 ? {} : res.json();
  }

  const ref = `?ref=${encodeURIComponent(cfg.branch)}`;

  return {
    async list(dir) {
      const data = await call("GET", dir, undefined, ref);
      if (!Array.isArray(data)) return [];
      return data.map((f: any) => ({ name: String(f.name), sha: String(f.sha), type: String(f.type) }));
    },
    async get(path) {
      const data = await call("GET", path, undefined, ref);
      if (!data || Array.isArray(data) || typeof data.content !== "string") return null;
      return { text: Buffer.from(data.content, "base64").toString("utf-8"), sha: String(data.sha) };
    },
    async getBinaryExists(path) {
      const data = await call("GET", path, undefined, ref);
      return data !== null;
    },
    async put(path, content, message, sha) {
      const data = await call("PUT", path, {
        message,
        content: content.toString("base64"),
        branch: cfg.branch,
        ...(sha ? { sha } : {}),
      });
      return { sha: String(data?.content?.sha ?? "") };
    },
    async remove(path, sha, message) {
      await call("DELETE", path, { message, sha, branch: cfg.branch });
    },
  };
}
