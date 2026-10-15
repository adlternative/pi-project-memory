"""Compare Pi configuration/extension fingerprints without exposing file contents."""
from pathlib import Path
import hashlib
import json
import os

lab = Path(__file__).resolve().parent.parent
root = Path(os.environ.get('PI_CODING_AGENT_DIR', str(Path.home() / '.pi/agent'))).expanduser()
names = ['settings.json', 'models.json', 'auth.json', 'trust.json', 'mcp.json', 'AGENTS.md', 'CLAUDE.md', 'SYSTEM.md', 'APPEND_SYSTEM.md']
actual = {}
for name in names:
    path = root / name
    actual[name] = hashlib.sha256(path.read_bytes()).hexdigest() if path.is_file() else None
extension_root = root / 'extensions'
if extension_root.exists():
    for path in sorted(extension_root.rglob('*')):
        if path.is_symlink():
            actual[str(path.relative_to(root))] = 'symlink:' + str(path.readlink())
        elif path.is_file():
            actual[str(path.relative_to(root))] = hashlib.sha256(path.read_bytes()).hexdigest()
baseline = lab / 'evidence/global-pi-before.json'
if not baseline.is_file():
    raise SystemExit('No local pre-experiment fingerprint; this optional audit requires your own baseline (not committed).')
before = json.loads(baseline.read_text())
changed = sorted(key for key in before.keys() | actual.keys() if before.get(key) != actual.get(key))
report = {'ok': not changed, 'checked_entries': len(actual), 'changed': changed,
          'scope': 'global Pi config and extensions only; live session/history/cache activity is intentionally excluded'}
(lab / 'evidence/global-pi-after.json').write_text(json.dumps(actual, indent=2))
(lab / 'evidence/isolation-check.json').write_text(json.dumps(report, indent=2))
print(json.dumps(report, indent=2))
if changed:
    raise SystemExit(1)
