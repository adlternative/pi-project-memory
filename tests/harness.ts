import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  createAssistantMessageEventStream, getCurrentSystemPrompt, type AssistantMessage,
  type JsonObject, type Model, type SimpleStreamOptions, type ToolCall, type TranscriptContext,
} from "@earendil-works/pi-ai";
import {
  createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { MemoryStore, projectIdentity } from "../src/store.ts";
import { createMemorySandboxGuard } from "../sandbox-guard.ts";

export interface Request { kind: "main" | "extract" | "semantic"; model: string; context: TranscriptContext; options?: SimpleStreamOptions; data?: any }
export type Reply = string | ToolCall | { stopReason: "error" | "aborted"; text: string };
const usage = () => ({ input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });
export function syntheticStream(model: Model<string>, context: TranscriptContext, options: SimpleStreamOptions | undefined, answer: (request: Request) => Reply | Promise<Reply>, requests: Request[]) {
  const stream = createAssistantMessageEventStream();
  queueMicrotask(async () => {
    const prompt = getCurrentSystemPrompt(context.messages);
    const kind = prompt.startsWith("Extract at most") ? "extract" : prompt.startsWith("Select up to 5 memory ids") ? "semantic" : "main";
    const last = context.messages.findLast(message => message.role === "user");
    const text = last ? typeof last.content === "string" ? last.content : last.content.filter(part => part.type === "text").map(part => part.text).join("\n") : "";
    const request: Request = { kind, model: model.id, context, options, ...(kind !== "main" ? { data: JSON.parse(text) } : {}) };
    requests.push(request);
    const message: AssistantMessage = { role: "assistant", api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), content: [], usage: usage(), stopReason: "pending" };
    try {
      const reply = await answer(request);
      stream.push({ type: "start", partial: message });
      if (typeof reply === "object" && "stopReason" in reply) {
        message.stopReason = reply.stopReason; message.errorMessage = reply.text;
        stream.push({ type: "error", reason: reply.stopReason, error: message });
      } else if (typeof reply === "string") {
        message.content = [{ type: "text", text: "" }];
        stream.push({ type: "text_start", contentIndex: 0, partial: message });
        message.content = [{ type: "text", text: reply }];
        stream.push({ type: "text_delta", contentIndex: 0, delta: reply, partial: message });
        stream.push({ type: "text_end", contentIndex: 0, content: reply, partial: message });
        message.stopReason = "stop";
        stream.push({ type: "done", reason: "stop", message });
      } else {
        message.content = [reply];
        stream.push({ type: "toolcall_start", contentIndex: 0, partial: message });
        stream.push({ type: "toolcall_end", contentIndex: 0, toolCall: reply, partial: message });
        message.stopReason = "toolUse";
        stream.push({ type: "done", reason: "toolUse", message });
      }
    } catch {
      message.stopReason = "error"; message.errorMessage = "Synthetic provider failure";
      stream.push({ type: "error", reason: "error", error: message });
    } finally { stream.end(); }
  });
  return stream;
}

export async function makeHarness(t: { after(fn: () => Promise<void>): void }, options: {
  root?: string; project?: string; auto?: boolean; disabled?: boolean; persistent?: boolean; fileTools?: boolean;
  settings?: Record<string, unknown>; useFlags?: boolean; dedicatedTools?: boolean;
  sessionManager?: SessionManager; answer?: (request: Request) => Reply | Promise<Reply>;
} = {}) {
  await mkdir(resolve(".sandbox"), { recursive: true });
  const root = options.root ?? await mkdtemp(resolve(".sandbox", "sdk-"));
  const cwd = join(root, options.project ?? "project");
  const agentDir = join(root, "agent"); const memoryDir = join(root, "memory");
  await mkdir(cwd, { recursive: true }); await mkdir(agentDir, { recursive: true });
  const runtime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json"), modelsStorePath: join(agentDir, "catalog.json"), allowModelNetwork: false, refreshOnCreate: false });
  const requests: Request[] = [];
  runtime.registerProvider("memory-test", {
    api: "memory-test-api", apiKey: "synthetic-not-a-real-credential", baseUrl: "http://127.0.0.1:1",
    models: [
      { id: "synthetic", name: "Synthetic memory test", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 4000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
      { id: "synthetic-fast", name: "Synthetic fast", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 4000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
    ],
    streamSimple: (model, context, settings) => syntheticStream(model, context, settings, options.answer ?? (() => "Done."), requests),
  });
  // Tool-driven tests opt in; the default configuration exposes no memory tools, like CC.
  const supplied = (options.settings?.projectMemory ?? {}) as Record<string, unknown>;
  const projectMemory = { dedicatedTools: options.dedicatedTools ?? true, ...supplied };
  const settings = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: "off", defaultProjectTrust: "never", enableInstallTelemetry: false, ...options.settings, projectMemory } as never);
  const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager: settings, noExtensions: true, additionalExtensionPaths: [resolve("src/index.ts")], extensionFactories: options.fileTools ? [createMemorySandboxGuard(memoryDir)] : [], noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
  await loader.reload();
  const loaded = loader.getExtensions();
  assert.deepEqual(loaded.errors, []);
  assert.equal(loaded.extensions.length, options.fileTools ? 2 : 1);
  // Flags are per-run overrides; settings tests leave them unset to exercise the persisted path.
  if (options.useFlags !== false) {
    loaded.runtime.flagValues.set("memory-dir", memoryDir);
    if (options.auto !== undefined) loaded.runtime.flagValues.set("memory-auto", options.auto);
    if (options.disabled !== undefined) loaded.runtime.flagValues.set("memory-disabled", options.disabled);
  }
  const manager = options.sessionManager ?? (options.persistent === false ? SessionManager.inMemory(cwd) : SessionManager.create(cwd, join(agentDir, "sessions")));
  const model = runtime.getModel("memory-test", "synthetic"); assert.ok(model);
  const { session } = await createAgentSession({ cwd, agentDir, modelRuntime: runtime, model, thinkingLevel: "off", resourceLoader: loader, sessionManager: manager, settingsManager: settings, ...(options.fileTools ? { tools: ["pmem_*", "read", "edit", "write"] } : { noTools: "builtin" as const }) });
  const errors: unknown[] = [];
  await session.bindExtensions({ mode: "json", onError: error => errors.push(error) });
  t.after(async () => {
    await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    session.dispose();
    if (!options.root) await rm(root, { recursive: true, force: true });
  });
  const identity = await projectIdentity(cwd);
  return { root, cwd, agentDir, memoryDir, identity, session, manager, requests, errors, store: new MemoryStore(memoryDir, identity.key, identity.name) };
}

export function extraction(request: Request, content = "Use pnpm, not npm, to install dependencies.") {
  const evidence = request.data.evidence.findLast((entry: any) => entry.role === "user");
  return JSON.stringify({ memories: [{ id: "package-manager", type: "feedback", title: "Package manager", content, entryId: evidence.entryId, quote: evidence.text }] });
}
export const tool = (name: string, args: JsonObject): ToolCall => ({ type: "toolCall", id: "call-" + name, name, arguments: args });

/** Extraction is detached, so tests wait for its bookkeeping entry instead of assuming it finished. */
export function extractionCount(h: Awaited<ReturnType<typeof makeHarness>>): number {
  return h.manager.getEntries().filter(entry => entry.type === "custom" && entry.customType === "pi-project-memory.extraction").length;
}

export async function waitForExtraction(h: Awaited<ReturnType<typeof makeHarness>>, timeoutMs = 20_000): Promise<void> {
  const target = extractionCount(h) + 1;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (extractionCount(h) >= target) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error("memory extraction did not finish in time");
}
