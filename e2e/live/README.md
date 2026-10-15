# Real-model micro-project E2E

This is a genuine Pi/real-model acceptance journey, not the synthetic provider tests under `tests/`. It uses the installed native `openai-codex` provider and disposable data only.

## Project and public test seams

- Fixture: `e2e/fixtures/tiny-invoice/`, a dependency-free Node integer-cent quote calculator (5 initial tests).
- Public seams: independent Pi user conversations, the existing memory tools/commands and standard file tools, and the project's `quote()`/Node tests.
- The controller adds shipping requirements as two new failing tests. A cold real-model session must implement `shippingCents` in the real `quote.js` and pass all 7 tests.
- Each run uses new random collaboration labels. They appear in prompts and memory only, never source/README/tests. Cold recall prompts do not contain the expected answers.

## Re-run

This consumes real model quota. The completed run used `openai-codex/gpt-6.1-sol`; catalog cost estimates are not an invoice.

```bash
cd pi-project-memory
npm ci --ignore-scripts
# Use a Node 22 installation; set PI_MEMORY_TEST_NODE if it is not your default node.
python3 -u e2e/live/run.py
```

Optional `PI_MEMORY_LIVE_MODEL` selects another built-in model, and `PI_MEMORY_AUTH_PATH` selects an existing Pi `auth.json`. No login/refresh is performed. The stored OAuth must have at least ten minutes remaining; otherwise the test refuses to proceed. `gpt-5.3-codex-spark` was not supported by this account; no fake-provider fallback is used.

## Isolation

- Everything created is under a fresh `.sandbox/live-project-*` directory. Project A/B have distinct local Git roots. No real repository/history/memories are imported.
- Every stage is a new Node process. Ten stages create fresh real-model Pi conversations; the remaining stages run the Pi forget command or environment/project checks.
- Empty experimental HOME, explicit agent/session/memory paths, in-memory settings, disabled discovery/skills/context/MCP. `PI_OFFLINE` disables automatic catalog activity, not explicitly requested model inference.
- The only credential access is a trusted read into RAM. A custom `CredentialStore.modify/delete` throws before invoking any refresh callback, so the running Pi's OAuth is not rotated or written back. Credentials never enter prompts and are not copied into experimental auth files.
- Main-model file tools can read the four public project files, edit only `quote.js` in the coding stage, or access its own project memory Markdown. No shell or arbitrary command tool is available; other project/config/credential/session paths are blocked.
- `run_project_tests` has fixed arguments. Authoritative tests live outside the editable project, and execute in a read-only/no-network/no-fork macOS Seatbelt sandbox. A probe verifies outside reads, file writes and hardlinks are denied before any model task.
- Node bootstrap required read permission for the root directory itself, not a recursive root grant. The initial stricter profile aborted; the final profile adds `(literal "/")` read only and keeps all writes/network denied.
- Selected access/refresh tokens are scanned against experimental artifacts without being printed; reports record only the audit result and mutation counts.

No global Pi install, reload, credential mutation, or sandbox/network weakening fallback is performed. This harness is macOS-specific and refuses rather than silently running project tests without `/usr/bin/sandbox-exec`.

## Acceptance journey

1. Sandbox sentinel probe and the 5-test baseline.
2. Real model records two future collaboration facts in separate Markdown topics and runs baseline tests.
3. Add shipping tests and observe red before the model changes code.
4. Cold session implements shipping, runs tests and recalls the old random facts without being given them again.
5. Real model locally updates the batch-label topic, preserving unrelated nickname memory.
6. Fresh session recalls the new value, not the old one.
7. Two paraphrased semantic searches really call the nested live model; recorded tool results return the correct respective topics.
8. Memory-disabled control returns null values. A different project returns null values.
9. Pi `/pmem forget` deletes the batch topic. Fresh recall returns a null batch and retains the unrelated nickname.
10. A no-write user turn with auto extraction enabled records a new future review group through the actual extraction model; the next cold session recalls it.
11. Final authoritative project tests are still green (7/7), and business files contain no collaboration canaries.

## Completed run (historical local paths, not committed data)

- Run: `.sandbox/live-project-hkx2t6p9/`
- Modified application: `.sandbox/live-project-hkx2t6p9/project-a/quote.js`
- 15 independent process stages, 10 real-model conversations, 17 acceptance checks passed.
- Real `gpt-6.1-sol` usage: 56,381 total tokens including cached/nested usage; catalog estimate USD 0.125946, not actual subscription billing.
- Main report on the original developer machine: `evidence/live-micro-project.json`; each stage's `results/<stage>/result.json` and session JSONL are under the run directory. Raw reports, conversations, credential fingerprints and sandbox directories are intentionally not committed; a new run creates a new local report.
- The initial environment-only failed attempt remains at `.sandbox/live-project-9zqwwr5q/`; it stopped before model work. There was no failed model-result retry used to select a passing trial.

## Limits and a retention finding

This is one model and one small project, not a broad reliability benchmark. No concurrent-load or cross-platform real-model claim is made.

The functional forget check passed: a fresh model session returned a null deleted batch. An additional inspection found that another note's original provenance quote can still contain an old batch label. This is historical audit data, not the live note body; forgetting a topic is **not secure erasure** of all provenance, transcripts or backups, and another query/model could potentially reconstruct old facts from those sources. Do not treat this test as proof of privacy-grade deletion. A stricter policy would need a separate provenance-redaction/model-visibility decision.
