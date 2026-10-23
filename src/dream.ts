import { constants } from "node:fs";
import { lstat, open, readdir, realpath, type FileHandle } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { buildSessionProjection, parseSessionEntries, type ProjectedSessionEntry } from "@earendil-works/pi-coding-agent";
import { clip, MAX_DREAM_FORGETS, MAX_DREAM_WRITES, record, redact, validateInput, validateSource, type Draft, type Memory } from "./model.ts";

const MAX_SESSION_BYTES = 8 * 1024 * 1024;
const MAX_SESSIONS = 8;
const MAX_LINES = 16;
const LINE_BYTES = 500;
const NOTE_BYTES = 400;
const INPUT_BYTES = 30_000;
const QUOTE_MIN = 8;

export interface DreamLine { entryId: string; role: "user" | "assistant"; text: string }
export interface DreamNote { id: string; type: string; title: string; text: string; updatedAt: string }
export interface DreamInput { now: string; notes: DreamNote[]; forgotten: string[]; sessions: { id: string; lines: DreamLine[] }[] }
interface DreamEvidence { entryId: string; role: "user" | "assistant" | "note"; text: string }
export interface ListedSession { path: string; id: string; modifiedMs: number }
export interface DreamReport {
  status: "ok" | "skipped" | "failed";
  reason?: string;
  saved?: string[];
  forgotten?: string[];
  provider?: string;
  model?: string;
  requestedModel?: string;
  usage?: unknown;
}

export const DREAM_PROMPT = `Consolidate this project's saved notes. Merge duplicates, correct contradicted facts, and drop notes that are stale or redundant.
Update an existing id instead of creating a near-duplicate. Add a note only for a durable fact that is not already saved.
Convert relative dates to absolute dates using now. Do not save secrets, one-off task state, or facts obvious from the code.
Never restore a forgotten id. Never delete a note you are also writing. Do not rename ids.
User and feedback additions, and type changes into user or feedback, require a user-role session line. Other writes may cite a session line or a note, including the note being updated.
Every write and every deletion needs entryId and an exact quote of at least 8 characters from that evidence text. Note evidence ids are note:<id>. Deletion cannot cite the note it deletes.
Forget at most 8 ids. Write at most 8 notes. Deletion is permanent for automatic memory: that id and identical content stay forgotten.
Return {"updates":[{"id":"existing-id","type":"user|feedback|project|reference","title":"short title","content":"concise note","entryId":"evidence id","quote":"exact substring"}],"additions":[{"id":"new-id","type":"user|feedback|project|reference","title":"short title","content":"concise note","entryId":"evidence id","quote":"exact substring"}],"forget":[{"id":"existing-id","entryId":"evidence id","quote":"exact substring"}]}.
Optional description may be included on a write. Use empty arrays when nothing should change.`;

/** Active-branch user and assistant prose only. Tool output, thinking, compaction, and custom entries stay out. */
export function conversationLines(entries: ProjectedSessionEntry[], sessionId: string): DreamLine[] {
  const lines: DreamLine[] = [];
  for (const item of entries) {
    if (item.sourceEntry.type !== "message") continue;
    for (const message of item.messages) {
      // Bash and tool messages have no prose worth remembering; the cast only reads fields every message may carry.
      const raw = message as { role?: string; stopReason?: string; content?: unknown };
      const role = raw.role === "user" ? "user" : raw.role === "assistant" ? "assistant" : undefined;
      if (!role || (role === "assistant" && raw.stopReason !== "stop")) continue;
      const content = typeof raw.content === "string"
        ? raw.content
        : Array.isArray(raw.content) ? raw.content.flatMap(part => part && typeof part === "object" && "type" in part && part.type === "text" && "text" in part && typeof part.text === "string" ? [part.text] : []).join("\n") : "";
      const text = clip(redact(content.trim()), LINE_BYTES);
      const entryId = `s:${sessionId}:${item.sourceEntry.id}`;
      if (!text || entryId.length > 180) continue;
      lines.push({ entryId, role, text });
    }
  }
  return lines.slice(-MAX_LINES);
}

