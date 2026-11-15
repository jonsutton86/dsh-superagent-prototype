"""SIGKILL at real provisioning boundaries on disposable XFS; fault hooks exist only in this fixture."""
import json
import os
from pathlib import Path
import signal
import subprocess
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
         'second-project-applied', 'hard-limit-applied', 'first-owner-applied', 'complete-before-reply',
         'repair-before-ownership', 'repair-complete-before-reply', 'repair-finish-first-owner', 'repair-finish-complete']
results = []
for index, boundary in enumerate(cases):
    killpoint = 'intent-committed' if boundary.startswith('repair-') else boundary
    first = 4000 + 20 * index
    config = {'endpointId': str(uuid.uuid4()), 'uid': uid, 'gid': gid, 'policy': {
        'kind': 'linux-xfs-project', 'filesystemUUID': filesystem, 'mountRoot': str(mount),
        'projectIds': {'first': first, 'last': first + 9}, 'pool': {'bytes': 32 * 1024 ** 2, 'inodes': 256},
        'workspace': {'bytes': 16 * 1024 ** 2, 'inodes': 128}}}
    request = {'endpointId': config['endpointId'], 'requestId': 'original', 'requestHash': 'a' * 64,
               'workspace': 'original-work', 'projectId': first}
    config_path = mount.parent / (boundary + '-config.json')
    with os.fdopen(os.open(config_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), 'w') as stream:
        json.dump(config, stream)
    serial = [0]
    def admin(action, value, expected_code=0, target_registry=registry):
        serial[0] += 1
        input_path = mount.parent / (boundary + '-input-' + str(serial[0]) + '.json')
        with os.fdopen(os.open(input_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), 'w') as stream:
            json.dump(value, stream)
        command = [sys.executable, '-B', 'scripts/agentic_storage_admin.py', '--config', str(config_path),
                   '--registry', str(target_registry), action, '--request' if action == 'inspect' else '--approval', str(input_path)]
        result = subprocess.run(command, capture_output=True, text=True, timeout=20)
        assert result.returncode == expected_code, (boundary, result.stderr)
        return json.loads(result.stdout if result.returncode == 0 else result.stderr)
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
                if path == roots[0] and killpoint == 'intent-committed': crash()
                result = mkdir(path, *args, **kwargs)
                if path == roots[0] and killpoint == 'first-root-created': crash()
                return result
            projects = [0]
            def run_hook(program, *args):
                project = program == 'xfs_quota' and any(str(arg).startswith('project -s ') for arg in args)
                limit = program == 'xfs_quota' and any(str(arg).startswith('limit -p ') for arg in args)
                if project and killpoint == 'first-root-recorded' and projects[0] == 0: crash()
                result = run(program, *args)
                if project:
                    projects[0] += 1
                    if killpoint == 'first-project-applied' and projects[0] == 1: crash()
                    if killpoint == 'second-project-applied' and projects[0] == 2: crash()
                if limit and killpoint == 'hard-limit-applied': crash()
                return result
            def chown_hook(path, *args, **kwargs):
                result = chown(path, *args, **kwargs)
                if path == roots[0] and killpoint == 'first-owner-applied': crash()
                return result
            def observe_hook(value):
                result = observe(value)
                if killpoint == 'complete-before-reply': crash()
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
        if killpoint == 'intent-committed': assert states == ['missing', 'missing']
        elif boundary == 'first-root-created': assert states == ['unrecorded', 'missing']
        elif boundary in ['first-root-recorded', 'first-project-applied']: assert states == ['recorded', 'missing']
        else: assert states == ['recorded', 'recorded']
        if boundary == 'first-root-recorded': assert evidence['roots'][0]['projectId'] != first
        if boundary == 'first-owner-applied': assert [item['uid'] for item in evidence['roots']] == [uid, 0]
        if boundary in ['hard-limit-applied', 'first-owner-applied', 'complete-before-reply']:
            assert evidence['quota']['hardBytes'] == config['policy']['workspace']['bytes']
        assert evidence['repair'] is None
        assert host.inspect(request)['snapshotHash'] == evidence['snapshotHash']
        assert admin('inspect', request)['inspection']['snapshotHash'] == evidence['snapshotHash']
        assert list(host.db.iterdump()) == saved

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
        # Explicit repair is a separate intent bound to fresh evidence; it is not an original-request retry.
        repairable = not boundary.startswith('repair-') and boundary not in ['first-root-created', 'first-owner-applied', 'complete-before-reply']
        before_repair = list(host.db.iterdump())
        try:
            host.repair(request, 'repair', 'f' * 64)
            raise AssertionError('Stale repair evidence accepted')
        except RuntimeError:
            pass
        assert list(host.db.iterdump()) == before_repair
        if boundary.startswith('repair-'):
            host.close()
            repair_pid = os.fork()
            if repair_pid == 0:
                try:
                    repairing = storage.StorageHost(registry, config)
                    effect, completed = storage.run, repairing._observe
                    def interrupted_effect(program, *args):
                        result = effect(program, *args)
                        if boundary != 'repair-complete-before-reply' and program == 'xfs_quota' and any(str(arg).startswith('limit -p ') for arg in args):
                            os.kill(os.getpid(), signal.SIGKILL)
                        return result
                    def interrupted_reply(value):
                        result = completed(value)
                        if boundary == 'repair-complete-before-reply': os.kill(os.getpid(), signal.SIGKILL)
                        return result
                    storage.run = interrupted_effect; repairing._observe = interrupted_reply
                    repairing.repair(request, 'repair', evidence['snapshotHash'])
                except BaseException:
                    os._exit(2)
                os._exit(3)
            _, repair_status = os.waitpid(repair_pid, 0)
            assert os.WIFSIGNALED(repair_status) and os.WTERMSIG(repair_status) == signal.SIGKILL
            host = storage.StorageHost(registry, config)
            assert host.db.execute('SELECT phase FROM repairs WHERE endpoint=?', (config['endpointId'],)).fetchone()[0] == 'started'
            before_inspect = list(host.db.iterdump())
            inspected_repair = admin('inspect', request)['inspection']['repair']
            assert inspected_repair == {'repairId': 'repair', 'phase': 'started', 'originalSnapshotHash': evidence['snapshotHash']}
            assert list(host.db.iterdump()) == before_inspect
            storage.run = read_only
            try:
                if boundary == 'repair-complete-before-reply':
                    assert host.repair(request, 'repair', evidence['snapshotHash'])['projectId'] == first
                    assert host.db.execute('SELECT phase FROM repairs WHERE endpoint=?', (config['endpointId'],)).fetchone()[0] == 'complete'
                else:
                    saved_repair = list(host.db.iterdump())
                    try:
                        host.repair(request, 'repair', evidence['snapshotHash'])
                        raise AssertionError('Incomplete repair replayed')
                    except RuntimeError:
                        pass
                    assert list(host.db.iterdump()) == saved_repair
                try:
                    host.repair(request, 'replacement-repair', host.inspect(request)['snapshotHash'])
                    raise AssertionError('New ID bypassed original repair intent')
                except RuntimeError:
                    pass
            finally:
                storage.run = original_run
            if boundary != 'repair-complete-before-reply':
                fresh = admin('inspect', request)['inspection']['snapshotHash']
                approval = {'request': request, 'repairId': 'repair', 'snapshotHash': evidence['snapshotHash'], 'finishSnapshotHash': fresh}
                before_finish = list(host.db.iterdump())
                assert admin('finish-repair', {**approval, 'repairId': 'replacement'}, expected_code=1)['state'] == 'unverified'
                assert admin('finish-repair', {**approval, 'snapshotHash': 'f' * 64}, expected_code=1)['state'] == 'unverified'
                assert admin('finish-repair', {**approval, 'finishSnapshotHash': 'f' * 64}, expected_code=1)['state'] == 'unverified'
                assert list(host.db.iterdump()) == before_finish
                if boundary.startswith('repair-finish-'):
                    host.close()
                    finishing_pid = os.fork()
                    if finishing_pid == 0:
                        try:
                            finishing = storage.StorageHost(registry, config)
                            handoff, observation = os.chown, finishing._observe
                            def killed_handoff(path, *args):
                                handoff(path, *args)
                                if boundary == 'repair-finish-first-owner': os.kill(os.getpid(), signal.SIGKILL)
                            def killed_observation(value):
                                result = observation(value)
                                if boundary == 'repair-finish-complete': os.kill(os.getpid(), signal.SIGKILL)
                                return result
                            os.chown = killed_handoff; finishing._observe = killed_observation
                            finishing.finish_repair(request, 'repair', evidence['snapshotHash'], fresh)
                        except BaseException:
                            os._exit(2)
                        os._exit(3)
                    _, finish_status = os.waitpid(finishing_pid, 0)
                    assert os.WIFSIGNALED(finish_status) and os.WTERMSIG(finish_status) == signal.SIGKILL
                    host = storage.StorageHost(registry, config)
                    assert host.repair_receipt(request)['phase'] == 'finishing'
                if boundary == 'repair-finish-first-owner':
                    retained_finish = list(host.db.iterdump())
                    assert admin('finish-repair', approval, expected_code=1)['state'] == 'unverified'
                    assert list(host.db.iterdump()) == retained_finish
                    assert [path.stat().st_uid for path in roots] == [uid, 0]
                else:
                    assert admin('finish-repair', approval)['observation']['projectId'] == first
                    assert host.repair_receipt(request)['phase'] == 'complete'
                    # Repeated handoff approval and original repair replay only observe; inode/ctime unchanged.
                    metadata = [(path.stat().st_ino, path.stat().st_ctime_ns) for path in roots]
                    assert admin('finish-repair', approval)['observation']['projectId'] == first
                    assert host.repair(request, 'repair', evidence['snapshotHash'])['projectId'] == first
                    assert [(path.stat().st_ino, path.stat().st_ctime_ns) for path in roots] == metadata
                assert host.repair_receipt(request)['finishSnapshotHash'] == fresh
                assert admin('finish-repair', {**approval, 'finishSnapshotHash': host.inspect(request)['snapshotHash']}, expected_code=1)['state'] == 'unverified'
        elif repairable:
            fixed = admin('repair', {'request': request, 'repairId': 'repair', 'snapshotHash': evidence['snapshotHash']})['observation']
            assert fixed['projectId'] == first and host.saved(request) == fixed['roots']
            assert json.loads(host.db.execute('SELECT intent FROM operations WHERE endpoint=? AND request=?',
                (config['endpointId'], 'original')).fetchone()[0]) == request
            storage.run = read_only
            try:
                assert host.repair(request, 'repair', evidence['snapshotHash'])['roots'] == fixed['roots']
            finally:
                storage.run = original_run
            assert host.db.execute('SELECT phase FROM repairs WHERE endpoint=?', (config['endpointId'],)).fetchone()[0] == 'complete'
        else:
            try:
                host.repair(request, 'repair', evidence['snapshotHash'])
                raise AssertionError('Unsafe repair admitted')
            except RuntimeError:
                pass
            assert list(host.db.iterdump()) == before_repair
        # The interrupted or completed original occupies its allocation; only one more fits this pool.
        host.provision({**request, 'requestId': 'second', 'workspace': 'second', 'projectId': first + 1})
        try:
            host.provision({**request, 'requestId': 'third', 'workspace': 'third', 'projectId': first + 2})
            raise AssertionError('Uncertain allocation was treated as free capacity')
        except RuntimeError:
            pass
        assert host.db.execute('SELECT count(*) FROM operations WHERE endpoint=?', (config['endpointId'],)).fetchone()[0] == 2
        results.append({'boundary': boundary, 'originalIntentRetained': True, 'mutationReplay': False,
                        'observation': 'verified' if boundary == 'complete-before-reply' else 'refused-incomplete', 'capacityRetained': True, 'inspectionStates': states, 'inspectionReadOnly': True, 'operatorInspection': True, 'explicitRepair': ('interrupted-replay-verified' if boundary.startswith('repair-') else 'verified' if repairable else 'refused')})
    finally:
        host.close()
