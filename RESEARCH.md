# Memory research → Pi design

## Scope and evidence

Historical paths and Evidence IDs below identify the original local investigation. Raw `evidence/`, downloaded/derived third-party artifacts, credentials, transcripts and `.sandbox/` data are intentionally excluded from this repository; the source tests and live E2E scripts recreate fresh local runs.

This lab is separate from `/Users/adl/codex` and `~/.pi/agent`. No experimental extension has been installed or loaded in the running Pi. No real conversations, existing memories, or credentials are copied into test stores. Tests use synthetic data and an isolated agent directory.

### Codex (local source, not claims about a released service)

- `codex-rs/memories/write/src/start.rs`: eligible root sessions start asynchronous extraction then consolidation; ephemeral/subagents skip; DB availability and quota checks gate work.
- `phase1.rs`, `phase1_output.rs`: per-rollout extraction, leased jobs, bounded concurrency, structured output, secret redaction. V1 produces raw memory + summary; V2 produces only a bounded summary. Earlier blanket statements that both always store raw memory were inaccurate.
- `phase2.rs`, `workspace.rs`: global lease, synchronize selected sources, diff from a filesystem git baseline; skip unchanged inputs, consolidate with a constrained internal worker. Managed sandbox blocks network and restricts writes, but explicitly disabled/external parent sandboxing is preserved—not an unconditional security guarantee.
- `ext/memories/src/{extension,prompts}.rs`: a bounded summary is injected; optional dedicated tools use a local backend. `local/search.rs` implements lexical line matching and path/line ordering, not semantic ranking.
- `state/src/runtime/memories.rs`, `state/memory_migrations/`: durable extraction/job state, usage-driven input selection. These are useful pipeline invariants, not a reason for a small Pi package to require SQLite and an internal Git repository.

### Claude Code documented behavior

Primary source: https://code.claude.com/docs/en/memory.md (retrieved in this task).

- Two distinct systems: user/project instructions (`CLAUDE.md`/rules) and automatically maintained notes.
- Auto memory: `~/.claude/projects/<project>/memory/MEMORY.md` index plus topic files; worktrees/subdirectories of one repository share scope.
- Startup loads the first 200 lines or 25KB of the index, not every topic file; standard tools load detail on demand.
- Types: user, feedback, project, reference. Skip secrets, readily re-derived code facts and duplicate instructions. Remember/forget can be requested explicitly.
- Official local-memory documentation says machine-local, not automatically synchronized across machines. It does not establish that every installation uses BM25, background extraction, auto dream, or shared-memory tools.

### Claude Code 2.1.280 shipped artifact (static only)

Target: the installed `@anthropic-ai/claude-code/bin/claude.exe`.
SHA-256: `387a5c5dcdbb815085edf0baf79591f9d8894efe922bceaf3d75b1b08055229d`.

REA 6.4.0 was installed only under `.tools/rea` with a lab-local npm cache and HOME. No MCP registration or analysis engine was installed globally.

- `evidence/cc-artifact.json`: Evidence `ev_e53f416f0238905418d91136816915da24f96f8e4ef409d5ab3a3f5be3006a13` identifies the Mach-O.
- `evidence/cc-macho.json`: Evidence `ev_68f53fdf9f3dfd59ae361f5153179c13b8c51acaa513afd40d914a3ab72c04fb` establishes the `__BUN/__bun` section at file offset 67993600.
- `evidence/extract-cc.py`: ordinary read-only Python extraction of complete NUL-delimited UTF-8 Bun JS sources, NOT decompilation or original source recovery. `cc-derived-manifest.json` records offsets, lengths and hashes. Extraction provenance is shell evidence, not a fabricated REA Evidence ID.
- REA analyzed the derived subset without executing the binary: `cc-javascript.json`, Evidence `ev_b9e1ba415a857e7e7feb4bd60bdd40cfeb2882b54a8a3a30426acbecfd293efe`. Summary view: `cc-analysis-summary.json`, Evidence `ev_46147a1c1c3b7202fea2a475540f80b36163819b18383844d23890570af516b7`.
- Coverage is **partial**: 9 parsed JS files, 0 parse failures; several expanded semantic graphs exceeded the result budget. Imports outside this derived subset and live remote flag values are unresolved. The report does not establish runtime activation.

Focused source observations:

