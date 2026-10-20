import { createHash } from "node:crypto";

export const TYPES = ["user", "feedback", "project", "reference"] as const;
export type MemoryType = (typeof TYPES)[number];
export interface MemoryInput { id: string; type: MemoryType; title: string; description?: string; content: string }
export interface Source { sessionId: string; entryId: string; quote: string; origin: "explicit" | "extracted" | "file" }
export interface Memory extends MemoryInput { source: Source; createdAt: string; updatedAt: string }
export interface State { version: 2; revision: number; notes: Memory[]; forgotten: string[]; index: string; invalid?: { file: string; error: string }[] }
export interface Draft extends MemoryInput { source: Source }
export const MAX_NOTES = 128;
/** Tombstones roll over oldest-first; forgetting must never brick the store. */
export const MAX_FORGOTTEN = 512;
export const hash = (text: string) => createHash("sha256").update(text).digest("hex");
export const fingerprint = (text: string) => "sha:" + hash(text.normalize("NFKC").toLowerCase().replace(/\s+/gu, " ").trim());
export const validId = (id: string) => /^[a-z0-9][a-z0-9_-]{0,63}$/.test(id) && id !== "memory";

export function clip(text: string, bytes: number): string {
  const data = Buffer.from(text);
  if (data.length <= bytes) return text;
  let end = Math.max(0, bytes);
  while (end > 0 && (data[end] & 0xc0) === 0x80) end--;
  return data.subarray(0, end).toString("utf8");
}

export function redact(text: string): string {
  return text
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g, "[REDACTED]")
    .replace(/\b(?:sk-(?:ant-)?[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[A-Z0-9]{16})\b/g, "[REDACTED]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, "Bearer [REDACTED]")
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[REDACTED]")
    // Keyword rule only fires on secret-shaped values (ASCII and either 8+ chars with a digit/symbol, or 20+ chars), so prose like "password: ask ops" survives.
    .replace(/(\b(?:password|passwd|api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|secret|token)\b["']?\s*[:=]\s*)["']?(?=[\w.\/+=~!@#$%^*-]*[\d.\/+=~!@#$%^*_-]|[\w.\/+=~!@#$%^*-]{20})[\w.\/+=~!@#$%^*-]{8,}["']?/gi, "$1[REDACTED]")
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, "$1[REDACTED]@")
    .replace(/([?&](?:token|key|api_key|password|signature|x-amz-signature|x-amz-security-token)=)[^\s&#]+/gi, "$1[REDACTED]");
}

export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected an object");
  return value as Record<string, unknown>;
}

export function text(value: unknown, maxBytes: number, multiline = false): string {
  if (typeof value !== "string" || !value.trim() || Buffer.byteLength(value) > maxBytes || Buffer.from(value).toString("utf8") !== value || /[\x00-\x08\x0b\x0c\x0e-\x1f]/u.test(value) || (!multiline && /[\r\n]/u.test(value))) throw new Error("Invalid or oversized memory text");
  return value.trim();
}

export function validateInput(value: unknown): MemoryInput {
  const item = record(value);
  const id = text(item.id, 64);
  if (!validId(id) || !TYPES.includes(item.type as MemoryType)) throw new Error("Invalid memory id or type (memory is reserved for MEMORY.md)");
  const title = text(item.title, 160);
  const content = text(item.content, 2000, true);
  const description = item.description === undefined ? undefined : text(item.description, 320);
  const all = title + "\n" + (description ?? "") + "\n" + content;
  if (redact(all) !== all || all.includes("[REDACTED]")) throw new Error("Do not save credentials or redacted secrets");
  return { id, type: item.type as MemoryType, title, ...(description === undefined ? {} : { description }), content };
}

export function validateSource(value: unknown): Source {
  const item = record(value);
  if (item.origin !== "explicit" && item.origin !== "extracted" && item.origin !== "file") throw new Error("Invalid memory source");
  const quote = text(item.quote, 400, true);
  if (redact(quote) !== quote) throw new Error("Secret in memory source");
  return { sessionId: text(item.sessionId, 180), entryId: text(item.entryId, 180), quote, origin: item.origin };
}

export function timestamp(value: unknown): string {
  const result = text(value, 30);
  if (!Number.isFinite(Date.parse(result))) throw new Error("Invalid memory timestamp");
  return result;
}

export function validateForgotten(value: unknown): string[] {
  if (!Array.isArray(value)) throw new Error("Invalid forgotten memory list");
  if (value.length > 1024) throw new Error("Invalid forgotten memory list: too many markers");
  return value.map(id => {
    if (typeof id !== "string" || (!validId(id) && !/^sha:[a-f0-9]{64}$/.test(id))) throw new Error("Invalid forgotten id");
    return id;
  });
}

export function legacyState(value: unknown): Omit<State, "version" | "index"> {
  const state = record(value);
  if (state.version !== 1 || !Number.isSafeInteger(state.revision) || (state.revision as number) < 0 || !Array.isArray(state.notes) || state.notes.length > MAX_NOTES) throw new Error("Invalid legacy memory store schema");
  const notes = state.notes.map((value): Memory => {
    const item = record(value);
    return { ...validateInput(item), source: validateSource(item.source), createdAt: timestamp(item.createdAt), updatedAt: timestamp(item.updatedAt) };
  });
  if (new Set(notes.map(note => note.id)).size !== notes.length) throw new Error("Duplicate legacy memory ids");
  return { revision: state.revision as number, notes, forgotten: validateForgotten(state.forgotten) };
}
