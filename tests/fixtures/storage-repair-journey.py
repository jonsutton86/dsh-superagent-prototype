"""Real endpoint request loss, root CLI repair, and original endpoint receipt recovery in disposable CI."""
import json
import os
from pathlib import Path
import selectors
import sqlite3
import subprocess
import sys
import time
import uuid

mount = Path(sys.argv[1])
assert os.environ.get('GITHUB_ACTIONS') == 'true' and os.getuid() == 0
assert str(mount).startswith('/tmp/agentic-storage-') and mount.name == 'volume'
uid, gid = map(int, sys.argv[2:4])
base = mount.parent
registry = base / 'journey-registry'; registry.mkdir(mode=0o700)
exchange = base / 'journey-exchange'; exchange.mkdir(mode=0o700); os.chown(exchange, uid, gid)
config_path, socket_path = base / 'journey.json', base / 'journey.sock'
config = {'endpointId': str(uuid.uuid4()), 'uid': uid, 'gid': gid, 'policy': {
    'kind': 'linux-xfs-project', 'filesystemUUID': subprocess.check_output(['findmnt', '-n', '-o', 'UUID', '--target', str(mount)], text=True).strip(),
    'mountRoot': str(mount), 'projectIds': {'first': 5000, 'last': 5009},
    'pool': {'bytes': 32 * 1024 ** 2, 'inodes': 256}, 'workspace': {'bytes': 16 * 1024 ** 2, 'inodes': 128}}}
def private_json(path, value):
    with os.fdopen(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), 'w') as stream:
        json.dump(value, stream)
private_json(config_path, config)
fault = '''import os,signal,sys
sys.path.insert(0,'scripts')
import agentic_storage as storage
from agentic_storage_service import serve
original=storage.run
def run(program,*args):
 if program=='xfs_quota' and any(str(arg).startswith('project -s -p ') and '/workspaces/socket-one ' in str(arg) for arg in args):
  os.kill(os.getpid(),signal.SIGKILL)
 return original(program,*args)
storage.run=run
serve(*sys.argv[1:])
'''
normal = [sys.executable, '-B', 'scripts/agentic_storage_service.py', '--config', str(config_path), '--registry', str(registry), '--socket', str(socket_path)]
def start(argv):
    process = subprocess.Popen(argv, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    try:
        with selectors.DefaultSelector() as selector:
            selector.register(process.stdout, selectors.EVENT_READ)
            assert selector.select(15) and process.stdout.readline().strip() == 'storage-host-ready'
        return process
    except BaseException:
        process.kill(); process.wait(); raise

def admin(action, value):
    path = base / ('journey-' + action + '.json'); private_json(path, value)
    result = subprocess.run([sys.executable, '-B', 'scripts/agentic_storage_admin.py', '--config', str(config_path), '--registry', str(registry),
        action, '--request' if action == 'inspect' else '--approval', str(path)], capture_output=True, text=True, timeout=20)
    assert result.returncode == 0, result.stderr
    return json.loads(result.stdout)

service = start([sys.executable, '-B', '-c', fault, str(config_path), str(registry), str(socket_path)])
client = None
try:
    env = {'PATH': os.environ['PATH'], 'CI': 'true', 'DSH_STORAGE_SERVICE_CONFIG': json.dumps(config),
           'DSH_STORAGE_SERVICE_SOCKET': str(socket_path), 'DSH_STORAGE_REPAIR_EXCHANGE': str(exchange)}
    client = subprocess.Popen(['node', 'node_modules/vitest/vitest.mjs', 'run', 'tests/storage-host-client.spec.ts', '--no-cache'],
        user=uid, group=gid, extra_groups=[], env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    deadline = time.monotonic() + 30
    while not (exchange / 'ready').exists() and time.monotonic() < deadline and client.poll() is None:
        time.sleep(.1)
    if not (exchange / 'ready').exists():
        if client.poll() is not None:
            stdout, stderr = client.communicate(); print(stdout, flush=True)
            raise AssertionError('Endpoint did not preserve failed provisioning: ' + stderr)
        raise AssertionError('Endpoint did not preserve failed provisioning before the fixture deadline')
    service.wait(timeout=10); assert service.returncode == -9
    with sqlite3.connect((registry / 'host.sqlite').as_uri() + '?mode=ro', uri=True) as database:
        request = json.loads(database.execute('SELECT intent FROM operations WHERE endpoint=? AND request=?',
            (config['endpointId'], 'socket-original')).fetchone()[0])
    assert request['workspace'] == 'socket-one' and request['projectId'] == 5001
    inspected = admin('inspect', request)['inspection']
    assert [item['state'] for item in inspected['roots']] == ['recorded', 'missing']
    admin('repair', {'request': request, 'repairId': 'operator-original', 'snapshotHash': inspected['snapshotHash']})
    service = start(normal)
    (exchange / 'done').write_text('repaired'); (exchange / 'done').chmod(0o644)
    stdout, stderr = client.communicate(timeout=90)
    print(stdout, flush=True)
    assert client.returncode == 0, stderr
    with sqlite3.connect((registry / 'host.sqlite').as_uri() + '?mode=ro', uri=True) as database:
        assert database.execute('SELECT count(*) FROM operations WHERE endpoint=?', (config['endpointId'],)).fetchone()[0] == 2
        assert database.execute('SELECT id,request,phase FROM repairs WHERE endpoint=?', (config['endpointId'],)).fetchall() == [('operator-original', 'socket-original', 'complete')]
    print(json.dumps({'nativeStorageRepairJourney': 'passed', 'originalEndpointIntentRetained': True,
                      'rootOperatorRepair': True, 'endpointRestartAndOriginalGrantRecovery': True, 'duplicateAllocation': False}), flush=True)
finally:
    if client is not None and client.poll() is None:
        client.kill(); client.wait()
    if service.poll() is None:
        service.terminate()
        try:
            service.wait(timeout=15)
        except subprocess.TimeoutExpired:
            service.kill(); service.wait(); raise AssertionError('Repair journey service did not stop')
