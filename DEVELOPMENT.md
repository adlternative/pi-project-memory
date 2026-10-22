# Development and verification

Everything here is for working on the plugin. User-facing documentation is in [README.md](./README.md); design notes and reverse-engineering evidence are in [RESEARCH.md](./RESEARCH.md).

## Setup

```bash
npm ci --ignore-scripts
npm run check   # tsc --noEmit, including unused locals
npm test        # node --test under an isolated agent dir
```

Tests set `PI_CODING_AGENT_DIR` to a scratch directory, forbid network access, and use an in-process synthetic model provider, so they never import real history, credentials or cost money.

## Suites

| Suite | Command | Covers |
|---|---|---|
| Unit and integration | `npm test` | storage, Markdown parsing, migration, transactions, recall, tools, settings, extraction (call and fork), worktree scoping |
| CLI, tools path | `python3 tests/cli-smoke.py` | two real Pi processes with the synthetic provider; extraction, then cold recall |
| CLI, files-only path | `PI_MEMORY_TEST_FILE_TOOLS=1 python3 tests/cli-smoke.py` | same, with ordinary file tools and a lab guard |
| Install from the private repository | `PI_CODING_AGENT_DIR=<scratch> python3 tests/install-smoke.py` | install, load, write, cold recall, uninstall |
| Pi config audit | `python3 tests/check-isolation.py [--record]` | hashes global Pi settings, models, auth, MCP and extensions; warns when the baseline is older than a day |

`PI_MEMORY_TEST_NODE` selects the Node binary, and `PI_MEMORY_PI_BIN` the Pi launcher.

## Real-model journey

`e2e/live/` drives a disposable Node project through separate Pi processes with a real provider: remembering two conventions, a cold session implementing a feature against failing tests, an update, semantic retrieval, disabled and cross-project controls, forgetting, and automatic extraction followed by recall. See [e2e/live/README.md](e2e/live/README.md).

It reads an existing credential into memory through an injected store whose writes throw, so the running Pi's login is never refreshed or rewritten.

## Isolation during development

`./run-sandbox.sh` starts Pi with a throwaway agent directory, session directory and project under `.sandbox/manual/`, no discovered extensions, skills, MCP or context files, and the lab-only `sandbox-guard.ts` restricting file tools to that project's memory directory.

Nothing in this repository installs the plugin globally, and the sandbox launcher is not part of normal use.

## Layout

```text
src/index.ts            extension: lifecycle, tools, commands, settings
src/store.ts            project identity, store read/write, reconciliation
src/files.ts            scoped file I/O, lock, journal and recovery
src/markdown.ts         frontmatter parsing, rendering, index maintenance
src/model.ts            types, validation, redaction, limits
src/search.ts           BM25 and tokenisation
src/intelligence.ts     model calls, extraction prompt and validation
src/fork-extraction.ts  scoped tools and the bounded sub-agent loop
sandbox-guard.ts        lab-only file-tool restriction
tests/, e2e/            suites described above
```

## Limitations of the verification

The automated suites use a synthetic provider; only the `e2e/live` journey touches a real model, and it samples one model on one small project. Linux and Windows are unverified, as is power-loss durability.
