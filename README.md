# pi-project-memory 0.2

A native Pi extension with Claude Code-style **`MEMORY.md` navigation and one Markdown file per memory**. Agents can make focused changes with ordinary `read/edit/write` tools instead of rewriting a JSON store. Includes local English/CJK BM25, optional model-assisted semantic selection, and opt-in incremental extraction.

**Nothing is installed into global Pi by default.** The isolated launcher writes only under this project's `.sandbox/`. Development validation did not modify the running Pi configuration or the Codex repository. See [RESEARCH.md](./RESEARCH.md) for sources and design decisions. Raw experiments, conversations, credentials, and analysis artifacts are not committed.

## File layout

```text
<agent-dir>/project-memory/<project-hash>/
├── MEMORY.md                  # Navigation; custom prose outside the generated block is preserved
├── feedback_tools.md          # One topic; the filename is its stable id
├── project_decisions.md
├── .state.json                # Revision, provenance quotes, timestamps, hashes, tombstones; no body field
├── .legacy-memories.json       # Byte-exact original JSON backup, present only after migration
└── .pending.json               # Present only during a transaction or interrupted recovery
```

`<agent-dir>` follows `PI_CODING_AGENT_DIR`, defaulting to `~/.pi/agent`. `--memory-dir /absolute/base` overrides the base while retaining project separation. The canonical Git common-directory path identifies a project: subdirectories, worktrees, and sessions in the same repository share memory; different repositories do not. Non-Git directories use their canonical cwd. There is no cross-project user-profile pool.

Topic files use simple YAML frontmatter and a normal Markdown body:

```markdown
---
name: "Package manager preference"
description: "Dependency installation for this project"
type: feedback
modified: "2026-10-15T00:00:00.000Z"
---

Use pnpm rather than npm by default.
```

- Filenames contain lowercase letters, digits, `-`, or `_`, up to 64 characters. `memory` is reserved for the index.
- `name` and `type` are required; `description` and `modified` are optional. Types are `user/feedback/project/reference`.
- Supports flat plain strings, JSON double-quoted strings, and YAML single-quoted strings. Folded values, nested YAML, and aliases are not supported. Add a YAML parser only if complex metadata becomes necessary; no extra runtime dependency is needed today.
- **To change one fact, edit that topic's body.** There is no need to modify internal JSON. The next read detects file changes, updates provenance/timestamps/revision, and synchronizes the index. Successful standard-tool writes also trigger immediate validation and synchronization.
- Manual edits receive `file` provenance instead of inheriting the previous session's quote. Ordinary `edit` does not rewrite the `modified` line, avoiding interference with the host's read/write cache and unnecessary diffs. Actual change times come from the file and internal metadata; inspect them with `pmem_read`.

## Maintaining MEMORY.md

The extension rebuilds only links between these markers. Custom prose outside the block is preserved:

```markdown
# Project memory

Add your own navigation guidance here.

<!-- pi-memory:index:start -->
- [Package manager preference](feedback_tools.md) — feedback
<!-- pi-memory:index:end -->

Additional annotations can go here.
```

The index is not a second source of truth for note bodies. Edit topic files to change facts. Do not put unique information inside the generated block or modify hidden state, locks, migration backups, or journals. A standard-tool write with invalid frontmatter is not silently rolled back: the tool reports ingestion failure and the agent can repair it with `edit`. Recall reports temporary unavailability rather than treating a damaged store as empty.

## Isolated trial

```bash
cd pi-project-memory
npm ci --ignore-scripts
./run-sandbox.sh
# Enable optional automatic extraction:
./run-sandbox.sh --memory-auto
# Separate an initial prompt with -- so Pi's extension boolean flag does not consume it:
./run-sandbox.sh --memory-auto -- "Use pnpm rather than npm for this project's future work."
```

The launcher creates configuration, sessions, a project, and memory only under `.sandbox/manual/`. It disables discovered extensions, skills, context files, and MCP, loading only this extension and the experimental `sandbox-guard.ts`.

The trial provides four memory tools plus ordinary `read/edit/write`. **File tools are restricted to the current project's `MEMORY.md` and topic `.md` files**: they cannot access global Pi, other projects, hidden state, or arbitrary source files. There is no shell tool. A missing experimental root makes the guard refuse file tools rather than fail open. Normal installation does not load this lab guard or restrict the user's entire Pi to memory editing.

