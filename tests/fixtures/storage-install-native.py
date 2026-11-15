"""Disposable CI root installation and actual systemd lifecycle; never runs on operator hosts."""
import copy
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import time
import uuid

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'scripts'))
from agentic_storage_install import install

mount = Path(sys.argv[1])
assert os.environ.get('GITHUB_ACTIONS') == 'true' and os.getuid() == 0
assert str(mount).startswith('/tmp/agentic-storage-') and mount.name == 'volume'
uid, gid = map(int, sys.argv[2:4])
base = mount.parent
root, registry = base / 'installed-host', base / 'installed-registry'
config = {'endpointId': str(uuid.uuid4()), 'uid': uid, 'gid': gid, 'policy': {
    'kind': 'linux-xfs-project', 'filesystemUUID': subprocess.check_output(['findmnt', '-n', '-o', 'UUID', '--target', str(mount)], text=True).strip(),
    'mountRoot': str(mount), 'projectIds': {'first': 2000, 'last': 2009},
    'pool': {'bytes': 32 * 1024 ** 2, 'inodes': 256}, 'workspace': {'bytes': 16 * 1024 ** 2, 'inodes': 128}}}
manifest = install(str(root), str(registry), config)
stamps = {path.name: path.stat().st_mtime_ns for path in root.iterdir()}
assert install(str(root), str(registry), config) == manifest
assert {path.name: path.stat().st_mtime_ns for path in root.iterdir()} == stamps
changed = copy.deepcopy(config); changed['uid'] += 1
try:
    install(str(root), str(registry), changed)
    raise AssertionError('Changed configuration replaced an existing installation')
except RuntimeError:
    pass
partial = base / 'partial-install'; partial.mkdir(mode=0o700)
try:
    install(str(partial), str(registry), config)
    raise AssertionError('Incomplete installation silently resumed')
except RuntimeError:
    pass
assert not list(partial.iterdir())
unit = manifest['unit']
socket = '/run/' + unit.removesuffix('.service') + '/host.sock'
request = {'endpointId': config['endpointId'], 'requestId': 'installed-original', 'requestHash': 'a' * 64,
           'workspace': 'installed-proof', 'projectId': 2000}
client = '''import json,socket,sys
s=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM);s.settimeout(20);s.connect(sys.argv[1])
s.sendall(sys.argv[2].encode());s.shutdown(socket.SHUT_WR)
data=b''
while True:
 part=s.recv(65536)
 if not part: break
 data+=part
print(data.decode())
'''
def call(op):
    result = subprocess.run([sys.executable, '-c', client, socket, json.dumps({'op': op, 'request': request})],
                            user=uid, group=gid, extra_groups=[], capture_output=True, text=True, timeout=25)
    assert result.returncode == 0, result.stderr
    value = json.loads(result.stdout)
    assert value.get('ok') is True, value
    return value

def systemctl(*args):
    subprocess.run(['systemctl', *args], check=True, capture_output=True, text=True, timeout=140)

def wait_ready():
    deadline = time.monotonic() + 15
    while not Path(socket).exists() and time.monotonic() < deadline:
        time.sleep(.1)
    assert Path(socket).exists()

def snapshot():
    with sqlite3.connect((registry / 'host.sqlite').as_uri() + '?mode=ro', uri=True) as database:
        return list(database.iterdump())

linked = False
try:
    subprocess.run(['systemd-analyze', 'verify', str(root / unit)], check=True, capture_output=True, text=True)
    systemctl('link', str(root / unit)); linked = True
    systemctl('daemon-reload'); systemctl('start', unit); wait_ready()
    first = call('provision')
    saved = snapshot()
    assert first['observation']['quota']['hardBytes'] == config['policy']['workspace']['bytes']
    systemctl('kill', '--signal=KILL', '--kill-who=main', unit)
    deadline = time.monotonic() + 15
    while subprocess.run(['systemctl', 'is-active', '--quiet', unit]).returncode == 0 and time.monotonic() < deadline:
        time.sleep(.1)
    systemctl('reset-failed', unit); systemctl('start', unit); wait_ready()
    resumed = call('observe')
    assert resumed['requestId'] == first['requestId'] and resumed['requestHash'] == first['requestHash']
    assert resumed['observation']['directories'] == first['observation']['directories']
    assert resumed['observation']['mountId'] == first['observation']['mountId']
    assert snapshot() == saved
    systemctl('stop', unit)
    assert not Path(socket).exists()
    print(json.dumps({'nativeStorageInstallation': 'passed', 'systemdVerified': True, 'unchangedReinstall': True,
                      'changedAndPartialInstallRefused': True, 'originalOperationObservedAfterKill': True,
                      'registryAndMountIdentityPreserved': True}), flush=True)
finally:
    if linked:
        systemctl('stop', unit)
        systemctl('disable', unit)
        systemctl('daemon-reload')
