"""Installation planning is pure; no privileged installation on a development host."""
from pathlib import Path
import sys
import unittest
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'scripts'))
from agentic_storage_install import plan

CONFIG = {'endpointId': '11111111-1111-4111-8111-111111111111', 'uid': 1001, 'gid': 1001, 'policy': {
    'kind': 'linux-xfs-project', 'filesystemUUID': '22222222-2222-4222-8222-222222222222', 'mountRoot': '/srv/quota',
    'projectIds': {'first': 100, 'last': 110}, 'pool': {'bytes': 40960, 'inodes': 100}, 'workspace': {'bytes': 4096, 'inodes': 10}}}

class Installation(unittest.TestCase):
    def test_pinned_bundle_without_activation(self):
        files, manifest = plan('/opt/agentic-storage', '/var/lib/agentic-storage', CONFIG)
        self.assertEqual((files, manifest), plan('/opt/agentic-storage', '/var/lib/agentic-storage', CONFIG))
        unit = files[manifest['unit']].decode()
        self.assertIn('Restart=no\n', unit)
        self.assertIn('KillMode=control-group\n', unit)
        self.assertNotIn('ExecStartPre=', unit)
        self.assertNotIn('ProtectSystem=', unit)  # Preserve host mount identities until migration is supported.
        self.assertEqual(set(manifest['files']), set(files) - {'manifest.json'})

    def test_paths_and_identity_rejected(self):
        for directory in ['/opt/../evil', '/opt/%n', '/opt/a b', '/opt/a\nExecStart=evil', '/srv/quota/host', '/var/lib/agentic-storage']:
            with self.assertRaises(RuntimeError):
                plan(directory, '/var/lib/agentic-storage', CONFIG)
        for value in [0, True, -1]:
            with self.assertRaises(RuntimeError):
                plan('/opt/host', '/var/lib/registry', {**CONFIG, 'uid': value})

unittest.main()
