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
  const base = "~/pi-memory-settings-test";
  const h = await makeHarness(t, { useFlags: false, settings: { projectMemory: { directory: base } } });
  await h.session.prompt("/pmem");
  const expected = h.store.dir.replace(h.memoryDir, join(homedir(), "pi-memory-settings-test"));
  assert.equal(lastReport(h).directory, expected);
  // Reading config must not create anything in the home directory.
  await assert.rejects(readdir(join(homedir(), "pi-memory-settings-test")), /ENOENT/);
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
  assert.equal(JSON.parse(String(injected.content)).directory, dir);

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
