import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { linesFromSessionText, listProjectSessions, parseDream, dreamDue, executeDream, type DreamInput } from "../src/dream.ts";
import { MemoryStore, hash, type Draft } from "../src/store.ts";
import { makeHarness, type Request } from "./harness.ts";

const source = { sessionId: "synthetic-session", entryId: "user-entry", quote: "Please remember this preference.", origin: "explicit" as const };
const draft = (id: string, content: string, type: Draft["type"] = "feedback"): Draft => ({ id, type, title: id, content, source });

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  await mkdir(resolve(".sandbox"), { recursive: true });
  const root = await mkdtemp(resolve(".sandbox", "dream-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, store: new MemoryStore(root, hash("project-a").slice(0, 24), "project-a") };
}

function input(notes: DreamInput["notes"], sessions: DreamInput["sessions"] = []): DreamInput {
  return { now: "2026-10-23T00:00:00.000Z", notes, forgotten: [], sessions };
}

const keep = { id: "package-manager", type: "feedback" as const, title: "Package manager", text: "Use pnpm, not npm, to install dependencies.", updatedAt: "2026-10-01T00:00:00.000Z" };
const drop = { id: "pkg-mgr", type: "feedback" as const, title: "Package manager alias", text: "Use pnpm rather than npm for installs.", updatedAt: "2026-10-02T00:00:00.000Z" };

test("session evidence keeps the active branch and drops tool output", () => {
  const header = { type: "session", version: 3, id: "sess", timestamp: "2026-01-01T00:00:00.000Z", cwd: "/tmp/project" };
  const message = (id: string, parentId: string | null, role: string, text: string, extra: Record<string, unknown> = {}) => ({
    type: "message", id, parentId, timestamp: "2026-01-01T00:00:01.000Z",
    message: { role, content: role === "toolResult" ? [{ type: "text", text }] : text, timestamp: 1, ...extra },
  });
  const content = [
    header,
    message("root", null, "user", "Root preference uses pnpm."),
    message("abandoned", "root", "user", "Abandoned branch text should vanish."),
    message("kept", "root", "user", "Kept branch says use pnpm."),
    message("tool", "kept", "toolResult", "tool output should vanish", { toolCallId: "c", toolName: "bash", isError: false }),
    message("partial", "tool", "assistant", "calling a tool", { stopReason: "toolUse", content: [{ type: "text", text: "calling a tool" }] }),
  ].map(entry => JSON.stringify(entry)).join("\n");
  const lines = linesFromSessionText(content, "sess");
  assert.deepEqual(lines.map(line => line.text), ["Root preference uses pnpm.", "Kept branch says use pnpm."]);
  assert.equal(lines.some(line => line.text.includes("tool output") || line.text.includes("Abandoned") || line.text.includes("calling a tool")), false);
});

test("dream citations have to be real, and preferences still need a user", () => {
  const sessions = [{ id: "sess", lines: [{ entryId: "s:sess:m1", role: "user" as const, text: "Please keep reviews in the payments group." }] }];
  const body = input([keep, drop], sessions);
  const plan = parseDream({
    updates: [{ id: "package-manager", type: "feedback", title: "Package manager", content: "Use pnpm, not npm, for this project.", entryId: "note:pkg-mgr", quote: "Use pnpm rather than npm" }],
    additions: [{ id: "reviews", type: "project", title: "Reviews", content: "Reviews go to the payments group.", entryId: "s:sess:m1", quote: "payments group" }],
    forget: [{ id: "pkg-mgr", entryId: "note:package-manager", quote: "Use pnpm, not npm" }],
  }, body, [keep, drop], [], "dream-session");
  assert.deepEqual(plan.forget, ["pkg-mgr"]);
  assert.equal(plan.drafts[1].source.origin, "extracted");
  assert.throws(() => parseDream({ updates: [], additions: [], forget: [{ id: "pkg-mgr", entryId: "note:pkg-mgr", quote: "Use pnpm rather" }] }, body, [keep, drop], [], "s"), /cannot cite the note it deletes/);
  assert.throws(() => parseDream({ updates: [], additions: [{ id: "who", type: "user", title: "Who", content: "The user leads payments.", entryId: "note:package-manager", quote: "Use pnpm, not npm" }], forget: [] }, body, [keep, drop], [], "s"), /user evidence/);
  assert.throws(() => parseDream({ updates: [{ id: "package-manager", type: "feedback", title: "Package manager", content: "Use pnpm.", entryId: "note:missing", quote: "Use pnpm, not npm" }], additions: [], forget: [] }, body, [keep, drop], [], "s"), /Ungrounded/);
  assert.throws(() => parseDream({ updates: [], additions: [], forget: [], extra: true }, body, [keep, drop], [], "s"), /envelope/);
  assert.throws(() => parseDream({ updates: [{ id: "package-manager", type: "feedback", title: "Package manager", content: "Use pnpm, not npm, for this project.", entryId: "note:pkg-mgr", quote: "Use pnpm rather than npm" }], additions: [], forget: [{ id: "package-manager", entryId: "note:pkg-mgr", quote: "Use pnpm rather than npm" }] }, body, [keep, drop], [], "s"), /not a current note|repeats/);
  assert.equal(dreamDue({ dreamedAt: new Date(Date.now() - 3_600_000).toISOString() }, { dreamMinHours: 24, dreamRetryHours: 1 }, Date.now()), false);
  assert.equal(dreamDue({ dreamFailedAt: new Date().toISOString() }, { dreamMinHours: 0, dreamRetryHours: 1 }, Date.now()), false);
  assert.equal(dreamDue({ dreamFailedAt: new Date(Date.now() - 2 * 3_600_000).toISOString() }, { dreamMinHours: 0, dreamRetryHours: 1 }, Date.now()), true);
});

test("consolidate merges into one revision, keeps the clock across later saves, and refuses a stale plan", async t => {
  const { store } = await fixture(t);
  await store.save([draft("package-manager", "Use pnpm, not npm, to install dependencies."), draft("pkg-mgr", "Use pnpm rather than npm for installs.")]);
  const revision = (await store.read()).revision;
  const createdAt = (await store.read()).notes.find(note => note.id === "package-manager")!.createdAt;
  const applied = await store.consolidate([
    { id: "package-manager", type: "feedback", title: "Package manager", content: "Use pnpm, not npm, for this project.", source: { ...source, origin: "extracted", entryId: "note:pkg-mgr", quote: "Use pnpm rather than npm" } },
  ], ["pkg-mgr"], { expectedRevision: revision });
  assert.deepEqual(applied.forgotten, ["pkg-mgr"]);
  const state = await store.read();
  assert.deepEqual(state.notes.map(note => note.id), ["package-manager"]);
  assert.equal(state.notes[0].content, "Use pnpm, not npm, for this project.");
  assert.equal(state.notes[0].createdAt, createdAt);
  assert.ok(state.forgotten.includes("pkg-mgr"));
  assert.ok(state.dreamedAt);
  assert.equal(state.dreamFailedAt, undefined);
  const dreamedAt = state.dreamedAt;
  await store.save([draft("reviews", "Reviews go to the payments group.", "project")]);
  assert.equal((await store.read()).dreamedAt, dreamedAt);
  const stale = await store.read();
  await store.save([draft("reviews", "Reviews go to the payments-review group.", "project")]);
  await assert.rejects(store.consolidate([], [], { expectedRevision: stale.revision }), /stale/);
  assert.equal((await store.read()).dreamedAt, dreamedAt);
});

test("a note deleted in the same plan can donate its text, and an older tombstone cannot come back", async t => {
  const { store } = await fixture(t);
  await store.save([draft("alpha", "Use pnpm, not npm, for this repository."), draft("beta", "Reviews go to payments.")]);
  const first = await store.read();
  await store.consolidate([
    { id: "beta", type: "project", title: "Practices", content: "Use pnpm, not npm, for this repository.", source: { ...source, origin: "extracted" } },
  ], ["alpha"], { expectedRevision: first.revision });
  assert.equal((await store.read()).notes[0].content, "Use pnpm, not npm, for this repository.");
  await store.forget("beta");
  const forgotten = await store.read();
  await store.consolidate([draft("beta", "Use pnpm, not npm, for this repository.", "project")], [], { expectedRevision: forgotten.revision });
  assert.equal((await store.read()).notes.length, 0);
});

test("a failed dream backs off without editing notes, and a bad clock fails closed", async t => {
  const { store } = await fixture(t);
  await store.save([draft("reviews", "Reviews go to the payments group.", "project")]);
  const before = await store.read();
  await store.recordDreamFailure({ expectedRevision: before.revision });
  const failed = await store.read();
  assert.equal(failed.notes.length, 1);
  assert.ok(failed.dreamFailedAt);
  assert.equal(failed.dreamedAt, undefined);
  await store.consolidate([], [], { expectedRevision: failed.revision });
  assert.equal((await store.read()).dreamFailedAt, undefined);
  const disk = JSON.parse(await readFile(store.file, "utf8"));
  disk.dreamedAt = "not-a-time";
  await writeFile(store.file, JSON.stringify(disk));
  await assert.rejects(store.read(), /timestamp/);
  assert.equal(await readFile(store.file, "utf8"), JSON.stringify(disk));
});

test("session discovery ignores symlinks and other projects", async t => {
  const { root } = await fixture(t);
  const cwd = join(root, "project");
  const dir = join(root, "sessions");
  await mkdir(cwd); await mkdir(dir);
  const header = (id: string, project: string) => JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-01-01T00:00:00.000Z", cwd: project }) + "\n";
  await writeFile(join(dir, "ours.jsonl"), header("ours", cwd));
  await writeFile(join(dir, "theirs.jsonl"), header("theirs", join(root, "other")));
  await symlink(join(dir, "ours.jsonl"), join(dir, "linked.jsonl"));
  const listed = await listProjectSessions(cwd, dir);
  assert.deepEqual(listed.map(item => item.id), ["ours"]);
});

test("gates skip the model when the store is fresh or another session has not happened yet", async t => {
  const { root } = await fixture(t);
  const note = { ...draft("reviews", "Reviews go to the payments group.", "project"), createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" };
  const base = {
    signal: AbortSignal.timeout(1000), now: Date.now(), cwd: root, sessionDir: join(root, "missing-sessions"), sessionId: "current", currentLines: [],
    callModel: async () => { throw new Error("model"); },
    consolidate: async () => { throw new Error("write"); },
    recordFailure: async () => { throw new Error("stamp"); },
  };
  const fresh = await executeDream({ ...base, trigger: "auto", settings: { dreamMinHours: 24, dreamMinSessions: 0, dreamRetryHours: 0 }, snapshot: { notes: [note], forgotten: [], revision: 1, dreamedAt: new Date().toISOString() } });
  const lonely = await executeDream({ ...base, trigger: "auto", settings: { dreamMinHours: 0, dreamMinSessions: 2, dreamRetryHours: 0 }, snapshot: { notes: [note], forgotten: [], revision: 1 } });
  assert.equal(fresh.reason, "not_due");
  assert.equal(lonely.reason, "too_few_sessions");
});

async function waitForDream(h: Awaited<ReturnType<typeof makeHarness>>) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const entry = h.manager.getEntries().find(item => item.type === "custom" && item.customType === "pi-project-memory.dream");
    if (entry && entry.type === "custom") return entry.data as { status: string; reason?: string; saved?: string[]; forgotten?: string[] };
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`dream did not finish (${h.requests.map(request => request.kind).join(",") || "no model calls"})`);
}

