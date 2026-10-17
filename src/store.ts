import { execFile } from "node:child_process";
import { basename, dirname, join, resolve } from "node:path";
import { lstat, realpath, rename } from "node:fs/promises";
import { promisify } from "node:util";
import { MemoryFiles, type Change, type FileText } from "./files.ts";
import { parseTopic, renderIndex, renderTopic } from "./markdown.ts";
import { clip, fingerprint, hash, legacyState, MAX_NOTES, record, timestamp, validId, validateForgotten, validateInput, validateSource, type Draft, type Memory, type Source, type State } from "./model.ts";
export { clip, fingerprint, hash, MAX_NOTES, record, redact, TYPES, validateInput } from "./model.ts";
export type { Draft, Memory, MemoryInput, MemoryType, Source, State } from "./model.ts";

interface Metadata { hash: string; contentHash: string; source: Source; createdAt: string; updatedAt: string }
interface DiskState { version: 2; revision: number; records: Record<string, Metadata>; forgotten: string[]; indexHash: string }
interface Loaded { state: State; disk: DiskState; metadata: FileText | null; index: FileText | null; documents: Map<string, FileText> }
const emptyDisk = (): DiskState => ({ version: 2, revision: 0, records: {}, forgotten: [], indexHash: hash("") });
const emptyState = (): State => ({ version: 2, revision: 0, notes: [], forgotten: [], index: renderIndex(null, []) });
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
  return { version: 2, revision: disk.revision as number, records, forgotten: validateForgotten(disk.forgotten), indexHash: disk.indexHash };
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

  private async persist(loaded: Loaded, notes: Memory[], forgotten: string[], edits: Map<string, string | null>, extras: Change[] = [], signal?: AbortSignal) {
    if (notes.length > MAX_NOTES) throw new Error("Memory limit reached; review /pmem list and forget obsolete notes");
    const index = renderIndex(loaded.index?.text ?? null, notes);
    const records = Object.fromEntries([...notes].sort((a, b) => a.id.localeCompare(b.id)).map(note => {
      const name = `${note.id}.md`;
      const body = edits.has(name) ? edits.get(name) : loaded.documents.get(name)?.text;
      if (body === undefined || body === null) throw new Error("Missing Markdown for memory metadata");
      return [note.id, noteMetadata(note, hash(body))];
    }));
    const disk = validateDisk({ version: 2, revision: loaded.disk.revision + 1, records, forgotten, indexHash: hash(index) });
    const changes: Change[] = [...edits].map(([name, after]) => ({ name, before: loaded.documents.get(name)?.hash ?? null, after }));
    changes.push(...extras);
    if (index !== loaded.index?.text) changes.push({ name: "MEMORY.md", before: loaded.index?.hash ?? null, after: index });
    changes.push({ name: ".state.json", before: loaded.metadata?.hash ?? null, after: JSON.stringify(disk, null, 2) + "\n" });
    await this.files.commit(changes, signal);
  }

  private async load(): Promise<Loaded> {
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
    for (const name of names) {
      const file = await this.files.read(name);
      if (!file) throw new Error(`Memory file changed during read: ${name}`);
      documents.set(name, file);
      const input = parseTopic(name, file.text);
      const prior = Object.hasOwn(disk.records, input.id) ? disk.records[input.id] : undefined;
      const unchanged = prior?.hash === file.hash;
      const source: Source = unchanged ? prior.source : { sessionId: "filesystem", entryId: name, quote: clip(input.content, 400), origin: "file" };
      notes.push({ ...input, source, createdAt: prior?.createdAt ?? file.modifiedAt, updatedAt: unchanged ? prior.updatedAt : file.modifiedAt });
      if (!unchanged) forgotten = forgotten.filter(id => id !== input.id && id !== fingerprint(input.content));
    }
    for (const [id, prior] of Object.entries(disk.records)) if (!documents.has(`${id}.md`)) forgotten.push(id, prior.contentHash);
    forgotten = [...new Set(forgotten)];
    const state: State = { version: 2, revision: disk.revision, notes, forgotten, index: renderIndex(index?.text ?? null, notes) };
    const loaded: Loaded = { state, disk, metadata, index, documents };
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

  async read(): Promise<State> {
    await this.adoptLegacyDir();
    if (!await this.files.directory(false)) return emptyState();
    return this.files.locked(async () => (await this.load()).state);
  }

  async save(drafts: Draft[], options: { automatic?: boolean; expectedRevision?: number; signal?: AbortSignal } = {}): Promise<Memory[]> {
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
        const existing = notes.find(note => note.id === input.id) ?? notes.find(note => fingerprint(note.content) === digest);
        const description = input.description ?? existing?.description;
        if (existing && existing.content === input.content && existing.title === input.title && existing.type === input.type && existing.description === description) { saved.push(existing); continue; }
        if (!options.automatic) forgotten = forgotten.filter(id => id !== input.id && id !== digest);
        const now = new Date().toISOString();
        const note: Memory = { ...input, ...(description === undefined ? {} : { description }), id: existing?.id ?? input.id, createdAt: existing?.createdAt ?? now, updatedAt: now };
        if (existing) notes[notes.indexOf(existing)] = note;
        else { if (notes.length >= MAX_NOTES) throw new Error("Memory limit reached; review /pmem list and forget obsolete notes"); notes.push(note); }
        edits.set(`${note.id}.md`, renderTopic(note));
        saved.push(note);
      }
      if (edits.size || JSON.stringify(forgotten) !== JSON.stringify(loaded.state.forgotten)) await this.persist(loaded, notes, forgotten, edits, [], options.signal);
      return saved;
    }, options.signal);
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
