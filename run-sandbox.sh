#!/usr/bin/env bash
set -euo pipefail
LAB="$(cd "$(dirname "$0")" && pwd)"
RUN="$LAB/.sandbox/manual"
mkdir -p "$RUN/agent" "$RUN/sessions" "$RUN/project"
export PI_CODING_AGENT_DIR="$RUN/agent"
export PI_CODING_AGENT_SESSION_DIR="$RUN/sessions"
export PI_OFFLINE=1 PI_SKIP_VERSION_CHECK=1 PI_TELEMETRY=0
export PI_MEMORY_SANDBOX_ROOT="$RUN/memory"
# Keep the disposable non-Git project independent of this plugin repository.
export GIT_CEILING_DIRECTORIES="$LAB/.sandbox"
unset PI_SESSION_ID PI_SESSION_FILE PI_MODEL PI_PROVIDER
cd "$RUN/project"
exec pi --offline -ne -ns -np -nc --no-themes --no-mcp --no-approve \
  --tools read,edit,write,pmem_list,pmem_read,pmem_search,pmem_save \
  -e "$LAB/src/index.ts" -e "$LAB/sandbox-guard.ts" --memory-dir "$RUN/memory" --session-dir "$RUN/sessions" "$@"
