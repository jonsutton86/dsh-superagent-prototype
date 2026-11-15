"""Exercise the real privileged library only inside the disposable CI filesystem."""
import importlib.util
import json
import os
from pathlib import Path
import sys
import uuid

spec = importlib.util.spec_from_file_location('agentic_storage', Path(__file__).resolve().parents[2] / 'scripts/agentic_storage.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
root = Path(sys.argv[1])
assert os.environ.get('GITHUB_ACTIONS') == 'true' and str(root).startswith('/tmp/agentic-storage-') and root.name == 'volume'
registry = root.parent / 'registry'
registry.mkdir(mode=0o700)
filesystem = module.run('findmnt', '-n', '-o', 'UUID', '--target', root).strip()
endpoint = str(uuid.uuid4())
config = {'endpointId': endpoint, 'uid': int(sys.argv[2]), 'gid': int(sys.argv[3]), 'policy': {
    'kind': 'linux-xfs-project', 'filesystemUUID': filesystem, 'mountRoot': str(root),
    'projectIds': {'first': 100, 'last': 109}, 'pool': {'bytes': 32 * 1024 ** 2, 'inodes': 256},
    'workspace': {'bytes': 16 * 1024 ** 2, 'inodes': 128}}}
request = {'endpointId': endpoint, 'requestId': 'original', 'requestHash': 'a' * 64, 'workspace': 'one', 'projectId': 100}


def refused(action):
    try:
        action()
    except RuntimeError:
        return
    raise AssertionError('Expected host refusal')


baseline_descriptors = len(list(Path('/proc/self/fd').iterdir()))
host = module.StorageHost(registry, config)
try:
    refused(lambda: host.provision({**request, 'workspace': '../escape'}))
    refused(lambda: host.provision({**request, 'endpointId': str(uuid.uuid4())}))
    refused(lambda: host.provision({**request, 'projectId': 99}))
    assert host.db.execute('SELECT count(*) FROM operations').fetchone()[0] == 0
    original = host.provision(request)
    assert original['quota']['hardBytes'] == 16 * 1024 ** 2
    assert len(original['roots']) == 2
    for path in host.roots(request):
        assert path.stat().st_uid == config['uid'] and path.parent.stat().st_uid == 0
    # Response loss: reopen original root registry; no quota-setting command is allowed on retry.
    host.close()
    host = module.StorageHost(registry, config)
    real_run = module.run
    def read_only(program, *args):
        assert not any(str(arg).startswith(('project -s', 'limit -p')) for arg in args), 'Replayed host mutation'
        return real_run(program, *args)
    module.run = read_only
    assert host.provision(request) == original
    module.run = real_run
    refused(lambda: host.provision({**request, 'requestHash': 'b' * 64}))
    # Registry-wide range collision, even for a different endpoint identity.
    refused(lambda: module.StorageHost(registry, {**config, 'endpointId': str(uuid.uuid4())}))
    # SQLite may retain a shared database descriptor until the other connection closes.
    # The rejected registration must release its own flock handle immediately.
    lock_handles = []
    for descriptor in Path('/proc/self/fd').iterdir():
        try:
            if os.readlink(descriptor) == str(registry / 'host.lock'):
                lock_handles.append(descriptor)
        except FileNotFoundError:
            pass
    assert len(lock_handles) == 1, 'Failed registration retained its host lock handle'
    # Crash after committed intent but before roots: inspection cannot invent success or replay the write.
    second = {**request, 'requestId': 'uncertain', 'workspace': 'two', 'projectId': 101}
    host.db.execute('INSERT INTO operations VALUES (?,?,?,?,?,?,?)', (endpoint, second['requestId'], second['workspace'], filesystem,
        second['projectId'], json.dumps(second, sort_keys=True), '[null,null]'))
    host.db.commit()
    refused(lambda: host.provision(second))
    assert not any(path.exists() for path in host.roots(second))
    refused(lambda: host.provision({**request, 'requestId': 'third', 'workspace': 'three', 'projectId': 102}))
    # A root replacement cannot be adopted even if it is given the same project later.
    path = host.roots(request)[0]
    path.rename(path.with_name('retained-original'))
    path.mkdir(mode=0o700)
    refused(lambda: host.observe(request))
    print(json.dumps({'nativeStorageHost': 'passed', 'replayMutation': False, 'overlapRefused': True,
                      'uncertainIntentRetained': True, 'capacityRetained': True, 'rootReplacementRefused': True}), flush=True)
finally:
    host.close()
    assert len(list(Path('/proc/self/fd').iterdir())) == baseline_descriptors, 'Host descriptors remained after all connections closed'
