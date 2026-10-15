import { readFile, readdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { CredentialStore, OAuthCredential } from "@earendil-works/pi-ai";
import { redact } from "../../src/model.ts";

/** Read selected existing OAuth into RAM only; modify throws BEFORE a refresh callback could run. */
export async function readonlyRuntime(authPath: string, modelId: string, options: { modelsPath?: string } = {}) {
  const providerId = "openai-codex";
  let values;
  try { values = JSON.parse(await readFile(authPath, "utf8")); }
  catch { throw new Error("Could not read an existing credential file; its content is never logged"); }
  const value = values[providerId];
  if (value?.type !== "oauth" || typeof value.access !== "string" || typeof value.refresh !== "string" || typeof value.expires !== "number") throw new Error("An existing OpenAI Codex OAuth login is required");
  const credential: OAuthCredential = value;
  let reads = 0;
  let mutationAttempts = 0;
  const credentials: CredentialStore = {
    async read(id) {
      if (id !== providerId) return undefined;
      if (credential.expires - Date.now() < 10 * 60_000) throw new Error("OAuth is near expiry; this E2E refuses refresh instead of affecting the live login");
      reads++;
      return structuredClone(credential);
    },
    async list() { return [{ providerId, type: "oauth" }]; },
    async modify() { mutationAttempts++; throw new Error("E2E credential writes and refresh callbacks are disabled"); },
    async delete() { mutationAttempts++; throw new Error("E2E credential deletion is disabled"); },
  };
  const runtime = await ModelRuntime.create({ credentials, modelsPath: options.modelsPath ?? null, allowModelNetwork: false, refreshOnCreate: false });
  const model = runtime.getModel(providerId, modelId);
  if (!model) throw new Error("Requested built-in live model is unavailable");
  return {
    runtime, model,
    audit: () => ({ provider: providerId, mode: "read-only OAuth in memory", reads, mutationAttempts, refreshDisabled: true }),
    safeError(error: unknown) {
      let value = error instanceof Error ? error.message : String(error);
      for (const secret of [credential.access, credential.refresh]) if (secret.length > 16) value = value.split(secret).join("[REDACTED]");
      return redact(value).slice(0, 600);
    },
    async assertNoSecretFiles(root: string) {
      const pending = [root]; let checked = 0;
      while (pending.length) {
        const dir = pending.pop()!;
        for (const entry of await readdir(dir, { withFileTypes: true })) {
          const path = join(dir, entry.name);
          if (entry.isDirectory()) pending.push(path);
          else if (entry.isFile()) {
            const bytes = await readFile(path); checked++;
            if ([credential.access, credential.refresh].some(secret => secret.length > 16 && bytes.includes(Buffer.from(secret)))) {
              await unlink(path);
              throw new Error("A secret-bearing experimental artifact was removed; aborting without printing it");
            }
          }
        }
      }
      if (mutationAttempts) throw new Error("Credential mutation was attempted; refusing to call this an isolated pass");
      return { filesChecked: checked, secretsWritten: false };
    },
  };
}
