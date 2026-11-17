import assert from "node:assert/strict";
import { test } from "node:test";
import { execFile } from "node:child_process";
import { link, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { renderTopic } from "../src/markdown.ts";
import { promisify } from "node:util";
import { MemoryStore, clip, hash, projectIdentity, projectKey, redact, type Draft, type Memory } from "../src/store.ts";
import { search, tokenize } from "../src/search.ts";
import { MemoryModelError, modelJSON, parseExtraction } from "../src/intelligence.ts";
import { renderIndex } from "../src/markdown.ts";

export const draft = (id = "package-manager", content = "Use pnpm, not npm, to install dependencies."): Draft => ({
  id, type: "feedback", title: id, content,
  source: { sessionId: "synthetic-session", entryId: "user-entry", quote: "Please remember this preference.", origin: "explicit" },
});

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  await mkdir(resolve(".sandbox"), { recursive: true });
  const root = await mkdtemp(resolve(".sandbox", "core-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, store: new MemoryStore(root, hash("project-a").slice(0, 24), "project-a") };
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
  const cold = new MemoryStore(resolve(store.dir, ".."), hash("project-a").slice(0, 24), "project-a");
  assert.deepEqual(await cold.read(), await store.read());
  assert.equal((await cold.read()).notes[0].createdAt, saved.createdAt);
});

test("parallel writers serialize complete read-modify-write transactions", async t => {
  const { root, store } = await fixture(t);
  const other = new MemoryStore(root, hash("project-a").slice(0, 24), "project-a");
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

  // A deep directory inside a linked worktree still has to resolve to the same repo root.
  const worktreeNested = join(worktree, "deep", "path"); await mkdir(worktreeNested, { recursive: true });
  assert.equal(await projectKey(cwd), await projectKey(worktreeNested));

  // A worktree checked out from a bare repository belongs to that bare repository.
  const bare = join(root, "bare.git");
  await promisify(execFile)("git", ["clone", "-q", "--bare", cwd, bare], { env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } });
  await promisify(execFile)("git", ["worktree", "add", "-q", join(root, "from-bare")], { cwd: bare, env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } });
  assert.equal(await projectKey(bare), await projectKey(join(root, "from-bare")));

  // A submodule is a separate repository, so it keeps its own memory.
  const library = join(root, "library");
  await promisify(execFile)("git", ["init", "-q", "-b", "main", library], { env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } });
  await promisify(execFile)("git", ["-c", "user.name=Memory Test", "-c", "user.email=memory@example.invalid", "commit", "--allow-empty", "-q", "-m", "library"], { cwd: library, env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } });
  await promisify(execFile)("git", ["-c", "protocol.file.allow=always", "-c", "user.name=Memory Test", "-c", "user.email=memory@example.invalid", "submodule", "add", "-q", library, "vendor/lib"], { cwd, env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } });
  assert.notEqual(await projectKey(cwd), await projectKey(join(cwd, "vendor", "lib")));
});

test("inherited GIT_DIR/GIT_WORK_TREE/GIT_COMMON_DIR cannot split memory across a worktree", async t => {
  const { root } = await fixture(t);
  const cwd = join(root, "repo"); const worktree = join(root, "worktree");
  await mkdir(cwd);
  const git = (...args: string[]) => promisify(execFile)("git", ["-c", "core.hooksPath=/dev/null", ...args], { cwd, env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } });
  await git("init", "-b", "main");
  await git("-c", "user.name=Memory Test", "-c", "user.email=memory@example.invalid", "commit", "--allow-empty", "-m", "test");
  await git("worktree", "add", "-b", "polluted", worktree);
  const expected = await projectKey(worktree);

  // Run the real resolver in a fresh process, as git hooks or an exported shell variable would.
  const entry = pathToFileURL(resolve("src/store.ts")).href;
  const child = async (env: NodeJS.ProcessEnv) => {
    const { stdout } = await promisify(execFile)(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", `import {projectKey} from ${JSON.stringify(entry)}; console.log(await projectKey(${JSON.stringify(worktree)}))`], { env: { ...process.env, ...env }, timeout: 60_000 });
    return stdout.trim();
  };
  for (const polluted of [{ GIT_DIR: join(root, "elsewhere", ".git") }, { GIT_WORK_TREE: root }, { GIT_COMMON_DIR: join(root, "elsewhere") }]) {
    assert.equal(await child(polluted), expected, `unexpected split for ${JSON.stringify(polluted)}`);
  }
});

