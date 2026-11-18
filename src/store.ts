import { execFile } from "node:child_process";
import { basename, dirname, join, resolve } from "node:path";
import { lstat, realpath, rename } from "node:fs/promises";
import { promisify } from "node:util";
import { MemoryFiles, type Change, type FileText } from "./files.ts";
import { INDEX_BYTES, parseTopic, renderIndexFitted, renderTopic } from "./markdown.ts";
import { clip, CONTENT_BYTES, fingerprint, hash, legacyState, MAX_FORGOTTEN, MAX_NOTES, record, timestamp, validId, validateForgotten, validateInput, validateSource, type Draft, type Memory, type Source, type State } from "./model.ts";
export { clip, fingerprint, hash, MAX_NOTES, record, redact, TYPES, validateInput } from "./model.ts";
export type { Draft, Memory, MemoryInput, MemoryType, Source, State } from "./model.ts";

interface Metadata { hash: string; contentHash: string; source: Source; createdAt: string; updatedAt: string }
interface DreamState { lastAt: number; sessionsSince: number }
interface DiskState { version: 2; revision: number; records: Record<string, Metadata>; forgotten: string[]; indexHash: string; dream?: DreamState }
interface Loaded { state: State; disk: DiskState; metadata: FileText | null; index: FileText | null; documents: Map<string, FileText> }
const emptyDisk = (): DiskState => ({ version: 2, revision: 0, records: {}, forgotten: [], indexHash: hash("") });
const emptyState = (): State => ({ version: 2, revision: 0, notes: [], forgotten: [], index: renderIndexFitted(null, []).text });
/** Keeps frontmatter, trims the body to the accepted size. */
function clampTopicBody(source: string, max: number): string {
  const match = source.match(/^(---\n[\s\S]*?\n---\n)([\s\S]*)$/);
  if (!match) return source;
  return match[1] + clampBytes(match[2], max);
}

/** Cuts at a codepoint boundary so the result is still valid UTF-8 and parses as a note. */
function clampBytes(text: string, max: number): string {
  let out = text;
  while (Buffer.byteLength(out) > max) out = out.slice(0, Math.floor(out.length * 0.9) - 1);
  return out.replace(/[\uD800-\uDFFF]$/, "");
}

const noteMetadata = (note: Memory, digest: string): Metadata => ({ hash: digest, contentHash: fingerprint(note.content), source: note.source, createdAt: note.createdAt, updatedAt: note.updatedAt });

function validateDisk(value: unknown): DiskState {
  const disk = record(value);
  if (disk.version !== 2 || !Number.isSafeInteger(disk.revision) || (disk.revision as number) < 0 || typeof disk.indexHash !== "string" || !/^[a-f0-9]{64}$/.test(disk.indexHash)) throw new Error("Invalid Markdown memory state schema");
  const entries = Object.entries(record(disk.records));
  if (entries.length > MAX_NOTES) throw new Error("Too many memory metadata records");
  const records = Object.fromEntries(entries.map(([id, value]) => {
    const entry = record(value);
    if (!validId(id) || typeof entry.hash !== "string" || !/^[a-f0-9]{64}$/.test(entry.hash) || typeof entry.contentHash !== "string" || !/^sha:[a-f0-9]{64}$/.test(entry.contentHash)) throw new Error("Invalid memory metadata");
    return [id, { hash: entry.hash, contentHash: entry.contentHash, source: validateSource(entry.source), createdAt: timestamp(entry.createdAt), updatedAt: timestamp(entry.updatedAt) }];
  }));
  const rawDream = record(disk.dream ?? {});
  const lastAt = typeof rawDream.lastAt === "number" && Number.isFinite(rawDream.lastAt) ? rawDream.lastAt : 0;
  const sessionsSince = typeof rawDream.sessionsSince === "number" && Number.isFinite(rawDream.sessionsSince) ? Math.max(0, Math.floor(rawDream.sessionsSince)) : 0;
  return { version: 2, revision: disk.revision as number, records, forgotten: validateForgotten(disk.forgotten), indexHash: disk.indexHash, dream: { lastAt, sessionsSince } };
}

export interface ProjectIdentity { key: string; name: string }

const NAME_MAX = 48;
function slugName(value: string): string {
  const slug = value.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/-+/g, "-").replace(/^[-.]+|[-.]+$/g, "").slice(0, NAME_MAX).replace(/[-.]+$/g, "");
  return slug || "project";
}

