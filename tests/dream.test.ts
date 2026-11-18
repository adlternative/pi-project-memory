import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { makeHarness, tool } from "./harness.ts";
import { renderTopic } from "../src/markdown.ts";
import { MemoryStore, hash } from "../src/store.ts";
import { dreamTools, type StagedChange } from "../src/dream.ts";
import { projectSessions, searchSessions, sessionDigest } from "../src/sessions.ts";

const source = { sessionId: "old", entryId: "old-user", quote: "q", origin: "explicit" as const };
const at = "2026-01-01T00:00:00.000Z";
const note = (id: string, content: string, title = id) => ({ id, type: "project" as const, title, content, source, createdAt: at, updatedAt: at });

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const root = await mkdtemp(resolve(".sandbox", "dream-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new MemoryStore(root, hash("project").slice(0, 24), "project");
  await mkdir(store.dir, { recursive: true, mode: 0o700 });
  return { root, store };
}

test("dream tools read before they change, stage everything and never touch disk", async t => {
  const { store } = await fixture(t);
  await writeFile(join(store.dir, "deploy.md"), renderTopic(note("deploy", "Canary, then region, then fleet.")));
  await writeFile(join(store.dir, "lunch.md"), renderTopic(note("lunch", "Team lunch is on Fridays.")));
  const state = await store.read();
  const files = await store.topicFiles();
  const staged = new Map<string, StagedChange>();
  const tools = Object.fromEntries(dreamTools({ notes: state.notes, files, sessions: [], staged, read: new Set() }).map(item => [item.name, item]));

  assert.match(await tools.list_notes.execute({}), /deploy \[project\] deploy: Canary/);
  await assert.rejects(tools.write_note.execute({ id: "deploy", content: renderTopic(note("deploy", "Rewritten blind.")) }), /Read deploy in full/);
  await assert.rejects(tools.delete_note.execute({ id: "lunch" }), /Read lunch/);
  assert.match(await tools.read_note.execute({ id: "deploy" }), /Canary, then region/);
  assert.match(await tools.write_note.execute({ id: "deploy", content: renderTopic(note("deploy", "Canary, region, fleet; pause 10 min between.")) }), /Staged/);
  await assert.rejects(tools.write_note.execute({ id: "bad", content: "no frontmatter" }), /frontmatter|Invalid/);
  await assert.rejects(tools.write_note.execute({ id: "../escape", content: renderTopic(note("x", "y")) }), /Invalid note id/);
  await assert.rejects(tools.write_note.execute({ id: "leak", content: renderTopic(note("leak", "token=sk-" + "a".repeat(32))) }), /credentials/);
  assert.match(await tools.write_note.execute({ id: "rollback", content: renderTopic(note("rollback", "Roll back region by region.")) }), /Staged/);
  await tools.read_note.execute({ id: "lunch" });
  assert.match(await tools.delete_note.execute({ id: "lunch" }), /Staged deletion/);
  await assert.rejects(tools.read_session.execute({ id: "not-listed" }), /Only sessions listed/);

  assert.deepEqual([...staged.values()].map(change => [change.id, change.before === null, change.after === null]), [["deploy", false, false], ["rollback", true, false], ["lunch", false, true]]);
  assert.equal(staged.get("deploy")?.before, files.get("deploy")?.hash);
  assert.match(await readFile(join(store.dir, "deploy.md"), "utf8"), /Canary, then region, then fleet\./, "nothing is written before the pass ends");
});

test("applyDream applies a pass atomically and refuses unsafe ones", async t => {
  const { store } = await fixture(t);
  for (const [id, body] of [["a", "Alpha."], ["b", "Beta."], ["c", "Gamma."], ["d", "Delta."], ["e", "Epsilon."]]) await writeFile(join(store.dir, `${id}.md`), renderTopic(note(id, body)));
  await store.read();
  const files = await store.topicFiles();
  const draft = (id: string, content: string) => ({ id, type: "project" as const, title: id, content, source });

  // A note edited during the pass aborts everything, so a concurrent change is never overwritten.
  await writeFile(join(store.dir, "b.md"), renderTopic(note("b", "Beta, edited by the user.")));
  await assert.rejects(store.applyDream([{ id: "a", before: files.get("a")!.hash, after: draft("a", "Alpha 2.") }, { id: "b", before: files.get("b")!.hash, after: draft("b", "Beta 2.") }]), /b\.md changed while dreaming/);
  assert.match(await readFile(join(store.dir, "a.md"), "utf8"), /Alpha\./, "the untouched part of the failed pass did not apply either");

  const fresh = await store.topicFiles();
  // Five notes allow 2 deletions per pass; 3 are refused.
  await assert.rejects(store.applyDream(["a", "c", "d"].map(id => ({ id, before: fresh.get(id)!.hash, after: null }))), /delete 3 of 5 notes, more than the 2 allowed/);
  await store.forget("e");
  await assert.rejects(store.applyDream([{ id: "e", before: null, after: draft("e", "Epsilon back.") }]), /restore forgotten note e/);

  const now = await store.topicFiles();
  const result = await store.applyDream([
    { id: "a", before: now.get("a")!.hash, after: draft("a", "Alpha merged with Gamma.") },
    { id: "c", before: now.get("c")!.hash, after: null },
    { id: "f", before: null, after: draft("f", "A new durable fact.") },
  ]);
  assert.deepEqual(result, { created: ["f"], updated: ["a"], deleted: ["c"] });
  const state = await store.read();
  assert.deepEqual(state.notes.map(item => item.id).sort(), ["a", "b", "d", "f"]);
  assert.ok(state.forgotten.includes("c"), "deleted notes are tombstoned so extraction cannot restore them");
  assert.ok((await store.dreamState()).lastAt > 0, "a finished pass moves the timer");
});

test("project sessions span worktrees of one repository and nothing else", async t => {
  const root = await mkdtemp(resolve(".sandbox", "dream-sessions-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { execFileSync } = await import("node:child_process");
  const main = join(root, "repo"), linked = join(root, "linked"), other = join(root, "other");
  await mkdir(main, { recursive: true }); await mkdir(other, { recursive: true });
  const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: "ignore", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
  git(main, "init", "-q"); git(main, "commit", "-q", "--allow-empty", "-m", "init"); git(main, "worktree", "add", "-q", linked);
  git(other, "init", "-q");
  const sessions = join(root, "sessions");
  for (const [cwd, text] of [[main, "Main checkout: we deploy with the canary first."], [linked, "Worktree: rollback is region by region."], [other, "Other repo secret plan."]] as const) {
    const manager = SessionManager.create(cwd, join(sessions, cwd.replace(/[/\\:]/g, "-")));
    manager.appendMessage({ role: "user", content: text, timestamp: Date.now() });
    manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "Noted." }], api: "x", provider: "x", model: "x", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: Date.now() } as never);
  }
  const found = await projectSessions(sessions, linked);
  assert.deepEqual(found.map(item => item.cwd).sort(), [main, linked].sort(), "both worktrees, not the other repository");
  assert.match(await sessionDigest(found.find(item => item.cwd === linked)!.file), /> Worktree: rollback is region by region\.\n< Noted\./);
  assert.match(await searchSessions(found, "CANARY"), /> Main checkout: we deploy with the canary first\./);
  assert.equal((await searchSessions(found, "secret plan")), "No matches.");
});