empty_registry = mount.parent / 'missing-operator-registry'; empty_registry.mkdir(mode=0o700)
assert admin('inspect', request, expected_code=1, target_registry=empty_registry)['state'] == 'unverified'
assert list(empty_registry.iterdir()) == [], 'Inspection initialized a missing registry'
# Snapshot the shared registry, including all endpoints and unresolved finishing receipts.
backup_dir = mount.parent / 'registry-backup'; backup_dir.mkdir(mode=0o700)
backup_path = backup_dir / 'host.sqlite'
backup_command = [sys.executable, '-B', 'scripts/agentic_storage_admin.py', '--config', str(config_path),
                  '--registry', str(registry), 'backup', '--output', str(backup_path)]
backup = subprocess.run(backup_command, capture_output=True, text=True, timeout=30)
assert backup.returncode == 0, backup.stderr
receipt = json.loads(backup.stdout)['backup']
import hashlib
import sqlite3
assert receipt['sha256'] == hashlib.sha256(backup_path.read_bytes()).hexdigest()
assert receipt['workspaceFilesIncluded'] is False and receipt['restoreVerified'] is False
assert backup_path.stat().st_uid == 0 and backup_path.stat().st_mode & 0o777 == 0o600
with sqlite3.connect((registry / 'host.sqlite').as_uri() + '?mode=ro', uri=True) as original_db, sqlite3.connect(backup_path) as backup_db:
    assert list(original_db.iterdump()) == list(backup_db.iterdump())
    assert backup_db.execute("SELECT count(*) FROM repairs WHERE phase='finishing'").fetchone()[0] == 1
    assert receipt['records']['endpoints'] == len(cases)
    assert receipt['records']['operations'] == 2 * len(cases)
