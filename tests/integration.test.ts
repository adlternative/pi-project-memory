import assert from "node:assert/strict";
import { test } from "node:test";
import { readdir } from "node:fs/promises";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { getCurrentTools } from "@earendil-works/pi-ai";
import { evidenceSinceCheckpoint } from "../src/intelligence.ts";
import { clip } from "../src/store.ts";
import { extraction, makeHarness, tool } from "./harness.ts";

const noteArgs = { id: "package-manager", type: "feedback", title: "Package manager", content: "Use pnpm, not npm, to install dependencies." };

function extractionEntries(h: Awaited<ReturnType<typeof makeHarness>>) {
  return h.manager.getEntries().flatMap(entry => entry.type === "custom" && entry.customType === "pi-project-memory.extraction" ? [entry] : []);
}

test("real file extension loads only four tools; explicit model tool saves and skips redundant extraction", async t => {
  let main = 0;
  const h = await makeHarness(t, { auto: true, answer: request => {
    assert.equal(request.kind, "main");
    return ++main === 1 ? tool("pmem_save", noteArgs) : "Saved [pmem:package-manager].";
  } });
  assert.deepEqual(h.session.getActiveToolNames().sort(), ["pmem_list", "pmem_read", "pmem_save", "pmem_search"]);
  await h.session.prompt("Please remember: use pnpm, not npm, to install dependencies.");
  const state = await h.store.read();
  assert.equal(state.notes.length, 1);
  assert.equal(state.notes[0].source.origin, "explicit");
  assert.equal(h.requests.length, 2);
  assert.deepEqual(h.errors, []);
  assert.deepEqual(extractionEntries(h), []);
  assert.ok(h.manager.getEntries().some(entry => entry.type === "custom" && entry.customType === "pi-project-memory.checkpoint"));
});

test("a fresh Pi session loads the index once and leaves topic bodies on disk", async t => {
  const h = await makeHarness(t);
  await h.store.save([{ ...noteArgs, type: "feedback", source: { sessionId: "old-session", entryId: "old-user", quote: "Use pnpm", origin: "explicit" } }]);
  const fresh = await makeHarness(t, { root: h.root });
  await fresh.session.prompt("How should I install dependencies for this project?");
  const input = JSON.stringify(fresh.requests[0].context);
  assert.ok(input.includes("package-manager"), "the index links the topic");
  assert.ok(input.includes("Untrusted saved project notes"));
  assert.equal(input.includes("Use pnpm, not npm"), false, "topic bodies are not injected; they stay on disk");
  const before = fresh.manager.getEntries();
  assert.equal(before.filter(entry => entry.type === "custom_message" && entry.customType === "pi-project-memory.index").length, 1);
  await fresh.session.prompt("Another dependency installation question.");
  assert.deepEqual(fresh.manager.getEntries().slice(0, before.length), before);
  assert.equal(JSON.stringify(fresh.requests[1].context).match(/Untrusted saved project notes/g)?.length, 1);
  const other = await makeHarness(t, { root: h.root, project: "unrelated" });
  await other.session.prompt("How should I install dependencies?");
  assert.equal(JSON.stringify(other.requests[0].context).includes("package-manager"), false);
});

test("opt-in turn-end extraction is bounded, no-tool, source-grounded and incremental across resume", async t => {
  const h = await makeHarness(t, { auto: true, answer: request => request.kind === "extract" ? extraction(request) : "Done." });
  await h.session.prompt("Please prefer pnpm over npm for this project.");
  assert.equal((await h.store.read()).notes[0].source.origin, "extracted");
  const call = h.requests.find(request => request.kind === "extract")!;
  assert.deepEqual(getCurrentTools(call.context.messages), []);
  assert.ok(Buffer.byteLength(JSON.stringify(call.data)) <= 32000);
  assert.deepEqual(call.data.evidence.map((entry: any) => entry.role), ["user", "assistant"]);
  assert.equal(extractionEntries(h).length, 1);
  const path = h.manager.getSessionFile(); assert.ok(path);
  const resumed = await makeHarness(t, { root: h.root, auto: true, sessionManager: SessionManager.open(path), answer: request => request.kind === "extract" ? '{"memories":[]}' : "Done." });
  await resumed.session.prompt("We now prefer short design notes for future reviews.");
  const resumedCall = resumed.requests.find(request => request.kind === "extract")!;
  assert.equal(JSON.stringify(resumedCall.data.evidence).includes("prefer pnpm over npm"), false);
  assert.ok(JSON.stringify(resumedCall.data.evidence).includes("short design notes"));
  assert.deepEqual(resumed.errors, []);
});

