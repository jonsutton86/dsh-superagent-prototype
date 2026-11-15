"""SIGKILL at real provisioning boundaries on disposable XFS; fault hooks exist only in this fixture."""
import json
import os
from pathlib import Path
import signal
import sys
import uuid

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'scripts'))
import agentic_storage as storage

mount = Path(sys.argv[1])
assert os.environ.get('GITHUB_ACTIONS') == 'true' and os.getuid() == 0
assert str(mount).startswith('/tmp/agentic-storage-') and mount.name == 'volume'
uid, gid = map(int, sys.argv[2:4])
registry = mount.parent / 'crash-registry'; registry.mkdir(mode=0o700)
filesystem = storage.run('findmnt', '-n', '-o', 'UUID', '--target', mount).strip()
cases = ['intent-committed', 'first-root-created', 'first-root-recorded', 'first-project-applied',
         'second-project-applied', 'hard-limit-applied', 'first-owner-applied', 'complete-before-reply']
results = []
for index, boundary in enumerate(cases):
    first = 4000 + 20 * index
    config = {'endpointId': str(uuid.uuid4()), 'uid': uid, 'gid': gid, 'policy': {
        'kind': 'linux-xfs-project', 'filesystemUUID': filesystem, 'mountRoot': str(mount),
        'projectIds': {'first': first, 'last': first + 9}, 'pool': {'bytes': 32 * 1024 ** 2, 'inodes': 256},
        'workspace': {'bytes': 16 * 1024 ** 2, 'inodes': 128}}}
    request = {'endpointId': config['endpointId'], 'requestId': 'original', 'requestHash': 'a' * 64,
               'workspace': 'original-work', 'projectId': first}
    host = storage.StorageHost(registry, config)
    roots = host.roots(request)
    host.close()  # Fork with no inherited database/lock connection.
    pid = os.fork()
    if pid == 0:
        try:
            host = storage.StorageHost(registry, config)
            run, mkdir, chown, observe = storage.run, Path.mkdir, os.chown, host._observe
            def crash():
                os.kill(os.getpid(), signal.SIGKILL)
            def mkdir_hook(path, *args, **kwargs):
                if path == roots[0] and boundary == 'intent-committed': crash()
                result = mkdir(path, *args, **kwargs)
                if path == roots[0] and boundary == 'first-root-created': crash()
                return result
            projects = [0]
            def run_hook(program, *args):
                project = program == 'xfs_quota' and any(str(arg).startswith('project -s ') for arg in args)
                limit = program == 'xfs_quota' and any(str(arg).startswith('limit -p ') for arg in args)
                if project and boundary == 'first-root-recorded' and projects[0] == 0: crash()
                result = run(program, *args)
                if project:
                    projects[0] += 1
                    if boundary == 'first-project-applied' and projects[0] == 1: crash()
                    if boundary == 'second-project-applied' and projects[0] == 2: crash()
                if limit and boundary == 'hard-limit-applied': crash()
                return result
            def chown_hook(path, *args, **kwargs):
                result = chown(path, *args, **kwargs)
                if path == roots[0] and boundary == 'first-owner-applied': crash()
                return result
            def observe_hook(value):
                result = observe(value)
                if boundary == 'complete-before-reply': crash()
                return result
            Path.mkdir = mkdir_hook; storage.run = run_hook; os.chown = chown_hook; host._observe = observe_hook
            host.provision(request)
        except BaseException:
            os._exit(2)
        os._exit(3)  # Missing fault hook must never be mistaken for a passing crash test.
    waited, status = os.waitpid(pid, 0)
    assert waited == pid and os.WIFSIGNALED(status) and os.WTERMSIG(status) == signal.SIGKILL, (boundary, status)
    host = storage.StorageHost(registry, config)
    try:
        row = host.db.execute('SELECT intent, roots FROM operations WHERE endpoint=? AND request=?',
                              (config['endpointId'], 'original')).fetchone()
        assert row and json.loads(row[0]) == request
        saved = list(host.db.iterdump())
        evidence = host.inspect(request)
        assert evidence['request'] == request and evidence['authorizesRepair'] is False
        assert len(evidence['snapshotHash']) == 64
        assert list(host.db.iterdump()) == saved
        states = [item['state'] for item in evidence['roots']]
        if boundary == 'intent-committed': assert states == ['missing', 'missing']
        elif boundary == 'first-root-created': assert states == ['unrecorded', 'missing']
        elif boundary in ['first-root-recorded', 'first-project-applied']: assert states == ['recorded', 'missing']
        else: assert states == ['recorded', 'recorded']
        if boundary == 'first-root-recorded': assert evidence['roots'][0]['projectId'] != first
        if boundary == 'first-owner-applied': assert [item['uid'] for item in evidence['roots']] == [uid, 0]
        if boundary in ['hard-limit-applied', 'first-owner-applied', 'complete-before-reply']:
            assert evidence['quota']['hardBytes'] == config['policy']['workspace']['bytes']
        assert host.inspect(request)['snapshotHash'] == evidence['snapshotHash']

        identities = [(str(path), path.stat().st_ino, path.stat().st_uid) for path in roots if path.exists()]
        original_run = storage.run
        def read_only(program, *args):
            assert not (program == 'xfs_quota' and any(str(arg).startswith(('project -s ', 'limit -p ')) for arg in args)), 'Replayed host effect'
            return original_run(program, *args)
        storage.run = read_only
        try:
            for action in [host.observe, host.provision]:
                try:
                    result = action(request)
                    assert boundary == 'complete-before-reply', 'Partial provisioning accepted'
                    assert result['projectId'] == first
                except RuntimeError:
                    assert boundary != 'complete-before-reply', 'Completed effect could not be observed'
            try:
                host.provision({**request, 'requestHash': 'b' * 64})
                raise AssertionError('Original operation identity replaced')
            except RuntimeError:
                pass
        finally:
            storage.run = original_run
        assert list(host.db.iterdump()) == saved
        assert [(str(path), path.stat().st_ino, path.stat().st_uid) for path in roots if path.exists()] == identities
        # The interrupted or completed original occupies its allocation; only one more fits this pool.
        host.provision({**request, 'requestId': 'second', 'workspace': 'second', 'projectId': first + 1})
        try:
            host.provision({**request, 'requestId': 'third', 'workspace': 'third', 'projectId': first + 2})
            raise AssertionError('Uncertain allocation was treated as free capacity')
        except RuntimeError:
            pass
        assert host.db.execute('SELECT count(*) FROM operations WHERE endpoint=?', (config['endpointId'],)).fetchone()[0] == 2
        results.append({'boundary': boundary, 'originalIntentRetained': True, 'mutationReplay': False,
                        'observation': 'verified' if boundary == 'complete-before-reply' else 'refused-incomplete', 'capacityRetained': True, 'inspectionStates': states, 'inspectionReadOnly': True})
    finally:
        host.close()
print(json.dumps({'nativeStorageCrashBoundaries': results}), flush=True)
