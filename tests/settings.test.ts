import assert from "node:assert/strict";
import { test } from "node:test";
import { homedir } from "node:os";
import { join } from "node:path";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { MemoryStore, projectIdentity } from "../src/store.ts";
import { renderTopic } from "../src/markdown.ts";
import { makeHarness, tool, waitForExtraction } from "./harness.ts";

const note = { id: "package-manager", type: "feedback" as const, title: "Package manager", content: "Use pnpm, not npm, to install dependencies." };
const source = { sessionId: "old", entryId: "old-user", quote: "pnpm", origin: "explicit" as const };

const lastReport = (h: Awaited<ReturnType<typeof makeHarness>>) => {
  const report = h.session.messages.filter(message => message.role === "custom" && message.customType === "pi-project-memory.report").at(-1);
  assert.ok(report && report.role === "custom", "expected a /pmem report");
  return JSON.parse(typeof report.content === "string" ? report.content : JSON.stringify(report.content));
};

test("settings decide the memory directory and expand a leading ~/", async t => {
  const name = `pi-memory-settings-test-${process.pid}`;
  const base = `~/${name}`;
  const h = await makeHarness(t, { useFlags: false, settings: { projectMemory: { directory: base } } });
  await h.session.prompt("/pmem");
  const expected = h.store.dir.replace(h.memoryDir, join(homedir(), name));
  assert.equal(lastReport(h).directory, expected);
  // Reading config must not create anything in the home directory.
  await assert.rejects(readdir(join(homedir(), name)), /ENOENT/);
});

test("a per-run flag still overrides the persisted setting", async t => {
  const h = await makeHarness(t, { settings: { projectMemory: { directory: join(homedir(), "ignored-dir") } } });
  await h.session.prompt("/pmem");
  assert.equal(lastReport(h).directory, h.store.dir);
});

test("a relative settings directory is rejected instead of silently landing somewhere", async t => {
  const h = await makeHarness(t, { useFlags: false, settings: { projectMemory: { directory: "relative/memory" } } });
  await h.session.prompt("/pmem");
  assert.deepEqual(h.session.messages.filter(message => message.role === "custom" && message.customType === "pi-project-memory.report"), []);
  await assert.rejects(readdir(join(h.cwd, "relative", "memory")), /ENOENT/);
});

test("enabled:false disables recall, writes and extraction without touching stored notes", async t => {
  let step = 0;
  const dir = join(homedir(), "pi-memory-disabled-test");
  const h = await makeHarness(t, {
    useFlags: false,
    settings: { projectMemory: { enabled: false, directory: dir, autoExtract: true } },
    answer: () => (++step === 1 ? tool("pmem_save", note) : "Done."),
  });
  const identity = await projectIdentity(h.cwd);
  const store = new MemoryStore(dir, identity.key, identity.name);
  await store.save([{ ...note, source }]);
  const before = (await store.read()).revision;
  await h.session.prompt("Please remember to keep using pnpm here.");
  const result = h.session.messages.find(message => message.role === "toolResult");
  assert.ok(result && result.role === "toolResult" && result.isError, "save must be refused while disabled");
  assert.equal(JSON.stringify(h.requests[0].context).includes("Untrusted saved project notes"), false);
  // The refused tool call is followed by one final assistant turn; never a nested extraction call.
  assert.deepEqual(h.requests.map(request => request.kind), ["main", "main"]);
  assert.equal((await store.read()).revision, before);
});

test("autoExtract:true persists the opt-in so extraction runs without the flag", async t => {
  const h = await makeHarness(t, {
    useFlags: false,
    settings: { projectMemory: { autoExtract: true } },
    answer: request => (request.kind === "extract" ? JSON.stringify({ memories: [] }) : "Done."),
  });
  await h.session.prompt("We prefer pnpm over npm for future work in this repository.");
  await waitForExtraction(h);
  assert.deepEqual(h.requests.map(request => request.kind), ["main", "extract"]);
  assert.deepEqual(h.errors, []);
});

