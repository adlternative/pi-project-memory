import type { Api, AssistantMessage, Message, Model, ToolCall, Usage } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { MemoryModelError, modelCallOptions } from "./intelligence.ts";
import { clip, redact } from "./model.ts";

/** A tool the memory sub-agent may call; it never sees Pi's own tools or the wider filesystem. */
export interface LoopTool {
  name: string;
  description: string;
  parameters: unknown;
  execute: (args: any) => Promise<string>;
}

export interface LoopResult { turns: number; text: string; usage: Usage; provider: string; model: string; outOfTurns?: boolean }

const emptyUsage = (): Usage => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });

function addUsage(total: Usage, next: Usage | undefined) {
  if (!next) return;
  total.input += next.input; total.output += next.output; total.cacheRead += next.cacheRead; total.cacheWrite += next.cacheWrite;
  total.totalTokens += next.totalTokens;
  if (next.reasoning !== undefined) total.reasoning = (total.reasoning ?? 0) + next.reasoning;
  for (const key of ["input", "output", "cacheRead", "cacheWrite", "total"] as const) total.cost[key] += next.cost?.[key] ?? 0;
}

/**
 * Runs a bounded tool loop on the parent's model registry: one assistant turn per iteration, tool errors
 * returned to the model as text. A provider error, abort or truncated reply throws, so a failed pass is
 * never mistaken for one that finished with nothing to do.
 */
export async function runToolLoop(input: {
  model: Model<Api>; modelRegistry: ExtensionContext["modelRegistry"]; system?: string; prompt: string;
  tools: LoopTool[]; signal: AbortSignal; maxTurns: number;
  /** Return normally with outOfTurns instead of throwing when the last turn still called tools. */
  stopAtLimit?: boolean;
}): Promise<LoopResult> {
  const usage = emptyUsage();
  const byName = new Map(input.tools.map(tool => [tool.name, tool]));
  const declarations = input.tools.map(tool => ({ name: tool.name, description: tool.description, parameters: tool.parameters as never }));
  const messages: Message[] = [{ role: "user", content: [{ type: "text", text: input.prompt }], timestamp: Date.now() }];
  for (let turns = 1; turns <= input.maxTurns; turns++) {
    input.signal.throwIfAborted();
    const reply: AssistantMessage = await input.modelRegistry.streamSimple(input.model, { ...(input.system ? { systemPrompt: input.system } : {}), messages, tools: declarations }, modelCallOptions(input.model, input.signal)).result();
    addUsage(usage, reply.usage);
    if (reply.stopReason === "stop") {
      const text = reply.content.filter(part => part.type === "text").map(part => part.text).join("\n").trim();
      return { turns, text, usage, provider: reply.provider, model: reply.model };
    }
    if (reply.stopReason !== "toolUse") {
      const detail = reply.errorMessage || (reply.stopReason === "length" ? "model output token limit reached" : "provider did not complete the response");
      throw new MemoryModelError(`Memory model ${input.model.provider}/${input.model.id} stopped with ${reply.stopReason}: ${detail}`, { ...reply, usage });
    }
    messages.push(reply);
    const calls = reply.content.filter((part): part is ToolCall => part.type === "toolCall");
    for (const [index, call] of calls.entries()) {
      const tool = byName.get(call.name);
      let text: string;
      let isError = false;
      try {
        if (!tool) throw new Error(`Unknown tool ${call.name}`);
        text = await tool.execute(call.arguments);
      } catch (error) {
        isError = true;
        text = `Error: ${clip(redact(error instanceof Error ? error.message : String(error)), 600)}`;
      }
      // Tell the model how much room is left so it finishes instead of running out of turns.
      const left = input.maxTurns - turns;
      if (index === calls.length - 1 && left <= 3) text += left > 0 ? `\n\n[${left} turn${left === 1 ? "" : "s"} left: stage your remaining changes and finish with your summary.]` : "";
      messages.push({ role: "toolResult", toolCallId: call.id, toolName: call.name, content: [{ type: "text", text }], isError, timestamp: Date.now() });
    }
  }
  if (input.stopAtLimit) return { turns: input.maxTurns, text: "", usage, provider: input.model.provider, model: input.model.id, outOfTurns: true };
  throw new Error(`Memory sub-agent did not finish within ${input.maxTurns} turns; nothing was changed`);
}
