"""Independent real Pi processes; optional ordinary Markdown editing; synthetic provider only."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

lab = Path(__file__).resolve().parent.parent
root = Path(tempfile.mkdtemp(prefix="cli-", dir=lab / ".sandbox"))
for name in ["home", "agent", "project", "sessions", "tmp", "cache"]:
    (root / name).mkdir()
node = os.environ.get("PI_MEMORY_TEST_NODE") or shutil.which("node")
cli = (lab / "node_modules/@earendil-works/pi-coding-agent/dist/cli.js").resolve()
trace = root / "trace.jsonl"
extension = Path(os.environ.get("PI_MEMORY_TEST_EXTENSION", str(lab / "src/index.ts"))).resolve()
file_tools = os.environ.get("PI_MEMORY_TEST_FILE_TOOLS") == "1"
env = {
    "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
    "HOME": str(root / "home"), "TMPDIR": str(root / "tmp"),
    "XDG_CACHE_HOME": str(root / "cache"), "TERM": "dumb", "NO_COLOR": "1",
    "PI_CODING_AGENT_DIR": str(root / "agent"),
    "PI_CODING_AGENT_SESSION_DIR": str(root / "sessions"),
    "PI_OFFLINE": "1", "PI_SKIP_VERSION_CHECK": "1", "PI_TELEMETRY": "0",
    "PI_MEMORY_FIXTURE_TRACE": str(trace), "PI_MEMORY_SANDBOX_ROOT": str(root / "memory"),
    "GIT_CEILING_DIRECTORIES": str(root),
}
base = [node, str(cli), "--offline", "-ne", "-ns", "-np", "-nc", "--no-themes", "--no-mcp", "--no-approve",
        "-e", str(extension), "-e", str(lab / "tests/provider-fixture.ts"),
        "--provider", "memory-test", "--model", "synthetic", "--mode", "json",
        "--memory-dir", str(root / "memory"), "--session-dir", str(root / "sessions")]
if file_tools:
    base += ["--tools", "read,edit,write,pmem_list,pmem_read,pmem_search,pmem_save", "-e", str(extension.parent.parent / "sandbox-guard.ts")]
else:
    base += ["--no-builtin-tools"]
phases = [["--memory-auto", "--", "For future work, prefer pnpm instead of npm when installing dependencies."]]
if file_tools:
    phases += [["--memory-auto", "--", "CHANGE_INSTALLER_TO_BUN: update the saved installer to bun. How should I install dependencies?"]]
phases += [["--", "How should I install dependencies in this project?"]]
for number, args in enumerate(phases):
    run = subprocess.run(base + args, cwd=root / "project", env=env, capture_output=True, text=True, timeout=60)
    (root / f"run-{number}.jsonl").write_text(run.stdout)
    (root / f"run-{number}.stderr").write_text(run.stderr)
    assert run.returncode == 0, (run.returncode, run.stderr[-2000:])
stores = list((root / "memory").rglob(".state.json"))
assert len(stores) == 1, stores
state = json.loads(stores[0].read_text())
assert state["version"] == 2 and set(state["records"]) == {"package-manager"}, state
assert "content" not in state["records"]["package-manager"]
topic = stores[0].parent / "package-manager.md"
index = stores[0].parent / "MEMORY.md"
assert topic.read_text().startswith("---\nname:") and "type: feedback\n" in topic.read_text()
assert "(package-manager.md)" in index.read_text()
assert not list((root / "memory").rglob("memories.json"))
records = [json.loads(line) for line in trace.read_text().splitlines()]
expected = ["main", "extract", "main", "main", "main", "main"] if file_tools else ["main", "extract", "main"]
assert [item["kind"] for item in records] == expected, records
assert records[1]["tools"] == [], records
assert records[-1]["recalled"] is True and records[0]["recalled"] is False, records
names = {"pmem_list", "pmem_read", "pmem_search", "pmem_save"} | ({"read", "edit", "write"} if file_tools else set())
assert set(records[0]["tools"]) == names, records
installer = "bun" if file_tools else "pnpm"
assert f"Use {installer}, not npm" in topic.read_text()
assert f"Use {installer} [pmem:package-manager]." in (root / f"run-{len(phases)-1}.jsonl").read_text()
if file_tools:
    assert state["records"]["package-manager"]["source"]["origin"] == "file"
report = {"ok": True, "root": str(root), "node": node, "extension": str(extension), "real_pi_processes": len(phases),
          "file_tools": file_tools, "requests": records, "notes": len(state["records"]), "topic": str(topic),
          "isolation": "empty HOME + explicit agent/session/memory dirs; no inherited credentials; discovered extensions/skills/MCP/context disabled; synthetic provider; file tools (if enabled) guarded to current memory"}
(lab / "evidence" / os.environ.get("PI_MEMORY_TEST_REPORT", "cli-smoke.json")).write_text(json.dumps(report, indent=2))
print(json.dumps(report, indent=2))