test("extractModel runs extraction on its own model, leaving the session model alone", async t => {
  const h = await makeHarness(t, {
    useFlags: false,
    settings: { projectMemory: { autoExtract: true, extractModel: "memory-test/synthetic-fast" } },
    answer: request => (request.kind === "extract" ? '{"memories":[]}' : "Done."),
  });
  await h.session.prompt("We prefer pnpm over npm for future work in this repository.");
  await waitForExtraction(h);
  assert.equal(h.requests.find(request => request.kind === "main")?.model, "synthetic");
  assert.equal(h.requests.find(request => request.kind === "extract")?.model, "synthetic-fast");
  assert.deepEqual(h.errors, []);
});

test("an unavailable extractModel falls back to the session model and records the request", async t => {
  const h = await makeHarness(t, {
    useFlags: false,
    settings: { projectMemory: { autoExtract: true, extractModel: "qoder/fast" } },
    answer: request => (request.kind === "extract" ? '{"memories":[]}' : "Done."),
  });
  await h.session.prompt("We prefer pnpm over npm for future work in this repository.");
  await waitForExtraction(h);
  assert.equal(h.requests.find(request => request.kind === "extract")?.model, "synthetic");
  const entry = h.manager.getEntries().find(entry => entry.type === "custom" && entry.customType === "pi-project-memory.extraction");
  assert.ok(entry && entry.type === "custom");
  assert.equal((entry.data as { requestedModel?: string }).requestedModel, "qoder/fast");
});

test("by default there are no memory tools, and a plain Markdown file is the interface", async t => {
  const h = await makeHarness(t, { useFlags: false, dedicatedTools: false });
  assert.deepEqual(h.session.getActiveToolNames(), []);
  // The directory has to reach the model even before anything exists, since no tool can report it.
  await h.session.prompt("What do you know about this project?");
  const injected = h.manager.getEntries().find(entry => entry.type === "custom_message" && entry.customType === "pi-project-memory.index");
  assert.ok(injected && injected.type === "custom_message", "expected the directory pointer");
  const identity = await projectIdentity(h.cwd);
  // Without overrides the plugin resolves its base from the process agent dir, not the harness option.
  const dir = join(getAgentDir(), "project-memory", `${identity.name}__${identity.key.slice(0, 12)}`);
  t.after(() => rm(dir, { recursive: true, force: true }));
  const payload = JSON.parse(String(injected.content));
  assert.equal(payload.directory, dir);
  // Files-only sessions must not advertise a tool they do not have.
  assert.equal(String(payload.notice).includes("pmem_"), false);

  // Writing the topic file by hand is enough: the plugin ingests it into the index.
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const store = new MemoryStore(join(getAgentDir(), "project-memory"), identity.key, identity.name);
  await writeFile(join(dir, "package-manager.md"), renderTopic({
    ...note,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    source,
  }));
  assert.equal((await store.read()).notes.length, 1);

  const cold = await makeHarness(t, { root: h.root, useFlags: false, dedicatedTools: false });
  await cold.session.prompt("How should I install dependencies in this project?");
  // Recall injects the index; bodies stay on disk and are read on demand (CC parity).
  assert.ok(JSON.stringify(cold.requests[0].context).includes("(package-manager.md)"));
  assert.equal((await store.read()).notes[0].content, "Use pnpm, not npm, to install dependencies.");
  assert.deepEqual(cold.session.getActiveToolNames(), []);
});

test("dedicatedTools:true keeps the pmem tools available", async t => {
  const h = await makeHarness(t, { useFlags: false, dedicatedTools: true });
  assert.deepEqual(h.session.getActiveToolNames().sort(), ["pmem_list", "pmem_read", "pmem_save", "pmem_search"]);
});