repeated = subprocess.run(backup_command, capture_output=True, text=True, timeout=30)
assert repeated.returncode == 1 and json.loads(repeated.stderr)['state'] == 'unverified'
assert receipt['sha256'] == hashlib.sha256(backup_path.read_bytes()).hexdigest()
assert not Path(str(backup_path) + '-wal').exists()
verify_command = [sys.executable, '-B', 'scripts/agentic_storage_admin.py', 'verify-backup', '--input', str(backup_path), '--sha256', receipt['sha256']]
verified = subprocess.run(verify_command, capture_output=True, text=True, timeout=30)
assert verified.returncode == 0, verified.stderr
assert json.loads(verified.stdout)['backup']['artifactVerified'] is True
assert json.loads(verified.stdout)['backup']['restoreVerified'] is False
assert json.loads(verified.stdout)['backup']['records'] == receipt['records']
invalid = subprocess.run([*verify_command[:-1], 'f' * 64], capture_output=True, text=True, timeout=30)
assert invalid.returncode == 1 and json.loads(invalid.stderr)['state'] == 'unverified'
assert receipt['sha256'] == hashlib.sha256(backup_path.read_bytes()).hexdigest()

audit_command = [part if part != 'verify-backup' else 'audit-backup' for part in verify_command]
audited = subprocess.run(audit_command, capture_output=True, text=True, timeout=30)
assert audited.returncode == 0, audited.stderr
bindings = json.loads(audited.stdout)['backup']['bindings']
assert bindings['recordBindingsVerified'] is True and bindings['unresolvedRepairs'] == 1
assert bindings['restoreVerified'] is False and bindings['liveFilesystemVerified'] is False
assert receipt['sha256'] == hashlib.sha256(backup_path.read_bytes()).hexdigest()