export function linesFromSessionText(content: string, sessionId: string): DreamLine[] {
  const entries = parseSessionEntries(content).filter(entry => entry.type !== "session");
  return conversationLines(buildSessionProjection(entries).entries, sessionId);
}

export function dreamDue(clock: { dreamedAt?: string; dreamFailedAt?: string }, settings: { dreamMinHours: number; dreamRetryHours: number }, now: number): boolean {
  if (clock.dreamedAt && !((now - Date.parse(clock.dreamedAt)) / 3_600_000 >= settings.dreamMinHours)) return false;
  if (clock.dreamFailedAt && settings.dreamRetryHours > 0) {
    const failed = Date.parse(clock.dreamFailedAt);
    const dreamed = clock.dreamedAt ? Date.parse(clock.dreamedAt) : 0;
    if (failed >= dreamed && !((now - failed) / 3_600_000 >= settings.dreamRetryHours)) return false;
  }
  return true;
}

/** Drop the oldest session lines, then sessions, then tombstone ids, then the oldest notes, until the model input fits. */
export function fitDreamInput(input: DreamInput): DreamInput {
  const copy: DreamInput = { now: input.now, forgotten: [...input.forgotten], notes: input.notes.map(note => ({ ...note })), sessions: input.sessions.map(session => ({ id: session.id, lines: [...session.lines] })) };
  const size = () => Buffer.byteLength(JSON.stringify(copy));
  while (size() > INPUT_BYTES) {
    const oldest = copy.sessions.at(-1);
    if (oldest && oldest.lines.length > 1) oldest.lines.shift();
    else if (copy.sessions.length) copy.sessions.pop();
    else if (copy.forgotten.length) copy.forgotten.shift();
    else if (copy.notes.length > 1) copy.notes.pop();
    else if (copy.notes[0] && Buffer.byteLength(copy.notes[0].text) > 80) copy.notes[0].text = clip(copy.notes[0].text, Math.floor(Buffer.byteLength(copy.notes[0].text) / 2));
    else break;
  }
  return copy;
}

function evidenceOf(input: DreamInput): DreamEvidence[] {
  return [
    ...input.notes.map(note => ({ entryId: `note:${note.id}`, role: "note" as const, text: note.text })),
    ...input.sessions.flatMap(session => session.lines.map(line => ({ entryId: line.entryId, role: line.role, text: line.text }))),
  ];
}

function cite(entryId: unknown, quote: unknown, evidence: Map<string, DreamEvidence>, forbidden?: string): { entryId: string; quote: string; role: DreamEvidence["role"] } {
  if (typeof entryId !== "string" || typeof quote !== "string") throw new Error("Ungrounded dream evidence");
  const item = evidence.get(entryId);
  const trimmed = quote.trim();
  if (!item || trimmed.length < QUOTE_MIN || Buffer.byteLength(trimmed) > 400 || !item.text.includes(trimmed) || redact(trimmed) !== trimmed) throw new Error("Ungrounded dream evidence");
  if (forbidden && entryId === forbidden) throw new Error("Dream deletion cannot cite the note it deletes");
  return { entryId, quote: trimmed, role: item.role };
}

