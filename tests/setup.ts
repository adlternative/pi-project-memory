import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

process.env.PI_CODING_AGENT_DIR = resolve(".sandbox", "test-agent-" + process.pid);
process.env.PI_OFFLINE = "1";
process.env.PI_SKIP_VERSION_CHECK = "1";
process.env.PI_TELEMETRY = "0";
process.env.GIT_CEILING_DIRECTORIES = resolve(".sandbox");
mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
globalThis.fetch = async () => { throw new Error("Network forbidden in isolated memory tests"); };
