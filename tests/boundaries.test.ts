import assert from "node:assert/strict";
import { test } from "node:test";
import { readdir } from "node:fs/promises";
import { makeHarness, tool } from "./harness.ts";

const source = { sessionId: "s".repeat(170), entryId: "e".repeat(170), quote: "Synthetic user evidence", origin: "explicit" as const };

test("aborting an in-flight extraction cancels it without committing or checkpointing", { timeout: 15000 }, async t => {
  let ready!: () => void;
  const started = new Promise<void>(resolve => { ready = resolve; });
  let observedAbort = false;
  const h = await makeHarness(t, { auto: true, answer: async request => {
    if (request.kind !== "extract") return "Task complete.";
    ready();
    assert.ok(request.options?.signal);
    await new Promise<void>(resolve => request.options!.signal!.addEventListener("abort", () => { observedAbort = true; resolve(); }, { once: true }));
    return { stopReason: "aborted", text: "Synthetic cancellation" };
  } });
  const running = h.session.prompt("We prefer pnpm rather than npm for future work.");
  await started;
  await h.session.abort();
  await running;
  assert.equal(observedAbort, true);
  assert.deepEqual((await h.store.read()).notes, []);
  assert.equal(h.manager.getEntries().some(entry => entry.type === "custom" && entry.customType === "pi-project-memory.checkpoint"), false);
});

test("cancelled writes and the hard note-count limit leave prior data intact", async t => {
  const h = await makeHarness(t);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(h.store.save([{ id: "cancelled", type: "project", title: "Cancelled", content: "Do not persist this.", source }], { signal: controller.signal }));
  for (let i = 0; i < 128; i += 4) await h.store.save(Array.from({ length: 4 }, (_, j) => ({ id: "note-" + (i + j), type: "project" as const, title: "Synthetic note", content: "Distinct bounded fact number " + (i + j), source })));
  const before = await h.store.read();
  await assert.rejects(h.store.save([{ id: "overflow", type: "project", title: "Too many", content: "Must not evict another note.", source }]), /limit/);
  assert.deepEqual(await h.store.read(), before);
});

test("JSON escaping and long provenance cannot make request-local memory break a user turn", async t => {
  const h = await makeHarness(t);
  for (let i = 0; i < 8; i++) await h.store.save([{ id: "escaped-" + i, type: "project", title: '"\\'.repeat(60), content: "alpha " + '"\\'.repeat(700) + i, source }]);
  await h.session.prompt("Explain alpha.");
  assert.equal(h.session.getLastAssistantText(), "Done.");
  assert.deepEqual(h.errors, []);
  const injected = h.requests[0].context.messages.find(message => message.role === "user" && JSON.stringify(message.content).includes("Untrusted saved project notes"));
  assert.ok(injected && injected.role === "user");
  const text = typeof injected.content === "string" ? injected.content : injected.content.filter(part => part.type === "text").map(part => part.text).join("\n");
  assert.ok(Buffer.byteLength(text) <= 6000);
});

test("worst-case escaped evidence is trimmed before a nested model call, not uploaded unbounded", async t => {
  const h = await makeHarness(t, { auto: true, answer: request => request.kind === "extract" ? '{"memories":[]}' : "Done." });
  for (let i = 0; i < 24; i++) await h.store.save([{ id: "escaped-" + i, type: "project", title: '"\\'.repeat(60), content: '"\\'.repeat(700) + i, source }]);
  for (let i = 0; i < 12; i++) h.manager.appendMessage({ role: "user", content: '"\\'.repeat(490) + i, timestamp: Date.now() });
  await h.session.prompt("Remember only useful reusable facts from this session.");
  const call = h.requests.find(request => request.kind === "extract");
  assert.ok(call);
  assert.ok(Buffer.byteLength(JSON.stringify(call.data)) <= 30000);
  assert.ok(call.data.evidence.length <= 12);
  assert.deepEqual(h.errors, []);
});

test("disabled mode refuses even a model-issued write and never creates a store", async t => {
  let count = 0;
  const h = await makeHarness(t, { disabled: true, auto: true, answer: () => ++count === 1 ? tool("pmem_save", { id: "should-not-save", type: "user", title: "Preference", content: "Use pnpm." }) : "Memory is disabled." });
  await h.session.prompt("Remember to use pnpm in this project.");
  const result = h.session.messages.find(message => message.role === "toolResult");
  assert.ok(result && result.role === "toolResult" && result.isError);
  await assert.rejects(readdir(h.memoryDir), /ENOENT/);
  assert.deepEqual(h.requests.map(request => request.kind), ["main", "main"]);
});
