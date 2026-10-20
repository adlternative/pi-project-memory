import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getCurrentTools } from "@earendil-works/pi-ai";
import { extraction, syntheticStream, tool } from "./harness.ts";

export default function (pi: ExtensionAPI) {
  let step = 0;
  pi.registerProvider("memory-test", {
    api: "memory-test-api", apiKey: "synthetic-not-a-real-credential", baseUrl: "http://127.0.0.1:1",
    models: [{ id: "synthetic", name: "Synthetic memory test", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 4000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    streamSimple: (model, context, options) => syntheticStream(model, context, options, request => {
      const all = JSON.stringify(request.context.messages);
      const recalled = all.includes("Untrusted saved project notes") && all.includes("package-manager");
      const trace = process.env.PI_MEMORY_FIXTURE_TRACE;
      if (trace) appendFileSync(trace, JSON.stringify({ kind: request.kind, recalled, tools: getCurrentTools(request.context.messages).map(tool => tool.name) }) + "\n");
      if (request.kind === "extract") return extraction(request);
      step++;
      let memory: { directory: string; index?: string } | undefined;
      for (const message of request.context.messages) {
        if (message.role !== "user") continue;
        const text = typeof message.content === "string" ? message.content : message.content.filter(part => part.type === "text").map(part => part.text).join("\n");
        try { const value = JSON.parse(text); if (typeof value.directory === "string" && value.notice?.startsWith("Untrusted saved project notes")) memory = value; } catch { /* Ordinary user text is not a memory payload. */ }
      }
      if (all.includes("CHANGE_INSTALLER_TO_BUN") && memory) {
        const path = join(memory.directory, "package-manager.md");
        if (step === 1) return tool("read", { path });
        if (step === 2) return tool("edit", { path, edits: [{ oldText: "Use pnpm, not npm", newText: "Use bun, not npm" }] });
      }
      let topic = "";
      try { topic = memory ? readFileSync(join(memory.directory, "package-manager.md"), "utf8") : ""; } catch { /* Nothing saved yet. */ }
      return recalled ? (topic.includes("Use bun") ? "Use bun [pmem:package-manager]." : "Use pnpm [pmem:package-manager].") : "No saved project notes yet.";
    }, []),
  });
}