test("everyNTurns counts prompts, and idle flush covers the gap", async t => {
  const h = await makeHarness(t, {
    useFlags: false,
    settings: { projectMemory: { autoExtract: true, everyNTurns: 2, idleFlushSeconds: 0 } },
    answer: request => (request.kind === "extract" ? '{"memories":[]}' : "Done."),
  });
  await h.session.prompt("First prompt with a durable preference.");
  assert.deepEqual(h.requests.map(request => request.kind), ["main"]);
  await h.session.prompt("Second prompt mentioning another preference.");
  await waitForExtraction(h);
  assert.deepEqual(h.requests.map(request => request.kind), ["main", "main", "extract"]);
});

test("idle flush runs a pass after the turn settles, without waiting for the cadence", async t => {
  const h = await makeHarness(t, {
    useFlags: false,
    settings: { projectMemory: { autoExtract: true, everyNTurns: 99, idleFlushSeconds: 0.05 } },
    answer: request => (request.kind === "extract" ? '{"memories":[]}' : "Done."),
  });
  await h.session.prompt("One prompt that should be flushed while idle.");
  await waitForExtraction(h);
  const entry = h.manager.getEntries().find(entry => entry.type === "custom" && entry.customType === "pi-project-memory.extraction");
  assert.ok(entry && entry.type === "custom");
  assert.equal((entry.data as { trigger?: string }).trigger, "idle");
});

test("settings defaults: extraction is on, tools are off, cadence is Claude Code's", async () => {
  const { parseMemorySettings } = await import("../src/index.ts");
  const defaults = parseMemorySettings(undefined);
  assert.equal(defaults.autoExtract, true);
  assert.equal(defaults.enabled, true);
  assert.equal(defaults.dedicatedTools, false);
  assert.equal(defaults.everyNTurns, 5);
  assert.equal(defaults.idleFlushSeconds, 120);
  assert.equal(defaults.extractModel, "qoder/fast");
  assert.equal(defaults.extractionMode, "call");
  assert.equal(parseMemorySettings({ autoExtract: false }).autoExtract, false);
  assert.equal(parseMemorySettings({ everyNTurns: 0 }).everyNTurns, 1);
});

