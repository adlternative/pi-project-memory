import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { readonlyRuntime } from "./auth.ts";

const root = resolve(process.argv[2]);
const authPath = process.argv[3];
const modelId = process.argv[4] ?? "gpt-5.3-codex-spark";
await mkdir(root, { recursive: true });
const live = await readonlyRuntime(authPath, modelId);
try {
  const response = await live.runtime.completeSimple(live.model, { messages: [{ role: "user", content: "Reply with exactly LIVE_MEMORY_READY", timestamp: Date.now() }] }, { maxTokens: 64, reasoning: "low", transport: "sse", timeoutMs: 45000, signal: AbortSignal.timeout(50000) });
  const text = response.content.filter(part => part.type === "text").map(part => part.text).join("");
  if (response.stopReason !== "stop" || text.trim() !== "LIVE_MEMORY_READY") throw new Error(`Live readiness failed (${response.stopReason}): ${response.errorMessage ?? "unexpected reply"}`);
  const report = { ok: true, model: `${response.provider}/${response.model}`, api: response.api, stopReason: response.stopReason, reply: text, usage: response.usage, auth: live.audit(), artifacts: await live.assertNoSecretFiles(root) };
  await writeFile(resolve(root, "probe.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} catch (error) {
  const report = { ok: false, model: modelId, reason: live.safeError(error), auth: live.audit() };
  await writeFile(resolve(root, "probe.json"), JSON.stringify(report, null, 2));
  await live.assertNoSecretFiles(root);
  console.log(JSON.stringify(report)); process.exitCode = 1;
}