# Root operator pairs a host snapshot with the real Node exporter running as the endpoint UID.
import shutil
endpoint_parent = mount.parent / 'pair-endpoint'; endpoint_parent.mkdir(mode=0o700); os.chown(endpoint_parent, uid, gid)
endpoint_state = endpoint_parent / 'state'; endpoint_state.mkdir(mode=0o700); os.chown(endpoint_state, uid, gid)
endpoint_database = endpoint_state / 'endpoint.sqlite'
with sqlite3.connect(endpoint_database) as saved, sqlite3.connect(registry / 'host.sqlite') as original:
    saved.executescript('CREATE TABLE endpoint_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE remote_storage(workspace TEXT PRIMARY KEY,request_id TEXT,project_id INTEGER,value TEXT); CREATE TABLE remote_grant(id TEXT PRIMARY KEY,value TEXT);')
    saved.executemany('INSERT INTO endpoint_meta VALUES(?,?)', [('id', config['endpointId']), ('storage-policy', json.dumps(config['policy']))])
    for encoded, in original.execute('SELECT intent FROM operations WHERE endpoint=?', (config['endpointId'],)):
        value = {**json.loads(encoded), 'phase': 'provisioning', 'createdAt': '2026-11-15T00:00:00.000Z'}
        saved.execute('INSERT INTO remote_storage VALUES(?,?,?,?)', (value['workspace'], value['requestId'], value['projectId'], json.dumps(value)))