test("moving a repository changes its path-derived key, so memory must be migrated deliberately", async t => {
  const { root } = await fixture(t);
  const cwd = join(root, "repo"); const moved = join(root, "renamed");
  await mkdir(cwd);
  await promisify(execFile)("git", ["init", "-q", "-b", "main", cwd], { env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } });
  const before = await projectKey(cwd);
  await rename(cwd, moved);
  // Documented behavior: the store stays on disk under the old key and the new path starts empty.
  assert.notEqual(await projectKey(moved), before);
});

test("UTF-8 caps and redaction cover multilingual text and known credential shapes", () => {
  assert.equal(clip("\u4e2d\u{1f642}\u6587abc", 6), "\u4e2d");
  assert.equal(Buffer.byteLength(clip("\u4e2d\u{1f642}\u6587abc", 8)), 7);
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
    asNote({ ...draft("frontend", "\u524d\u7aef\u6587\u6863\u5199\u4f5c\u8981\u7b80\u77ed\uff0c\u91cd\u70b9\u89e3\u91ca\u8bbe\u8ba1\u53d6\u820d\u3002"), title: "\u524d\u7aef\u6587\u6863" }),
    asNote(draft("backend", "\u540e\u7aef\u90e8\u7f72\u5fc5\u987b\u5728\u6d4b\u8bd5\u73af\u5883\u9a8c\u8bc1\u3002")),
    asNote({ ...draft("pnpm", "Preferred package manager."), title: "pnpm" }),
    asNote(draft("incidental", "Other rules. A pnpm reference appears here.")),
  ];
  assert.equal(search(notes, "\u524d\u7aef\u6587\u6863")[0].note.id, "frontend");
  assert.equal(search(notes, "ＰＮＰＭ")[0].note.id, "pnpm");
  assert.deepEqual(search(notes, "doesnotexist"), []);
  assert.deepEqual(search(notes, "!!!"), []);
  assert.ok(tokenize("\u4e2d\u6587\u7f16\u7a0b").includes("b:\u7f16\u7a0b"));
});

test("extraction validates evidence, role, duplicate ids, secret text and unknown fields", () => {
  const evidence = [{ entryId: "u1", role: "user" as const, text: "Always use pnpm, not npm." }, { entryId: "a1", role: "assistant" as const, text: "A speculative preference." }];
  const memory = { id: "pnpm", type: "feedback", title: "Package manager", content: "Use pnpm.", entryId: "u1", quote: "use pnpm" };
  const parsed = parseExtraction({ memories: [memory] }, evidence, "session");
  assert.equal(parsed.drafts[0].source.origin, "extracted");
  assert.deepEqual(parsed.rejected, []);
  for (const item of [
    { ...memory, quote: "invented" },
    { ...memory, entryId: "absent" },
    { ...memory, entryId: "a1", quote: "speculative" },
    { ...memory, unexpected: true },
    { ...memory, content: "token=" + "x".repeat(30) },
  ]) {
    // A bad item is dropped with its reason; the valid item beside it is kept.
    const mixed = parseExtraction({ memories: [item, { ...memory, id: "kept" }] }, evidence, "session");
    assert.deepEqual(mixed.drafts.map(draft => draft.id), ["kept"]);
    assert.equal(mixed.rejected.length, 1);
  }
  assert.deepEqual(parseExtraction({ memories: [memory, memory] }, evidence, "session").rejected, ["Duplicate extraction ids"]);
  assert.throws(() => parseExtraction({ memories: [memory], extra: true }, evidence, "session"), /Invalid extraction envelope/);
  assert.throws(() => parseExtraction({ memory }, evidence, "session"), /Invalid extraction envelope/);
});