The launcher does not run `pi install` or `/reload` and does not inherit global settings/auth files. Existing provider environment variables can still authenticate manual trials. If `/login` is needed, credentials are written only to the experimental agent directory. This is configuration/data/tool-scope isolation, not an OS sandbox.

## Tools and commands

| Tool | Purpose |
|---|---|
| `pmem_list({offset?})` | Ten previews per page, with relative `.md` paths and `nextOffset` |
| `pmem_read({id})` | A complete note, relative file path, and provenance |
| `pmem_search({query, mode?})` | Local `keyword` BM25 by default; optional `semantic` model selection; up to five matches |
| `pmem_save({id,type,title,description?,content})` | Create/update one topic Markdown file, retaining its id; useful without standard file tools |

Structured output is `{directory,indexPath,notes,truncated,nextOffset}`. Each `note.path` is relative to `directory`. Standard file tools are optional: the four memory tools work independently. Tool guidance asks for an explicit user request before saving/editing memory; it is not a hard semantic authorization check on natural language.

```text
/pmem                        Show directory, count, revision, and automatic-extraction status
/pmem list [offset]           Paginate the index
/pmem show <id>               Show content and provenance
/pmem forget <id>             Delete the topic and index link; record tombstones
/pmem auto on|off             Toggle extraction for this session, without changing global settings
/pmem extract                 Extract unprocessed evidence from the active branch
```

Deleting a topic file also becomes forgetting on the next read, preventing automatic identical-content restoration. Explicitly recreating that Markdown file or saving it again counts as manual restoration. Forget does not erase original sessions, migration backups, or historical provenance quotes in other notes, nor does it recognize arbitrary semantic paraphrases. **It is not privacy-grade secure erasure.**

## Migrating older stores

The first access to an old `memories.json` migrates it automatically: validate all input, generate topic Markdown/index/internal state, preserve a byte-exact `.legacy-memories.json` backup, and remove the old active JSON. Note ids, bodies, descriptions, sources, timestamps, and tombstones survive; revision increases monotonically.

- Existing Markdown, reserved ids, or damaged legacy JSON stop migration without overwriting or guessing how to merge.
- Do not run 0.1 and 0.2 writers against one directory. A legacy writer recreating `memories.json` after migration causes a conflict, not silently ignored writes.
- Missing `.state.json` never triggers resurrection from the migration backup. Restore metadata or resolve the situation manually.
- Backups retain old content. Review them and session history separately if stronger deletion is needed.

## Injection, retrieval, extraction, and hard limits

- Only fixed `project_memory` usage rules are appended at runtime. The original system prompt is not replaced and `SYSTEM.md` is not modified. Historical bodies remain untrusted data, not system instructions.
- The `context` hook includes at most the first 200 lines/3,000 UTF-8 bytes of the actual `MEMORY.md`, plus up to three BM25 snippets of 600 bytes each, **within a 6,000-byte total**. This recall message is request-local, not permanently appended or used to rewrite history. Tool results are recorded normally.
- BM25 runs locally with title weight 3 and description/body weight 1. It uses English words and CJK character/bigram tokens. Semantic mode asks the current model to select from up to 48 candidate previews; it is not a vector index and may miss older notes or details outside previews.
- Automatic extraction is off by default. When enabled, each persistent user run makes at most one no-tool model call: a cancellable `turn_end` prepares candidates, and final successful settlement commits them. Runs that directly wrote memory skip redundant extraction. Failed, aborted, or stale-revision candidates are not committed.
- Extraction uses at most the latest 12 new user/final-assistant texts from the active branch, capped at 1,000 bytes each. System prompts, thinking, tool output, and abandoned branches are excluded. Ephemeral `--no-session` runs do not perform automatic or manual extraction.

| Resource | Limit |
|---|---:|
| Topics per project | 128 |
| Title / description / body | 160 / 320 / 2,000 UTF-8 bytes |
| Topic Markdown including frontmatter | 4,096 bytes |
| MEMORY.md file | 25,000 bytes; excess is an error, not permission to overwrite custom prose |
| Internal state / legacy JSON | 1 MiB each |
| Tombstones | 1,024; no automatic eviction |
| Internal transaction journal | 4 MiB |
| Tool output | 12,000 bytes |
| Nested model input | 32,000-byte hard cap; trimmed to 30,000 beforehand |
| Nested model output / timeout | 2,000 tokens, 16,000 bytes / 15 seconds |