/**
 * The hash identifies the project; the readable name is only a label.
 *
 * Pi's session and CC's memory folders collapse separators into "-", so /a/b and /a-b encode
 * identically. A pure slug would merge two projects, so the hash stays authoritative here.
 */
export async function projectIdentity(cwd: string): Promise<ProjectIdentity> {
  const canonical = await realpath(cwd);
  const common = await gitCommonDir(canonical);
  const root = common
    ? await realpath(resolve(canonical, common)).catch(() => resolve(canonical, common))
    : canonical;
  const base = common ? (basename(root) === ".git" ? basename(dirname(root)) : basename(root).replace(/\.git$/, "")) : basename(canonical);
  return { key: hash(root).slice(0, 24), name: slugName(base) };
}

export async function projectKey(cwd: string): Promise<string> {
  return (await projectIdentity(cwd)).key;
}

// These redirect git at another repository. Inherited from a hook or an export, they make a
// worktree resolve to nothing, which would silently split its memory from the main checkout.
const GIT_LOCATION_ENV = ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR"];

async function gitCommonDir(cwd: string): Promise<string | null> {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const name of GIT_LOCATION_ENV) delete env[name];
  try {
    const { stdout } = await promisify(execFile)("git", ["rev-parse", "--git-common-dir"], { cwd, env, timeout: 2000, maxBuffer: 8192 });
    return stdout.trim() || null;
  } catch { /* Non-Git directories remain isolated by canonical cwd. */ return null; }
}

/**
 * Tokens a merge must not drop: URLs, code spans without spaces, ticket/MR numbers (6+ digits), commit
 * hashes (7+ hex with a digit and a letter) and file paths. Trailing sentence punctuation is not part of
 * a token; dates and prose are not tokens.
 */