test("memory JSON calls explicitly disable hidden qoder/fast reasoning without changing other models", async () => {
  for (const [provider, id, api, disabled] of [
    ["qoder", "fast", "openai-completions", true],
    ["qoder", "ultimate", "openai-completions", false],
    ["other", "fast", "openai-completions", false],
    ["qoder", "fast", "anthropic-messages", false],
  ] as const) {
    const model = { provider, id, api, reasoning: false } as NonNullable<Parameters<typeof modelJSON>[1]>;
    const ctx = { modelRegistry: { streamSimple: (_model: unknown, _context: unknown, options: {
      reasoning?: string; onPayload?: (payload: unknown) => unknown;
    }) => ({ result: async () => {
      const payload = { model: id, max_completion_tokens: 8192, messages: [] };
      const sent = (options.onPayload?.(payload) ?? payload) as Record<string, unknown>;
      assert.equal(sent.reasoning_effort, disabled ? "none" : undefined);
      assert.equal(options.reasoning, disabled ? undefined : "low");
      assert.equal(model.reasoning, false, "the shared model configuration must stay unchanged");
      assert.equal(sent.messages, payload.messages);
      return { stopReason: "stop", content: [{ type: "text", text: '{"memories":[]}' }], usage: {} };
    } }) } } as unknown as Parameters<typeof modelJSON>[0];
    assert.deepEqual((await modelJSON(ctx, model, "Extract", {})).data, { memories: [] });
  }
});

test("JSON calls use the model's own output budget and reject incomplete JSON", async () => {
  const model = { provider: "memory-test", id: "synthetic" } as NonNullable<Parameters<typeof modelJSON>[1]>;
  let truncated = false;
  const usage = { input: 10, output: 2400, reasoning: 1999, cacheRead: 0, cacheWrite: 0, totalTokens: 2410, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  const ctx = { modelRegistry: { streamSimple: (_model: unknown, _context: unknown, options: { maxTokens?: number }) => ({ result: async () => {
    assert.equal(options.maxTokens, undefined, "no memory-specific output cap; the model's own limit applies");
    return { stopReason: truncated ? "length" : "stop", content: [{ type: "text", text: truncated ? '{"memories":[' : '{"memories":[]}' }], usage };
  } }) } } as unknown as Parameters<typeof modelJSON>[0];
  const result = await modelJSON(ctx, model, "Extract", {});
  assert.deepEqual(result.data, { memories: [] });
  assert.equal(result.response.usage.reasoning, 1999);
  truncated = true;
  await assert.rejects(modelJSON(ctx, model, "Extract", {}), error => error instanceof MemoryModelError && error.response.stopReason === "length");
});

test("model failures preserve stop reason and usage without exposing credentials or raw JSON", async () => {
  const model = { provider: "memory-test", id: "synthetic" } as NonNullable<Parameters<typeof modelJSON>[1]>;
  const usage = { input: 10, output: 2000, cacheRead: 0, cacheWrite: 0, totalTokens: 2010, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  const secret = "sk-" + "f".repeat(32);
  for (const stopReason of ["length", "error", "aborted", "toolUse", "stop"] as const) {
    const response = { stopReason, errorMessage: stopReason === "error" ? `HTTP 429 ${secret}` : undefined, content: [{ type: "text", text: "invalid JSON " + secret }], usage };
    const ctx = { modelRegistry: { streamSimple: () => ({ result: async () => response }) } } as unknown as Parameters<typeof modelJSON>[0];
    await assert.rejects(modelJSON(ctx, model, "Extract", {}), error => {
      assert.ok(error instanceof MemoryModelError);
      assert.equal(error.response, response);
      assert.equal(error.response.usage.totalTokens, 2010);
      assert.equal(error.message.includes(secret), false);
      assert.match(error.message, stopReason === "stop" ? /invalid JSON/ : new RegExp(stopReason));
      if (stopReason === "length") assert.match(error.message, /model output token limit reached/);
      if (stopReason === "error") assert.match(error.message, /HTTP 429/);
      return true;
    });
  }
});

test("extraction distinguishes invalid evidence references without relaxing exact matching", () => {
  const evidence = [{ entryId: "u1", role: "user" as const, text: "\u8bf7\u4f7f\u7528 pnpm\u3002".repeat(30) }];
  const memory = { id: "pnpm", type: "feedback", title: "Package manager", content: "Use pnpm.", entryId: "u1", quote: "\u8bf7\u4f7f\u7528 pnpm\u3002" };
  assert.equal(parseExtraction({ memories: [memory] }, evidence, "session").drafts[0].source.quote, memory.quote);
  for (const [change, reason] of [
    [{ entryId: "missing" }, /entryId is not in/],
    [{ quote: "" }, /empty or missing/],
    [{ quote: evidence[0].text }, /exceeds 400 UTF-8 bytes/],
    [{ quote: "\u8bf7\u4f7f\u7528pnpm\u3002" }, /not an exact substring/],
  ] as const) {
    const result = parseExtraction({ memories: [{ ...memory, ...change }] }, evidence, "session");
    assert.deepEqual(result.drafts, []);
    assert.match(result.rejected[0], reason);
  }
});

test("project folders are readable but the hash stays authoritative", async t => {
  const { root } = await fixture(t);
  const cwd = join(root, "My Repo!"); await mkdir(cwd);
  await promisify(execFile)("git", ["init", "-q", "-b", "main", cwd], { env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } });
  const identity = await projectIdentity(cwd);
  assert.equal(identity.name, "my-repo");
  assert.match(identity.key, /^[a-f0-9]{24}$/);

  const store = new MemoryStore(root, identity.key, identity.name);
  await store.save([draft()]);
  assert.equal(basename(store.dir), `my-repo__${identity.key.slice(0, 12)}`);

  const worktree = join(root, "wt");
  await promisify(execFile)("git", ["worktree", "add", "-q", "-b", "feat", worktree], { cwd, env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } });
  assert.deepEqual(await projectIdentity(worktree), identity);

  // Two paths that Pi's session encoding cannot tell apart must not share memory.
  const lookalike = join(root, "My-Repo");
  await mkdir(lookalike);
  await promisify(execFile)("git", ["init", "-q", "-b", "main", lookalike], { env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } });
  const other = await projectIdentity(lookalike);
  assert.equal(other.name, identity.name);
  assert.notEqual(other.key, identity.key);
  assert.notEqual(new MemoryStore(root, other.key, other.name).dir, store.dir);
});