1. `cc-derived/chunk-183749702.js`, `mVn/ce/F`: memory extraction skips `toolUseContext.agentId`, checks `tengu_passport_quail` with a false fallback, checks auto-memory availability, skips a range with successful direct memory writes or without substantial user prose, tracks the last processed UUID and coalesces overlapping requests. The worker gets at most 5 turns and a file-scoped permission callback. This is NOT proof that extraction runs for every local user.
2. `cc-derived/chunk-183772572.js`, `tn/blt/aMe`: auto dream is gated by `tengu_onyx_plover` remote configuration before `autoDreamEnabled`; lock metadata includes `.consolidate-lock`, live PID checks and last-consolidated time. It is not universally enabled just because its implementation ships.
3. `cc-derived/chunk-188410808.js`: a memory BM25 implementation and `.bm25-index.json` persistence exist; filename/frontmatter/headings/body fields have separate weights. This is lexical relevance scoring, NOT embeddings. Existence of this branch does not prove it is active for the installed user.
4. Other shipped branches contain memory-store/sync tools. Their presence does not establish that ordinary local auto memory is server-synced. The prior response overstated this.

No claim of copying/lineage between Codex and Claude Code is established by a shared Markdown layout. The earlier answer's “copied” assertion was speculation and is not a design premise.

### Pi integration and isolation

Installed host: `@earendil-works/pi-coding-agent` (Node 22 launcher). Read the installed README, extension/package/SDK/configuration/settings/session/message/model/provider/security docs and checked extension examples.

Relevant contracts:
- Extensions: `before_agent_start` can add a named prompt section; `context` can add request-local context without rewriting persisted history.
- Tools use TypeBox, structured results and the host file-mutation queue.
- `agent_before_settle` is the actionable final boundary; `agent_end` is not necessarily final (retry/queued work can follow). `agent_settled` is notification-only. An SDK cancellation test exposed a Pi 1.2 detail: `ctx.signal` is gone at the final boundary, because the lower-level agent run has ended. Automatic extraction therefore prepares a candidate in a successful `turn_end` (with the active abort signal) and commits only at successful `agent_before_settle`. Continuation, cancellation and shutdown discard an uncommitted candidate; Pi itself was not modified.
- `ctx.modelRegistry.streamSimple()` makes provider-neutral nested calls with request-time auth. A tool can report nested usage; a lifecycle callback cannot append a public UsageEntry through its read-only session manager. Auto extraction must therefore expose separate usage bookkeeping rather than silently claim Pi's totals include it.
- Session projection respects compaction/context edits; do not extract from abandoned branches, system instructions, thinking, tool output, or injected memory.
- `PI_CODING_AGENT_DIR`, explicit `agentDir`, isolated ModelRuntime paths, in-memory settings, `-ne -ns -np -nc --no-mcp` and an explicit extension path permit isolated tests. A separate cwd by itself is NOT a sandbox.

## v0.1 first implementation (historical; storage choice superseded below)

- Independent package, no runtime dependencies beyond Pi-provided peers; no global install.
- Repository-scoped bounded file store; resolve the Git common directory so worktrees share memory, hash canonical non-Git cwd otherwise. No global cross-project user-profile bucket.
- Explicit list/read/save/search tools and `/pmem` management, including forget. Stable ids, provenance, atomic writes and cross-process conflict protection; corruption fails closed.
- Small read-time index plus task-relevant notes as bounded, request-local **untrusted data**, not a rewritten system prompt full of memory bodies. Live instructions win over old notes.
- Local Chinese/English BM25; optional model-assisted semantic selection for paraphrases, clearly labeled as a model call, not embedding search.
- Automatic extraction is opt-in (`--memory-auto`), persistent user runs only, with a successful-final-boundary commit. Single bounded no-tool model call while cancellation is live, incremental active-branch evidence, strict result validation, deduplication, stale-snapshot rejection and forgotten-id suppression. Skip a run that already saved memory directly. No child Pi process, shell-capable summarizer, historic-session crawling or recursive agent.
- A single bounded `memories.json` is canonical; the human-readable/list and retrieval index are generated at read time. This avoids a second Markdown/index file drifting after a partial write. Consolidate notes by stable ids and exact-content deduplication on atomic save instead of porting Codex's large DB + global worker pipeline. Do not implement team cloud sync, unattended destructive pruning, embeddings, skill generation or a second “dream” agent in this first package.

Test plan: unit checks for ranking/CJK, validation, corruption, atomicity/concurrency, forgotten-note suppression and scope; SDK tests through real extension loading with a synthetic provider for extraction/recall/error/abort/resume/branch boundaries; CLI smoke in an isolated HOME/agent dir; fingerprint global configuration/extensions before/after. No paid call or credential copying is needed for deterministic acceptance tests.

## v0.2: requested CC-style editable Markdown