export function parseDream(value: unknown, input: DreamInput, notes: Pick<Memory, "id" | "type">[], forgotten: string[], sessionId: string): { drafts: Draft[]; forget: string[] } {
  const root = record(value);
  if (Object.keys(root).some(key => !["updates", "additions", "forget"].includes(key))) throw new Error("Invalid dream envelope");
  if (!Array.isArray(root.updates) || !Array.isArray(root.additions) || !Array.isArray(root.forget)) throw new Error("Invalid dream envelope");
  if (root.updates.length + root.additions.length > MAX_DREAM_WRITES || root.forget.length > MAX_DREAM_FORGETS) throw new Error("Dream plan exceeds its write limit");
  const evidence = new Map<string, DreamEvidence>();
  for (const item of evidenceOf(input)) {
    if (evidence.has(item.entryId)) throw new Error("Duplicate dream evidence");
    evidence.set(item.entryId, item);
  }
  const forgottenIds = new Set(forgotten.filter(id => !id.startsWith("sha:")));
  const seen = new Set<string>();
  const drafts: Draft[] = [];
  const takeWrite = (value: unknown, kind: "update" | "addition") => {
    const item = record(value);
    if (Object.keys(item).some(key => !["id", "type", "title", "description", "content", "entryId", "quote"].includes(key))) throw new Error("Unknown dream field");
    const memory = validateInput(item);
    if (seen.has(memory.id) || forgottenIds.has(memory.id)) throw new Error("Dream write repeats or restores an id");
    const existing = notes.find(note => note.id === memory.id);
    if (kind === "update" && !existing) throw new Error("Dream update is not an existing note");
    if (kind === "addition" && existing) throw new Error("Dream addition uses an existing id");
    const quoted = cite(item.entryId, item.quote, evidence);
    const needsUser = (kind === "addition" || (existing && existing.type !== memory.type)) && (memory.type === "user" || memory.type === "feedback");
    if (needsUser && quoted.role !== "user") throw new Error("Preferences require user evidence");
    seen.add(memory.id);
    drafts.push({ ...memory, source: validateSource({ sessionId, entryId: quoted.entryId, quote: quoted.quote, origin: "extracted" }) });
  };
  for (const item of root.updates) takeWrite(item, "update");
  for (const item of root.additions) takeWrite(item, "addition");
  const forget: string[] = [];
  for (const value of root.forget) {
    const item = record(value);
    if (Object.keys(item).some(key => !["id", "entryId", "quote"].includes(key))) throw new Error("Unknown dream field");
    if (typeof item.id !== "string" || seen.has(item.id) || !notes.some(note => note.id === item.id)) throw new Error("Dream forget id is not a current note");
    cite(item.entryId, item.quote, evidence, `note:${item.id}`);
    seen.add(item.id);
    forget.push(item.id);
  }
  return { drafts, forget };
}

async function readBounded(path: string, bytes: number): Promise<string | undefined> {
  let handle: FileHandle | undefined;
  try { handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)); }
  catch { return; }
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1 || info.size <= 0 || info.size > MAX_SESSION_BYTES) return;
    const buf = Buffer.alloc(Math.min(bytes, info.size));
    await handle.read(buf, 0, buf.length, 0);
    return new TextDecoder("utf-8", { fatal: bytes >= info.size }).decode(buf);
  } catch { return; }
  finally { await handle.close(); }
}

/** Regular session files in this project's session directory. Symlinks and other projects are skipped. */
export async function listProjectSessions(cwd: string, sessionDir: string): Promise<ListedSession[]> {
  if (!sessionDir) return [];
  let names: string[];
  try { names = await readdir(sessionDir); }
  catch { return []; }
  const root = resolve(sessionDir);
  const want = await realpath(cwd).catch(() => resolve(cwd));
  const listed: ListedSession[] = [];
  for (const name of names) {
    if (!name.endsWith(".jsonl")) continue;
    const path = join(root, name);
    const within = relative(root, path);
    if (within.startsWith("..") || isAbsolute(within)) continue;
    const info = await lstat(path).catch(() => undefined);
    if (!info?.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size <= 0 || info.size > MAX_SESSION_BYTES) continue;
    const prefix = await readBounded(path, 65_536);
    if (!prefix) continue;
    const header = parseSessionEntries(prefix).find(entry => entry.type === "session");
    if (!header || header.type !== "session" || typeof header.id !== "string" || !header.id) continue;
    if (header.cwd) {
      const theirs = await realpath(header.cwd).catch(() => resolve(header.cwd));
      if (theirs !== want) continue;
    }
    listed.push({ path, id: header.id, modifiedMs: info.mtimeMs });
  }
  return listed;
}

