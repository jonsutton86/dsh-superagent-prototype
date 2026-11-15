"""Installed root service plus non-root managed Harness/coordinator/SSH journey, disposable CI only."""
import json
import os
from pathlib import Path
import pwd
import sqlite3
import subprocess
import sys
import uuid

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'scripts'))
from agentic_storage_install import install
mount = Path(sys.argv[1])
assert os.environ.get('GITHUB_ACTIONS') == 'true' and os.getuid() == 0
assert str(mount).startswith('/tmp/agentic-storage-') and mount.name == 'volume'
uid, gid = map(int, sys.argv[2:4])
cli = os.environ['DSH_ENDPOINT_QUALIFICATION_CLI']
assert Path(cli).is_file()
base = mount.parent
root, registry = base / 'launcher-host', base / 'installed-registry'
config = {'endpointId': str(uuid.uuid4()), 'uid': uid, 'gid': gid, 'policy': {
    'kind': 'linux-xfs-project', 'filesystemUUID': subprocess.check_output(['findmnt', '-n', '-o', 'UUID', '--target', str(mount)], text=True).strip(),
    'mountRoot': str(mount), 'projectIds': {'first': 3000, 'last': 3009},
    'pool': {'bytes': 32 * 1024 ** 2, 'inodes': 256}, 'workspace': {'bytes': 16 * 1024 ** 2, 'inodes': 128}}}
manifest = install(str(root), str(registry), config)
unit = manifest['unit']
def systemctl(*args):
    subprocess.run(['systemctl', *args], check=True, capture_output=True, text=True, timeout=140)
linked = False
try:
    systemctl('link', str(root / unit)); linked = True
    systemctl('daemon-reload'); systemctl('start', unit)
    env = {'PATH': os.environ['PATH'], 'HOME': pwd.getpwuid(uid).pw_dir, 'CI': 'true',
           'DSH_ENDPOINT_QUALIFICATION_CLI': cli, 'DSH_ENDPOINT_LAUNCHER_QUALIFICATION': '1',
           'DSH_STORAGE_LAUNCHER_CONFIG': json.dumps(json.loads((root / 'endpoint-storage.json').read_text())['storage'])}
    result = subprocess.run(['node', 'node_modules/vitest/vitest.mjs', 'run', 'tests/endpoint-launcher.spec.ts', '--no-cache'],
                            user=uid, group=gid, extra_groups=[], env=env, capture_output=True, text=True, timeout=330)
    print(result.stdout, flush=True)
    assert result.returncode == 0, result.stderr
    with sqlite3.connect((registry / 'host.sqlite').as_uri() + '?mode=ro', uri=True) as database:
        rows = database.execute('SELECT workspace, project FROM operations WHERE endpoint=? ORDER BY project', (config['endpointId'],)).fetchall()
        assert rows == [('__dsh_startup', 3000), ('launcher-proof', 3001)], rows
    print(json.dumps({'nativeStorageLauncher': 'passed', 'realHarness': True, 'sshEnrollment': True,
                      'endpointAndCoordinatorRestart': True, 'originalAllocationsRetained': True}), flush=True)
finally:
    if linked:
        systemctl('stop', unit); systemctl('disable', unit); systemctl('daemon-reload')
