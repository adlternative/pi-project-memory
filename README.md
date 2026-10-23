# pi-project-memory

Persistent, editable project memory for [Pi](https://pi.dev): a `MEMORY.md` index plus one Markdown file per memory.

Memory is plain Markdown in a directory you own. The agent reads and writes it with ordinary `read`/`edit`/`write` tools, the way Claude Code does on a project, and the extension keeps the index, provenance and internal state consistent. No database, no embeddings, no background daemon.

- Per-repository scope: worktrees and subdirectories of one repository share memory, unrelated projects stay separate
- A bounded index is injected once per session; note bodies are read on demand
- Local BM25 search (English and CJK) with an optional model-assisted semantic pass
- Optional background extraction that can read the notes and rewrite them itself
- Atomic file updates, a cross-process lock, and revision checks against stale writes

## Requirements

- Pi with extension support (developed and tested against Pi 1.2.0)
- Node.js 22.19.0 or newer
- `git` on `PATH` and read access to this repository

## Install

Install for all projects (writes to `~/.pi/agent/settings.json`):

```bash
pi install git:github.com/adlternative/pi-project-memory
```

Install for the current project only (writes to `.pi/settings.json`, applied once you trust the folder):

```bash
pi install -l git:github.com/adlternative/pi-project-memory
```

Try it for a single run without installing:

```bash
pi -e git:github.com/adlternative/pi-project-memory
```

### Private repository access

Pi clones with your normal Git credentials. Either authenticate `gh` for an account with access, or make sure `ssh -T git@github.com` succeeds. If cloning fails, fix Git access and re-run the command.

### From a local checkout

```bash
git clone git@github.com:adlternative/pi-project-memory.git
pi install ./pi-project-memory
```

Run `/reload` in a running session, or restart Pi, so the extension loads.

### Verify

```bash
pi list      # shows the installed package
pi --help    # lists --memory-dir, --memory-auto, --memory-dream, --memory-disabled
```

Inside a session, `/pmem` prints the memory directory for the current project.

## First memory

Start Pi in a repository and simply tell it what matters:

```text
Remember that this project uses pnpm, not npm, and that reviews go to the payments-review group.
```

Each fact becomes its own topic file. In a later session, without repeating yourself:

```text
How should I install dependencies here, and where do reviews go?
```

```text
/pmem list
/pmem show package-manager
```

Memory is context, not configuration: it is offered to the model as untrusted reference material, and your current instructions always win.

## Where memory lives

```text
<agent-dir>/project-memory/<repo-name>__<hash>/
├── MEMORY.md              # index; your own prose outside the generated block is kept
├── package-manager.md     # one topic; the filename is its stable id
├── review-process.md
├── .state.json            # revision, provenance, timestamps, hashes, tombstones
└── .pending.json          # only during a transaction or interrupted recovery
```

`<agent-dir>` is `~/.pi/agent` unless `PI_CODING_AGENT_DIR` says otherwise. The folder name carries the repository name for humans and a hash for identity, because paths that differ only in separators (for example `/a/b` and `/a-b`) must not share notes.

The canonical Git common directory decides the project: every worktree, subdirectory and symlinked checkout of one repository shares a store. A git submodule is its own repository and gets its own store. Non-Git directories are keyed by their canonical working directory. Renaming or moving a repository changes the key, so move the old folder to the new name to keep its notes.

### Editing a topic by hand

```markdown
---
name: "Package manager preference"
description: "Dependency installation for this project"
type: feedback
modified: "2026-10-15T00:00:00.000Z"
---

Use pnpm rather than npm by default.
```

- `name` and `type` are required; `description` and `modified` are optional. Types are `user`, `feedback`, `project`, `reference`.
- Filenames use lowercase letters, digits, `-` or `_`, up to 64 characters. `memory` is reserved for the index.
- Flat plain, JSON double-quoted and YAML single-quoted values are supported; folded values, nested YAML and aliases are not.
- Delete a topic file to forget it; recreating it later is an explicit manual restore.
- Do not edit `.state.json`, `.pending.json` or `.lock`.

`MEMORY.md` is regenerated only between its markers, so custom notes above or below survive:

```markdown
# Project memory

Add your own navigation guidance here.

<!-- pi-memory:index:start -->
- [Package manager preference](package-manager.md) — feedback
<!-- pi-memory:index:end -->
```

## Configuration

Configure memory in Pi settings so it survives installs. Use user scope (`~/.pi/agent/settings.json`) for everything, or project scope (`.pi/settings.json`) for one repository.

```json
{
  "projectMemory": {
    "enabled": true,
    "directory": "~/pi-memory",
    "autoExtract": false,
    "extractModel": "qoder/fast",
    "dedicatedTools": false,
    "everyNTurns": 5,
    "idleFlushSeconds": 120,
    "extractionMode": "call",
    "autoDream": false,
    "dreamMinHours": 24,
    "dreamMinSessions": 5,
    "dreamRetryHours": 1
  }
}
```

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Master switch; `false` stops recall, writes and extraction without deleting notes |
| `directory` | `<agent-dir>/project-memory` | Base directory for all project stores; absolute or starting with `~/` |
| `autoExtract` | `false` | Opt in to background extraction |
| `extractModel` | `qoder/fast` | Model for extraction, as `provider/model` or a bare id; falls back to the session model and records `requestedModel` |
| `dedicatedTools` | `false` | Expose `pmem_list`/`pmem_read`/`pmem_search`/`pmem_save`; off means files are the interface |
| `everyNTurns` | `5` | Run one extraction pass every N user prompts |
| `idleFlushSeconds` | `120` | Also run a pass after this much inactivity; `0` disables it |
| `extractionMode` | `"call"` | `"call"` sends one no-tool JSON request; `"fork"` runs a bounded sub-agent with two memory-only tools |
| `autoDream` | `false` | Opt in to a separate consolidation pass. It does not replace extraction |
| `dreamMinHours` | `24` | Minimum hours since the last successful dream |
| `dreamMinSessions` | `5` | Other persistent sessions touched since that dream. The current session does not count |
| `dreamRetryHours` | `1` | After a failed dream, wait this long before an automatic retry. `0` retries on the next session |

Per-run overrides exist for experiments and automation; a flag affects only the process it is passed to. Precedence is flag, then settings, then default.

| Flag | Overrides |
|---|---|
| `--memory-dir <path>` | `directory` |
| `--memory-auto` | `autoExtract` |
| `--memory-dream` | `autoDream` |
| `--memory-disabled` | `enabled` (forces off) |

## Tools and commands

By default there are **no memory tools**: the model reads and writes Markdown with its ordinary file tools, which is how Claude Code works and how Codex ships (`dedicated_tools = false`). Set `"dedicatedTools": true` when the model has no file tools, or when you want search without a shell.

| Tool (opt-in) | Purpose |
|---|---|
| `pmem_list({offset?})` | Ten previews per page with relative paths and `nextOffset` |
| `pmem_read({id})` | One complete note with its path and provenance |
| `pmem_search({query, mode?})` | Local `keyword` BM25 by default; optional `semantic` model selection; up to five matches |
| `pmem_save({id,type,title,description?,content})` | Create or update one topic file |

Structured output is `{directory,indexPath,notes,truncated,nextOffset}`; each `note.path` is relative to `directory`.

| Command | Purpose |
|---|---|
| `/pmem` | Directory, count, revision, model and mode |
| `/pmem list [offset]` | Paginate the index |
| `/pmem show <id>` | Content and provenance |
| `/pmem forget <id>` | Delete the topic, drop its link, record a tombstone |
| `/pmem auto on\|off` | Toggle extraction for this session only |
| `/pmem extract` | Run a pass now, synchronously |
| `/pmem dream` | Consolidate now: merge, correct, and tombstone. Ignores the schedule |
| `/pmem dream on\|off` | Toggle automatic dreaming for this session only |

## When memory is written

Five paths can write:

1. The model edits a topic file with `write`/`edit`; the extension ingests it immediately and refreshes the index.
2. The model calls `pmem_save` (when `dedicatedTools` is on).
3. Background extraction, when `autoExtract` is on: every `everyNTurns` prompts, after `idleFlushSeconds` of inactivity, or once as a trailing pass if a pass was already running.
4. `/pmem extract`.
5. `/pmem forget` removes a note.
6. Dreaming, when `autoDream` is on or you run `/pmem dream`. A dream may update notes and forget duplicates. Forgetting still writes a tombstone, so automatic extraction cannot put that id or the same text back. The model never deletes files itself and never rewrites `MEMORY.md`.

Nothing is written when the feature is disabled, in ephemeral sessions, when the turn errored or was aborted, when the run already wrote memory itself, when no substantive user text arrived, or when messages are still queued.

Background extraction runs detached, so the turn settles immediately. Only one pass runs at a time; a pass is discarded when a newer turn has already started. Results are re-checked against the store revision before writing, and a shutdown first runs a pending idle pass, then drains in-flight work for up to 15 seconds.

`call` mode makes one request and applies validated JSON. `fork` mode gives a sub-agent up to six turns with `read_memory` and `write_memory`, both confined to the current project's memory directory, then applies its staged files atomically. A cancelled or failed pass discards everything.

## Retrieval and limits

- The first 200 lines / 3,000 UTF-8 bytes of `MEMORY.md` are injected once per session; note bodies are not.
- BM25 runs locally with title weight 3 and description/body weight 1, folding common English suffixes and indexing CJK as characters and bigrams.
- `pmem_search({mode: "semantic"})` asks the current model to pick from up to 48 candidate previews; it is not a vector index.

| Resource | Limit |
|---|---:|
| Topics per project | 128 |
| Title / description / body | 160 / 320 / 2,000 UTF-8 bytes |
| Topic file including frontmatter | 4,096 bytes |
| MEMORY.md | 25,000 bytes |
| Tool output | 12,000 bytes |
| Nested model input / output | 32,000 bytes (trimmed to 30,000) / 16,000 bytes, 2,000 tokens |
| Extraction budget | 20 s, 12 messages, 1,000 bytes each, at most 4 notes |

## Safety

- **Not secure erasure.** `/pmem forget` deletes the topic and blocks automatic restoration of that id or identical content. It does not erase Pi sessions, migration backups, or provenance quotes stored in other notes.
- **Memory is untrusted input.** Notes are data, not instructions, and current instructions win; a note can still influence later sessions, so keep automatic extraction off for sensitive work.
- Known credential shapes are redacted before extraction and rejected on save; this is not DLP.
- Writes use an in-process queue plus a cross-process lock, replace each file atomically, and journal multi-file updates with `.state.json` committed last. A crash-left `.lock` deliberately blocks access until you remove it.
- Path traversal, symlinks, hardlinked data files, invalid UTF-8 and unknown state are rejected. New files are `0600`, directories `0700`.

## How this compares

Claude Code and Codex both keep memory as files, but they disagree about who writes them. Details in [RESEARCH.md](./RESEARCH.md).

| | This plugin | Claude Code (local auto memory) | Codex |
|---|---|---|---|
| Store | `<agent-dir>/project-memory/<repo>__<hash>/` | `~/.claude/projects/<project>/memory/` | `~/.codex/memories/` plus a SQLite bookkeeping DB |
| Layout | `MEMORY.md` index + one file per note | `MEMORY.md` index + one file per note | index, summary, raw memories, rollout summaries, skills |
| Scope | Git common dir; worktrees share, submodules do not | Git repository; worktrees share | Global consolidation of rollouts, not per repository |
| Loaded at start | index (3 KB) once per session | `MEMORY.md` first 200 lines or 25 KB | summary truncated to 2.5k tokens as developer instructions |
| Model-facing tools | none by default; four optional | none, ordinary file tools | four read-only, default off |
| Search | local BM25 + optional model pass | grep | literal line matching |
| Who writes | model (files or tool), or background extraction | model (files), or background extraction sub-agent | only the background pipeline; the model gets one note-file escape hatch |
| Extraction | opt-in; one call, or a ≤6-turn scoped sub-agent; cadence and idle flush | background fork with restricted tools, 4–5 turns | two-phase pipeline with leases and a git-baseline diff |
| Consolidation | opt-in dream: one JSON plan, tombstones, 24h and 5 other sessions | auto-dream, forked sub-agent, server-gated | Phase 2 consolidation agent |
| Team or cloud sync | none | personal/team/org stores with server sync | none |
| Write guarantees | atomic per file, journal, cross-process lock | plain file writes | SQLite plus git baseline |
| Forget | `/pmem forget` with a tombstone | delete the file | not exposed |

What is deliberately different:

- **Model writes are allowed.** Codex keeps the model out of memory; this plugin treats notes as files the model may edit, like Claude Code, because a correction is usually cheapest to apply immediately.
- **No team sync.** Notes stay on this machine; there is no server component to trust or configure.
- **Search is local and ranked.** Claude Code relies on grep and Codex on literal matching; BM25 costs nothing and returns ranked snippets, with an optional model pass for paraphrases.
- **Dreaming is a second pass, and it is off.** Extraction still records what this turn taught. Dream, when you opt in, merges near-duplicates and drops contradicted notes across earlier sessions. It is one bounded model call with a validated plan, not a shell-capable sub-agent, and it will not restore a forgotten id.

## Update and uninstall

```bash
pi update --extensions
pi update git:github.com/adlternative/pi-project-memory
pi remove git:github.com/adlternative/pi-project-memory
```

Add `-l` for the project-scoped entry. Removing the package does not delete notes; delete `<agent-dir>/project-memory/` when you want them gone.

## Troubleshooting

**The tools do not appear.** They are off by default; set `"dedicatedTools": true` and run `/reload`. Note that `--no-extensions` disables configured packages entirely.

**Nothing is recalled.** Run `/pmem`; it must print a directory that exists. Memory is per repository, so a different checkout has its own store.

**Writes stop with a busy or conflict error.** Another Pi process holds the lock, or an external edit conflicted with a pending transaction. Close other sessions, inspect `.pending.json` and the affected topic, and keep the newer manual edit.

**Memory did not update after a prompt.** Background extraction is off by default, and when on it runs once per `everyNTurns` prompts or after an idle period. Run `/pmem extract` to force a pass.

## Limitations

- No team or cloud sync, no per-subagent store. Dream reviews at most eight recent sessions and the newest notes that fit in a 30KB prompt, and it writes or forgets at most eight notes per pass.
- `forget` is not privacy-grade erasure.
- Fork-mode writes are applied file by file at the end, so a crash during that short window can still leave a subset written.
- Developed and tested on macOS with Pi 1.2.0; Linux and Windows are unverified, as is power-loss durability.
- Other Pi forks or versions are not guaranteed compatible.

## License

MIT. See [LICENSE](LICENSE). Development and verification notes live in [DEVELOPMENT.md](DEVELOPMENT.md).
