"""Real-model memory E2E over a tiny Node project. Every phase is a fresh Pi process."""
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import subprocess
import tempfile
import time

lab = Path(__file__).resolve().parents[2]
root = Path(tempfile.mkdtemp(prefix='live-project-', dir=lab / '.sandbox')).resolve()
node = os.environ.get('PI_MEMORY_TEST_NODE') or shutil.which('node')
model = os.environ.get('PI_MEMORY_LIVE_MODEL', 'gpt-6.1-sol')
auth = Path(os.environ.get('PI_MEMORY_AUTH_PATH', str(Path.home() / '.pi/agent/auth.json'))).resolve()
nonce = secrets.token_hex(4)
old_label, new_label = 'olive-' + nonce, 'cedar-' + secrets.token_hex(4)
nickname, review_group = 'wren-' + secrets.token_hex(4), 'maple-' + secrets.token_hex(4)
ask = 'Look up existing cross-session memory for this project and report the current demo batch label and project nickname. Use null for missing values; do not guess from directory or project names. Return only a JSON object with exactly the keys "batchLabel" and "nickname".'
for name in ['home', 'tmp', 'memory', 'results']:
    (root / name).mkdir()
for project in ['project-a', 'project-b']:
    shutil.copytree(lab / 'e2e/fixtures/tiny-invoice', root / project)
    subprocess.run(['git', '-c', 'core.hooksPath=/dev/null', 'init', '--template=', '-q', '-b', 'main', str(root / project)], env={**os.environ, 'GIT_CONFIG_GLOBAL': '/dev/null', 'GIT_CONFIG_NOSYSTEM': '1'}, check=True, capture_output=True)
    checks = root / ('checks-' + project)
    checks.mkdir()
    (checks / 'package.json').write_text('{"type":"module"}\n')
    source = (root / project / 'quote.test.js').read_text()
    (checks / 'quote.test.js').write_text(source.replace('"./quote.js"', json.dumps(str(root / project / 'quote.js'))))
(root / 'outside-sentinel.txt').write_text('DO NOT TOUCH\n')
(root / 'project-a/sandbox-probe.js').write_text('''import fs from 'node:fs';
import assert from 'node:assert/strict';
const path=process.argv[2];
assert.throws(()=>fs.readFileSync(path));
assert.throws(()=>fs.writeFileSync(path,'BAD'));
assert.throws(()=>fs.linkSync(path,new URL('./forbidden-link',import.meta.url)));
assert.throws(()=>fs.writeFileSync(new URL('./forbidden-output',import.meta.url),'BAD'));
console.log('SANDBOX_OK');
''')

stages = [
    {'name': 'sandbox-probe', 'project': 'project-a', 'mode': 'work', 'prompt': ''},
    {'name': 'project-baseline', 'project': 'project-a', 'mode': 'work', 'prompt': ''},
    {'name': 'seed', 'project': 'project-a', 'mode': 'work', 'auto': True, 'prompt': f'Read README and the tests, then run project tests to confirm the baseline. For future work, the demo batch label is fixed at {old_label}; the project nickname is {nickname}. These are cross-session collaboration conventions, not business data. Remember them in separate topics for later updates. Do not put the label or nickname in source, tests, or README, and do not change business code. Report briefly.'},
    {'name': 'project-red', 'project': 'project-a', 'mode': 'work', 'prompt': ''},
    {'name': 'cold-task', 'project': 'project-a', 'mode': 'work', 'editSource': True, 'prompt': 'Add a shippingCents option to quote: default 0, require a nonnegative safe integer, add it to totalCents after the discount, and reject final-total overflow. Modify only quote.js; the tests are ready. Run project tests afterward. Follow existing project conventions and do not put collaboration labels in business files. On the final line, return a JSON object with exactly "batchLabel" and "nickname", using the current values recalled from memory or null when unknown.'},
    {'name': 'update', 'project': 'project-a', 'mode': 'work', 'prompt': f'Change this project collaboration convention: from now on the demo batch label is {new_label}. Replace the old value directly in the corresponding topic Markdown without retaining the old label or a historical explanation. Keep the nickname and other memories unchanged. Do not modify business source, tests, or README.'},
    {'name': 'cold-updated', 'project': 'project-a', 'mode': 'recall', 'prompt': ask},
    {'name': 'semantic', 'project': 'project-a', 'mode': 'recall', 'prompt': 'Use pmem_search in semantic mode to retrieve "the tag used for groups of demo orders" and "what the team calls this little app", then report their current values using only project memory. Do not guess. Return only a JSON object with exactly "batchLabel" and "nickname", using null for missing values.'},
    {'name': 'disabled-control', 'project': 'project-a', 'mode': 'disabled', 'prompt': ask},
    {'name': 'other-project', 'project': 'project-b', 'mode': 'recall', 'prompt': ask},
    {'name': 'forget', 'project': 'project-a', 'mode': 'forget', 'prompt': '', 'forgetIds': []},
    {'name': 'after-forget', 'project': 'project-a', 'mode': 'recall', 'prompt': ask},
    {'name': 'auto', 'project': 'project-a', 'mode': 'auto', 'auto': True, 'prompt': f'From now on, review cards for this project belong to group {review_group}. This is a future collaboration workflow, not business configuration, and requires no code change. For this turn, only run project tests and give a one-line result.'},
    {'name': 'cold-auto', 'project': 'project-a', 'mode': 'recall', 'prompt': 'Look up existing cross-session memory: which group should future review cards for this project use? Return only a JSON object with exactly the key "reviewGroup". Use null if there is no record; do not guess.'},
    {'name': 'project-final', 'project': 'project-a', 'mode': 'work', 'prompt': ''},
]
config = {'modelId': model, 'authPath': str(auth), 'stages': stages}
config_path = root / 'config.json'
config_path.write_text(json.dumps(config, ensure_ascii=False, indent=2))
summary = {'ok': False, 'root': str(root), 'model': 'openai-codex/' + model, 'provider': 'real built-in provider, no mock', 'checks': [], 'startedAt': time.time()}
(root / 'summary.json').write_text(json.dumps(summary, indent=2))
print('Live E2E root:', root, flush=True)


