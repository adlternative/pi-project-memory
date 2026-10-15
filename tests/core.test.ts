import assert from "node:assert/strict";
import { test } from "node:test";
import { execFile } from "node:child_process";
import { link, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { MemoryStore, clip, hash, projectKey, redact, type Draft, type Memory } from "../src/store.ts";
import { search, tokenize } from "../src/search.ts";
import { parseExtraction } from "../src/intelligence.ts";
import { renderIndex } from "../src/markdown.ts";

export const draft = (id = "package-manager", content = "Use pnpm, not npm, to install dependencies."): Draft => ({
  id, type: "feedback", title: id, content,
  source: { sessionId: "synthetic-session", entryId: "user-entry", quote: "Please remember this preference.", origin: "explicit" },
});

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  await mkdir(resolve(".sandbox"), { recursive: true });
  const root = await mkdtemp(resolve(".sandbox", "core-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, store: new MemoryStore(root, hash("project-a").slice(0, 24)) };
}

test("canonical saves, updates, provenance and deduplication survive a cold read", async t => {
  const { store } = await fixture(t);
  assert.deepEqual(await store.read(), { version: 2, revision: 0, notes: [], forgotten: [], index: renderIndex(null, []) });
  const [saved] = await store.save([draft()]);
  const first = await store.read();
  assert.deepEqual(first, { version: 2, revision: 1, notes: [saved], forgotten: [], index: await readFile(store.indexFile, "utf8") });
  assert.deepEqual(await store.save([draft()]), [saved]);
  assert.equal((await store.read()).revision, 1);
  const [same] = await store.save([draft("another-name")]);
  assert.equal(same.id, saved.id);
  assert.equal((await store.read()).notes.length, 1);
  await store.save([draft("package-manager", "Use bun for this project instead.")]);
  const cold = new MemoryStore(resolve(store.dir, ".."), hash("project-a").slice(0, 24));
  assert.deepEqual(await cold.read(), await store.read());
  assert.equal((await cold.read()).notes[0].createdAt, saved.createdAt);
});

test("parallel writers serialize complete read-modify-write transactions", async t => {
  const { root, store } = await fixture(t);
  const other = new MemoryStore(root, hash("project-a").slice(0, 24));
  await Promise.all(Array.from({ length: 20 }, (_, i) => (i % 2 ? store : other).save([draft("note-" + i, "A distinct fact number " + i)])));
  const state = await store.read();
  assert.equal(state.revision, 20);
  assert.equal(new Set(state.notes.map(note => note.id)).size, 20);
  assert.deepEqual((await readdir(store.dir)).sort(), [".state.json", "MEMORY.md", ...Array.from({ length: 20 }, (_, i) => "note-" + i + ".md")].sort());
});

test("busy/crash-left locks fail closed without deleting another writer's lock", async t => {
  const { store } = await fixture(t);
  await store.save([draft()]);
  const before = await readFile(store.file, "utf8");
  const lock = join(store.dir, ".lock");
  await writeFile(lock, "another-writer");
  await assert.rejects(store.save([draft("other", "Different fact.")]), /busy/);
  assert.equal(await readFile(store.file, "utf8"), before);
  assert.equal(await readFile(lock, "utf8"), "another-writer");
});

test("stale extraction and malformed batches cannot partly overwrite current memory", async t => {
  const { store } = await fixture(t);
  await store.save([draft()]);
  const snapshot = await store.read();
  await store.save([draft("package-manager", "Use bun instead now.")]);
  const current = await store.read();
  await assert.rejects(store.save([draft()], { automatic: true, expectedRevision: snapshot.revision }), /stale/);
  await assert.rejects(store.save([draft("ok", "Valid fact"), draft("../escape", "Invalid fact")]), /Invalid/);
  assert.deepEqual(await store.read(), current);
});

test("forget suppresses automatic resurrection by id AND identical-content hash; explicit restore is possible", async t => {
  const { store } = await fixture(t);
  await store.save([draft()]);
  await store.forget("package-manager");
  assert.deepEqual(await store.save([draft()], { automatic: true }), []);
  assert.deepEqual(await store.save([draft("different-id")], { automatic: true }), []);
  assert.equal((await store.read()).notes.length, 0);
  assert.equal((await store.read()).forgotten.length, 2);
  await store.save([draft()]);
  assert.equal((await store.read()).forgotten.length, 0);
  assert.equal((await store.read()).notes.length, 1);
});

test("invalid JSON, schema changes, oversized files and unsafe ids fail closed", async t => {
  const { store } = await fixture(t);
  await store.save([draft()]);
  for (const body of ["{broken", '{"version":99}', "x".repeat(1024 * 1024 + 1)]) {
    await writeFile(store.file, body);
    await assert.rejects(store.read());
    await assert.rejects(store.save([draft()]));
    assert.equal(await readFile(store.file, "utf8"), body);
    assert.equal((await readdir(store.dir)).some(name => name.endsWith(".tmp") || name === ".lock"), false);
  }
});

test("symlink/hardlink files and symlink directories are rejected without touching their targets", async t => {
  const { store, root } = await fixture(t);
  await store.save([draft()]);
  const target = join(root, "outside");
  await writeFile(target, "DO NOT TOUCH");
  await rm(store.file);
  await symlink(target, store.file);
  await assert.rejects(store.read());
  await assert.rejects(store.save([draft()]));
  assert.equal(await readFile(target, "utf8"), "DO NOT TOUCH");
  await rm(store.file);
  await link(target, store.file);
  await assert.rejects(store.read(), /Unsafe/);
  await rm(store.dir, { recursive: true });
  await symlink(root, store.dir);
  await assert.rejects(store.read(), /symlink/);
});

test("store files are private and invalid inputs never create an empty store", async t => {
  const { root, store } = await fixture(t);
  await assert.rejects(store.save([draft("invalid/path", "no")]));
  assert.deepEqual(await readdir(root), []);
  await store.save([draft()]);
  const { stat } = await import("node:fs/promises");
  if (process.platform !== "win32") {
    assert.equal((await stat(store.file)).mode & 0o777, 0o600);
    assert.equal((await stat(store.dir)).mode & 0o777, 0o700);
  }
});

test("repository common-dir scopes worktrees together, different repos/directories apart", async t => {
  const { root } = await fixture(t);
  const cwd = join(root, "repo"); const sibling = join(root, "other"); const worktree = join(root, "worktree");
  await mkdir(cwd); await mkdir(sibling);
  const git = (...args: string[]) => promisify(execFile)("git", ["-c", "core.hooksPath=/dev/null", ...args], { cwd, env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } });
  await git("init", "-b", "main");
  await git("-c", "user.name=Memory Test", "-c", "user.email=memory@example.invalid", "commit", "--allow-empty", "-m", "test");
  await git("worktree", "add", "-b", "test-worktree", worktree);
  const subdir = join(cwd, "subdir"); await mkdir(subdir);
  assert.equal(await projectKey(cwd), await projectKey(subdir));
  assert.equal(await projectKey(cwd), await projectKey(worktree));
  assert.notEqual(await projectKey(cwd), await projectKey(sibling));
  const alias = join(root, "alias"); await symlink(cwd, alias);
  assert.equal(await projectKey(cwd), await projectKey(alias));
});

test("UTF-8 caps and redaction cover multilingual text and known credential shapes", () => {
  assert.equal(clip("中🙂文abc", 6), "中");
  assert.equal(Buffer.byteLength(clip("中🙂文abc", 8)), 7);
  const secret = "sk-" + "x".repeat(32);
  const text = 'Bearer fakecredentialhere; password=sample-password ' + secret + ' https://example.invalid/?token=sample-token&x=1';
  const redacted = redact(text);
  for (const part of ["fakecredentialhere", "sample-password", secret, "sample-token"]) assert.equal(redacted.includes(part), false);
});

test("credentials cannot be stored as note text or provenance", async t => {
  const { store } = await fixture(t);
  await assert.rejects(store.save([draft("unsafe", "api_key=" + "x".repeat(30))]), /credentials/);
  const note = draft(); note.source.quote = "password=synthetic-password";
  await assert.rejects(store.save([note]), /Secret/);
});

test("BM25 ranks title matches and Chinese text, handles NFKC, returns no fabricated matches", () => {
  const asNote = (input: Draft): Memory => ({ ...input, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" });
  const notes = [
    asNote({ ...draft("frontend", "前端文档写作要简短，重点解释设计取舍。"), title: "前端文档" }),
    asNote(draft("backend", "后端部署必须在测试环境验证。")),
    asNote({ ...draft("pnpm", "Preferred package manager."), title: "pnpm" }),
    asNote(draft("incidental", "Other rules. A pnpm reference appears here.")),
  ];
  assert.equal(search(notes, "前端文档")[0].note.id, "frontend");
  assert.equal(search(notes, "ＰＮＰＭ")[0].note.id, "pnpm");
  assert.deepEqual(search(notes, "doesnotexist"), []);
  assert.deepEqual(search(notes, "!!!"), []);
  assert.ok(tokenize("中文编程").includes("b:编程"));
});

test("extraction validates evidence, role, duplicate ids, secret text and unknown fields", () => {
  const evidence = [{ entryId: "u1", role: "user" as const, text: "Always use pnpm, not npm." }, { entryId: "a1", role: "assistant" as const, text: "A speculative preference." }];
  const memory = { id: "pnpm", type: "feedback", title: "Package manager", content: "Use pnpm.", entryId: "u1", quote: "use pnpm" };
  const parsed = parseExtraction({ memories: [memory] }, evidence, "session");
  assert.equal(parsed[0].source.origin, "extracted");
  for (const item of [
    { ...memory, quote: "invented" },
    { ...memory, entryId: "absent" },
    { ...memory, entryId: "a1", quote: "speculative" },
    { ...memory, unexpected: true },
    { ...memory, content: "token=" + "x".repeat(30) },
  ]) assert.throws(() => parseExtraction({ memories: [item] }, evidence, "session"));
  assert.throws(() => parseExtraction({ memories: [memory, memory] }, evidence, "session"));
});
