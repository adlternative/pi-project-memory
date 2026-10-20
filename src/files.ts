import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, readFile, rename, unlink, type FileHandle } from "node:fs/promises";
import { join, parse, relative, sep } from "node:path";
import { hostname } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { hash, record, validId } from "./model.ts";
import { INDEX_BYTES, TOPIC_BYTES } from "./markdown.ts";

export interface FileText { text: string; hash: string; modifiedAt: string }
export interface Change { name: string; before: string | null; after: string | null }
const MIB = 1024 * 1024;
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT";
const digest = (value: unknown) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const allowed = (name: string) => ["MEMORY.md", ".state.json", "memories.json", ".legacy-memories.json", ".pending.json"].includes(name) || (name.endsWith(".md") && validId(name.slice(0, -3)));
const limit = (name: string) => name === ".pending.json" ? 4 * MIB : name === "MEMORY.md" ? INDEX_BYTES : name.endsWith(".md") ? TOPIC_BYTES : MIB;

const LOCK_WAIT_MS = 3000;

/** A lock whose owner is a dead process on this host. Unknown/foreign/unparseable locks are never reclaimed. */
function deadOwner(text: string): boolean {
  try {
    const owner = record(JSON.parse(text));
    if (owner.host !== hostname() || !Number.isSafeInteger(owner.pid) || (owner.pid as number) <= 0) return false;
    try { process.kill(owner.pid as number, 0); return false; } catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
  } catch { return false; }
}

/** Serialize reclaimers so one cannot delete a fresh lock another reclaimer just acquired. */
async function reclaim(lockPath: string, dead: string): Promise<boolean> {
  const guard = lockPath + ".reclaim";
  let handle: FileHandle;
  try { handle = await open(guard, "wx", 0o600); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    // A reclaim takes milliseconds; a guard older than 10s was left by a crash mid-reclaim.
    const info = await lstat(guard).catch(() => null);
    if (info && Date.now() - info.mtimeMs > 10_000) await unlink(guard).catch(() => {});
    return false;
  }
  try {
    // Nonces are unique, so a fresh lock never equals the dead text.
    if (await readFile(lockPath, "utf8").catch(() => null) !== dead) return false;
    await unlink(lockPath).catch(() => {});
    return true;
  } finally { await handle.close(); await unlink(guard).catch(() => {}); }
}