test("default and ephemeral runs never perform automatic model calls", async t => {
  for (const config of [{ auto: false }, { auto: true, persistent: false }]) {
    const h = await makeHarness(t, config);
    await h.session.prompt("We prefer pnpm over npm in this project.");
    assert.deepEqual(h.requests.map(request => request.kind), ["main"]);
    assert.equal((await h.store.read()).notes.length, 0);
    await assert.rejects(readdir(h.store.dir), /ENOENT/);
  }
});

test("an error or aborted main run cannot become a durable memory", async t => {
  for (const stopReason of ["error", "aborted"] as const) {
    const h = await makeHarness(t, { auto: true, answer: () => ({ stopReason, text: "Synthetic failure" }) });
    await h.session.prompt("This unsuccessful task should never become a memory.");
    assert.deepEqual(h.requests.map(request => request.kind), ["main"]);
    assert.deepEqual((await h.store.read()).notes, []);
  }
});

test("invalid extraction fails closed without damaging a successful conversation", async t => {
  const h = await makeHarness(t, { auto: true, answer: request => request.kind === "extract" ? '{"memories":[{"id":"invented"}]}' : "Task succeeded." });
  await h.session.prompt("Some durable information might exist here.");
  assert.equal(h.session.getLastAssistantText(), "Task succeeded.");
  assert.deepEqual((await h.store.read()).notes, []);
  const entries = extractionEntries(h);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].type === "custom" && (entries[0].data as any).status, "failed");
  assert.deepEqual(h.errors, []);
});

test("known credential values are removed before extraction; raw tool/system content is not supplied", async t => {
  const token = "sk-" + "f".repeat(32);
  const h = await makeHarness(t, { auto: true, answer: request => request.kind === "extract" ? '{"memories":[]}' : "Done." });
  await h.session.prompt("Remember the deployment preference; credential for this one task is " + token);
  const input = JSON.stringify(h.requests.find(request => request.kind === "extract")!.data);
  assert.equal(input.includes(token), false);
  assert.ok(input.includes("[REDACTED]"));
  assert.equal(input.includes("You are an expert"), false);
});

test("semantic tool selection can recover a paraphrase, allowlists ids, and reports nested usage", async t => {
  let main = 0;
  const h = await makeHarness(t, { answer: request => {
    if (request.kind === "semantic") return '{"ids":["package-manager"]}';
    return ++main === 1 ? tool("pmem_search", { query: "What installer do we favor?", mode: "semantic" }) : "Use pnpm [pmem:package-manager].";
  } });
  await h.store.save([{ ...noteArgs, type: "feedback", source: { sessionId: "old", entryId: "old-user", quote: "pnpm", origin: "explicit" } }]);
  await h.session.prompt("What installer do we favor?");
  assert.deepEqual(h.requests.map(request => request.kind), ["main", "semantic", "main"]);
  const nested = h.requests[1];
  assert.deepEqual(getCurrentTools(nested.context.messages), []);
  const message = h.session.messages.find(message => message.role === "toolResult");
  assert.ok(message && message.role === "toolResult");
  assert.equal(message.isError, false);
  assert.equal(message.usage?.totalTokens, 15);
  assert.ok(JSON.stringify(message.content).includes("package-manager"));
  assert.deepEqual(h.errors, []);
});

test("forged semantic ids produce a tool error, never a fabricated saved-memory answer", async t => {
  let main = 0;
  const h = await makeHarness(t, { answer: request => request.kind === "semantic" ? '{"ids":["../../not-a-memory"]}' : ++main === 1 ? tool("pmem_search", { query: "installer", mode: "semantic" }) : "No verified memory result." });
  await h.store.save([{ ...noteArgs, type: "feedback", source: { sessionId: "old", entryId: "old-user", quote: "pnpm", origin: "explicit" } }]);
  await h.session.prompt("What installer did we choose?");
  const message = h.session.messages.find(message => message.role === "toolResult");
  assert.ok(message && message.role === "toolResult" && message.isError);
  assert.equal((await h.store.read()).notes.length, 1);
});