function planFrom(request: Request) {
  const notes = request.data.notes as { id: string; text: string }[];
  const keeper = notes.find(note => note.id === "package-manager");
  const duplicate = notes.find(note => note.id === "pkg-mgr");
  assert.ok(keeper && duplicate);
  return JSON.stringify({
    updates: [{ id: "package-manager", type: "feedback", title: "Package manager", content: "Use pnpm, not npm, for this project.", entryId: "note:pkg-mgr", quote: "Use pnpm rather than npm" }],
    additions: [],
    forget: [{ id: "pkg-mgr", entryId: "note:package-manager", quote: "Use pnpm, not npm" }],
  });
}

test("a later session dreams over real transcripts and merges duplicate notes", async t => {
  let turned = false;
  const h = await makeHarness(t, { answer: () => turned ? "Done." : (turned = true, { type: "toolCall", id: "call-read", name: "pmem_read", arguments: { id: "missing" } }) });
  const note = (id: string, content: string) => ({ id, type: "feedback" as const, title: id === "package-manager" ? "Package manager" : "Package manager alias", content, source });
  await h.store.save([
    note("package-manager", "Use pnpm, not npm, to install dependencies."),
    note("pkg-mgr", "Use pnpm rather than npm for installs."),
  ]);
  await h.session.prompt("Keep using pnpm for future installs in this repository.");
  const h2 = await makeHarness(t, {
    root: h.root,
    settings: { projectMemory: { autoDream: true, dreamMinHours: 0, dreamMinSessions: 1, dreamRetryHours: 0 } },
    answer: request => {
      if (request.kind !== "dream") return "Done.";
      const body = JSON.stringify(request.data);
      assert.equal(body.includes("Keep using pnpm for future installs"), true);
      assert.equal(body.includes("Memory not found"), false);
      return planFrom(request);
    },
  });
  const data = await waitForDream(h2);
  assert.equal(data.status, "ok", JSON.stringify(data));
  assert.deepEqual(data.forgotten, ["pkg-mgr"]);
  const state = await h2.store.read();
  assert.deepEqual(state.notes.map(item => item.id), ["package-manager"]);
  assert.equal(state.notes[0].content, "Use pnpm, not npm, for this project.");
  assert.ok(state.dreamedAt);
});

