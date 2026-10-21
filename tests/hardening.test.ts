import assert from "node:assert/strict";
import { test } from "node:test";
import { fork } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { join, resolve } from "node:path";
import { MemoryStore, hash, redact, type Draft, type Memory } from "../src/store.ts";
import { search } from "../src/search.ts";

const d = (id: string, content: string, title = id): Draft => ({ id, type: "project", title, content, source: { sessionId: "s", entryId: "e", quote: "q", origin: "explicit" } });
const key = hash("hardening").slice(0, 24);
async function fixture(t: { after(fn: () => Promise<void>): void }) {
  await mkdir(resolve(".sandbox"), { recursive: true });
  const root = await mkdtemp(resolve(".sandbox", "hard-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, store: new MemoryStore(root, key, "hard") };
}

if (process.argv[2] === "child") {
  const store = new MemoryStore(process.argv[3], key, "hard");
  let ok = 0;
  for (let i = 0; i < 15; i++) { await store.save([d(`c${process.argv[4]}-${i}`, `fact ${process.argv[4]} ${i}`)]); ok++; }
  process.send!(ok); process.exit(0);
}

test("one broken topic file does not hide the others from tolerant reads, and blocks writes", async t => {
  const { store } = await fixture(t);
  await store.save([d("a", "fact a"), d("b", "fact b")]);
  const state = await readFile(store.file, "utf8");
  await writeFile(join(store.dir, "b.md"), "no frontmatter\n");
  const tolerant = await store.read({ tolerant: true });
  assert.deepEqual(tolerant.notes.map(n => n.id), ["a"]);
  assert.deepEqual(tolerant.invalid?.map(i => i.file), ["b.md"]);
  assert.equal(tolerant.forgotten.length, 0, "a broken file is not treated as deleted");
  await assert.rejects(store.read());
  await assert.rejects(store.save([d("c", "fact c")]));
  assert.equal(await readFile(store.file, "utf8"), state, "nothing is reconciled while a file is broken");
  await writeFile(join(store.dir, "b.md"), "---\nname: b\ntype: project\n---\n\nfact b fixed\n");
  assert.equal((await store.read()).notes.length, 2);
});

test("tombstones roll over instead of bricking forget", async t => {
  const { store } = await fixture(t);
  for (let i = 0; i < 300; i++) { await store.save([d(`n${i}`, `fact ${i}`)]); await store.forget(`n${i}`); }
  const state = await store.read();
  assert.equal(state.forgotten.length, 512);
  assert.ok(state.forgotten.includes("n299"));
  assert.ok(!state.forgotten.includes("n0"));
});

test("a lock left by a dead local process is reclaimed; a live or foreign lock is not", async t => {
  const { store } = await fixture(t);
  await store.save([d("a", "x")]);
  const lock = join(store.dir, ".lock");
  await writeFile(lock, JSON.stringify({ pid: 2 ** 22 + 12345, host: hostname(), nonce: "dead" }));
  await store.save([d("b", "y")]);
  await assert.rejects(readFile(lock), /ENOENT/);
  for (const owner of [{ pid: process.pid, host: hostname() }, { pid: 2 ** 22 + 12345, host: "other-host" }, "garbage"]) {
    const body = typeof owner === "string" ? owner : JSON.stringify(owner);
    await writeFile(lock, body);
    await assert.rejects(store.save([d("c", "z")]), /busy/);
    assert.equal(await readFile(lock, "utf8"), body);
  }
  await unlink(lock);
});

test("concurrent processes wait for the lock instead of failing", async t => {
  const { root } = await fixture(t);
  await new MemoryStore(root, key, "hard").save([d("seed", "seed")]);
  const counts = await Promise.all([0, 1, 2, 3].map(n => new Promise<number>((done, fail) => {
    fork(process.argv[1], ["child", root, String(n)], { execArgv: process.execArgv }).on("message", m => done(m as number)).on("exit", code => code && fail(new Error(`child ${code}`)));
  })));
  assert.deepEqual(counts, [15, 15, 15, 15]);
  assert.equal((await new MemoryStore(root, key, "hard").read()).notes.length, 61);
});

test("saving identical content under a new id returns the existing note untouched", async t => {
  const { store } = await fixture(t);
  await store.save([d("deploy", "Run make deploy", "Deploy")]);
  const [result] = await store.save([d("release", "Run make deploy", "Release checklist")]);
  assert.equal(result.id, "deploy");
  assert.deepEqual((await store.read()).notes.map(n => `${n.id}:${n.title}`), ["deploy:Deploy"]);
});

test("credential rules keep prose but still catch secret-shaped values", () => {
  for (const prose of ["password: \u8bf7\u627e\u8fd0\u7ef4\u7533\u8bf7", "CI \u7684 token: \u5b58\u5728 Vault \u91cc", "secret=\u89c1 1Password", "token=environment"]) assert.equal(redact(prose), prose);
  for (const secret of ["password: hunter22", "api_key=\"abcd1234efgh\"", "password=correcthorsebatterystaple"]) assert.match(redact(secret), /\[REDACTED\]/);
});

test("search folds English suffixes and ignores single-character Chinese noise", () => {
  const note = (id: string, title: string, content: string): Memory => ({ ...d(id, content, title), createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" });
  const notes = [note("identity", "\u7528\u6237\u59d3\u540d\uff1a\u5fb7\u70c8", "\u7528\u6237\u79f0\u547c\u4e3a\u5fb7\u70c8"), note("pkg", "Package manager", "Use pnpm to install dependencies")];
  for (const q of ["installation", "dependency", "packages"]) assert.equal(search(notes, q)[0]?.note.id, "pkg", q);
  assert.deepEqual(search(notes, "\u6211\u4eec\u7684\u6570\u636e\u5e93\u8fde\u63a5\u600e\u4e48\u914d"), []);
  assert.equal(search(notes, "\u5fb7\u70c8")[0].note.id, "identity");
  assert.equal(search(notes, "\u70c8")[0]?.note.id, "identity", "a lone character still matches");
});