test("a concurrent edit during extraction rejects the stale model result", async t => {
  let h: Awaited<ReturnType<typeof makeHarness>>;
  h = await makeHarness(t, { auto: true, answer: async request => {
    if (request.kind !== "extract") return "Done.";
    await h.store.save([{ ...noteArgs, type: "feedback", content: "Newer explicit choice: use bun.", source: { sessionId: "other-session", entryId: "new-user", quote: "bun", origin: "explicit" } }]);
    return extraction(request);
  } });
  await h.session.prompt("Old preference: we use pnpm in this project.");
  assert.equal((await h.store.read()).notes[0].content, "Newer explicit choice: use bun.");
  assert.equal(extractionEntries(h).length, 1);
  assert.equal(extractionEntries(h)[0].type === "custom" && (extractionEntries(h)[0].data as any).status, "failed");
});

test("forget command suppresses old evidence, toggle is session-only, disabled mode never opens stores", async t => {
  const h = await makeHarness(t);
  await h.store.save([{ ...noteArgs, type: "feedback", source: { sessionId: "old", entryId: "old-user", quote: "pnpm", origin: "explicit" } }]);
  await h.session.prompt("Old conversation about pnpm.");
  await h.session.prompt("/pmem forget package-manager");
  assert.deepEqual((await h.store.read()).notes, []);
  assert.deepEqual(evidenceSinceCheckpoint(h.session.extensionRunner.createContext()), []);
  await h.session.prompt("/pmem auto on");
  await h.session.prompt("/pmem auto off");
  assert.equal(h.requests.length, 1);
  const disabled = await makeHarness(t, { disabled: true, auto: true });
  await disabled.session.prompt("Please discuss project preferences.");
  assert.equal(disabled.requests.length, 1);
  await assert.rejects(readdir(disabled.memoryDir), /ENOENT/);
  assert.deepEqual(disabled.errors, []);
});

test("evidence respects branch navigation, omitted/context-edited messages, and checkpoints", async t => {
  const h = await makeHarness(t);
  const first = h.manager.appendMessage({ role: "user", content: "Original incorrect preference", timestamp: Date.now() });
  h.manager.appendMessage({ role: "user", content: "Abandoned branch must not leak", timestamp: Date.now() });
  h.manager.branch(first);
  h.manager.appendContextEdit(first, { content: "Corrected active preference" });
  const hidden = h.manager.appendMessage({ role: "user", content: "Omitted evidence", timestamp: Date.now() });
  h.manager.appendContextEdit(hidden, null);
  const ctx = h.session.extensionRunner.createContext();
  assert.deepEqual(evidenceSinceCheckpoint(ctx).map(entry => entry.text), ["Corrected active preference"]);
  h.manager.appendCustomEntry("pi-project-memory.checkpoint", {});
  assert.deepEqual(evidenceSinceCheckpoint(ctx), []);
});

test("read-time fragments remain byte-bounded even with full multilingual notes", async t => {
  const h = await makeHarness(t);
  for (let i = 0; i < 24; i++) await h.store.save([{ id: "note-" + i, type: "project", title: clip("\u4e2d\u6587\u8bbe\u8ba1\u53d6\u820d".repeat(20), 150), content: clip("\u8fd9\u91cc\u8bb0\u5f55\u9879\u76ee\u7684\u91cd\u8981\u8bbe\u8ba1\u53d6\u820d\u548c\u5916\u90e8\u53c2\u8003\u3002".repeat(100), 1880) + i, source: { sessionId: "old", entryId: "e" + i, quote: "\u5408\u6210\u6d4b\u8bd5", origin: "explicit" } }]);
  await h.session.prompt("\u89e3\u91ca\u4e2d\u6587\u8bbe\u8ba1\u53d6\u820d\u3002");
  const messages = h.requests[0].context.messages;
  const injected = messages.filter(message => message.role === "user" && JSON.stringify(message.content).includes("Untrusted saved project notes"));
  assert.equal(injected.length, 1);
  const content = injected[0].content;
  const text = typeof content === "string" ? content : content.filter(part => part.type === "text").map(part => part.text).join("\n");
  assert.ok(Buffer.byteLength(text) <= 6000);
  assert.deepEqual(h.errors, []);
});