test("manual dream redacts secrets before the model sees the session", async t => {
  const h = await makeHarness(t, { answer: request => request.kind === "dream" ? '{"updates":[],"additions":[],"forget":[]}' : "Done." });
  await h.store.save([{ id: "reviews", type: "project", title: "Reviews", content: "Reviews go to the payments group.", source }]);
  await h.session.prompt("The api_key=Abcd1234efgh5678 is not a project fact.");
  await h.session.prompt("/pmem dream");
  const dream = h.requests.find(request => request.kind === "dream");
  assert.ok(dream);
  const body = JSON.stringify(dream.data);
  assert.equal(body.includes("Abcd1234efgh5678"), false);
  assert.equal(body.includes("[REDACTED]"), true);
  assert.ok((await h.store.read()).dreamedAt);
  const report = h.session.messages.findLast(message => message.role === "custom" && message.customType === "pi-project-memory.report");
  assert.equal(report?.role === "custom" && typeof report.content === "string" && report.content.includes("Dream finished"), true);
});

test("a bad dream response leaves notes alone and stamps a backoff", async t => {
  const h = await makeHarness(t, { settings: { projectMemory: { autoDream: false } } });
  await h.store.save([{ id: "reviews", type: "project", title: "Reviews", content: "Reviews go to the payments group.", source }]);
  const h2 = await makeHarness(t, {
    root: h.root,
    settings: { projectMemory: { autoDream: true, dreamMinHours: 0, dreamMinSessions: 0, dreamRetryHours: 0 } },
    answer: request => request.kind === "dream" ? "not-json" : "Done.",
  });
  const data = await waitForDream(h2);
  assert.equal(data.status, "failed");
  const state = await h2.store.read();
  assert.equal(state.notes[0].content, "Reviews go to the payments group.");
  assert.ok(state.dreamFailedAt);
  assert.equal(state.dreamedAt, undefined);
});