os.chmod(endpoint_database, 0o600); os.chown(endpoint_database, uid, gid)
source_bytes = endpoint_database.read_bytes()
pair_command = [sys.executable, '-B', 'scripts/agentic_storage_admin.py', '--config', str(config_path), '--registry', str(registry),
                'capture-pair', '--output', str(backup_dir / 'paired-host.sqlite'), '--node', str(Path(shutil.which('node')).resolve()),
                '--exporter', str(Path('scripts/endpoint-storage-snapshot.mjs').resolve()), '--endpoint-state', str(endpoint_state),
                '--endpoint-output', str(endpoint_parent / 'snapshot')]
paired = subprocess.run(pair_command, capture_output=True, text=True, timeout=140)
assert paired.returncode == 0, paired.stderr
pair = json.loads(paired.stdout)
assert pair['recordBindingsVerified'] is False
assert pair['pair']['hostLockHeldThroughEndpointCapture'] is True and pair['pair']['restoreVerified'] is False
endpoint_receipt = pair['pair']['endpoint']
assert endpoint_receipt['endpointId'] == config['endpointId'] and endpoint_receipt['artifactVerified'] is True
artifact = Path(endpoint_receipt['endpoint']['path'])
assert artifact.stat().st_uid == uid and artifact.stat().st_mode & 0o777 == 0o600
assert endpoint_receipt['endpoint']['sha256'] == hashlib.sha256(artifact.read_bytes()).hexdigest()
assert endpoint_database.read_bytes() == source_bytes
repeated_pair = subprocess.run(pair_command, capture_output=True, text=True, timeout=30)
assert repeated_pair.returncode == 1 and json.loads(repeated_pair.stderr)['state'] == 'unverified'
print(json.dumps({'nativeStoragePairedCapture': 'passed', 'endpointRunsWithoutRoot': True, 'sourceUnchanged': True,
                  'hostLockHeldThroughCapture': True, 'recordBindingsVerified': False, 'restoreVerified': False}), flush=True)

print(json.dumps({'nativeStorageCrashBoundaries': results, 'missingRegistryUnchanged': True,
                  'registryBackup': {'allRecordsRetained': True, 'uncertainRepairRetained': True,
                                     'overwriteRefused': True, 'standaloneSQLite': True, 'offlineArtifactVerification': True, 'recordBindingsVerified': True}}), flush=True)