export function identifiers(text: string): string[] {
  const found = new Set<string>();
  const add = (token: string) => { const value = token.replace(/[.,;:!?)\]]+$/, ""); if (value.length >= 2) found.add(value); };
  for (const match of text.matchAll(/https?:\/\/[^\s)\]>"'\uff0c\u3002\uff1b\u3001]+/gi)) add(match[0]);
  for (const match of text.matchAll(/`([^`\s]{2,80})`/g)) add(match[1]);
  for (const match of text.matchAll(/(?<![\w.])(?:(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}|\d{6,})(?!\w|\.\w)/gi)) add(match[0]);
  for (const match of text.matchAll(/(?<![\w/~])(?:~?\/)?(?:[\w.-]+\/)+[\w.-]*\.[a-z][a-z0-9]{0,5}(?!\w)/gi)) add(match[0]);
  return [...found];
}

/** Topic Markdown is authoritative; the hidden JSON stores only provenance and coordination metadata. */
export class MemoryStore {
  readonly dir: string;
  readonly file: string;
  readonly indexFile: string;
  private readonly legacyDir: string;
  private readonly files: MemoryFiles;
  constructor(root: string, key: string, name: string = key) {
    if (!/^[a-f0-9]{24}$/.test(key)) throw new Error("Invalid project key");
    const base = resolve(root);
    this.legacyDir = join(base, key);
    this.dir = name === key ? this.legacyDir : join(base, `${slugName(name)}__${key.slice(0, 12)}`);
    this.file = join(this.dir, ".state.json");
    this.indexFile = join(this.dir, "MEMORY.md");
    this.files = new MemoryFiles(this.dir);
  }

  private async persist(loaded: Loaded, notes: Memory[], forgotten: string[], edits: Map<string, string | null>, extras: Change[] = [], signal?: AbortSignal, dream = loaded.disk.dream) {
    if (notes.length > MAX_NOTES) throw new Error("Memory limit reached; review /pmem list and forget obsolete notes");
    const { text: index } = renderIndexFitted(loaded.index?.text ?? null, notes);
    const records = Object.fromEntries([...notes].sort((a, b) => a.id.localeCompare(b.id)).map(note => {
      const name = `${note.id}.md`;
      const body = edits.has(name) ? edits.get(name) : loaded.documents.get(name)?.text;
      if (body === undefined || body === null) throw new Error("Missing Markdown for memory metadata");
      return [note.id, noteMetadata(note, hash(body))];
    }));
    const disk = validateDisk({ version: 2, revision: loaded.disk.revision + 1, records, forgotten: forgotten.slice(-MAX_FORGOTTEN), indexHash: hash(index), ...(dream ? { dream } : {}) });
    const changes: Change[] = [...edits].map(([name, after]) => ({ name, before: loaded.documents.get(name)?.hash ?? null, after }));
    changes.push(...extras);
    if (index !== loaded.index?.text) changes.push({ name: "MEMORY.md", before: loaded.index?.hash ?? null, after: index });
    changes.push({ name: ".state.json", before: loaded.metadata?.hash ?? null, after: JSON.stringify(disk, null, 2) + "\n" });
    await this.files.commit(changes, signal);
  }

  /** tolerant: skip unreadable topic files (reported in state.invalid) and never reconcile/persist while any exist. */
  private async load(tolerant = false): Promise<Loaded> {
    const metadata = await this.files.read(".state.json");
    const legacy = await this.files.read("memories.json");
    const index = await this.files.read("MEMORY.md");
    const names = await this.files.topics();
    if (metadata && legacy) throw new Error("Legacy JSON reappeared beside Markdown state; stop the v0.1 writer and resolve it before continuing");
    if (!metadata && await this.files.read(".legacy-memories.json")) throw new Error("Missing .state.json after migration; restore metadata instead of resurrecting the legacy backup");
    let disk = metadata ? validateDisk(JSON.parse(metadata.text)) : emptyDisk();
    const documents = new Map<string, FileText>();
    const notes: Memory[] = [];
    let forgotten = [...disk.forgotten];
    const invalid: { file: string; error: string }[] = [];
    const truncated: string[] = [];
    for (const name of names) {
      let file: FileText | null, input;
      try {
        file = await this.files.read(name);
        if (!file) throw new Error(`Memory file changed during read: ${name}`);
        // A note over the body limit is clamped rather than rejected: one oversized file must not disable the store.
        try { input = parseTopic(name, file.text); }
        catch (error) {
          if (!(error instanceof Error) || !/Invalid or oversized memory text/.test(error.message)) throw error;
          input = parseTopic(name, clampTopicBody(file.text, CONTENT_BYTES));
          truncated.push(name.replace(/\.md$/, ""));
        }
      } catch (error) {
        if (!tolerant || legacy) throw error;
        invalid.push({ file: name, error: (error as Error).message });
        continue;
      }
      documents.set(name, file);
      const prior = Object.hasOwn(disk.records, input.id) ? disk.records[input.id] : undefined;
      const unchanged = prior?.hash === file.hash;
      const source: Source = unchanged ? prior.source : { sessionId: "filesystem", entryId: name, quote: clip(input.content, 400), origin: "file" };
      notes.push({ ...input, source, createdAt: prior?.createdAt ?? file.modifiedAt, updatedAt: unchanged ? prior.updatedAt : file.modifiedAt });
      if (!unchanged) forgotten = forgotten.filter(id => id !== input.id && id !== fingerprint(input.content));
    }
    for (const [id, prior] of Object.entries(disk.records)) if (!documents.has(`${id}.md`) && !invalid.some(item => item.file === `${id}.md`)) forgotten.push(id, prior.contentHash);
    forgotten = [...new Set(forgotten)].slice(-MAX_FORGOTTEN);
    const fitted = renderIndexFitted(index?.text ?? null, notes);
    const state: State = { version: 2, revision: disk.revision, notes, forgotten, index: fitted.text, ...(fitted.omitted.length ? { indexOmitted: fitted.omitted } : {}), ...(invalid.length ? { invalid } : {}), ...(truncated.length ? { truncated } : {}) };
    const loaded: Loaded = { state, disk, metadata, index, documents };
    if (invalid.length) return loaded;
    if (legacy) {
      if (names.length || index) throw new Error("Legacy JSON and existing Markdown coexist; migration refuses to overwrite authored files");
      const old = legacyState(JSON.parse(legacy.text));
      disk = { ...disk, revision: old.revision };
      const edits = new Map(old.notes.map(note => [`${note.id}.md`, renderTopic(note)]));
      await this.persist({ ...loaded, disk }, old.notes, old.forgotten, edits, [
        { name: ".legacy-memories.json", before: null, after: legacy.text },
        { name: "memories.json", before: legacy.hash, after: null },
      ]);
      return this.load();
    }
    if (!metadata && !names.length && !index) return loaded;
    const currentRecords = Object.fromEntries([...notes].sort((a, b) => a.id.localeCompare(b.id)).map(note => [note.id, noteMetadata(note, documents.get(`${note.id}.md`)!.hash)]));
    if (!metadata || JSON.stringify(currentRecords) !== JSON.stringify(disk.records) || JSON.stringify(forgotten) !== JSON.stringify(disk.forgotten) || disk.indexHash !== hash(state.index) || index?.text !== state.index) {
      await this.persist(loaded, notes, forgotten, new Map());
      return this.load();
    }
    return loaded;
  }

  /** Hash-only folders from earlier versions are renamed in place, never copied or merged. */
  private async adoptLegacyDir(): Promise<void> {
    if (this.dir === this.legacyDir) return;
    if (await this.files.directory(false)) return;
    const legacy = await lstat(this.legacyDir).catch(() => undefined);
    if (!legacy?.isDirectory() || legacy.isSymbolicLink()) return;
    await rename(this.legacyDir, this.dir).catch(error => { if (error.code !== "ENOENT" && error.code !== "EEXIST") throw error; });
  }

  /** Strict by default. tolerant skips broken topic files (listed in state.invalid) for read-only callers. */
  async read(options: { tolerant?: boolean; strictNotes?: boolean } = {}): Promise<State> {
    await this.adoptLegacyDir();
    if (!await this.files.directory(false)) return emptyState();
    return this.files.locked(async () => {
      const { state } = await this.load(options.tolerant);
      // File tools ask for the strict view so an oversized note is reported instead of silently clamped.
      if (options.strictNotes && state.truncated?.length) throw new Error(`Oversized memory file: ${state.truncated[0]}.md`);
      return state;
    });
  }

  async save(drafts: Draft[], options: { automatic?: boolean; expectedRevision?: number; signal?: AbortSignal; skipWhenFull?: boolean } = {}): Promise<Memory[]> {
    if (drafts.length > 4) throw new Error("At most four memories per save");
    const validated = drafts.map(draft => ({ ...validateInput(draft), source: validateSource(draft.source) }));
    await this.adoptLegacyDir();
    return this.files.locked(async () => {
      const loaded = await this.load();
      if (options.expectedRevision !== undefined && loaded.state.revision !== options.expectedRevision) throw new Error("Memory changed during extraction; stale result discarded");
      const notes = [...loaded.state.notes];
      let forgotten = [...loaded.state.forgotten];
      const saved: Memory[] = [];
      const edits = new Map<string, string | null>();
      for (const input of validated) {
        const digest = fingerprint(input.content);
        if (options.automatic && (forgotten.includes(input.id) || forgotten.includes(digest))) continue;
        const sameId = notes.find(note => note.id === input.id);
        // Identical content under another id is a duplicate: return that note untouched instead of renaming it.
        const duplicate = sameId ? undefined : notes.find(note => fingerprint(note.content) === digest);
        if (duplicate) { saved.push(duplicate); continue; }
        const existing = sameId;
        const description = input.description ?? existing?.description;
        if (existing && existing.content === input.content && existing.title === input.title && existing.type === input.type && existing.description === description) { saved.push(existing); continue; }
        if (!options.automatic) forgotten = forgotten.filter(id => id !== input.id && id !== digest);
        const now = new Date().toISOString();
        const note: Memory = { ...input, ...(description === undefined ? {} : { description }), id: existing?.id ?? input.id, createdAt: existing?.createdAt ?? now, updatedAt: now };
        if (existing) notes[notes.indexOf(existing)] = note;
        else {
          // The index budget is the real limit, the note cap a safety net. Reads tolerate an index that
          // outgrew its budget; adding a note that would push a link out of the index is refused.
          const full = notes.length >= MAX_NOTES ? "count" : renderIndexFitted(loaded.index?.text ?? null, [...notes, note]).omitted.length > renderIndexFitted(loaded.index?.text ?? null, notes).omitted.length ? "index" : undefined;
          if (full) {
            // Extractions drop new notes when full instead of discarding the whole batch (updates above still apply).
            if (options.skipWhenFull) continue;
            throw new Error(full === "count" ? "Memory limit reached; review /pmem list and forget obsolete notes" : `MEMORY.md exceeds ${INDEX_BYTES.toLocaleString("en-US")} UTF-8 bytes; forget or merge notes before adding more`);
          }
          notes.push(note);
        }
        edits.set(`${note.id}.md`, renderTopic(note));
        saved.push(note);
      }
      if (edits.size || JSON.stringify(forgotten) !== JSON.stringify(loaded.state.forgotten)) await this.persist(loaded, notes, forgotten, edits, [], options.signal);
      return saved;
    }, options.signal);
  }

  /** Records one session for dream eligibility; returns the counters. */
  async noteDreamSession(): Promise<{ lastAt: number; sessionsSince: number }> {
    // Starting a session must not create a store or a directory that was never used.
    if (!await this.files.directory(false)) return { lastAt: 0, sessionsSince: 0 };
    await this.adoptLegacyDir();
    return this.files.locked(async () => {
      const loaded = await this.load();
      const dream = { lastAt: loaded.disk.dream?.lastAt ?? 0, sessionsSince: (loaded.disk.dream?.sessionsSince ?? 0) + 1 };
      await this.writeDream(loaded, dream);
      return dream;
    });
  }

  /**
   * Claims a scheduled pass when it is due, like Claude Code's .consolidate-lock: the timer moves under the
   * store lock, so of many sessions starting together only one gets the claim. Returns the prior state for
   * releaseDream, or null when not due or already claimed.
   */
  async claimDream(minHours: number, minSessions: number, now = Date.now()): Promise<{ lastAt: number; sessionsSince: number } | null> {
    if (!await this.files.directory(false)) return null;
    await this.adoptLegacyDir();
    return this.files.locked(async () => {
      const loaded = await this.load();
      const prior = { lastAt: loaded.disk.dream?.lastAt ?? 0, sessionsSince: loaded.disk.dream?.sessionsSince ?? 0 };
      if (prior.sessionsSince < minSessions || (prior.lastAt !== 0 && now - prior.lastAt < minHours * 3_600_000)) return null;
      await this.writeDream(loaded, { lastAt: now, sessionsSince: 0 });
      return prior;
    });
  }

  /** The dream counters as stored; a store that was never used reports a pass that never ran. */
  async dreamState(): Promise<{ lastAt: number; sessionsSince: number }> {
    if (!await this.files.directory(false)) return { lastAt: 0, sessionsSince: 0 };
    return this.files.locked(async () => {
      const dream = (await this.load(true)).disk.dream;
      return { lastAt: dream?.lastAt ?? 0, sessionsSince: dream?.sessionsSince ?? 0 };
    });
  }

  /** Hands a failed pass's claim back so the next session retries instead of waiting out minHours. */
  async releaseDream(prior: { lastAt: number; sessionsSince: number }, claimedAt: number): Promise<void> {
    await this.files.locked(async () => {
      const loaded = await this.load();
      // A later claim or a finished pass owns the timer now.
      if (loaded.disk.dream?.lastAt !== claimedAt) return;
      await this.writeDream(loaded, { lastAt: prior.lastAt, sessionsSince: prior.sessionsSince + (loaded.disk.dream?.sessionsSince ?? 0) });
    });
  }

  private async writeDream(loaded: Loaded, dream: DreamState): Promise<void> {
    await this.files.commit([{ name: ".state.json", before: loaded.metadata?.hash ?? null, after: JSON.stringify({ ...loaded.disk, dream }, null, 2) + "\n" }]);
  }

  /**
   * Applies a dream pass in one transaction. Each change carries the hash of the file the agent read, so a
   * note edited meanwhile (by extraction, a user or another pass) aborts the whole pass instead of being
   * overwritten; untouched notes may change freely. New notes need an id that is free and not forgotten,
   * deletions are capped at a quarter of the notes, and the index budget applies to new notes.
   */
  async applyDream(changes: { id: string; before: string | null; after: Draft | null }[], options: { signal?: AbortSignal } = {}): Promise<{ created: string[]; updated: string[]; deleted: string[] }> {
    const seen = new Set<string>();
    for (const change of changes) {
      if (!validId(change.id) || seen.has(change.id)) throw new Error(`Invalid or repeated memory id in dream: ${change.id}`);
      seen.add(change.id);
    }
    const validated = changes.map(change => ({ ...change, after: change.after ? { ...validateInput(change.after), source: validateSource(change.after.source) } : null }));
    await this.adoptLegacyDir();
    return this.files.locked(async () => {
      const loaded = await this.load();
      let notes = [...loaded.state.notes];
      let forgotten = [...loaded.state.forgotten];
      const edits = new Map<string, string | null>();
      const result = { created: [] as string[], updated: [] as string[], deleted: [] as string[] };
      const now = new Date().toISOString();
      for (const change of validated) {
        const current = loaded.documents.get(`${change.id}.md`)?.hash ?? null;
        if (current !== change.before) throw new Error(`${change.id}.md changed while dreaming; nothing was applied`);
        const existing = notes.find(note => note.id === change.id);
        if (!change.after) {
          if (!existing) continue;
          forgotten = [...new Set([...forgotten, change.id, fingerprint(existing.content)])];
          notes = notes.filter(note => note.id !== change.id);
          edits.set(`${change.id}.md`, null);
          result.deleted.push(change.id);
          continue;
        }
        if (change.after.id !== change.id) throw new Error(`Dream wrote ${change.after.id} into ${change.id}.md`);
        if (!existing && (forgotten.includes(change.id) || forgotten.includes(fingerprint(change.after.content)))) throw new Error(`Dream tried to restore forgotten note ${change.id}; nothing was applied`);
        const note: Memory = { ...change.after, createdAt: existing?.createdAt ?? now, updatedAt: now };
        if (existing) notes[notes.indexOf(existing)] = note;
        else notes.push(note);
        edits.set(`${change.id}.md`, renderTopic(note));
        (existing ? result.updated : result.created).push(change.id);
      }
      if (result.deleted.length > Math.max(1, Math.floor(loaded.state.notes.length / 4))) throw new Error("Dream tried to delete more than a quarter of the notes; nothing was applied");
      // A merge must not lose identifiers: every ticket number, hash, URL, path or code span of a deleted
      // note has to survive in some remaining note. A note the sessions showed to be wrong carries none
      // that matter, so the agent rewrites the survivor to keep them or does not delete.
      const remaining = notes.map(note => `${note.title}\n${note.description ?? ""}\n${note.content}`).join("\n");
      for (const id of result.deleted) {
        const gone = loaded.state.notes.find(note => note.id === id)!;
        const missing = identifiers(`${gone.title}\n${gone.content}`).filter(token => !remaining.includes(token));
        if (missing.length) throw new Error(`Deleting ${id} would lose ${missing.slice(0, 3).join(", ")}; merge them into a remaining note first. Nothing was applied`);
      }
      if (notes.length > MAX_NOTES) throw new Error("Memory limit reached; dream may not add notes past the cap");
      const before = renderIndexFitted(loaded.index?.text ?? null, loaded.state.notes).omitted.length;
      if (result.created.length && renderIndexFitted(loaded.index?.text ?? null, notes).omitted.length > before) throw new Error(`MEMORY.md exceeds ${INDEX_BYTES.toLocaleString("en-US")} UTF-8 bytes; dream may not add notes until others are merged`);
      // Every finished pass moves the timer, so the next one only reviews sessions after this one.
      const dream = { lastAt: Date.now(), sessionsSince: 0 };
      if (edits.size) await this.persist(loaded, notes, forgotten, edits, [], options.signal, dream);
      else await this.writeDream(loaded, dream);
      return result;
    }, options.signal);
  }

  /** Each topic file's text and hash as on disk, so a dream reads exactly what its changes are checked against. */
  async topicFiles(): Promise<Map<string, { text: string; hash: string }>> {
    if (!await this.files.directory(false)) return new Map();
    return this.files.locked(async () => {
      const loaded = await this.load(true);
      return new Map([...loaded.documents].map(([name, file]) => [name.replace(/\.md$/, ""), { text: file.text, hash: file.hash }]));
    });
  }

  async forget(id: string): Promise<void> {
    if (!validId(id)) throw new Error("Invalid memory id");
    await this.adoptLegacyDir();
    await this.files.locked(async () => {
      const loaded = await this.load();
      const note = loaded.state.notes.find(note => note.id === id);
      if (!note) throw new Error("Memory not found");
      const forgotten = [...new Set([...loaded.state.forgotten, id, fingerprint(note.content)])];
      await this.persist(loaded, loaded.state.notes.filter(note => note.id !== id), forgotten, new Map([[`${id}.md`, null]]));
    });
  }
}
