import assert from "node:assert/strict";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { MemoryStore, projectIdentity } from "../../src/store.ts";
import { readonlyRuntime } from "./auth.ts";
import { liveEnvironment, runProjectTests, sandboxProfile } from "./environment.ts";

interface Stage { name: string; project: "project-a" | "project-b"; prompt: string; mode: "work" | "recall" | "auto" | "disabled" | "forget"; editSource?: boolean; auto?: boolean; forgetIds?: string[] }
interface Config { modelId: string; authPath: string; stages: Stage[] }
const lab = resolve(import.meta.dirname, "../..");
const root = await realpath(resolve(process.argv[2]));
const base = await realpath(join(lab, ".sandbox"));
const within = relative(base, root);
assert.ok(within && !within.startsWith("..") && !isAbsolute(within), "Live E2E root must be inside this lab's .sandbox");
const config: Config = JSON.parse(await readFile(join(root, "config.json"), "utf8"));
const stage = config.stages.find(stage => stage.name === process.argv[3]);
assert.ok(stage && /^[a-z-]{1,40}$/.test(stage.name) && ["project-a", "project-b"].includes(stage.project));
const project = join(root, stage.project);
const checks = join(root, "checks-" + stage.project);
const memoryBase = join(root, "memory");
const output = join(root, "results", stage.name);
const agentDir = join(root, "agents", stage.name);
await mkdir(output, { recursive: true }); await mkdir(agentDir, { recursive: true });
const modelsPath = join(agentDir, "models.json");
await writeFile(modelsPath, JSON.stringify({ providers: { "openai-codex": { modelOverrides: { [config.modelId]: { maxTokens: 2400 } } } } }));
const live = await readonlyRuntime(config.authPath, config.modelId, { modelsPath });
assert.deepEqual(live.runtime.getRegisteredProviderIds(), [], "Only the built-in live provider is allowed");
assert.equal(live.model.maxTokens, 2400);

if (stage.name === "project-baseline" || stage.name === "project-red" || stage.name === "project-final") {
  const data = await runProjectTests(project, checks);
  await writeFile(join(output, "result.json"), JSON.stringify(data, null, 2));
  console.log(JSON.stringify({ stage: stage.name, ...data }));
  process.exitCode = data.ok || stage.name === "project-red" ? 0 : 1;
} else if (stage.name === "sandbox-probe") {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const profile = join(checks, "tests.sb");
  await writeFile(profile, sandboxProfile(project, checks));
  const { stdout } = await promisify(execFile)("/usr/bin/sandbox-exec", ["-f", profile, process.execPath, join(project, "sandbox-probe.js"), join(root, "outside-sentinel.txt")], { cwd: project, env: { PATH: "/usr/bin:/bin", HOME: project, TMPDIR: project, NO_COLOR: "1" }, timeout: 15000 });
  const data = { ok: stdout.includes("SANDBOX_OK"), stdout, auth: live.audit() };
  assert.equal(await readFile(join(root, "outside-sentinel.txt"), "utf8"), "DO NOT TOUCH\n");
  await writeFile(join(output, "result.json"), JSON.stringify(data, null, 2));
  console.log(JSON.stringify({ stage: stage.name, ...data }));
} else {
  const settings = SettingsManager.inMemory({ compaction: { enabled: false }, cacheWarming: "off", retry: { enabled: false, provider: { timeoutMs: 45000, maxRetries: 0 } }, defaultProjectTrust: "never", enableInstallTelemetry: false });
  const loader = new DefaultResourceLoader({ cwd: project, agentDir, settingsManager: settings, noExtensions: true, additionalExtensionPaths: [join(lab, "src/index.ts")], extensionFactories: [liveEnvironment({ project, memoryBase, checks, editSource: stage.editSource === true })], noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true });
  await loader.reload();
  const extensions = loader.getExtensions();
  assert.deepEqual(extensions.errors, []);
  extensions.runtime.flagValues.set("memory-dir", memoryBase);
  extensions.runtime.flagValues.set("memory-auto", stage.auto === true);
  extensions.runtime.flagValues.set("memory-disabled", stage.mode === "disabled");
  const memoryReads = ["pmem_list", "pmem_read", "pmem_search"];
  const tools = stage.mode === "disabled" ? [] : stage.mode === "recall" ? memoryReads : stage.mode === "auto" ? ["read", "run_project_tests", ...memoryReads] : ["read", "edit", "write", "run_project_tests", ...memoryReads, "pmem_save"];
  const manager = SessionManager.create(project, join(root, "sessions", stage.name));
  const { session } = await createAgentSession({ cwd: project, agentDir, modelRuntime: live.runtime, model: live.model, thinkingLevel: "low", resourceLoader: loader, sessionManager: manager, settingsManager: settings, tools });
  const errors: string[] = [];
  const events: { type: string; name?: string; input?: unknown; isError?: boolean }[] = [];
  await session.bindExtensions({ mode: "json", onError: error => errors.push(live.safeError(error.error)) });
  session.subscribe(event => {
    if (event.type === "tool_execution_start") events.push({ type: event.type, name: event.toolName, input: event.args });
    if (event.type === "tool_execution_end") events.push({ type: event.type, name: event.toolName, isError: event.isError });
  });
  let timedOut = false;
  const deadline = setTimeout(() => { timedOut = true; void session.abort(); }, 90000);
  try {
    if (stage.mode === "forget") for (const id of stage.forgetIds ?? []) await session.prompt(`/pmem forget ${id}`);
    else await session.prompt(stage.prompt);
    const assistant = session.messages.filter(message => message.role === "assistant");
    const last = assistant.at(-1);
    assert.ok(!timedOut && (stage.mode === "forget" || last?.stopReason === "stop"), "Live phase did not finish normally");
    assert.deepEqual(errors, []);
    const identity = await projectIdentity(project);
    const memory = new MemoryStore(memoryBase, identity.key, identity.name);
    const state = await memory.read();
    const extractions = manager.getEntries().flatMap(entry => entry.type === "custom" && entry.customType === "pi-project-memory.extraction" ? [entry.data] : []);
    const mainUsage = assistant.map(message => message.usage);
    const nestedUsage = session.messages.flatMap(message => message.role === "toolResult" && message.usage ? [message.usage] : []);
    const report = { ok: true, stage: stage.name, model: `${live.model.provider}/${live.model.id}`, nativeProvider: true, project, sessionId: manager.getSessionId(), sessionFile: manager.getSessionFile(), response: session.getLastAssistantText() ?? "", tools: session.getActiveToolNames(), events, memory: { directory: memory.dir, revision: state.revision, notes: state.notes }, extractions, mainUsage, nestedUsage, auth: live.audit(), artifacts: await live.assertNoSecretFiles(root) };
    await writeFile(join(output, "result.json"), JSON.stringify(report, null, 2));
    await live.assertNoSecretFiles(root);
    console.log(JSON.stringify({ stage: stage.name, ok: true, model: report.model, mainResponses: assistant.length, toolCalls: events.filter(event => event.type === "tool_execution_start").length, notes: state.notes.length, authMutationAttempts: report.auth.mutationAttempts }));
  } catch (error) {
    const report = { ok: false, stage: stage.name, reason: live.safeError(error), response: session.getLastAssistantText() ?? "", errors, events, auth: live.audit() };
    await writeFile(join(output, "result.json"), JSON.stringify(report, null, 2));
    await live.assertNoSecretFiles(root);
    console.log(JSON.stringify({ stage: stage.name, ok: false, reason: report.reason }));
    process.exitCode = 1;
  } finally {
    clearTimeout(deadline);
    await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    session.dispose();
  }
}