test("/pmem dream runs a tool-using sub-agent over recent sessions and applies its changes", async t => {
  let turn = 0;
  let prompt = "";
  const h = await makeHarness(t, {
    settings: { projectMemory: { dream: true } },
    answer: request => {
      const text = JSON.stringify(request.context);
      if (!text.includes("Dream: consolidate this project")) return "Rollback goes region by region from now on.";
      prompt = text;
      turn += 1;
      if (turn === 1) return tool("search_sessions", { query: "rollback" });
      if (turn === 2) return tool("read_note", { id: "deploy" });
      if (turn === 3) return tool("write_note", { id: "deploy", content: renderTopic(note("deploy", "Canary, then region, then fleet. Rollback goes region by region (decided 2026-01-02).", "Deploy and rollback order")) });
      if (turn === 4) return tool("read_note", { id: "deploy-draft" });
      if (turn === 5) return tool("delete_note", { id: "deploy-draft" });
      return "Merged the rollback decision into deploy and removed the draft note.";
    },
  });
  await mkdir(h.store.dir, { recursive: true, mode: 0o700 });
  await writeFile(join(h.store.dir, "deploy.md"), renderTopic(note("deploy", "Canary, then region, then fleet.")));
  await writeFile(join(h.store.dir, "deploy-draft.md"), renderTopic(note("deploy-draft", "Draft: canary first.")));
  for (const id of ["a", "b", "c", "d"]) await writeFile(join(h.store.dir, `${id}.md`), renderTopic(note(id, `Unrelated ${id}.`)));
  await h.session.prompt("From now on, rollback goes region by region.");
  await h.session.prompt("/pmem dream");

  assert.match(prompt, /read_session|search_sessions/, "the sub-agent is given session tools");
  assert.match(prompt, new RegExp(h.manager.getSessionId()), "the current session is listed as recent");
  const state = await h.store.read();
  assert.deepEqual(state.notes.map(item => item.id).sort(), ["a", "b", "c", "d", "deploy"]);
  assert.match(state.notes.find(item => item.id === "deploy")!.content, /Rollback goes region by region/);
  const entry = h.manager.getEntries().flatMap(item => item.type === "custom" && item.customType === "pi-project-memory.dream" ? [item] : []).at(-1)!;
  const data = entry.data as { status?: string; turns?: number; updated?: string[]; deleted?: string[]; created?: string[] };
  assert.equal(data.status, "ok");
  assert.equal(data.turns, 6);
  assert.deepEqual([data.updated, data.created, data.deleted], [["deploy"], [], ["deploy-draft"]]);
  const report = [...h.manager.getEntries()].reverse().find(item => item.type === "custom_message" && item.customType === "pi-project-memory.report");
  assert.ok(report && report.type === "custom_message");
  assert.match(String(report.content), /1 updated, 0 added, 1 removed/);
});

