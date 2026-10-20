import assert from "node:assert/strict";
import { test } from "node:test";
import { link, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { clip, fingerprint, hash, MemoryStore, type Draft } from "../src/store.ts";
import { INDEX_END, INDEX_START, parseTopic, renderIndex, renderTopic } from "../src/markdown.ts";
import { makeHarness, tool } from "./harness.ts";

const draft = (id = "feedback_tools", content = "Use pnpm to install dependencies."): Draft => ({ id, type: "feedback", title: "Package manager", description: "Preferred dependency installer", content, source: { sessionId: "old-session", entryId: "old-user", quote: "Use pnpm", origin: "explicit" } });
const markdown = (body = "Use pnpm to install dependencies.") => `---\nname: Package manager\ndescription: 'The user''s installer preference'\ntype: feedback\n---\n\n${body}\n`;

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const root = await mkdtemp(resolve(".sandbox", "markdown-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new MemoryStore(root, hash("project").slice(0, 24), "project");
  await mkdir(store.dir, { recursive: true, mode: 0o700 });
  return { root, store };
}

test("Markdown topics round-trip CC-style flat frontmatter, Unicode, quotes and maximum body bytes", async t => {
  const { store } = await fixture(t);
  const body = clip("\u4e2d\u6587\u8bbe\u8ba1\u53d6\u820d\u{1f642}".repeat(400), 2000);
  const [saved] = await store.save([{ ...draft(), title: 'The "quoted" user preference', content: body }]);
  const path = join(store.dir, "feedback_tools.md");
  const raw = await readFile(path, "utf8");
  assert.deepEqual(parseTopic("feedback_tools.md", raw), { id: saved.id, type: saved.type, title: saved.title, description: saved.description, content: saved.content });
  const state = await store.read();
  assert.deepEqual(state.notes, [saved]);
  const hidden = JSON.parse(await readFile(store.file, "utf8"));
  assert.equal(hidden.version, 2);
  assert.equal(Object.hasOwn(hidden.records.feedback_tools, "content"), false);
  assert.ok(state.index.includes("(feedback_tools.md)"));
});

test("standalone CC-style topic files bootstrap metadata; direct local edits preserve unrelated files", async t => {
  const { store } = await fixture(t);
  const path = join(store.dir, "feedback_tools.md");
  await writeFile(path, markdown());
  const initial = await store.read();
  assert.equal(initial.notes[0].source.origin, "file");
  assert.equal(initial.notes[0].description, "The user's installer preference");
  await store.save([draft("reference_other", "A distinct external reference.")]);
  const other = await readFile(join(store.dir, "reference_other.md"), "utf8");
  const before = await store.read();
  const original = await readFile(path, "utf8");
  const edited = original.replace("Use pnpm", "Use bun");
  await writeFile(path, edited);
  const after = await store.read();
  assert.ok(after.revision > before.revision);
  assert.equal(after.notes.find(note => note.id === "feedback_tools")?.content, "Use bun to install dependencies.");
  assert.equal(await readFile(path, "utf8"), edited);
  assert.equal(await readFile(join(store.dir, "reference_other.md"), "utf8"), other);
});

test("custom MEMORY.md prose survives generated-index refresh and every index points at a real topic", async t => {
  const { store } = await fixture(t);
  await writeFile(store.indexFile, "# Team notes\n\nA hand-written navigation tip.\n");
  await store.save([draft()]);
  await writeFile(store.indexFile, (await readFile(store.indexFile, "utf8")) + "\n## Personal annotations\nKeep this footer.\n");
  await store.save([draft("project_decision", "Prefer a small implementation.")]);
  const state = await store.read();
  assert.ok(state.index.startsWith("# Team notes\n\nA hand-written navigation tip."));
  assert.ok(state.index.endsWith("Keep this footer.\n"));
  assert.equal(state.index.split(INDEX_START).length, 2);
  assert.equal(state.index.split(INDEX_END).length, 2);
  for (const note of state.notes) { assert.ok(state.index.includes(`(${note.id}.md)`)); await readFile(join(store.dir, `${note.id}.md`)); }
});

test("v0.1 JSON migrates once with provenance, timestamps, forgotten hashes and byte-exact backup", async t => {
  const { store } = await fixture(t);
  const original = { version: 1, revision: 17, notes: [{ ...draft(), createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-02T00:00:00.000Z" }], forgotten: ["forgotten-note", fingerprint("Forgotten content")] };
  const raw = JSON.stringify(original, null, 2) + "\n";
  await writeFile(join(store.dir, "memories.json"), raw);
  const state = await store.read();
  assert.deepEqual(state.notes, original.notes);
  assert.deepEqual(state.forgotten, original.forgotten);
  assert.ok(state.revision > original.revision);
  assert.equal(await readFile(join(store.dir, ".legacy-memories.json"), "utf8"), raw);
  await assert.rejects(readFile(join(store.dir, "memories.json")), /ENOENT/);
  assert.deepEqual(await store.read(), state);
  await store.forget("feedback_tools");
  assert.deepEqual((await store.read()).notes, []);
  assert.deepEqual(await store.save([draft()], { automatic: true }), []);
});

test("migration refuses conflicting Markdown, invalid legacy data or a reserved index filename", async t => {
  const { store } = await fixture(t);
  const legacyPath = join(store.dir, "memories.json");
  const raw = JSON.stringify({ version: 1, revision: 0, notes: [{ ...draft(), createdAt: "2026-01-01", updatedAt: "2026-01-01" }], forgotten: [] });
  await writeFile(legacyPath, raw);
  await writeFile(join(store.dir, "feedback_tools.md"), markdown("Newer authored content."));
  await assert.rejects(store.read(), /coexist/);
  assert.equal(await readFile(legacyPath, "utf8"), raw);
  assert.equal(await readFile(join(store.dir, "feedback_tools.md"), "utf8"), markdown("Newer authored content."));
  await rm(join(store.dir, "feedback_tools.md"));
  await writeFile(legacyPath, raw.replace('"feedback_tools"', '"memory"'));
  await assert.rejects(store.read(), /reserved/);
  assert.equal((await readdir(store.dir)).includes("MEMORY.md"), false);
});

test("filesystem deletion becomes forgetting; backups are never an automatic resurrection source", async t => {
  const { store } = await fixture(t);
  await store.save([draft()]);
  const original = await readFile(join(store.dir, "feedback_tools.md"), "utf8");
  await rm(join(store.dir, "feedback_tools.md"));
  const state = await store.read();
  assert.deepEqual(state.notes, []);
  assert.ok(state.forgotten.includes("feedback_tools"));
  assert.equal(state.index.includes("(feedback_tools.md)"), false);
  assert.deepEqual(await store.save([draft("another-id")], { automatic: true }), []);
  await writeFile(join(store.dir, "feedback_tools.md"), original);
  assert.equal((await store.read()).notes[0].source.origin, "file");
  assert.equal((await store.read()).forgotten.includes("feedback_tools"), false);
});

test("an external topic edit invalidates an old extraction snapshot without overwriting its bytes", async t => {
  const { store } = await fixture(t);
  await store.save([draft()]);
  const before = await store.read();
  const path = join(store.dir, "feedback_tools.md");
  const updated = (await readFile(path, "utf8")).replace("Use pnpm", "Use bun");
  await writeFile(path, updated);
  await assert.rejects(store.save([draft()], { automatic: true, expectedRevision: before.revision }), /stale/);
  assert.equal(await readFile(path, "utf8"), updated);
  assert.equal((await store.read()).notes[0].content, "Use bun to install dependencies.");
});

async function pendingUpdate(store: MemoryStore) {
  await store.save([draft()]);
  const oldState = await readFile(store.file, "utf8");
  const oldTopic = await readFile(join(store.dir, "feedback_tools.md"), "utf8");
  const after = oldTopic.replace("Use pnpm", "Use bun");
  const disk = JSON.parse(oldState);
  disk.revision++;
  disk.records.feedback_tools.hash = hash(after);
  disk.records.feedback_tools.contentHash = fingerprint("Use bun to install dependencies.");
  const newState = JSON.stringify(disk, null, 2) + "\n";
  const changes = [{ name: "feedback_tools.md", before: hash(oldTopic), after }, { name: ".state.json", before: hash(oldState), after: newState }];
  await writeFile(join(store.dir, ".pending.json"), JSON.stringify({ version: 1, changes }));
  return { oldState, after, newState };
}

test("a partial multi-file transaction rolls forward once, without losing provenance", async t => {
  const { store } = await fixture(t);
  const pending = await pendingUpdate(store);
  await writeFile(join(store.dir, "feedback_tools.md"), pending.after);
  const state = await store.read();
  assert.equal(state.notes[0].content, "Use bun to install dependencies.");
  assert.equal(state.notes[0].source.origin, "explicit");
  assert.equal(await readFile(store.file, "utf8"), pending.newState);
  await assert.rejects(readFile(join(store.dir, ".pending.json")), /ENOENT/);
});

test("recovery after state-last commit never replays over a later external Markdown edit", async t => {
  const { store } = await fixture(t);
  const pending = await pendingUpdate(store);
  await writeFile(store.file, pending.newState);
  const newest = pending.after.replace("Use bun", "Use yarn");
  await writeFile(join(store.dir, "feedback_tools.md"), newest);
  assert.equal((await store.read()).notes[0].content, "Use yarn to install dependencies.");
  assert.equal(await readFile(join(store.dir, "feedback_tools.md"), "utf8"), newest);
});

test("recovery conflicts preserve pending journal and all newer user bytes", async t => {
  const { store } = await fixture(t);
  const pending = await pendingUpdate(store);
  const latest = markdown("A newer independent decision.");
  await writeFile(join(store.dir, "feedback_tools.md"), latest);
  await assert.rejects(store.read(), /recovery conflict/);
  assert.equal(await readFile(store.file, "utf8"), pending.oldState);
  assert.equal(await readFile(join(store.dir, "feedback_tools.md"), "utf8"), latest);
  await readFile(join(store.dir, ".pending.json"));
});

test("transaction paths, malformed topic data, invalid UTF-8 and note symlinks fail closed", async t => {
  const { store, root } = await fixture(t);
  await store.save([draft()]);
  const meta = await readFile(store.file, "utf8");
  const path = join(store.dir, "feedback_tools.md");
  for (const body of ["missing frontmatter", markdown("x".repeat(5000)), Buffer.from([0xff, 0xfe, 0xff])]) {
    await writeFile(path, body);
    await assert.rejects(store.read());
    assert.equal(await readFile(store.file, "utf8"), meta);
  }
  const outside = join(root, "outside.md"); await writeFile(outside, "DO NOT TOUCH");
  await rm(path); await symlink(outside, path); await assert.rejects(store.read(), /Unsafe/);
  await rm(path); await link(outside, path); await assert.rejects(store.read(), /Unsafe/);
  await rm(path); await writeFile(path, markdown());
  await writeFile(join(store.dir, ".pending.json"), JSON.stringify({ version: 1, changes: [{ name: "../outside.md", before: null, after: "bad" }, { name: ".state.json", before: hash(meta), after: meta }] }));
  await assert.rejects(store.read(), /Invalid memory transaction/);
  assert.equal(await readFile(outside, "utf8"), "DO NOT TOUCH");
});

test("index limits and malformed managed markers preserve authored index text", () => {
  const incomplete = "Do not discard this text.\n" + INDEX_START;
  assert.throws(() => renderIndex(incomplete, []), /Malformed/);
  assert.throws(() => renderIndex("x".repeat(25001), []), /exceeds/);
  assert.throws(() => parseTopic("memory.md", markdown()), /filename/);
  assert.throws(() => parseTopic("feedback.md", markdown().replace("type: feedback", "type: >")), /flat/);
});

test("real Pi read/edit tools make a local topic patch, update recall, and skip redundant auto extraction", async t => {
  let h: Awaited<ReturnType<typeof makeHarness>>; let step = 0;
  h = await makeHarness(t, { fileTools: true, auto: true, answer: request => {
    assert.equal(request.kind, "main");
    step++;
    const path = join(h.store.dir, "feedback_tools.md");
    return step === 1 ? tool("read", { path }) : step === 2 ? tool("edit", { path, edits: [{ oldText: "Use pnpm", newText: "Use bun" }] }) : "Updated the topic file.";
  } });
  await h.store.save([draft(), draft("reference_other", "A different reference.")]);
  const other = await readFile(join(h.store.dir, "reference_other.md"), "utf8");
  await h.session.prompt("Update the remembered installer from pnpm to bun; leave the other topic alone.");
  const completed = h.session.messages.filter(message => message.role === "toolResult");
  for (const result of completed) assert.equal(result.isError, false, JSON.stringify(result.content));
  const state = await h.store.read();
  assert.equal(state.notes.find(note => note.id === "feedback_tools")?.content, "Use bun to install dependencies.");
  assert.equal(state.notes.find(note => note.id === "feedback_tools")?.source.origin, "file");
  assert.equal(await readFile(join(h.store.dir, "reference_other.md"), "utf8"), other);
  assert.deepEqual(h.requests.map(request => request.kind), ["main", "main", "main"]);
  assert.deepEqual(h.errors, []);
});

test("real Pi writes can create and repair a topic; a fresh session reads it without a JSON editor", async t => {
  let h: Awaited<ReturnType<typeof makeHarness>>; let step = 0;
  h = await makeHarness(t, { fileTools: true, auto: true, answer: request => {
    assert.equal(request.kind, "main"); step++;
    const path = join(h.store.dir, "feedback_style.md");
    return step === 1 ? tool("write", { path, content: markdown("Keep design notes short.").replace("type: feedback", "type: invalid") }) : step === 2 ? tool("edit", { path, edits: [{ oldText: "type: invalid", newText: "type: feedback" }] }) : "Repaired and saved.";
  } });
  await h.session.prompt("Remember that future design notes should be short.");
  const results = h.session.messages.filter(message => message.role === "toolResult");
  assert.equal(results[0].isError, true); assert.equal(results[1].isError, false, JSON.stringify(results[1].content));
  const cold = await makeHarness(t, { root: h.root });
  await cold.session.prompt("How should I write design notes?");
  const parked = JSON.stringify(cold.requests[0].context);
  assert.ok(parked.includes("feedback_style.md"));
  assert.equal(parked.includes("Keep design notes short."), false);
  assert.ok((await cold.store.read()).index.includes("(feedback_style.md)"));
  assert.deepEqual(h.errors, []);
});

test("sandbox read/edit can repair an oversized topic instead of trapping the agent behind ingestion limits", async t => {
  let h: Awaited<ReturnType<typeof makeHarness>>; let step = 0;
  h = await makeHarness(t, { fileTools: true, answer: () => {
    step++; const path = join(h.store.dir, "feedback_tools.md");
    return step === 1 ? tool("write", { path, content: markdown("x".repeat(5000)) }) : step === 2 ? tool("read", { path }) : step === 3 ? tool("edit", { path, edits: [{ oldText: "x".repeat(5000), newText: "A repaired short preference." }] }) : "Repaired.";
  } });
  await h.session.prompt("Save the preference and repair any formatting or size error.");
  const results = h.session.messages.filter(message => message.role === "toolResult");
  assert.deepEqual(results.map(result => result.isError), [true, false, false]);
  assert.equal((await h.store.read()).notes[0].content, "A repaired short preference.");
  assert.deepEqual(h.errors, []);
});

test("sandbox ordinary file tools cannot write outside memory or overwrite hidden state", async t => {
  let h: Awaited<ReturnType<typeof makeHarness>>; let step = 0;
  h = await makeHarness(t, { fileTools: true, answer: () => ++step === 1 ? tool("write", { path: join(h.root, "outside.md"), content: "bad" }) : step === 2 ? tool("write", { path: h.store.file, content: "bad" }) : "Both unsafe writes were refused." });
  await h.store.save([draft()]); const before = await readFile(h.store.file, "utf8");
  await h.session.prompt("Synthetic safety check.");
  const results = h.session.messages.filter(message => message.role === "toolResult");
  assert.deepEqual(results.map(result => result.isError), [true, true]);
  await assert.rejects(readFile(join(h.root, "outside.md")), /ENOENT/);
  assert.equal(await readFile(h.store.file, "utf8"), before);
});

test("interrupted legacy migration resumes even after the original JSON moved to its backup", async t => {
  const { store } = await fixture(t);
  const note = { ...draft(), createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-02T00:00:00.000Z" };
  const legacy = JSON.stringify({ version: 1, revision: 8, notes: [note], forgotten: ["old-forgotten"] });
  const topic = renderTopic(note);
  const index = renderIndex(null, [note]);
  const metadata = JSON.stringify({ version: 2, revision: 9, records: { feedback_tools: { hash: hash(topic), contentHash: fingerprint(note.content), source: note.source, createdAt: note.createdAt, updatedAt: note.updatedAt } }, forgotten: ["old-forgotten"], indexHash: hash(index) });
  const changes = [
    { name: "feedback_tools.md", before: null, after: topic },
    { name: ".legacy-memories.json", before: null, after: legacy },
    { name: "memories.json", before: hash(legacy), after: null },
    { name: "MEMORY.md", before: null, after: index },
    { name: ".state.json", before: null, after: metadata },
  ];
  await writeFile(join(store.dir, ".legacy-memories.json"), legacy);
  await writeFile(join(store.dir, ".pending.json"), JSON.stringify({ version: 1, changes }));
  const state = await store.read();
  assert.deepEqual(state.notes, [note]);
  assert.deepEqual(state.forgotten, ["old-forgotten"]);
  assert.equal(state.revision, 9);
  assert.equal(await readFile(join(store.dir, ".legacy-memories.json"), "utf8"), legacy);
  await assert.rejects(readFile(join(store.dir, ".pending.json")), /ENOENT/);
});

test("lost migration metadata and a revived v0.1 writer both fail closed instead of restoring old notes", async t => {
  const { store } = await fixture(t);
  const old = JSON.stringify({ version: 1, revision: 0, notes: [{ ...draft(), createdAt: "2026-01-01", updatedAt: "2026-01-01" }], forgotten: [] });
  await writeFile(join(store.dir, "memories.json"), old);
  await store.read();
  await store.forget("feedback_tools");
  const metadata = await readFile(store.file, "utf8");
  await writeFile(join(store.dir, "memories.json"), old);
  await assert.rejects(store.read(), /Legacy JSON reappeared/);
  assert.equal(await readFile(store.file, "utf8"), metadata);
  await rm(join(store.dir, "memories.json"));
  await rm(store.file);
  await assert.rejects(store.read(), /Missing .state.json/);
  await assert.rejects(readFile(join(store.dir, "feedback_tools.md")), /ENOENT/);
});
