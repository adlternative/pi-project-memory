# pi-project-memory

Persistent, editable project memory for [Pi](https://pi.dev): a `MEMORY.md` index plus one Markdown file per memory, so the agent can read and patch a single fact with ordinary `read`/`edit` tools instead of rewriting a database.

Because memory is plain Markdown, you own it: open the folder in your editor, delete a file to forget something, or hand-edit a note. The extension keeps the index, provenance, and hidden state files in sync.

- Local English/CJK BM25 search with no network call
- Optional model-assisted semantic search for paraphrases and cross-language queries
- Optional, opt-in automatic extraction of durable facts at the end of a successful turn
- Per-repository scope: worktrees and subdirectories of one repo share memory; unrelated projects stay isolated
- Bounded recall (6 KB per request) instead of replaying everything ever saved

> This repository is private. `pi install` needs Git access to it — see [Install](#install).

## Requirements

- Pi with extensions support (developed and tested against Pi 1.2.0)
- Node.js 22.19.0 or newer
- `git` on `PATH` and read access to this repository

## Install

Install for all projects (writes to `~/.pi/agent/settings.json`):

```bash
pi install git:github.com/adlternative/pi-project-memory
```

Install for the current project only (writes to `.pi/settings.json`, applies after you trust the folder):

```bash
pi install -l git:github.com/adlternative/pi-project-memory
```

Try it for a single run without installing anything:

```bash
pi -e git:github.com/adlternative/pi-project-memory
```

### Private repository access

Pi clones this repository with your normal Git credentials. Use either:

```bash
gh auth login            # the account needs access to this private repo
# or make sure SSH works:
ssh -T git@github.com
```

If cloning fails, Pi reports the Git error; fix Git access first, then re-run `pi install`.

### From a local checkout

```bash
git clone git@github.com:adlternative/pi-project-memory.git
pi install ./pi-project-memory
```

Restart Pi, or run `/reload` in a running session, so the extension loads.

### Verify

```bash
pi list                  # shows the installed package
pi --help                # lists --memory-dir, --memory-auto, --memory-disabled
```

In a session, `/pmem` prints the memory directory for the current project.

## First memory

Start Pi in a repository and just tell it what to remember:

```text
Remember that this project uses pnpm, not npm, and that reviews go to the #payments-review group.
```

The agent saves each fact as its own topic file. In a later session, without repeating yourself:

```text
How should I install dependencies here, and where do reviews go?
```

Recall happens automatically: before each model request the extension injects the bounded index plus the most relevant notes, marked as untrusted historical data. The agent can also search and read memory explicitly with the tools below.

Review what was saved:

```text
/pmem list
/pmem show package-manager
```

## Tools and commands

| Tool | Purpose |
|---|---|
| `pmem_list({offset?})` | Ten previews per page with relative `.md` paths and `nextOffset` |
| `pmem_read({id})` | One complete note with its path and provenance |
| `pmem_search({query, mode?})` | Local `keyword` BM25 by default; optional `semantic` model selection; up to five matches |
| `pmem_save({id,type,title,description?,content})` | Create or update one topic file |

Structured tool output is `{directory,indexPath,notes,truncated,nextOffset}`; each `note.path` is relative to `directory`.

| Command | Purpose |
|---|---|
| `/pmem` | Directory, note count, revision, and extraction status |
| `/pmem list [offset]` | Paginate the index |
| `/pmem show <id>` | Show content and provenance |
| `/pmem forget <id>` | Delete the topic, drop its index link, record a tombstone |
| `/pmem auto on\|off` | Toggle automatic extraction for this session only |
| `/pmem extract` | Extract unprocessed evidence from the active branch now |

## Where memory lives

```text
<agent-dir>/project-memory/<repo-name>__<hash>/
├── MEMORY.md              # Navigation; your own prose outside the generated block is kept
├── package-manager.md     # One topic; the filename is its stable id
├── review-process.md
├── .state.json            # Revision, provenance, timestamps, hashes, tombstones
└── .pending.json          # Only during a transaction or interrupted recovery
```

Folder names read like `codex__646b6ecb79c8`, where the hash keeps identity unique. Pi's own session folders collapse `/` into `-`, so `/a/b` and `/a-b` would share a folder; that is acceptable for transcripts but not for notes, so the hash decides and the name is only a label. Folders created by earlier versions (hash only) are renamed in place on first use, keeping their notes.

`<agent-dir>` is `~/.pi/agent` unless `PI_CODING_AGENT_DIR` says otherwise. Change the base directory with `projectMemory.directory` in settings, or `--memory-dir` for one run; projects remain separated underneath it.

The canonical Git common directory identifies a project, resolved automatically with no configuration: every worktree, subdirectory, and symlinked checkout of one repository shares a single memory store. Worktrees checked out from a bare repository behave the same way. Inherited `GIT_DIR`, `GIT_WORK_TREE`, or `GIT_COMMON_DIR` values are ignored during resolution so an exported variable or git hook cannot silently give a worktree its own separate memory.

A git submodule is its own repository and therefore gets its own store. Non-Git directories use their canonical working directory. Nothing is pooled across unrelated projects. Session transcripts are separate from memory and remain per working directory, so each worktree has its own conversation history but they all read and write the same notes.

Renaming or moving a repository changes the path-derived key. The old notes stay on disk untouched; run `/pmem` in the moved checkout to print the new directory, then move the old project directory to that location while the new one does not yet exist.

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
- Filenames are lowercase letters, digits, `-`, or `_`, up to 64 characters. `memory` is reserved for the index.
- Flat plain, JSON double-quoted, and YAML single-quoted values are supported. Folded values, nested YAML, and aliases are not.
- Delete a topic file to forget it. Recreating it later is an explicit manual restore.
- Do not edit `.state.json`, `.pending.json`, or `.lock`. They are internal.

`MEMORY.md` is regenerated only inside its markers, so custom notes above or below survive:

```markdown
# Project memory

Add your own navigation guidance here.

<!-- pi-memory:index:start -->
- [Package manager preference](package-manager.md) — feedback
<!-- pi-memory:index:end -->
```

## Configuration

Configure memory in Pi settings, so it applies to every session after installation instead of being repeated on each launch. Use user scope for everything (`~/.pi/agent/settings.json`), or project scope (`.pi/settings.json`, applied once you trust the folder) to change one repository.

```json
{
  "projectMemory": {
    "enabled": true,
    "directory": "~/pi-memory",
    "autoExtract": false
  }
}
```

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Master switch. `false` stops recall, writes, and extraction without deleting saved notes |
| `directory` | `<agent-dir>/project-memory` | Base directory for all project stores. Absolute, or starting with `~/` |
| `autoExtract` | `false` | Opt in to one bounded extraction call after a successful persistent turn |

These are the counterpart of Claude Code's `autoMemoryEnabled` and `autoMemoryDirectory`. Run `/reload` after editing settings; `/pmem` confirms the resolved directory and state.

Worktree and subdirectory root detection needs no configuration; see [Where memory lives](#where-memory-lives).

### Per-run overrides

You normally do not need these. They exist for one-off experiments, tests, and subagent or automation processes that must not share the installed configuration.

| Flag | Overrides |
|---|---|
| `--memory-dir <path>` | `projectMemory.directory` |
| `--memory-auto` | `projectMemory.autoExtract` |
| `--memory-disabled` | `projectMemory.enabled` (forces off) |

Precedence is flag, then settings, then default. A flag affects only the process it is passed to. `/pmem auto on` and `/pmem auto off` toggle extraction for the current session only and never edit settings.

## Retrieval, extraction, and limits

Recall runs on every request:

- The first 200 lines / 3,000 UTF-8 bytes of `MEMORY.md`, plus up to three BM25 snippets of 600 bytes each, within a 6,000-byte total.
- This is request-local. It does not append to, or rewrite, your stored conversation.
- Only fixed `project_memory` usage rules are added to the prompt. Your system prompt and `SYSTEM.md` are not replaced.

Search is local BM25 with title weight 3 and description/body weight 1, tokenizing English words and CJK characters/bigrams. `pmem_search({mode: "semantic"})` asks the current model to pick from up to 48 candidate previews; it is not a vector index, so it can miss notes whose wording is far from the query.

Automatic extraction is off unless `projectMemory.autoExtract` (or `--memory-auto`) enables it. When on, a successful persistent turn makes at most one no-tool model call over the latest 12 new user/final-assistant texts (1,000 bytes each). System prompts, thinking, tool output, and abandoned branches are excluded. Failed, aborted, or stale candidates are discarded.

| Resource | Limit |
|---|---:|
| Topics per project | 128 |
| Title / description / body | 160 / 320 / 2,000 UTF-8 bytes |
| Topic file including frontmatter | 4,096 bytes |
| MEMORY.md | 25,000 bytes |
| Tool output | 12,000 bytes |
| Nested model input / output | 32,000 bytes (trimmed to 30,000) / 16,000 bytes, 2,000 tokens |
| Nested model timeout | 15 seconds |

Semantic-tool usage is reported through the tool result and counted by Pi. Automatic and manual extraction usage is recorded separately as `pi-project-memory.extraction` entries and is not added to Pi's footer totals.

There is no background "dreaming": no scheduled full-store consolidation, automatic eviction, or skill generation.

## Safety and scope

- **Not secure erasure.** `/pmem forget` deletes the topic and blocks automatic restoration of that id or identical content. It does not erase your original Pi sessions, migration backups, or historical provenance quotes stored in other notes. Treat deleted facts as recoverable from history.
- **Memory is untrusted input.** Notes are injected as data, not instructions, and the agent is told current instructions win. Memory is not a prompt-injection boundary: anything written to a note can influence later sessions. Leave automatic extraction off for sensitive conversations.
- Known credential formats are redacted before extraction, and obvious credentials are rejected when saving. This is not DLP and cannot catch every secret.
- Writes use an in-process queue plus a cross-process lock, replace each file atomically, and journal multi-file updates with `.state.json` committed last. Uncooperative external editors do not take the lock, so conflicts stop recovery with the journal intact rather than overwriting your newer text.
- A crash-left `.lock` deliberately blocks access. Close Pi sessions using that store, then inspect and remove only the stale lock. Never delete `.pending.json` or `.state.json` to "fix" a store.
- Path traversal, symlinks, hardlinked data files, invalid UTF-8, and unknown state are rejected. New files are `0600` and directories `0700` (Windows uses platform semantics).

## Update and uninstall

```bash
pi update --extensions                                    # update all packages
pi update git:github.com/adlternative/pi-project-memory   # update this package
pi remove git:github.com/adlternative/pi-project-memory   # uninstall
```

Add `-l` to update or remove the project-scoped entry. Removing the package does not delete saved memory; delete the `<agent-dir>/project-memory/` directory (or individual projects inside it) when you want the notes gone.

## Troubleshooting

**The tools don't appear.** Run `pi list` to confirm the package is installed, then restart Pi or run `/reload`. Note that `--no-extensions` disables configured packages, and `--no-tools` hides the memory tools; explicit `-e <path>` still loads a package.

**Nothing is recalled.** `/pmem` must show a directory that exists. Memory is per-repository, so a different checkout has its own store. Notes are only recalled when they match; check `/pmem list`.

**Writes stop with a busy or conflict error.** Another Pi process holds the lock, or an external edit conflicted with a pending transaction. Close the other sessions, inspect `.pending.json` and the affected topic, and keep the newer manual edit.

**`/pmem forget` didn't remove everything.** It removes the note from memory. Historical sessions, backups, and provenance quotes in other notes keep it; see [Safety and scope](#safety-and-scope).

## Development

Automated tests use a synthetic in-process provider and isolated data. They never import real history or credentials.

```bash
npm ci --ignore-scripts
npm run check
npm test
python3 tests/install-smoke.py    # requires PI_CODING_AGENT_DIR
python3 tests/cli-smoke.py
PI_MEMORY_TEST_FILE_TOOLS=1 python3 tests/cli-smoke.py
```

`tests/install-smoke.py` installs, loads, writes, recalls, and removes the package against an isolated `PI_CODING_AGENT_DIR`; it refuses to run against your real global Pi agent directory. Set `PI_MEMORY_TEST_NODE` to pick a specific Node, and `PI_MEMORY_PI_BIN` to pick a Pi launcher.

Try the extension in a throwaway environment without touching your Pi configuration:

```bash
./run-sandbox.sh
./run-sandbox.sh --memory-auto
./run-sandbox.sh --memory-auto -- "Use pnpm rather than npm for this project's future work."
```

The launcher creates everything under `.sandbox/manual/` and loads the experimental `sandbox-guard.ts`, which restricts file tools to that project's `MEMORY.md` and topic files. Normal installs do not load the guard.

`tests/check-isolation.py` compares global Pi configuration fingerprints and needs a developer-local baseline that is not committed, so it is optional after a fresh clone.

A real-model journey over a disposable Node project is documented in [`e2e/live/README.md`](e2e/live/README.md): 15 process stages, 10 real-model conversations, and 17 acceptance checks, including a cold session implementing a feature against previously failing tests.

### Known limitations

- Developed and tested on macOS with Pi 1.2.0. Linux and Windows are untested.
- Power-loss durability is not verified.
- One model and one small project were used for the live journey; it is not a broad reliability benchmark.
- Forget is not privacy-grade erasure (above).
- Renaming or moving a repository starts a new store at the new path; migrate the old directory manually (see [Where memory lives](#where-memory-lives)).
- Development dependencies pin Pi/test `pi-ai` 1.2.0 and `typebox` 1.3.27. Distributed packages declare only host peers, and other Pi forks or versions are not guaranteed compatible.

## License

MIT. See [LICENSE](LICENSE).