Semantic-tool usage is reported through its result and counted by Pi. Automatic/manual extraction usage is recorded separately as `pi-project-memory.extraction` and is not automatically included in footer totals. There is no complete dreaming system: no scheduled full-store consolidation, automatic eviction, or skill generation.

## Consistency and safety

- Plugin readers/writers use an in-process queue and a cross-process lock. Individual files are atomically replaced; bounded `.pending.json` records a multi-file transaction before `.state.json` commits last, allowing interrupted work to resume.
- Recovery stops with the journal intact when an external edit matches neither the transaction's before nor after version. A completed state-last transaction is never replayed over newer manual edits.
- Uncooperative external editors do not honor the plugin lock. Ordinary file access is not a globally atomic multi-file filesystem transaction. Close affected sessions and preserve the journal and manual edits before resolving conflicts.
- Crash-left `.lock` files deliberately stop access. Close all Pi sessions using the store, inspect PID/time, then remove only the stale lock. Do not delete `.pending.json` or `.state.json` as a shortcut. Non-conflicting journals recover after the lock is cleared.
- Path traversal, symlinks, data-file hardlinks, invalid UTF-8, and unknown/damaged state are rejected. New files use `0600`, directories `0700`; Windows follows platform permission semantics.
- Known credentials are redacted before extraction and obvious credentials are rejected on save. This is not DLP and cannot identify every secret. Memory is not a prompt-injection security boundary; keep automatic extraction off for sensitive conversations.

## Tests and limitations

Repository documentation, comments, executable E2E prompts, and test names are English. Multilingual fixture data uses Unicode escapes so UTF-8/CJK behavior remains covered without non-English repository prose.

Pi 1.2.0 with Node 22.22.3 and 24.18.1 passed **49 tests each**. Source and packaged artifacts also passed a three-process journey: extraction, standard read/edit modification, and cold-session recall.

Coverage includes local Markdown edits/repair, custom index prose, legacy migration and interrupted migration, provenance, forgetting and restoration suppression, stale proposals after external edits, transaction recovery/conflicts, corruption/path limits, and existing retrieval/session behavior. These automated tests use a synthetic provider and isolated data, without importing real history or credentials. Historical logs are `evidence/test-node{22,24}-markdown.log`, `cli-markdown-edit-smoke.json`, and `packed-markdown-edit-smoke.json`. Global Pi configuration/extension-entry fingerprints were unchanged and no default global project-memory store was created.

```bash
npm run check
npm test
python3 tests/cli-smoke.py
PI_MEMORY_TEST_FILE_TOOLS=1 python3 tests/cli-smoke.py
python3 tests/check-isolation.py # Optional developer-machine before/after audit, not a portable test
```

`PI_MEMORY_TEST_NODE` selects Node explicitly. Development dependencies pin Pi/test pi-ai to 1.2.0 and typebox to 1.3.27. `npm ci --ignore-scripts` installs only into this project, not global Pi. Distributed packages still declare host peers and do not bundle development dependencies. Other Pi forks/versions are not guaranteed compatible.

`tests/check-isolation.py` requires a developer-local `evidence/global-pi-before.json` that is not committed. It is not mandatory after a fresh clone. Historical `evidence/` and `.sandbox/` paths exist only on the original developer machine; reruns create new local artifacts.

A real-model micro-project E2E also passed using `openai-codex/gpt-6.1-sol`: 15 independent process stages, 10 real-model conversations, and 17 acceptance checks. A cold session implemented shipping against previously failing tests (7/7), then exercised updates, semantic retrieval, disabled/cross-project controls, forgetting, and automatic extraction followed by recall. See `e2e/live/README.md` and the local `evidence/live-micro-project.json`. The English-prompt rerun also passed all 17 checks; the live E2E notes preserve the initial ambiguous-query failure and its clarified translation. These are small samples of one model/project, not a broad reliability benchmark.

An additional inspection found old deleted values in another note's historical provenance quote. The tested model did not treat them as current facts, but this does not establish strict forgetting. Linux/Windows runtime and power-loss durability remain unverified. Logs, live E2E development scripts/data, CC-derived sources, REA, caches, credentials, and node_modules are excluded from the plugin package. Nothing has been installed globally.