test("a hash-only folder from an earlier version is renamed in place, keeping its notes", async t => {
  const { root } = await fixture(t);
  const key = hash("legacy-project").slice(0, 24);
  const legacy = new MemoryStore(root, key);
  await legacy.save([draft()]);
  assert.equal(basename(legacy.dir), key);

  const named = new MemoryStore(root, key, "legacy-project");
  const state = await named.read();
  assert.equal(state.notes.length, 1);
  assert.equal(basename(named.dir), `legacy-project__${key.slice(0, 12)}`);
  await assert.rejects(readdir(legacy.dir), /ENOENT/);
  assert.deepEqual((await named.read()).notes, state.notes);
});

test("consolidation applies updates and deletions together and rejects unsafe plans", async t => {
  const { store } = await fixture(t);
  await store.save([draft("alpha", "Use pnpm."), draft("beta", "Use pnpm in this repo."), draft("gamma", "Reviews go to the payments group.")]);
  const before = await store.read();
  const result = await store.consolidate(
    [{ ...draft("alpha", "Use pnpm, never npm."), createdAt: undefined as never } as never],
    ["beta"],
  );
  assert.deepEqual(result, { updated: 1, deleted: 1 });
  const after = await store.read();
  assert.deepEqual(after.notes.map(item => item.id).sort(), ["alpha", "gamma"]);
  assert.ok(after.forgotten.includes("beta"));
  assert.ok(after.revision > before.revision);

  await assert.rejects(store.consolidate([draft("missing", "x")], []), /unknown id/);
  await assert.rejects(store.consolidate([], ["alpha", "gamma"]), /delete too many/);
  assert.equal((await store.read()).revision, after.revision);
});

test("dream counters advance per session and never create an unused store", async t => {
  const { root } = await fixture(t);
  const store = new MemoryStore(root, hash("project-b").slice(0, 24), "project-b");
  assert.deepEqual(await store.noteDreamSession(), { lastAt: 0, sessionsSince: 0 });
  await assert.rejects(readdir(store.dir), /ENOENT/);

  await store.save([draft()]);
  assert.deepEqual(await store.noteDreamSession(), { lastAt: 0, sessionsSince: 1 });
  assert.deepEqual(await store.noteDreamSession(), { lastAt: 0, sessionsSince: 2 });
});

test("an index that outgrew its budget still reads, writes and reports what it hides", async t => {
  const { store } = await fixture(t);
  // Written the way a hand edit or another tool leaves them: 500 notes, so the index cannot fit them all.
  for (let index = 0; index < 500; index += 1) {
    const id = `note-${String(index).padStart(3, "0")}`;
    await mkdir(store.dir, { recursive: true, mode: 0o700 });
    await writeFile(join(store.dir, `${id}.md`), renderTopic({ ...draft(id, `Detail ${index}.`), title: `A deliberately long memory title that fills the index quickly ${index}`, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: `2026-01-${String((index % 28) + 1).padStart(2, "0")}T00:00:00.000Z` }));
  }
  const state = await store.read();
  assert.equal(state.notes.length, 500);
  assert.ok(Buffer.byteLength(state.index) <= 25_000, `index was ${Buffer.byteLength(state.index)} bytes`);
  assert.ok((state.indexOmitted?.length ?? 0) > 0, "expected the index to report the links it had to drop");
  await store.forget("note-000");
  const after = await store.read();
  assert.equal(after.notes.length, 499);
});