/** Short bounded retry for live contention; reclaim only provably dead same-host owners; otherwise fail closed. */
async function acquire(lockPath: string, signal?: AbortSignal): Promise<FileHandle> {
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (let delay = 10; ; delay = Math.min(delay * 2, 200)) {
    signal?.throwIfAborted();
    try {
      const lock = await open(lockPath, "wx", 0o600);
      try { await lock.writeFile(JSON.stringify({ pid: process.pid, host: hostname(), nonce: randomUUID(), startedAt: new Date().toISOString() })); }
      catch (error) { await lock.close(); await unlink(lockPath).catch(() => {}); throw error; }
      return lock;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    const text = await readFile(lockPath, "utf8").catch(() => null);
    if (text !== null && deadOwner(text) && await reclaim(lockPath, text)) continue;
    if (Date.now() >= deadline) throw new Error("Memory store busy: retry; a .lock not owned by a dead local Pi process is never removed automatically");
    await sleep(delay + Math.floor(Math.random() * delay), undefined, { signal });
  }
}

/** Private memory-file I/O: no arbitrary paths, links, silent corruption or partial multi-file reads. */
export class MemoryFiles {
  readonly dir: string;
  constructor(dir: string) { this.dir = dir; }

  async directory(create: boolean): Promise<boolean> {
    let current = parse(this.dir).root;
    for (const component of relative(current, this.dir).split(sep).filter(Boolean)) {
      current = join(current, component);
      if (create) await mkdir(current, { mode: 0o700 }).catch(error => { if (error.code !== "EEXIST") throw error; });
      let info;
      try { info = await lstat(current); } catch (error) { if (missing(error) && !create) return false; throw error; }
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Memory directory must not contain symlinks");
    }
    return true;
  }

  async read(name: string): Promise<FileText | null> {
    if (!allowed(name)) throw new Error("Invalid memory file path");
    let file;
    let before;
    try {
      before = await lstat(join(this.dir, name));
      if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > limit(name)) throw new Error(`Unsafe or oversized memory file: ${name}`);
      file = await open(join(this.dir, name), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    } catch (error) { if (missing(error)) return null; throw error; }
    try {
      const info = await file.stat();
      if (!info.isFile() || info.nlink !== 1 || info.size > limit(name) || info.dev !== before.dev || info.ino !== before.ino) throw new Error(`Unsafe or changed memory file: ${name}`);
      const bytes = await file.readFile();
      if (bytes.length > limit(name)) throw new Error(`Oversized memory file: ${name}`);
      const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
      return { text, hash: hash(text), modifiedAt: info.mtime.toISOString() };
    } finally { await file.close(); }
  }

  async topics(): Promise<string[]> {
    const names = (await readdir(this.dir)).filter(name => !name.startsWith(".") && name.endsWith(".md") && name !== "MEMORY.md").sort();
    if (names.some(name => !validId(name.slice(0, -3)))) throw new Error("Topic filenames must be lowercase kebab/snake ids, not memory.md");
    if (names.length > 128) throw new Error("Memory limit reached; review topic files before continuing");
    return names;
  }

  async locked<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    return withFileMutationQueue(join(this.dir, ".state.json"), async () => {
      signal?.throwIfAborted();
      await this.directory(true);
      const lockPath = join(this.dir, ".lock");
      const lock = await acquire(lockPath, signal);
      try {
        await this.recover();
        signal?.throwIfAborted();
        return await fn();
      } finally { try { await lock.close(); } finally { await unlink(lockPath); } }
    });
  }

  private async atomic(name: string, body: string, signal?: AbortSignal) {
    const temporary = join(this.dir, `.${randomUUID()}.tmp`);
    try {
      const output = await open(temporary, "wx", 0o600);
      try { await output.writeFile(body); await output.sync(); } finally { await output.close(); }
      signal?.throwIfAborted();
      await rename(temporary, join(this.dir, name));
    } finally { await unlink(temporary).catch(error => { if (!missing(error)) throw error; }); }
  }

  private validateChanges(value: unknown): Change[] {
    if (!Array.isArray(value) || !value.length || value.length > 132) throw new Error("Invalid memory transaction");
    const names = new Set<string>();
    const changes = value.map(value => {
      const item = record(value);
      if (typeof item.name !== "string" || !allowed(item.name) || item.name === ".pending.json" || names.has(item.name) || (item.before !== null && !digest(item.before)) || (item.after !== null && (typeof item.after !== "string" || Buffer.byteLength(item.after) > limit(item.name)))) throw new Error("Invalid memory transaction entry");
      names.add(item.name);
      return { name: item.name, before: item.before as string | null, after: item.after as string | null };
    });
    const last = changes.at(-1)!;
    if (last.name !== ".state.json" || last.after === null || record(JSON.parse(last.after)).version !== 2) throw new Error("Memory transaction must commit v2 state last");
    return changes;
  }

  private async apply(changes: Change[]) {
    for (const change of changes) {
      const current = await this.read(change.name);
      const afterHash = change.after === null ? null : hash(change.after);
      if ((current?.hash ?? null) === afterHash) continue;
      if ((current?.hash ?? null) !== change.before) throw new Error(`Memory transaction conflict: ${change.name}; preserve .pending.json and resolve the external edit first`);
      if (change.after === null) await unlink(join(this.dir, change.name));
      else await this.atomic(change.name, change.after);
    }
    await unlink(join(this.dir, ".pending.json"));
  }

  private async recover() {
    const pending = await this.read(".pending.json");
    if (!pending) return;
    const value = record(JSON.parse(pending.text));
    if (value.version !== 1) throw new Error("Unknown memory transaction version");
    const changes = this.validateChanges(value.changes);
    const state = await this.read(".state.json");
    // State-last makes this a committed transaction; later external Markdown edits must not be replayed over.
    if (state?.hash === hash(changes.at(-1)!.after!)) { await unlink(join(this.dir, ".pending.json")); return; }
    for (const change of changes) {
      const current = (await this.read(change.name))?.hash ?? null;
      if (current !== change.before && current !== (change.after === null ? null : hash(change.after))) throw new Error(`Memory recovery conflict: ${change.name}; no files overwritten`);
    }
    await this.apply(changes);
  }

  async commit(input: Change[], signal?: AbortSignal) {
    const changes = this.validateChanges(input);
    for (const change of changes) if (((await this.read(change.name))?.hash ?? null) !== change.before) throw new Error(`Memory changed concurrently: ${change.name}`);
    const journal = JSON.stringify({ version: 1, changes });
    if (Buffer.byteLength(journal) > 4 * MIB) throw new Error("Memory transaction exceeds its hard cap");
    signal?.throwIfAborted();
    await this.atomic(".pending.json", journal, signal);
    // Once the journal commits, finish (or recover) the whole transaction instead of leaving cancellation half-applied.
    await this.apply(changes);
  }
}