def answer(report):
    matches = re.findall(r'\{[^{}]*(?:"batchLabel"|"reviewGroup")[^{}]*\}', report['response'])
    assert matches, ('No structured answer', report['stage'], report['response'])
    return json.loads(matches[-1])


def no_business_canaries():
    for project in ['project-a', 'project-b']:
        for name in ['quote.js', 'quote.test.js', 'README.md', 'package.json']:
            text = (root / project / name).read_text()
            assert not any(value in text for value in [old_label, new_label, nickname, review_group]), ('Collaboration fact leaked to source', project, name)


def check(name, value=True):
    assert value, name
    summary['checks'].append(name)
    print('PASS:', name, flush=True)
    (root / 'summary.json').write_text(json.dumps(summary, ensure_ascii=False, indent=2))


reports = {}
try:
    for stage in stages:
        if stage['name'] == 'project-red':
            public = root / 'project-a/quote.test.js'
            public.write_text(public.read_text() + (lab / 'e2e/live/shipping.fragment.js').read_text())
            (root / 'checks-project-a/quote.test.js').write_text(public.read_text().replace('"./quote.js"', json.dumps(str(root / 'project-a/quote.js'))))
        if stage['name'] == 'forget':
            targets = [note['id'] for note in reports['cold-updated']['memory']['notes'] if new_label in note['content']]
            assert targets, 'No batch-label topic to forget'
            stage['forgetIds'] = targets
            config_path.write_text(json.dumps(config, ensure_ascii=False, indent=2))
        env = {'PATH': os.environ.get('PATH', '/usr/bin:/bin'), 'HOME': str(root / 'home'), 'TMPDIR': str(root / 'tmp'),
               'PI_CODING_AGENT_DIR': str(root / 'agents' / stage['name']), 'PI_OFFLINE': '1', 'PI_SKIP_VERSION_CHECK': '1', 'PI_TELEMETRY': '0',
               'GIT_CEILING_DIRECTORIES': str(root), 'NO_COLOR': '1'}
        cert = auth.parent / 'certs/alilang-root-ca-g2.pem'
        if cert.exists(): env['NODE_EXTRA_CA_CERTS'] = str(cert)
        for name in ['HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY']:
            if os.environ.get(name): env[name] = os.environ[name]
        run = subprocess.run([node, '--experimental-strip-types', str(lab / 'e2e/live/worker.ts'), str(root), stage['name']], cwd=lab, env=env, capture_output=True, text=True, timeout=130)
        output = root / 'results' / stage['name']
        (output / 'stdout.log').write_text(run.stdout)
        (output / 'stderr.log').write_text(run.stderr)
        assert run.returncode == 0, ('Worker failed', stage['name'], run.stdout[-1000:], 'see local stderr')
        report = json.loads((output / 'result.json').read_text())
        reports[stage['name']] = report
        if stage['name'] == 'sandbox-probe': check('OS sandbox blocks outside reads, all writes, and hardlinks', report['ok'])
        elif stage['name'] in ['project-baseline', 'project-final']: check(stage['name'] + ': real Node project tests pass', report['ok'])
        elif stage['name'] == 'project-red': check('new shipping tests fail before the live model implements the feature', not report['ok'])
        elif stage['name'] == 'seed':
            notes = report['memory']['notes']
            batch = [n for n in notes if old_label in n['content']]
            nick = [n for n in notes if nickname in n['content']]
            check('real model saves two collaboration facts in distinct Markdown topics', bool(batch and nick and batch[0]['id'] != nick[0]['id']))
            check('real model used sandboxed project tests', any(e.get('name') == 'run_project_tests' for e in report['events']))
        elif stage['name'] == 'cold-task':
            check('cold coding session recovers facts without being told their values', answer(report) == {'batchLabel': old_label, 'nickname': nickname})
            check('live model edited the real project and ran tests', any(e.get('name') in ['edit', 'write'] and e.get('input', {}).get('path', '').endswith('quote.js') for e in report['events']) and any(e.get('name') == 'run_project_tests' for e in report['events']))
        elif stage['name'] == 'update': check('batch label updated without retaining the old active value', any(new_label in n['content'] for n in report['memory']['notes']) and all(old_label not in n['content'] for n in report['memory']['notes']))
        elif stage['name'] in ['cold-updated', 'semantic']:
            check(stage['name'] + ': new label wins and unrelated nickname survives', answer(report) == {'batchLabel': new_label, 'nickname': nickname})
            if stage['name'] == 'semantic':
                returned = []
                for line in Path(report['sessionFile']).read_text().splitlines():
                    message = json.loads(line).get('message', {})
                    if message.get('role') == 'toolResult' and message.get('toolName') == 'pmem_search' and not message.get('isError'):
                        text = '\n'.join(part.get('text', '') for part in message.get('content', []) if part.get('type') == 'text')
                        returned += json.loads(text).get('notes', [])
                check('semantic selection actually invokes the live nested model', bool(report['nestedUsage']) and any(e.get('name') == 'pmem_search' and e.get('input', {}).get('mode') == 'semantic' for e in report['events']) and any(new_label in note['content'] for note in returned) and any(nickname in note['content'] for note in returned))
        elif stage['name'] in ['disabled-control', 'other-project']: check(stage['name'] + ': no cross-session facts available', answer(report) == {'batchLabel': None, 'nickname': None})
        elif stage['name'] == 'after-forget': check('fresh session no longer recovers forgotten label; other topic survives', answer(report) == {'batchLabel': None, 'nickname': nickname})
        elif stage['name'] == 'auto': check('a genuine no-write user turn is distilled by the live extraction model', any(review_group in n['content'] and n['source']['origin'] == 'extracted' for n in report['memory']['notes']) and any(x.get('status') == 'ok' and x.get('saved') for x in report['extractions']))
        elif stage['name'] == 'cold-auto': check('new session recalls the automatically extracted collaboration group', answer(report) == {'reviewGroup': review_group})
        no_business_canaries()
    usages = []
    for report in reports.values():
        usages += report.get('mainUsage', []) + report.get('nestedUsage', [])
        usages += [item['usage'] for item in report.get('extractions', []) if item.get('usage')]
    summary.update(ok=True, finishedAt=time.time(), phases=len(stages), totalTokens=sum(u.get('totalTokens', 0) for u in usages), catalogCostEstimate=sum(u.get('cost', {}).get('total', 0) for u in usages), authMutationAttempts=sum(r.get('auth', {}).get('mutationAttempts', 0) for r in reports.values()))
except Exception as error:
    summary.update(ok=False, failedStage=stage['name'], failure=str(error)[:1600], finishedAt=time.time())
finally:
    (root / 'summary.json').write_text(json.dumps(summary, ensure_ascii=False, indent=2))
    (lab / 'evidence/live-micro-project.json').write_text(json.dumps(summary, ensure_ascii=False, indent=2))
    print(json.dumps(summary, ensure_ascii=False, indent=2), flush=True)
if not summary['ok']:
    raise SystemExit(1)