test("a dream that fails mid-pass applies nothing", async t => {
  let turn = 0;
  const h = await makeHarness(t, {
    settings: { projectMemory: { dream: true } },
    answer: request => {
      if (!JSON.stringify(request.context).includes("Dream: consolidate this project")) return "Done.";
      turn += 1;
      if (turn === 1) return tool("read_note", { id: "deploy" });
      if (turn === 2) return tool("write_note", { id: "deploy", content: renderTopic(note("deploy", "Half-finished rewrite.")) });
      return { stopReason: "error", text: '{"code":"110","message":"Billing daily count exceeded"}' };
    },
  });
  await mkdir(h.store.dir, { recursive: true, mode: 0o700 });
  await writeFile(join(h.store.dir, "deploy.md"), renderTopic(note("deploy", "Canary, then region, then fleet.")));
  await h.session.prompt("/pmem dream");
  assert.equal((await h.store.read()).notes[0].content, "Canary, then region, then fleet.");
  const data = h.manager.getEntries().flatMap(item => item.type === "custom" && item.customType === "pi-project-memory.dream" ? [item] : []).at(-1)!.data as { status?: string; reason?: string };
  assert.equal(data.status, "failed");
  assert.match(String(data.reason), /Billing daily count exceeded/);
});

test("a deletion that would lose an identifier is refused until a remaining note carries it", async t => {
  const { store } = await fixture(t);
  await writeFile(join(store.dir, "status.md"), renderTopic(note("status", "Branch `feat/qca-mount` pushed.")));
  await writeFile(join(store.dir, "fixes.md"), renderTopic(note("fixes", "Review fixes in commit bfeb6484c, ticket 88949056.")));
  for (const id of ["a", "b", "c"]) await writeFile(join(store.dir, `${id}.md`), renderTopic(note(id, `Other ${id}.`)));
  const state = await store.read();
  const files = await store.topicFiles();
  const staged = new Map<string, StagedChange>();
  const tools = Object.fromEntries(dreamTools({ notes: state.notes, files, sessions: [], staged, read: new Set() }).map(item => [item.name, item]));
  await tools.read_note.execute({ id: "fixes" });
  await assert.rejects(tools.delete_note.execute({ id: "fixes" }), /would lose bfeb6484c, 88949056/);
  await tools.read_note.execute({ id: "status" });
  await tools.write_note.execute({ id: "status", content: renderTopic(note("status", "Branch `feat/qca-mount` pushed; review fixes in commit bfeb6484c, ticket 88949056.")) });
  assert.match(await tools.delete_note.execute({ id: "fixes" }), /Staged deletion/);

  // The store enforces the same rule even if a caller skips the tool.
  await assert.rejects(store.applyDream([{ id: "fixes", before: files.get("fixes")!.hash, after: null }]), /would lose bfeb6484c/);
  const result = await store.applyDream([...staged.values()].map(change => ({ id: change.id, before: change.before, after: change.after === null ? null : { id: change.id, type: "project" as const, title: change.id, content: change.after.split("\n---\n")[1].trim(), source } })));
  assert.deepEqual(result, { created: [], updated: ["status"], deleted: ["fixes"] });
});