The user explicitly requested aligning the file experience with Claude Code to reduce agent edit burden. The single-JSON choice was a v0.1 simplification, not a Pi limitation; it is no longer the canonical storage design.

- `MEMORY.md` is physical Markdown navigation, and `<id>.md` is each memory's authoritative content. Flat frontmatter uses CC-style `name`, optional `description`, `type`, optional `modified`. Hyphenated and snake_case filenames work; lowercase `memory` is reserved to avoid case-insensitive aliasing with the index.
- Standard Pi `read/edit/write` can edit one topic without rewriting unrelated notes or internal metadata. Four memory tools remain available as a convenience and for sessions without file tools. Result objects expose the directory and relative topic paths.
- Only the index's marked navigation block is regenerated; user prose outside it survives. The index is bounded at 25,000 bytes and request-local injection remains capped at 6,000 bytes, not a full reproduction of CC's startup budget.
- `.state.json` contains only coordination/provenance metadata and forgotten hashes, not the canonical body fields. Files changed outside the plugin are reconciled and attributed to `file`, not laundered as their original session quote. New writes/edits are ingested immediately after a successful standard-tool operation; malformed content is reported without silently undoing authored bytes, and can be repaired with the same tools.
- Journaled, state-last multi-file commits preserve per-file atomic replacement and recover interrupted operations. Plugin readers honor the lock. Ordinary external editors do not, so this is not a claim of global filesystem multi-file atomicity: unexpected edits cause recovery to stop with the journal intact, rather than overwrite newer content.
- v0.1 migration validates all input, preserves note ids/text/timestamps/source/forgotten markers, increments revision and moves the exact old JSON to a hidden backup. It refuses mixed Markdown/legacy sources, refuses to remigrate after state loss, and detects a revived old writer. The backup is never an automatic recall source; forget does not erase it or old session history.
- The lab launcher now enables standard file tools behind a separate memory-only guard. Tests discovered that `pi.getFlag()` is local to the extension that registered the flag: another extension cannot read the memory extension's flags. The guard therefore takes the root by factory argument (SDK) or lab-only environment (CLI), and a missing root fails closed. The main package manifest still loads only the real memory extension, not the lab guard.
- Flat scalar frontmatter deliberately avoids another runtime dependency. Full YAML semantics, arbitrary nested memory folders, vectors, a global user-profile pool and dreaming remain outside this change. Actual file times/provenance are authoritative; ordinary edits do not silently reformat headers just to update `modified`.

Acceptance covers local standard-tool edits/repair, unchanged unrelated file bytes, index preservation, migration and migration crash states, old-writer/state-loss safeguards, staged-transaction recovery/conflicts, direct deletion/restore, stale automatic proposals, malformed/oversized/linked/invalid-UTF8 files, and real isolated CLI cold recall after an edit. Full logs live under `evidence/`; live hosted-model quality and power-loss behavior were not established by those synthetic tests.

## Follow-up: real-model micro-project E2E

A separate development harness now exercises the actual built-in `openai-codex/gpt-6.1-sol` provider against a disposable Node quote project. See `e2e/live/README.md` and `evidence/live-micro-project.json`.

- The passing run is `.sandbox/live-project-hkx2t6p9/`: 15 fresh process stages, 10 real-model conversations, 17 acceptance checks; authoritative project tests evolved from 5 baseline cases to 7 cases after the model implemented shipping.
- Random future collaboration labels are never embedded in application code/README/tests. Cold prompts omit their values. Memory-disabled and cross-project controls return null, avoiding the false confidence of recalling something visible in the project files or full old conversation.
- Recorded live semantic tool results, not just final answers, selected the respective batch/nickname topics for two paraphrased queries. Automatic extraction saved a new future review group as `extracted`, then a fresh session retrieved it.
- Existing OAuth is read into RAM through an injected credential store. Mutations throw before any refresh callback runs; no credential is copied to disk, and mutation counts stay zero. Explicit global config/auth fingerprints are unchanged.
- Project-test execution is protected by a read-only/no-network/no-fork Seatbelt profile with authoritative checks outside editable project files. A failing bootstrap probe was minimized to Node needing read permission on the root directory itself; adding only `(literal "/")` read fixed it without enabling writes or network.
- One retention limitation was observed: a surviving note's provenance quote can still contain an older deleted label. The functional cold recall correctly returned null, but this is not proof of privacy-grade erasure. No unrequested source-history rewriting was added to hide that finding.

This is a single-model sample, not evidence of universal model reliability, cross-platform support or power-loss durability.
