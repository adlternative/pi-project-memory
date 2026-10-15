import { clip, redact, validId, validateInput, type Memory, type MemoryInput } from "./model.ts";

export const INDEX_START = "<!-- pi-memory:index:start -->";
export const INDEX_END = "<!-- pi-memory:index:end -->";
export const INDEX_BYTES = 25_000;
export const TOPIC_BYTES = 4096;

function scalar(raw: string): string {
  if (raw.startsWith('"')) {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "string") throw new Error("Expected a quoted string");
    return value;
  }
  if (raw.startsWith("'")) {
    if (!/^'(?:[^']|'')*'$/.test(raw)) throw new Error("Invalid single-quoted frontmatter");
    return raw.slice(1, -1).replace(/''/g, "'");
  }
  // shortcut: flat scalar frontmatter only; use a YAML parser if multiline or nested metadata is needed.
  if (!raw || /^[\[\]{}&*!|>]/.test(raw)) throw new Error("Memory frontmatter supports flat string values only");
  return raw.replace(/\s+#.*$/, "").trim();
}

export function parseTopic(filename: string, source: string): MemoryInput {
  const id = filename.replace(/\.md$/, "");
  if (filename !== `${id}.md` || !validId(id)) throw new Error(`Invalid memory filename: ${filename}`);
  const normalized = source.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  const match = normalized.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match || redact(source) !== source) throw new Error(`Invalid or secret-bearing memory Markdown: ${filename}`);
  const fields: Record<string, string> = {};
  for (const line of match[1].split("\n")) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const item = line.match(/^([a-z]+):\s*(.*)$/);
    if (!item || !["name", "description", "type", "modified"].includes(item[1]) || Object.hasOwn(fields, item[1])) throw new Error(`Invalid frontmatter in ${filename}`);
    fields[item[1]] = scalar(item[2]);
  }
  if (fields.modified !== undefined && !Number.isFinite(Date.parse(fields.modified))) throw new Error(`Invalid modified timestamp in ${filename}`);
  return validateInput({ id, title: fields.name, type: fields.type, content: match[2].trim(), ...(fields.description === undefined ? {} : { description: fields.description }) });
}

export function renderTopic(note: Memory): string {
  return ["---", `name: ${JSON.stringify(note.title)}`, ...(note.description === undefined ? [] : [`description: ${JSON.stringify(note.description)}`]), `type: ${note.type}`, `modified: ${JSON.stringify(note.updatedAt)}`, "---", "", note.content, ""].join("\n");
}

/** Only the marked navigation block is generated; preserve user-authored text outside it. */
export function renderIndex(previous: string | null, notes: Memory[]): string {
  const source = previous ?? "# Project memory\n\n";
  if (redact(source) !== source || source.includes("\0")) throw new Error("Unsafe MEMORY.md content");
  const links = [...notes].sort((a, b) => a.id.localeCompare(b.id)).map(note => {
    const title = clip(note.title, 40).replace(/([\\\[\]])/g, "\\$1");
    return `- [${title}](${note.id}.md) — ${note.type}`;
  });
  const block = [INDEX_START, ...links, INDEX_END].join("\n");
  const start = source.indexOf(INDEX_START);
  const end = source.indexOf(INDEX_END);
  let result: string;
  if (start === -1 && end === -1) result = source.trimEnd() + "\n\n" + block + "\n";
  else {
    if (start < 0 || end < start || source.indexOf(INDEX_START, start + INDEX_START.length) !== -1 || source.indexOf(INDEX_END, end + INDEX_END.length) !== -1) throw new Error("Malformed managed index markers in MEMORY.md");
    result = source.slice(0, start) + block + source.slice(end + INDEX_END.length);
  }
  if (Buffer.byteLength(result) > INDEX_BYTES) throw new Error("MEMORY.md exceeds 25,000 UTF-8 bytes; shorten custom index text");
  return result;
}
