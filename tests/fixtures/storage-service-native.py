"""Root fixture launches service; client runs as the assigned non-root endpoint UID."""
import json
import os
from pathlib import Path
import selectors
import socket
import sqlite3
import subprocess
import sys
import uuid

root = Path(sys.argv[1])
assert os.environ.get('GITHUB_ACTIONS') == 'true' and str(root).startswith('/tmp/agentic-storage-') and root.name == 'volume'
uid, gid = map(int, sys.argv[2:4])
base = root.parent
registry = base / 'service-registry'; registry.mkdir(mode=0o700)
config_path = base / 'service.json'
socket_path = base / 'service.sock'
filesystem = subprocess.check_output(['findmnt', '-n', '-o', 'UUID', '--target', str(root)], text=True).strip()
config = {'endpointId': str(uuid.uuid4()), 'uid': uid, 'gid': gid, 'policy': {
    'kind': 'linux-xfs-project', 'filesystemUUID': filesystem, 'mountRoot': str(root),
    'projectIds': {'first': 1000, 'last': 1009}, 'pool': {'bytes': 32 * 1024 ** 2, 'inodes': 256},
    'workspace': {'bytes': 16 * 1024 ** 2, 'inodes': 128}}}
with os.fdopen(os.open(config_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), 'w') as file:
    json.dump(config, file)
argv = [sys.executable, 'scripts/agentic_storage_service.py', '--config', str(config_path),
    '--registry', str(registry), '--socket', str(socket_path)]

def start():
    process = subprocess.Popen(argv, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    try:
        with selectors.DefaultSelector() as selector:
            selector.register(process.stdout, selectors.EVENT_READ)
            assert selector.select(15), 'Host service did not report startup'
            assert process.stdout.readline().strip() == 'storage-host-ready'
        return process
    except BaseException:
        process.kill(); process.wait(); raise

process = start()
try:
    # Root can open the mode-0660 socket but is not the configured peer UID. Payload must not override peer credentials.
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
        connection.settimeout(5); connection.connect(str(socket_path))
        assert json.loads(connection.recv(4096)) == {'ok': False, 'error': 'storage_host_refused'}
    env = {'PATH': os.environ['PATH'], 'DSH_STORAGE_SERVICE_CONFIG': json.dumps(config),
           'DSH_STORAGE_SERVICE_SOCKET': str(socket_path), 'CI': 'true'}
    result = subprocess.run(['node', 'node_modules/vitest/vitest.mjs', 'run', 'tests/storage-host-client.spec.ts', '--no-cache'],
                            user=uid, group=gid, extra_groups=[], env=env, capture_output=True, text=True, timeout=90)
    print(result.stdout, flush=True)
    assert result.returncode == 0, result.stderr
    # Authorized peer still cannot send configuration, multiple commands, or an oversized frame.
    client = '''import json,socket,sys
s=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM);s.settimeout(10);s.connect(sys.argv[1])
s.sendall(sys.argv[2].encode());s.shutdown(socket.SHUT_WR)
data=b''
while True:
 part=s.recv(4096)
 if not part: break
 data+=part
assert json.loads(data)=={'ok':False,'error':'storage_host_refused'},data
'''
    for payload in ['{"op":"observe","request":{},"policy":{}}', '{}{}', '{"op":"observe","op":"provision","request":{}}', 'x' * 4097]:
        checked = subprocess.run([sys.executable, '-c', client, str(socket_path), payload], user=uid, group=gid,
                                 extra_groups=[], capture_output=True, text=True, timeout=15)
        assert checked.returncode == 0, checked.stderr
    slow_client = """import json,socket,sys,time
s=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM);s.connect(sys.argv[1]);s.settimeout(.2)
start=time.monotonic();data=b''
while time.monotonic()-start<9:
 s.sendall(b' ')
 try:
  part=s.recv(4096)
  if not part: break
  data+=part
  if data: break
 except socket.timeout: pass
assert json.loads(data)=={'ok':False,'error':'storage_host_refused'},data
assert 4 <= time.monotonic()-start < 8
"""
    slow = subprocess.run([sys.executable, '-c', slow_client, str(socket_path)], user=uid, group=gid,
                          extra_groups=[], capture_output=True, text=True, timeout=12)
    assert slow.returncode == 0, slow.stderr
    # The service must still accept a new connection after terminating the slow request.
    checked = subprocess.run([sys.executable, '-c', client, str(socket_path), '{}'], user=uid, group=gid,
                             extra_groups=[], capture_output=True, text=True, timeout=15)
    assert checked.returncode == 0, checked.stderr
    # A duplicate service must not mutate the host registry or displace the current listener.
    def saved_registry():
        with sqlite3.connect((registry / 'host.sqlite').as_uri() + '?mode=ro', uri=True) as database:
            return list(database.iterdump())
    before = saved_registry()
    inode = socket_path.stat().st_ino
    duplicate = subprocess.run(argv, capture_output=True, text=True, timeout=10)
    assert duplicate.returncode == 1 and duplicate.stdout.strip() == 'storage-host-unavailable'
    assert socket_path.stat().st_ino == inode and saved_registry() == before
    # SIGKILL leaves the socket. Restart reclaims only that stale transport, never host operation intents.
    process.kill(); process.wait(timeout=10)
    assert process.returncode == -9 and socket_path.exists()
    process = start()
    assert saved_registry() == before
    checked = subprocess.run([sys.executable, '-c', client, str(socket_path), '{}'], user=uid, group=gid,
                             extra_groups=[], capture_output=True, text=True, timeout=15)
    assert checked.returncode == 0, checked.stderr
    print(json.dumps({'nativeStorageService': 'passed', 'peerUidRequired': True, 'malformedRequestsRefused': True, 'slowRequestDeadline': True, 'crashRestartPreservedRegistry': True, 'duplicateListenerRefused': True}), flush=True)
finally:
    process.terminate()
    try:
        process.wait(timeout=15)
    except subprocess.TimeoutExpired:
        process.kill(); process.wait(); raise AssertionError('Storage service did not stop cleanly')
    assert process.returncode == 0, process.stderr.read()
    assert not socket_path.exists(), 'Service did not remove its own socket'