test("/pmem compact reports exact duplicates and applies them only when asked", async t => {
  const h = await makeHarness(t);
  // Written directly, the way hand edits create duplicates that the save path would have merged.
  for (const [id, content] of [["alpha", "Use pnpm in this repository."], ["beta", "Use pnpm in this repository."], ["gamma", "Reviews go to the payments group."]] as const) {
    await mkdir(h.store.dir, { recursive: true, mode: 0o700 });
    await writeFile(join(h.store.dir, `${id}.md`), renderTopic({ ...note, id, content, source, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" }));
  }
  assert.equal((await h.store.read()).notes.length, 3);
  await h.session.prompt("/pmem compact");
  const report = lastReport(h);
  assert.deepEqual(report.duplicates, [["alpha", "beta"]]);
  assert.deepEqual(report.stale, []);
  assert.equal(report.applied, 0);
  assert.equal((await h.store.read()).notes.length, 3);

  await h.session.prompt("/pmem compact apply");
  const applied = lastReport(h);
  assert.equal(applied.applied, 1);
  const ids = (await h.store.read()).notes.map(item => item.id).sort();
  assert.deepEqual(ids, ["alpha", "gamma"]);
});

test("/pmem status reports the index budget", async t => {
  const h = await makeHarness(t);
  await h.store.save([{ ...note, content: "Use pnpm in this repository.", source }]);
  await h.session.prompt("/pmem");
  const report = lastReport(h);
  assert.equal(report.index.limit, 25000);
  assert.ok(report.index.bytes > 0 && report.index.bytes < report.index.limit);
});

test("dream defaults are off with Claude Code's cadence", async () => {
  const { parseMemorySettings } = await import("../src/index.ts");
  const defaults = parseMemorySettings(undefined);
  assert.equal(defaults.dream, false);
  assert.equal(defaults.dreamMinHours, 24);
  assert.equal(defaults.dreamMinSessions, 5);
});

test("/pmem dream consolidates updates and deletions in one pass", async t => {
  const h = await makeHarness(t, {
    settings: { projectMemory: { dream: true } },
    answer: request => (JSON.stringify(request.context).includes("Consolidate this project's memory")
      ? JSON.stringify({ updates: [{ id: "alpha", type: "feedback", title: "Package manager", content: "Use pnpm, never npm." }], deletes: ["beta"], note: "merged alpha and beta" })
      : "Done."),
  });
  for (const [id, content] of [["alpha", "Use pnpm."], ["beta", "Use pnpm in this repo."], ["gamma", "Reviews go to the payments group."]] as const) {
    await mkdir(h.store.dir, { recursive: true, mode: 0o700 });
    await writeFile(join(h.store.dir, `${id}.md`), renderTopic({ ...note, id, content, source, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" }));
  }
  assert.equal((await h.store.read()).notes.length, 3);

  await h.session.prompt("/pmem dream");
  const deadline = Date.now() + 20_000;
  let entry;
  while (Date.now() < deadline) {
    entry = h.manager.getEntries().find(item => item.type === "custom" && item.customType === "pi-project-memory.dream");
    if (entry) break;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.ok(entry && entry.type === "custom", "expected a dream entry");
  const data = entry.data as { status?: string; updated?: number; deleted?: number };
  assert.equal(data.status, "ok");
  assert.equal(data.updated, 1);
  assert.equal(data.deleted, 1);
  const state = await h.store.read();
  assert.deepEqual(state.notes.map(item => item.id).sort(), ["alpha", "gamma"]);
  assert.equal(state.notes.find(item => item.id === "alpha")?.content, "Use pnpm, never npm.");
});

test("/pmem dream says there is nothing to consolidate on an empty store", async t => {
  const h = await makeHarness(t, { settings: { projectMemory: { dream: true } } });
  await h.session.prompt("/pmem dream");
  const report = [...h.manager.getEntries()].reverse().find(item => item.type === "custom_message" && item.customType === "pi-project-memory.report");
  assert.ok(report && report.type === "custom_message", "expected a report");
  assert.match(typeof report.content === "string" ? report.content : JSON.stringify(report.content), /Nothing to consolidate/);
});

test("dream shrinks its payload to fit the model input cap", async t => {
  let seen = 0;
  const h = await makeHarness(t, {
    settings: { projectMemory: { dream: true } },
    answer: request => {
      const text = JSON.stringify(request.context);
      seen = Math.max(seen, Buffer.byteLength(text));
      assert.ok(Buffer.byteLength(text) < 32_000, `dream payload was ${Buffer.byteLength(text)} bytes`);
      return JSON.stringify({ updates: [], deletes: [], note: "nothing to change" });
    },
  });
  const drafts = Array.from({ length: 70 }, (_, index) => ({
    ...note,
    id: `note-${index}`,
    title: `Note ${index}`,
    content: `Rule ${index}: ${"keep the workflow deterministic. ".repeat(20)}`,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: `2026-01-${String((index % 28) + 1).padStart(2, "0")}T00:00:00.000Z`,
  }));
  for (const draft of drafts) {
    await mkdir(h.store.dir, { recursive: true, mode: 0o700 });
    await writeFile(join(h.store.dir, `${draft.id}.md`), renderTopic({ ...draft, source }));
  }
  await h.session.prompt("/pmem dream");
  const deadline = Date.now() + 20_000;
  let entry;
  while (Date.now() < deadline) {
    entry = h.manager.getEntries().find(item => item.type === "custom" && item.customType === "pi-project-memory.dream");
    if (entry) break;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.ok(entry && entry.type === "custom", "expected a dream entry");
  assert.equal((entry.data as { status?: string }).status, "ok");
  assert.ok(seen > 0, "the model should have been called");
  assert.equal((await h.store.read()).notes.length, 70);
});