test("a pass that runs out of turns applies what it staged; one past the timeout applies nothing", async t => {
  let turn = 0;
  const h = await makeHarness(t, {
    settings: { projectMemory: { dream: true } },
    answer: request => {
      if (!JSON.stringify(request.context).includes("Dream: consolidate this project")) return "Done.";
      turn += 1;
      if (turn === 1) return tool("read_note", { id: "deploy" });
      if (turn === 2) return tool("write_note", { id: "deploy", content: renderTopic(note("deploy", "Canary, then region, then fleet; pause 10 minutes.")) });
      return tool("list_notes", {});
    },
  });
  await mkdir(h.store.dir, { recursive: true, mode: 0o700 });
  await writeFile(join(h.store.dir, "deploy.md"), renderTopic(note("deploy", "Canary, then region, then fleet.")));
  await h.session.prompt("/pmem dream");
  const data = h.manager.getEntries().flatMap(item => item.type === "custom" && item.customType === "pi-project-memory.dream" ? [item] : []).at(-1)!.data as { status?: string; turns?: number; updated?: string[] };
  assert.equal(data.status, "ok");
  assert.equal(data.turns, 40);
  assert.deepEqual(data.updated, ["deploy"]);
  assert.match((await h.store.read()).notes[0].content, /pause 10 minutes/);
});

test("sessions outside Git match only the same directory", async t => {
  const root = await mkdtemp(resolve(".sandbox", "dream-nogit-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, "home"), child = join(home, "child");
  await mkdir(child, { recursive: true });
  const sessions = join(root, "sessions");
  for (const cwd of [home, child]) {
    const manager = SessionManager.create(cwd, join(sessions, cwd.replace(/[/\\:]/g, "-")));
    manager.appendMessage({ role: "user", content: `Work in ${cwd}`, timestamp: Date.now() });
    manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "ok" }], api: "x", provider: "x", model: "x", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: Date.now() } as never);
  }
  assert.deepEqual((await projectSessions(sessions, home)).map(item => item.cwd), [home]);
});

test("write_note refuses a new note that would overflow the index and accepts an update", async t => {
  const { store } = await fixture(t);
  // 481 links of this size leave 20 bytes, less than one more link.
  for (let i = 0; i < 481; i += 1) await writeFile(join(store.dir, `n-${String(i).padStart(3, "0")}.md`), renderTopic(note(`n-${String(i).padStart(3, "0")}`, `Body ${i}.`, `A long title that fills the index ${i}`)));
  const state = await store.read();
  const files = await store.topicFiles();
  const staged = new Map<string, StagedChange>();
  const links = state.index.split("\n").filter(line => line.startsWith("- ["));
  const overhead = Buffer.byteLength(state.index) - links.reduce((sum, line) => sum + Buffer.byteLength(line) + 1, 0);
  const tools = Object.fromEntries(dreamTools({ notes: state.notes, files, sessions: [], staged, read: new Set(), indexOverhead: overhead }).map(item => [item.name, item]));
  const room = 25_000 - Buffer.byteLength(state.index);
  assert.ok(room < 200, `fixture should leave little room, has ${room}`);
  await assert.rejects(tools.write_note.execute({ id: "brand-new-topic", content: renderTopic(note("brand-new-topic", "x", "A long title that will not fit in the index")) }), /would push MEMORY\.md/);
  await tools.read_note.execute({ id: "n-000" });
  assert.match(await tools.write_note.execute({ id: "n-000", content: renderTopic(note("n-000", "Body 0, updated.", "A long title that fills the index 0")) }), /Staged/);
});

