import { execFile } from "node:child_process";
import { createReadStream } from "node:fs";
import { open, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import { clip, redact } from "./model.ts";

/** One transcript of this project, newest first; `when` is the file's last modification. */
export interface ProjectSession { id: string; file: string; cwd: string; when: string; title: string }

const run = promisify(execFile);

async function header(file: string): Promise<{ id?: string; cwd?: string; timestamp?: string } | undefined> {
  const handle = await open(file, "r").catch(() => undefined);
  if (!handle) return undefined;
  try {
    const { bytesRead, buffer } = await handle.read({ buffer: Buffer.alloc(4096), position: 0 });
    const line = buffer.subarray(0, bytesRead).toString("utf8").split("\n")[0];
    const value = JSON.parse(line) as Record<string, unknown>;
    return value.type === "session" ? { id: String(value.id ?? ""), cwd: String(value.cwd ?? ""), timestamp: String(value.timestamp ?? "") } : undefined;
  } catch { return undefined; } finally { await handle.close(); }
}

async function commonDir(cwd: string): Promise<string | null> {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const name of ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR"]) delete env[name];
  try {
    const { stdout } = await run("git", ["-C", cwd, "rev-parse", "--path-format=absolute", "--git-common-dir"], { env, timeout: 2000, maxBuffer: 8192 });
    return stdout.trim() || null;
  } catch { return null; }
}

/**
 * Transcripts of the project that `cwd` belongs to, like Claude Code's per-repository memory: every Pi
 * session directory whose recorded cwd is in the same Git repository, including deleted worktrees that
 * the repository still lists or that lived under the main checkout. Non-Git projects match by cwd.
 */
export async function projectSessions(sessionsRoot: string, cwd: string, since = 0): Promise<ProjectSession[]> {
  const mine = await commonDir(cwd);
  const worktrees = new Set<string>();
  if (mine) {
    try {
      const { stdout } = await run("git", ["-C", cwd, "worktree", "list", "--porcelain"], { timeout: 2000, maxBuffer: 1 << 20 });
      for (const line of stdout.split("\n")) if (line.startsWith("worktree ")) worktrees.add(line.slice(9));
    } catch { /* worktree listing is a hint, not required */ }
  }
  // Outside Git the project is just this directory, as for the memory store itself. Inside Git it is every
  // checkout of the repository: listed worktrees, anything whose common dir matches, and deleted worktrees
  // that lived inside the main checkout.
  const checkout = mine ? mine.replace(/\/\.git$/, "") : null;
  const belongs = new Map<string, boolean>();
  const matches = async (other: string) => {
    if (!other) return false;
    if (other === cwd) return true;
    if (!mine || !checkout) return false;
    if (!belongs.has(other)) {
      const known = worktrees.has(other) || other === checkout || other.startsWith(checkout + "/");
      belongs.set(other, known || (await commonDir(other)) === mine);
    }
    return belongs.get(other)!;
  };
  const found: ProjectSession[] = [];
  for (const dir of await readdir(sessionsRoot).catch(() => [] as string[])) {
    const path = join(sessionsRoot, dir);
    const files = (await readdir(path).catch(() => [] as string[])).filter(name => name.endsWith(".jsonl"));
    for (const name of files) {
      const file = join(path, name);
      const info = await stat(file).catch(() => undefined);
      if (!info || info.mtimeMs < since) continue;
      const head = await header(file);
      if (!head?.id || !await matches(head.cwd ?? "")) continue;
      found.push({ id: head.id, file, cwd: head.cwd ?? "", when: info.mtime.toISOString(), title: "" });
    }
  }
  return found.sort((a, b) => b.when.localeCompare(a.when));
}

interface Line { role: "user" | "assistant"; text: string }

function textOf(message: Record<string, unknown>): string {
  const content = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter(part => part && typeof part === "object" && (part as { type?: string }).type === "text").map(part => String((part as { text?: unknown }).text ?? "")).join("\n");
}

async function* conversation(file: string): AsyncGenerator<Line> {
  const lines = createInterface({ input: createReadStream(file, { encoding: "utf8" }), crlfDelay: Infinity });
  for await (const raw of lines) {
    if (!raw.includes('"type":"message"')) continue;
    let entry: Record<string, unknown>;
    try { entry = JSON.parse(raw) as Record<string, unknown>; } catch { continue; }
    const message = entry.message as Record<string, unknown> | undefined;
    if (!message || (message.role !== "user" && message.role !== "assistant")) continue;
    if (message.role === "assistant" && message.stopReason !== "stop") continue;
    const text = textOf(message).trim();
    if (text) yield { role: message.role, text };
  }
}

/** User requests and the assistant's final answers of one session, redacted and capped. */
export async function sessionDigest(file: string, maxBytes = 6000): Promise<string> {
  const out: string[] = [];
  let used = 0;
  for await (const line of conversation(file)) {
    const piece = `${line.role === "user" ? ">" : "<"} ${clip(redact(line.text.replace(/\s+/g, " ")), line.role === "user" ? 600 : 300)}`;
    if (used + Buffer.byteLength(piece) > maxBytes) { out.push("[truncated]"); break; }
    out.push(piece);
    used += Buffer.byteLength(piece) + 1;
  }
  return out.join("\n");
}

/** Lines across the given sessions that contain the query (case-insensitive), redacted and capped. */
export async function searchSessions(sessions: ProjectSession[], query: string, maxHits = 30): Promise<string> {
  const needle = query.toLowerCase();
  if (needle.trim().length < 2) throw new Error("Search for at least two characters");
  const hits: string[] = [];
  for (const session of sessions) {
    for await (const line of conversation(session.file)) {
      const at = line.text.toLowerCase().indexOf(needle);
      if (at < 0) continue;
      const start = Math.max(0, at - 160);
      hits.push(`[${session.id.slice(0, 8)} ${session.when.slice(0, 10)}] ${line.role === "user" ? ">" : "<"} ${clip(redact(line.text.slice(start, at + needle.length + 240).replace(/\s+/g, " ")), 420)}`);
      if (hits.length >= maxHits) return hits.join("\n") + "\n[more matches omitted]";
    }
  }
  return hits.length ? hits.join("\n") : "No matches.";
}

/** First user request of a session, used as its title in the list. */
export async function sessionTitle(file: string): Promise<string> {
  for await (const line of conversation(file)) if (line.role === "user") return clip(redact(line.text.replace(/\s+/g, " ")), 120);
  return "";
}
