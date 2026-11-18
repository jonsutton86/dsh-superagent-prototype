"""Launcher health-contract test; synthetic identity and HTTP, no native kernel claim."""
import copy
import importlib.util
import io
import json
from pathlib import Path
import sqlite3
import sys
from unittest.mock import Mock, patch
import uuid

spec = importlib.util.spec_from_file_location('endpoint', sys.argv[1])
endpoint = importlib.util.module_from_spec(spec)
spec.loader.exec_module(endpoint)
root = Path(sys.argv[2])
(root / 'state').mkdir()
token = root / 'state' / 'admin.token'
token.write_text('synthetic_' + 'x' * 43)
token.chmod(0o600)
database = root / 'state' / 'endpoint.sqlite'
identity = str(uuid.uuid4())
connection = sqlite3.connect(database)
connection.execute('CREATE TABLE endpoint_meta (key TEXT PRIMARY KEY, value TEXT)')
connection.execute('INSERT INTO endpoint_meta VALUES (?, ?)', ('id', identity))
connection.commit()
connection.close()
database.chmod(0o600)

policy = {'cgroupRoot': '/delegated/workers',
          'pool': {'cpuPercent': 200, 'memoryBytes': 1073741824, 'processes': 128},
          'command': {'cpuPercent': 100, 'memoryBytes': 268435456, 'processes': 32}}
config = endpoint.configuration({'resources': policy})
installation = {'port': 3084, 'endpointConfig': config}
result = {'id': identity, 'protocol': 1, 'platform': 'linux', 'confinement': 'linux-bubblewrap',
          'capabilities': {key: True for key in ('filesystem', 'process', 'administration', 'effectOwnership', 'credentialBindings', 'snapshotVerification')},
          'resources': {'kind': 'linux-cgroup-v2', 'policy': policy, 'ready': True, 'memoryBytes': 0, 'processes': 0, 'activeScopes': 0}}

def health(value, settings=installation):
    opener = Mock()
    opener.open.return_value = io.BytesIO(json.dumps({'endpointId': identity, 'result': value}).encode())
    with patch.object(endpoint.urllib.request, 'build_opener', return_value=opener):
        return endpoint.health(root, settings, Mock)

assert health(result)['endpoint']['resources']['policy'] == policy
weakened = copy.deepcopy(result)
weakened['resources']['policy']['command']['memoryBytes'] *= 2
assert health(weakened) is None
unready = copy.deepcopy(result)
unready['resources']['ready'] = False
assert health(unready) is None
missing = copy.deepcopy(result)
del missing['resources']
assert health(missing) is None
assert health(result, {'port': 3084, 'endpointConfig': endpoint.configuration({})}) is None
invalid = copy.deepcopy(policy)
invalid['command']['processes'] = 512
try:
    endpoint.configuration({'resources': invalid})
    raise AssertionError('Accepted a per-command budget above the pool')
except RuntimeError:
    pass
print('Resource health contract passed')
