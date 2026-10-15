import { resolve, relative } from "node:path";
import { lstat } from "node:fs/promises";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { MemoryFiles } from "./src/files.ts";
import { projectKey } from "./src/store.ts";
import { validId } from "./src/model.ts";

/** Only lab sessions load this. A missing root fails closed, not an unguarded file-tool session. */
export function createMemorySandboxGuard(root?: string): ExtensionFactory {
  return pi => {
    pi.on("tool_call", async (event, ctx) => {
      if (["pmem_list", "pmem_read", "pmem_search", "pmem_save"].includes(event.toolName)) return;
      if (!root || !["read", "edit", "write"].includes(event.toolName) || !("path" in event.input) || typeof event.input.path !== "string") return { block: true, reason: "The memory lab only permits memory tools and topic Markdown read/edit/write" };
      const files = new MemoryFiles(resolve(ctx.cwd, root, await projectKey(ctx.cwd)));
      const name = relative(files.dir, resolve(ctx.cwd, event.input.path));
      if (name !== "MEMORY.md" && !(name.endsWith(".md") && validId(name.slice(0, -3)))) return { block: true, reason: "Sandbox file tools are restricted to current-project MEMORY.md and topic .md files" };
      if (await files.directory(false)) {
        const info = await lstat(resolve(files.dir, name)).catch(error => { if (error.code !== "ENOENT") throw error; return undefined; });
        if (info && (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1)) return { block: true, reason: "Sandbox memory files must be regular, non-linked files" };
        // Let bounded built-in file tools repair malformed/oversized Markdown; ingestion validates its content.
      }
    });
  };
}

export default createMemorySandboxGuard(process.env.PI_MEMORY_SANDBOX_ROOT);
