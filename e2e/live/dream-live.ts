/**
 * Live check of the dream sub-agent against qoder/fast, on a copy of a real store.
 *
 * Reads ~/.pi/agent/models.json (read-only) for the provider, copies the store into a temporary directory,
 * runs one pass with this project's real sessions as evidence, applies it to the copy, and prints what
 * changed. The real store and the sessions are never written.
 *
 *   node --experimental-strip-types e2e/live/dream-live.ts <store-dir> <project-cwd> [days]
 */
import { cp, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { loadProjectContextFiles, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { parseTopic } from "../../src/markdown.ts";
import { MemoryStore } from "../../src/store.ts";
import { projectSessions } from "../../src/sessions.ts";
import { runDreamAgent } from "../../src/dream.ts";

const [storeDir, cwd, days = "3"] = process.argv.slice(2);
if (!storeDir || !cwd) throw new Error("usage: dream-live.ts <store-dir> <project-cwd> [days]");
const agentDir = join(homedir(), ".pi/agent");
const [name, key] = basename(storeDir).split("__");
// realpath: macOS tmpdir() goes through the /var symlink, which the store refuses by design.
const work = await realpath(await mkdtemp(join(tmpdir(), "pmem-dream-live-")));
try {
  await cp(storeDir, join(work, basename(storeDir)), { recursive: true });
  const store = new MemoryStore(work, key + "0".repeat(24 - key.length), name);
  const before = await store.read({ tolerant: true });
  const runtime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json"), modelsStorePath: join(work, "catalog.json"), allowModelNetwork: false, refreshOnCreate: false });
  const model = runtime.getModel("qoder", "fast");
  if (!model) throw new Error("qoder/fast is not configured");
  const sessions = (await projectSessions(join(agentDir, "sessions"), cwd, Date.now() - Number(days) * 86_400_000)).slice(0, 25);
  const instructions = loadProjectContextFiles({ cwd, agentDir }).filter(file => /(^|\/)(AGENTS|CLAUDE)\.md$/.test(file.path) && !file.path.startsWith(agentDir));
  const started = Date.now();
  const calls: string[] = [];
  let lastMessages: unknown[] = [];
  const registry = {
    streamSimple: (...args: Parameters<typeof runtime.streamSimple>) => {
      lastMessages = args[1].messages;
      const stream = runtime.streamSimple(...args);
      return { ...stream, result: async () => {
        const reply = await stream.result();
        for (const part of reply.content) if (part.type === "toolCall") calls.push(`${part.name}(${JSON.stringify(part.arguments).slice(0, 90)})`);
        return reply;
      } };
    },
  } as unknown as Parameters<typeof runDreamAgent>[0]["modelRegistry"];
  let run;
  try {
    run = await runDreamAgent({
      model, modelRegistry: registry, store, notes: before.notes, index: before.index, sessions, instructions,
      today: new Date().toISOString().slice(0, 10), signal: AbortSignal.timeout(6 * 60_000),
    });
  } catch (error) {
    // Show what the sub-agent did, turn by turn, before failing.
    const trace = (lastMessages as { role: string; content?: unknown; isError?: boolean; toolName?: string }[]).map(message => {
      const parts = Array.isArray(message.content) ? message.content as { type: string; text?: string; name?: string; arguments?: unknown }[] : [];
      if (message.role === "assistant") return "A " + parts.map(part => part.type === "toolCall" ? `${part.name}(${JSON.stringify(part.arguments).slice(0, 80)})` : `text:${String(part.text ?? "").slice(0, 80)}`).join(" | ");
      if (message.role === "toolResult") return `  R ${message.isError ? "ERR " : ""}${message.toolName}: ${String(parts[0]?.text ?? "").replace(/\s+/g, " ").slice(0, 110)}`;
      return `${message.role}: ${String(parts[0]?.text ?? "").slice(0, 60)}`;
    });
    console.log(trace.join("\n"));
    throw error;
  }
  const { changes, loop } = run;
  const source = { sessionId: "live-check", entryId: "dream", quote: "live check", origin: "extracted" as const };
  const applied = await store.applyDream(changes.map(change => ({ id: change.id, before: change.before, after: change.after === null ? null : { ...parseTopic(`${change.id}.md`, change.after), source } })));
  const after = await store.read({ tolerant: true });
  const old = new Map(before.notes.map(note => [note.id, note]));
  console.log(JSON.stringify({
    model: `${loop.provider}/${loop.model}`, seconds: Math.round((Date.now() - started) / 1000), turns: loop.turns,
    usage: { input: loop.usage.input, output: loop.usage.output, cacheRead: loop.usage.cacheRead },
    sessionsGiven: sessions.length, instructionFiles: instructions.map(file => file.path),
    notes: [before.notes.length, after.notes.length], indexBytes: [Buffer.byteLength(before.index), Buffer.byteLength(after.index)],
    applied, toolCalls: calls,
  }, null, 1));
  for (const id of applied.updated) {
    const was = old.get(id)!, now = after.notes.find(note => note.id === id)!;
    console.log(`\n## updated ${id}\n- before (${Buffer.byteLength(was.content)}B): ${was.title} :: ${was.content.slice(0, 260).replace(/\n/g, " / ")}\n- after  (${Buffer.byteLength(now.content)}B): ${now.title} :: ${now.content.slice(0, 260).replace(/\n/g, " / ")}`);
  }
  for (const id of applied.created) { const now = after.notes.find(note => note.id === id)!; console.log(`\n## added ${id} (${Buffer.byteLength(now.content)}B): ${now.title} :: ${now.content.slice(0, 260).replace(/\n/g, " / ")}`); }
  for (const id of applied.deleted) { const was = old.get(id)!; console.log(`\n## removed ${id} (${Buffer.byteLength(was.content)}B): ${was.title} :: ${was.content.slice(0, 200).replace(/\n/g, " / ")}`); }
  console.log(`\n## summary\n${loop.text}`);
  // Full text of every note the pass wrote, for checking that merges kept their facts.
  const dump = Object.fromEntries([...applied.updated, ...applied.created].map(id => [id, after.notes.find(note => note.id === id)?.content ?? ""]));
  const gone = Object.fromEntries(applied.deleted.map(id => [id, old.get(id)?.content ?? ""]));
  await writeFile(process.env.DREAM_DUMP ?? join(work, "..", "dream-live-dump.json"), JSON.stringify({ written: dump, deleted: gone }, null, 1));
  const real = await readFile(join(storeDir, ".state.json"), "utf8");
  console.log(`\nreal store untouched: revision ${JSON.parse(real).revision}`);
} finally {
  await rm(work, { recursive: true, force: true });
}
