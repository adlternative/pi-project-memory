import { execFile } from "node:child_process";
import { lstat, mkdir, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { Type } from "typebox";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { MemoryFiles } from "../../src/files.ts";
import { clip, MemoryStore, projectIdentity } from "../../src/store.ts";
import { validId } from "../../src/model.ts";

/** Tests run read-only, without network or fork. The parent Pi alone can edit the approved source file. */
export function sandboxProfile(project: string, checks: string): string {
  const subpaths = [project, checks, "/System/Library", "/usr", "/Library/Apple", "/dev", "/private/etc", "/private/var/db/timezone"];
  return `(version 1)\n(deny default)\n(allow process-exec (literal ${JSON.stringify(process.execPath)}))\n(allow signal (target same-sandbox))\n(allow process-info* (target same-sandbox))\n(allow sysctl-read)\n(allow file-read-metadata)\n(allow file-read* (literal "/") (literal ${JSON.stringify(process.execPath)}) ${subpaths.map(path => `(subpath ${JSON.stringify(path)})`).join(" ")})\n(allow file-write-data (literal "/dev/null"))\n`;
}

export async function runProjectTests(project: string, checks: string) {
  const runtime = join(project, ".runtime");
  await mkdir(runtime, { recursive: true });
  const profile = join(checks, "tests.sb");
  await writeFile(profile, sandboxProfile(project, checks));
  const env = { PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, HOME: runtime, TMPDIR: runtime, NO_COLOR: "1" };
  try {
    const { stdout, stderr } = await promisify(execFile)("/usr/bin/sandbox-exec", ["-f", profile, process.execPath, "--experimental-test-isolation=none", "--test", join(checks, "quote.test.js")], { cwd: project, env, timeout: 15000, maxBuffer: 24000 });
    return { ok: true, exitCode: 0, stdout: clip(stdout, 6000), stderr: clip(stderr, 1000) };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return { ok: false, exitCode: typeof failure.code === "number" ? failure.code : 1, stdout: clip(failure.stdout ?? "", 6000), stderr: clip(failure.stderr ?? "Project tests did not complete", 1000) };
  }
}

export function liveEnvironment(options: { project: string; memoryBase: string; checks: string; editSource: boolean }): ExtensionFactory {
  return pi => {
    let turns = 0;
    pi.on("turn_start", (_event, ctx) => { if (++turns > 12) ctx.abort(); });
    pi.on("tool_call", async (event, ctx) => {
      if (["pmem_list", "pmem_read", "pmem_search", "pmem_save", "run_project_tests"].includes(event.toolName)) return;
      if (!["read", "edit", "write"].includes(event.toolName) || !("path" in event.input) || typeof event.input.path !== "string") return { block: true, reason: "Live E2E permits only approved project files, topic Markdown, and fixed sandboxed tests" };
      const target = resolve(ctx.cwd, event.input.path);
      const projectFile = relative(options.project, target);
      let allowed = event.toolName === "read" ? ["quote.js", "quote.test.js", "package.json", "README.md"].includes(projectFile) : options.editSource && projectFile === "quote.js";
      if (!allowed) {
        const identity = await projectIdentity(ctx.cwd);
        const files = new MemoryFiles(new MemoryStore(options.memoryBase, identity.key, identity.name).dir);
        const name = relative(files.dir, target);
        allowed = name === "MEMORY.md" || (name.endsWith(".md") && validId(name.slice(0, -3)));
        if (allowed) await files.directory(false);
      }
      if (!allowed) return { block: true, reason: "Path is outside this phase's approved project/memory files; no global Pi, credentials, old sessions or other projects may be read" };
      const info = await lstat(target).catch(error => { if (error.code !== "ENOENT") throw error; return undefined; });
      if (info && (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1)) return { block: true, reason: "Live E2E rejects linked/non-regular files" };
    });
    pi.registerTool({
      name: "run_project_tests", label: "Sandboxed project tests",
      description: "Run the project's authoritative Node tests in a read-only macOS sandbox with no network. No command/path arguments. Tests outside the editable project cannot be changed by the agent.",
      parameters: Type.Object({}), outputSchema: Type.Object({ ok: Type.Boolean(), exitCode: Type.Integer(), stdout: Type.String(), stderr: Type.String() }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      async execute() {
        const data = await runProjectTests(options.project, options.checks);
        return { content: [{ type: "text", text: JSON.stringify(data) }], details: data, structuredContent: data, isError: !data.ok };
      },
    });
  };
}
