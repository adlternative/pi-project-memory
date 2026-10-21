import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { makeHarness, tool, waitForExtraction } from "./harness.ts";
import { applyStaged, memoryTools } from "../src/fork-extraction.ts";
import { renderTopic } from "../src/markdown.ts";

const note = { id: "package-manager", type: "feedback" as const, title: "Package manager", content: "Use pnpm, not npm.", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", source: { sessionId: "s", entryId: "e", quote: "q", origin: "file" as const } };

test("sub-agent tools validate, stage, and only touch memory files", async t => {
  const root = await mkdtemp(resolve(".sandbox", "fork-tools-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const staged = new Map<string, string>();
  const [read, write] = memoryTools(root, staged);
  assert.equal((await read.execute("1", { path: "missing.md" })).content[0].text, "No file at missing.md");
  await assert.rejects(write.execute("2", { path: "../escape.md", content: "x" }), /inside the memory directory/);
  await assert.rejects(write.execute("3", { path: "/etc/passwd", content: "x" }), /memory directory/);
  await assert.rejects(write.execute("4", { path: "MEMORY.md", content: "x" }), /maintained automatically/);
  await assert.rejects(write.execute("5", { path: "no-frontmatter.md", content: "plain" }), /frontmatter/);
  const result = await write.execute("6", { path: "package-manager.md", content: renderTopic(note) });
  assert.match(result.content[0].text, /Staged package-manager.md/);
  assert.deepEqual([...staged.keys()], ["package-manager.md"]);
  // Nothing is on disk until the loop finishes and the caller applies the staging.
  await assert.rejects(readFile(join(root, "package-manager.md")), /ENOENT/);
  assert.match((await read.execute("7", { path: "package-manager.md" })).content[0].text, /type: feedback/);
  assert.deepEqual(await applyStaged(root, staged), ["package-manager.md"]);
  assert.match(await readFile(join(root, "package-manager.md"), "utf8"), /type: feedback/);
});

test("a discarded pass writes nothing, so no partial notes survive", async t => {
  const root = await mkdtemp(resolve(".sandbox", "fork-discard-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const staged = new Map<string, string>();
  const [, write] = memoryTools(root, staged);
  await write.execute("1", { path: "package-manager.md", content: renderTopic(note) });
  assert.equal(staged.size, 1);
  // Cancellation drops the staging map; nothing was ever written.
  assert.deepEqual(await applyStaged(root, new Map()), []);
  await assert.rejects(readFile(join(root, "package-manager.md")), /ENOENT/);
});

test("extractionMode fork runs the sub-agent and records the mode", async t => {
  const h = await makeHarness(t, {
    settings: { projectMemory: { autoExtract: true, extractionMode: "fork", everyNTurns: 1 } },
    answer: () => "Nothing to save.",
  });
  await h.session.prompt("We prefer pnpm over npm for future work in this repository.");
  await waitForExtraction(h);
  const entry = h.manager.getEntries().find(item => item.type === "custom" && item.customType === "pi-project-memory.extraction");
  assert.ok(entry && entry.type === "custom");
  const data = entry.data as { status?: string; mode?: string; saved?: string[] };
  assert.equal(data.status, "ok");
  assert.equal(data.mode, "fork");
  assert.deepEqual(data.saved, []);
  assert.deepEqual(h.errors, []);
});

test("fork mode writes notes through its scoped tools and records them", async t => {
  let step = 0;
  const h = await makeHarness(t, {
    settings: { projectMemory: { autoExtract: true, extractionMode: "fork", everyNTurns: 1 } },
    // The sub-agent prompt identifies the fork request; the parent turn answers normally.
    answer: request => (JSON.stringify(request.context).includes("memory extraction sub-agent")
      ? (++step === 1 ? tool("write_memory", { path: "package-manager.md", content: renderTopic(note) }) : "Nothing to save.")
      : "Done."),
  });
  await h.session.prompt("We prefer pnpm over npm for future work in this repository.");
  await waitForExtraction(h);
  const entry = h.manager.getEntries().find(item => item.type === "custom" && item.customType === "pi-project-memory.extraction");
  assert.ok(entry && entry.type === "custom");
  const data = entry.data as { status?: string; saved?: string[]; turns?: number };
  assert.equal(data.status, "ok");
  assert.deepEqual(data.saved, ["package-manager"]);
  assert.equal(data.turns, 2);
  assert.match(await readFile(join(h.store.dir, "package-manager.md"), "utf8"), /Use pnpm, not npm/);
  assert.match(await readFile(join(h.store.dir, "MEMORY.md"), "utf8"), /\(package-manager\.md\)/);
  assert.equal((await h.store.read()).notes.length, 1);
});