export async function executeDream(env: {
  signal: AbortSignal;
  trigger: "auto" | "manual";
  now: number;
  settings: { dreamMinHours: number; dreamMinSessions: number; dreamRetryHours: number };
  snapshot: { notes: Memory[]; forgotten: string[]; dreamedAt?: string; dreamFailedAt?: string; revision: number };
  cwd: string;
  sessionDir: string;
  sessionId: string;
  currentLines: DreamLine[];
  callModel: (data: DreamInput) => Promise<{ data: unknown; provider: string; model: string; usage?: unknown; requestedModel?: string }>;
  consolidate: (drafts: Draft[], forget: string[], expectedRevision: number) => Promise<{ saved: string[]; forgotten: string[] }>;
  recordFailure: (expectedRevision: number) => Promise<void>;
}): Promise<DreamReport> {
  if (env.signal.aborted) return { status: "skipped", reason: "aborted" };
  if (!env.snapshot.notes.length) return { status: "skipped", reason: "no_notes" };
  if (env.trigger === "auto" && !dreamDue(env.snapshot, env.settings, env.now)) return { status: "skipped", reason: "not_due" };
  const listed = await listProjectSessions(env.cwd, env.sessionDir);
  if (env.signal.aborted) return { status: "skipped", reason: "aborted" };
  const since = env.snapshot.dreamedAt ? Date.parse(env.snapshot.dreamedAt) : 0;
  const others = listed.filter(item => item.id !== env.sessionId && (env.trigger === "manual" || item.modifiedMs > since));
  if (env.trigger === "auto" && others.length < env.settings.dreamMinSessions) return { status: "skipped", reason: "too_few_sessions" };
  const sessions: DreamInput["sessions"] = [];
  if (env.currentLines.length) sessions.push({ id: env.sessionId, lines: env.currentLines });
  for (const item of [...others].sort((a, b) => b.modifiedMs - a.modifiedMs).slice(0, MAX_SESSIONS)) {
    const text = await readBounded(item.path, MAX_SESSION_BYTES);
    if (!text) continue;
    const lines = linesFromSessionText(text, item.id);
    if (lines.length) sessions.push({ id: item.id, lines });
  }
  const notes = [...env.snapshot.notes].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id)).map(note => ({
    id: note.id, type: note.type, title: note.title, updatedAt: note.updatedAt, text: clip([note.description, note.content].filter(Boolean).join("\n"), NOTE_BYTES),
  }));
  const input = fitDreamInput({ now: new Date(env.now).toISOString(), notes, forgotten: env.snapshot.forgotten.filter(id => !id.startsWith("sha:")).slice(-128), sessions });
  if (!input.notes.length) return { status: "skipped", reason: "no_notes" };
  try {
    const answer = await env.callModel(input);
    if (env.signal.aborted) return { status: "skipped", reason: "aborted" };
    const plan = parseDream(answer.data, input, env.snapshot.notes, env.snapshot.forgotten, env.sessionId);
    const applied = await env.consolidate(plan.drafts, plan.forget, env.snapshot.revision);
    return { status: "ok", saved: applied.saved, forgotten: applied.forgotten, provider: answer.provider, model: answer.model, ...(answer.requestedModel ? { requestedModel: answer.requestedModel } : {}), ...(answer.usage ? { usage: answer.usage } : {}) };
  } catch (error) {
    if (env.signal.aborted) return { status: "skipped", reason: "aborted" };
    const reason = clip(error instanceof Error ? error.message : String(error), 300);
    if (!reason.includes("stale")) await env.recordFailure(env.snapshot.revision).catch(() => undefined);
    return { status: "failed", reason };
  }
}
