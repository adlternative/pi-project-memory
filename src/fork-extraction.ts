import { isAbsolute, relative, resolve } from "node:path";
import type { Api, Message, Model, ToolCall } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { parseTopic } from "./markdown.ts";
import { clip, validId } from "./model.ts";

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
export function memoryTools(memoryDir: string, staged: Map<string, string>): ScopedTool[] {
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
        const text = await readFile(scopedPath(memoryDir, params.path), "utf8").catch(() => null);
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
        parseTopic(params.path, params.content);
        staged.set(params.path, params.content);
        return { content: [{ type: "text" as const, text: `Staged ${params.path}` }], details: undefined };
      },
    },
  ];
}

export const FORK_PROMPT = `You are the memory extraction sub-agent for this project. Update the Markdown memory files, then stop.

Use read_memory to inspect the index and any note you may update. Use write_memory to create or overwrite a topic file with flat frontmatter (name, optional description, type, optional modified) and a concise body.
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

/** Bounded tool loop on the parent's registry: one assistant turn per iteration, no nested session. */
export async function runForkExtraction(input: ForkInput): Promise<{ staged: Map<string, string>; turns: number }> {
  const staged = new Map<string, string>();
  const tools = memoryTools(input.memoryDir, staged);
  const declarations = tools.map(tool => ({ name: tool.name, description: tool.description, parameters: tool.parameters as never }));
  const byName = new Map(tools.map(tool => [tool.name, tool]));
  const messages: Message[] = [{
    role: "user",
    content: [{ type: "text", text: [FORK_PROMPT, "", "## Current index", input.index, "", "## New evidence", JSON.stringify(input.evidence)].join("\n") }],
    timestamp: Date.now(),
  }];
  const limit = input.maxTurns ?? 6;
  for (let turns = 1; turns <= limit; turns++) {
    if (input.signal.aborted) break;
    const reply = await input.modelRegistry.streamSimple(input.model, { messages, tools: declarations }, {
      maxTokens: 2000, reasoning: "low", cacheRetention: "none", signal: input.signal,
    }).result();
    if (reply.stopReason !== "toolUse") return { staged, turns };
    messages.push(reply);
    for (const call of reply.content.filter((part): part is ToolCall => part.type === "toolCall")) {
      const tool = byName.get(call.name);
      const text = tool
        ? await tool.execute(call.id, call.arguments as never).then(result => result.content[0].text, (error: unknown) => `Error: ${error instanceof Error ? error.message : String(error)}`)
        : `Unknown tool ${call.name}`;
      messages.push({ role: "toolResult", toolCallId: call.id, toolName: call.name, content: [{ type: "text", text }], isError: false, timestamp: Date.now() });
    }
  }
  return { staged, turns: limit };
}