test("an oversized note file is clamped and healed instead of blocking the store", async t => {
  const { store } = await fixture(t);
  await store.save([draft("good", "Use pnpm.")]);
  await mkdir(store.dir, { recursive: true, mode: 0o700 });
  const big = { ...draft("big", "x".repeat(3000)), title: "Oversized note", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" };
  await writeFile(join(store.dir, "big.md"), renderTopic(big));
  const state = await store.read();
  assert.deepEqual(state.notes.map(note => note.id).sort(), ["big", "good"]);
  const clamped = state.notes.find(note => note.id === "big")!;
  assert.ok(Buffer.byteLength(clamped.content) <= 2000);
  assert.equal((await store.read()).notes.length, 2);
  // Clamping stays in memory: the file on disk is left for the user or an agent to repair.
  assert.ok((await readFile(join(store.dir, "big.md"), "utf8")).length > 3000);
});

test("a due dream is claimed by exactly one of many sessions and a failed pass hands it back", async t => {
  const { store } = await fixture(t);
  await store.save([draft("alpha", "Use pnpm.")]);
  for (let i = 0; i < 5; i += 1) await store.noteDreamSession();
  const at = Date.now();
  const claims = await Promise.all(Array.from({ length: 6 }, () => store.claimDream(24, 5, at)));
  const winners = claims.filter(Boolean);
  assert.equal(winners.length, 1, "only one concurrent session may claim the pass");
  assert.deepEqual(winners[0], { lastAt: 0, sessionsSince: 5 });
  assert.equal(await store.claimDream(24, 5, at + 1000), null, "a claimed pass is not due again");

  // A session that starts while the claimed pass runs is counted, and survives the release.
  await store.noteDreamSession();
  await store.releaseDream(winners[0]!, at);
  assert.deepEqual(await store.claimDream(24, 5, at + 2000), { lastAt: 0, sessionsSince: 6 }, "a failed pass must leave the store due");
  await assert.doesNotReject(store.releaseDream(winners[0]!, at), "a stale release must not undo a newer claim");
  assert.equal(await store.claimDream(24, 5, at + 3000), null);
});

test("a full index refuses new notes but keeps updating existing ones", async t => {
  const { store } = await fixture(t);
  const make = (n: number) => ({ ...draft(`n-${String(n).padStart(3, "0")}`, `Body ${n}.`), type: "project" as const, title: `A deliberately long memory title that fills the index ${n}` });
  let saved = 0;
  await assert.rejects(async () => { for (; saved < 600; saved += 1) await store.save([make(saved)]); }, /MEMORY\.md exceeds 25,000 UTF-8 bytes/);
  const full = await store.read();
  assert.equal(full.notes.length, saved);
  assert.equal(full.indexOmitted, undefined, "every saved note must stay linked from the index");
  assert.deepEqual(await store.save([make(900)], { skipWhenFull: true }), [], "extraction skips new notes when the index is full");
  assert.equal((await store.save([{ ...make(0), content: "Updated while full." }]))[0].content, "Updated while full.");
  assert.equal((await store.read()).notes.length, saved);
});

test("a model reply between 16 and 32 KB is accepted and a larger one is refused", async () => {
  const model = { provider: "memory-test", id: "synthetic" } as NonNullable<Parameters<typeof modelJSON>[1]>;
  let size = 20_000;
  const ctx = { modelRegistry: { streamSimple: () => ({ result: async () => ({
    stopReason: "stop", content: [{ type: "text", text: JSON.stringify({ updates: [{ id: "a", content: "x".repeat(size) }], deletes: [], note: "" }) }], usage: {},
  }) }) } } as unknown as Parameters<typeof modelJSON>[0];
  assert.ok((await modelJSON(ctx, model, "Consolidate", {})).data, "a full consolidation reply must fit");
  size = 40_000;
  await assert.rejects(modelJSON(ctx, model, "Consolidate", {}), /output exceeds its hard cap/);
});
