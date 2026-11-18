import { isAbsolute, relative, resolve } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { parseTopic } from "./markdown.ts";
import { clip, MAX_NOTES, validId } from "./model.ts";
import { runToolLoop } from "./tool-loop.ts";

export interface ScopedTool {
  name: string;
  label: string;
  description: string;
  parameters: unknown;
  // The concrete parameter shape is validated by the provider from `parameters`.
  execute: (id: string, params: any) => Promise<{ content: { type: "text"; text: string }[]; details?: unknown }>;
}

function scopedPath(memoryDir: string, path: string): string {
  const target = resolve(memoryDir, path);
  const within = relative(memoryDir, target);
  if (within === ".." || within.startsWith(`..${"/"}`) || isAbsolute(within)) throw new Error("Path must stay inside the memory directory");
  if (within !== "MEMORY.md" && !(within.endsWith(".md") && validId(within.slice(0, -3)))) throw new Error("Only topic Markdown may be touched");
  return target;
}

/** Memory-root-scoped tools: the sub-agent never sees shell, edit, or the wider filesystem. */
export interface ToolLimits { existing?: ReadonlySet<string>; atCapacity?: boolean }

export function memoryTools(memoryDir: string, staged: Map<string, string>, limits: ToolLimits = {}): ScopedTool[] {
  // Overwriting a note replaces all of it, so the sub-agent must have read the whole file first.
  const read = new Set<string>();
  return [
    {
      name: "read_memory",
      label: "Read memory file",
      description: "Read a Markdown file from the project memory directory. Paths are relative to it.",
      parameters: Type.Object({ path: Type.String({ description: "Relative path, e.g. MEMORY.md or package-manager.md" }) }),
      async execute(_id, params) {
        // Read-your-writes: the staged copy wins so the sub-agent sees its own edits.
        const pending = staged.get(params.path);
        if (pending !== undefined) return { content: [{ type: "text" as const, text: clip(pending, 20_000) }], details: undefined };
        const { readFile } = await import("node:fs/promises");
        const target = scopedPath(memoryDir, params.path);
        const text = await readFile(target, "utf8").catch(() => null);
        if (text !== null && Buffer.byteLength(text) <= 20_000) read.add(target);
        return { content: [{ type: "text" as const, text: text === null ? `No file at ${params.path}` : clip(text, 20_000) }], details: undefined };
      },
    },
    {
      name: "write_memory",
      label: "Write memory file",
      description: "Create or overwrite one topic file. Requires flat frontmatter with name and type; the index updates itself.",
      parameters: Type.Object({
        path: Type.String({ description: "Relative topic path, e.g. package-manager.md" }),
        content: Type.String({ description: "Whole file, starting with frontmatter" }),
      }),
      async execute(_id, params) {
        const target = scopedPath(memoryDir, params.path);
        if (relative(memoryDir, target) === "MEMORY.md") throw new Error("MEMORY.md is maintained automatically; write topic files instead");
        const id = relative(memoryDir, target).replace(/\.md$/, "");
        if (limits.atCapacity && !limits.existing?.has(id) && !staged.has(params.path)) {
          throw new Error(`Memory is at capacity (${limits.existing?.size ?? 0} notes). Update an existing note instead of adding one.`);
        }
        const { access } = await import("node:fs/promises");
        const onDisk = await access(target).then(() => true, () => false);
        if (onDisk && !read.has(target) && !staged.has(params.path)) throw new Error(`Read ${params.path} in full with read_memory before overwriting it`);
        parseTopic(params.path, params.content);
        staged.set(params.path, params.content);
        return { content: [{ type: "text" as const, text: `Staged ${params.path}` }], details: undefined };
      },
    },
  ];
}

export const FORK_PROMPT = `You are the memory extraction sub-agent for this project. Update the Markdown memory files, then stop.

Use read_memory to inspect the index and any note you may update. Use write_memory to create or overwrite a topic file with flat frontmatter (name, optional description, type, optional modified) and a concise body. Read an existing note before overwriting it, and keep every fact it already has.
Rules: at most 4 changes; only durable, reusable facts (preferences, corrections, decisions with their reason, external references); never secrets; never one-off task state; update an existing note instead of duplicating; never write MEMORY.md.
When nothing is worth saving, make no calls and reply exactly: Nothing to save.`;

export interface ForkInput {
  model: Model<Api>;
  modelRegistry: ExtensionContext["modelRegistry"];
  memoryDir: string;
  evidence: unknown;
  index: string;
  signal: AbortSignal;
  maxTurns?: number;
  existingIds?: string[];
}

/** Applies the sub-agent's staged files only after its loop finished, one atomic rename each. */
export async function applyStaged(memoryDir: string, staged: Map<string, string>): Promise<string[]> {
  if (!staged.size) return [];
  const { mkdir, rename, unlink, writeFile } = await import("node:fs/promises");
  const { randomUUID } = await import("node:crypto");
  await mkdir(memoryDir, { recursive: true, mode: 0o700 });
  for (const [name, content] of staged) {
    const target = scopedPath(memoryDir, name);
    const temporary = `${target}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, content, { mode: 0o600 });
      await rename(temporary, target);
    } finally {
      await unlink(temporary).catch(() => {});
    }
  }
  return [...staged.keys()];
}

/** Bounded tool loop on the parent's registry; a provider error fails the pass instead of looking like "nothing to save". */
export async function runForkExtraction(input: ForkInput): Promise<{ staged: Map<string, string>; turns: number }> {
  const staged = new Map<string, string>();
  const existing = new Set(input.existingIds ?? []);
  const tools = memoryTools(input.memoryDir, staged, { existing, atCapacity: existing.size >= MAX_NOTES });
  const prompt = [FORK_PROMPT, "", "## Current index", input.index, "", "## New evidence", JSON.stringify(input.evidence)].join("\n");
  const loopTools = tools.map(tool => ({ ...tool, execute: async (args: unknown) => (await tool.execute("call", args as never)).content[0].text }));
  try {
    const result = await runToolLoop({ model: input.model, modelRegistry: input.modelRegistry, prompt, tools: loopTools, signal: input.signal, maxTurns: input.maxTurns ?? 6 });
    return { staged, turns: result.turns };
  } catch (error) {
    // Running out of turns keeps the old behaviour: what was staged so far is still a complete set of files.
    if (error instanceof Error && /did not finish within/.test(error.message)) return { staged, turns: input.maxTurns ?? 6 };
    throw error;
  }
}