test("delete_note refuses past the per-pass limit so the rest of the pass still applies", async t => {
  // Six notes, as in the ~/test store: the limit is 2, and a third deletion used to discard the whole pass.
  let turn = 0;
  const h = await makeHarness(t, {
    settings: { projectMemory: { dream: true } },
    answer: request => {
      if (!JSON.stringify(request.context).includes("Dream: consolidate this project")) return "Done.";
      turn += 1;
      if (turn === 1) return tool("read_note", { id: "n1" });
      if (turn === 2) return tool("write_note", { id: "n1", content: renderTopic(note("n1", "Merged one, two and three.")) });
      if (turn === 3) return tool("read_note", { id: "n2" });
      if (turn === 4) return tool("delete_note", { id: "n2" });
      if (turn === 5) return tool("read_note", { id: "n3" });
      if (turn === 6) return tool("delete_note", { id: "n3" });
      if (turn === 7) return tool("read_note", { id: "n4" });
      if (turn === 8) return tool("delete_note", { id: "n4" });
      return "Merged notes; one deletion was refused.";
    },
  });
  await mkdir(h.store.dir, { recursive: true, mode: 0o700 });
  for (const id of ["n1", "n2", "n3", "n4", "n5", "n6"]) await writeFile(join(h.store.dir, `${id}.md`), renderTopic(note(id, `Note ${id}.`)));
  await h.session.prompt("/pmem dream");
  const data = h.manager.getEntries().flatMap(item => item.type === "custom" && item.customType === "pi-project-memory.dream" ? [item] : []).at(-1)!.data as { status?: string; updated?: string[]; deleted?: string[]; reason?: string };
  assert.equal(data.status, "ok", String(data.reason));
  assert.deepEqual(data.updated, ["n1"]);
  assert.deepEqual(data.deleted, ["n2", "n3"]);
  assert.deepEqual((await h.store.read()).notes.map(item => item.id).sort(), ["n1", "n4", "n5", "n6"]);
});

test("/pmem dream during a scheduled pass waits for it instead of reporting a queue that never runs", async t => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let calls = 0;
  const h = await makeHarness(t, {
    settings: { projectMemory: { dream: true, dreamMinSessions: 1, dreamMinHours: 24 } },
    answer: async request => {
      if (!JSON.stringify(request.context).includes("Dream: consolidate this project")) return "Done.";
      calls += 1;
      await gate;
      return "Nothing to consolidate.";
    },
  });
  await mkdir(h.store.dir, { recursive: true, mode: 0o700 });
  await writeFile(join(h.store.dir, "alpha.md"), renderTopic(note("alpha", "Use pnpm.")));
  // A restart claims the due pass and runs it in the background, as /reload does.
  await h.session.extensionRunner.emit({ type: "session_start", reason: "reload" } as never);
  const deadline = Date.now() + 10_000;
  while (calls === 0 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(calls, 1, "the scheduled pass reached the model");
  const manual = h.session.prompt("/pmem dream");
  await new Promise(resolve => setTimeout(resolve, 100));
  release();
  await manual;
  const reports = h.manager.getEntries().flatMap(item => item.type === "custom_message" && item.customType === "pi-project-memory.report" ? [String(item.content)] : []);
  assert.ok(reports.some(text => /already running/.test(text)), reports.join(" | "));
  assert.ok(reports.some(text => /Dream done in \d+s/.test(text)), "the waiting command reports the pass's result");
  assert.equal(reports.some(text => /will run after it/.test(text)), false, "no promise of a queued pass");
  assert.equal(calls, 1, "no second pass was started");
});
