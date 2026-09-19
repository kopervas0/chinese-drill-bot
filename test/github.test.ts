import assert from "node:assert/strict";
import { test } from "node:test";
import { createGithub, GithubError } from "../src/github.js";

function mockFetch(handler: (url: string, init: RequestInit) => { status: number; body?: unknown }) {
  const seen: { url: string; init: RequestInit }[] = [];
  const impl = (async (url: string, init: RequestInit) => {
    seen.push({ url, init });
    const r = handler(url, init);
    return { status: r.status, ok: r.status >= 200 && r.status < 300, json: async () => r.body ?? {} } as Response;
  }) as unknown as typeof fetch;
  return { impl, seen };
}

test("get: правильный адрес, заголовки и разбор base64", async () => {
  const { impl, seen } = mockFetch(() => ({ status: 200, body: { content: Buffer.from("привет").toString("base64"), sha: "abc" } }));
  const gh = createGithub({ token: "TKN", repo: "own/repo", branch: "master", fetchImpl: impl });
  const r = await gh.get("data/decks/hsk4.json");
  assert.deepEqual(r, { text: "привет", sha: "abc" });
  assert.equal(seen[0].url, "https://api.github.com/repos/own/repo/contents/data/decks/hsk4.json?ref=master");
  const h = seen[0].init.headers as Record<string, string>;
  assert.equal(h.Authorization, "Bearer TKN");
  assert.equal(h["X-GitHub-Api-Version"], "2022-11-28");
});

test("get/list: 404 означает «нет»", async () => {
  const { impl } = mockFetch(() => ({ status: 404 }));
  const gh = createGithub({ token: "T", repo: "o/r", branch: "master", fetchImpl: impl });
  assert.equal(await gh.get("x.json"), null);
  assert.deepEqual(await gh.list("dir"), []);
});

test("put: ветка, base64, sha только при обновлении", async () => {
  const { impl, seen } = mockFetch(() => ({ status: 200, body: { content: { sha: "new" } } }));
  const gh = createGithub({ token: "T", repo: "o/r", branch: "main", fetchImpl: impl });
  assert.deepEqual(await gh.put("a/b.json", Buffer.from("x"), "msg", "oldsha"), { sha: "new" });
  await gh.put("a/c.json", Buffer.from("y"), "msg");
  const b1 = JSON.parse(String(seen[0].init.body));
  const b2 = JSON.parse(String(seen[1].init.body));
  assert.equal(seen[0].init.method, "PUT");
  assert.deepEqual(b1, { message: "msg", content: Buffer.from("x").toString("base64"), branch: "main", sha: "oldsha" });
  assert.equal("sha" in b2, false);
});

test("ошибки GitHub превращаются в GithubError без токена в сообщении", async () => {
  const { impl } = mockFetch(() => ({ status: 409 }));
  const gh = createGithub({ token: "SECRET-TOKEN", repo: "o/r", branch: "master", fetchImpl: impl });
  await assert.rejects(
    () => gh.put("a.json", Buffer.from("x"), "m"),
    (e: unknown) => e instanceof GithubError && e.status === 409 && !String(e.message).includes("SECRET-TOKEN"),
  );
});

test("некорректное имя репозитория отклоняется", () => {
  for (const repo of ["norepo", "a/b/c", "a b/c", "../x"]) {
    assert.throws(() => createGithub({ token: "T", repo, branch: "master" }));
  }
});

test("сегменты пути кодируются", async () => {
  const { impl, seen } = mockFetch(() => ({ status: 200, body: {} }));
  const gh = createGithub({ token: "T", repo: "o/r", branch: "master", fetchImpl: impl });
  await gh.remove("data/decks/колода#1.json", "sha", "m");
  assert.ok(seen[0].url.includes(encodeURIComponent("колода#1.json")));
  assert.equal(seen[0].init.method, "DELETE");
});
