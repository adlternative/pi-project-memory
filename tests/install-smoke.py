"""Verify the documented install path: private git package loads and works end to end.

Requires a writable, isolated Pi agent directory. Uses the repository's in-process
synthetic provider, so it makes no network model calls and costs nothing.
"""
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

lab = Path(__file__).resolve().parent.parent
agent = Path(os.environ['PI_CODING_AGENT_DIR']).resolve() if os.environ.get('PI_CODING_AGENT_DIR') else None
source = os.environ.get('PI_MEMORY_INSTALL_SOURCE', 'git:github.com/adlternative/pi-project-memory')
pi = os.environ.get('PI_MEMORY_PI_BIN', 'pi')

if agent is None:
    raise SystemExit('Set PI_CODING_AGENT_DIR to an isolated directory; this test never uses the global Pi home.')
if agent == (Path.home() / '.pi/agent'):
    raise SystemExit('Refusing to run against the real global Pi agent directory.')

run = Path(tempfile.mkdtemp(prefix='install-smoke-', dir=lab / '.sandbox'))
for name in ['project', 'sessions', 'tmp']:
    (run / name).mkdir()
env = {**os.environ, 'PI_CODING_AGENT_DIR': str(agent), 'TMPDIR': str(run / 'tmp'),
       'GIT_CEILING_DIRECTORIES': str(run), 'PI_OFFLINE': '1', 'PI_SKIP_VERSION_CHECK': '1',
       'PI_TELEMETRY': '0', 'GIT_TERMINAL_PROMPT': '0', 'NO_COLOR': '1'}
env.pop('PI_SESSION_ID', None)
env.pop('PI_SESSION_FILE', None)

subprocess.run([pi, 'install', source], env=env, check=True, capture_output=True, text=True, timeout=300)
settings = json.loads((agent / 'settings.json').read_text())
assert source in settings.get('packages', []), settings

settings['projectMemory'] = {'everyNTurns': 1, 'idleFlushSeconds': 0}
(agent / 'settings.json').write_text(json.dumps(settings, indent=2))

listed = subprocess.run([pi, 'list'], env=env, check=True, capture_output=True, text=True, timeout=120).stdout
assert source in listed, listed

# The extension registers three flags; their presence proves the installed package loaded.
help_text = subprocess.run([pi, '--help'], env=env, check=True, capture_output=True, text=True, timeout=120).stdout
for flag in ['--memory-dir', '--memory-auto', '--memory-disabled']:
    assert flag in help_text, f'{flag} missing from `pi --help`'

candidates = [path for path in (agent / 'git').rglob('package.json') if '"pi-project-memory"' in path.read_text()]
assert len(candidates) == 1, candidates
package = candidates[0]
fixture = package.parent / 'tests/provider-fixture.ts'
assert fixture.is_file(), f'Missing in-process provider fixture at {fixture}'

subprocess.run(['git', '-c', 'core.hooksPath=/dev/null', 'init', '--template=', '-q', '-b', 'main'],
               cwd=run / 'project', env={**env, 'GIT_CONFIG_GLOBAL': '/dev/null', 'GIT_CONFIG_NOSYSTEM': '1'}, check=True)
memory = run / 'memory'
trace = run / 'trace.jsonl'
common = [pi, '--no-approve', '-ns', '-np', '-nc', '--no-themes', '--no-mcp', '--no-builtin-tools',
          '--provider', 'memory-test', '--model', 'synthetic', '--mode', 'json',
          '--memory-dir', str(memory), '--session-dir', str(run / 'sessions'), '-e', str(fixture)]
prompts = [
    ['--memory-auto', '--', 'For future work, prefer pnpm instead of npm when installing dependencies.'],
    ['--', 'How should I install dependencies in this project?'],
]
outputs = []
for index, prompt in enumerate(prompts):
    proc = subprocess.run(common + prompt, cwd=run / 'project', env={**env, 'PI_MEMORY_FIXTURE_TRACE': str(trace)},
                          capture_output=True, text=True, timeout=180)
    assert proc.returncode == 0, (index, proc.stderr[-2000:])
    outputs.append(proc.stdout)

stores = list(memory.rglob('.state.json'))
assert len(stores) == 1, stores
topic = stores[0].parent / 'package-manager.md'
assert 'Use pnpm, not npm' in topic.read_text(), topic.read_text()
assert '(package-manager.md)' in (stores[0].parent / 'MEMORY.md').read_text()
assert 'Use pnpm [pmem:package-manager].' in outputs[1], outputs[1][-800:]
assert [json.loads(line)['kind'] for line in trace.read_text().splitlines()] == ['main', 'extract', 'main']

subprocess.run([pi, 'remove', source], env=env, check=True, capture_output=True, text=True, timeout=120)
assert source not in json.loads((agent / 'settings.json').read_text()).get('packages', [])
shutil.rmtree(run, ignore_errors=True)
print(json.dumps({'ok': True, 'source': source, 'installed_and_loaded': True,
                  'wrote_topic': str(topic.name), 'cold_recall': 'Use pnpm [pmem:package-manager].',
                  'removed_cleanly': True}, indent=2))
