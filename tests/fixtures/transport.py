"""Transport contracts with synthetic credentials and HTTP identity responses; no external connections."""
import copy
import importlib.machinery
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import Thread
from types import SimpleNamespace
import unittest
from unittest.mock import patch

scripts, directory, case = sys.argv[1:]
os.umask(0o077)
sys.path.insert(0, scripts)
import agentic_transport as t
loader = importlib.machinery.SourceFileLoader('transport_launcher', str(Path(scripts) / 'agentic-os'))
spec = importlib.util.spec_from_loader(loader.name, loader)
api = importlib.util.module_from_spec(spec)
sys.modules[loader.name] = api
loader.exec_module(api)


class TransportTests(unittest.TestCase):
    def setUp(self):
        self.base = Path(directory)
        self.root = self.base / 'transport $HOME %n with spaces'
        api.private_directory(self.root)
        self.secret = 'synthetic-endpoint-credential-' + 'x' * 43
        for name, content in {'key': 'synthetic SSH private key', 'known': '127.0.0.1 ssh-ed25519 synthetic\n', 'token': self.secret}.items():
            api.atomic(self.base / name, content)
        self.endpoint = {'endpointId': 'a9d04bee-cf56-4ab6-9234-38d91ed8ccc9', 'url': 'http://127.0.0.1:3084',
                         'credentialFile': '/remote/private/admin.token', 'platform': 'linux', 'confinement': 'linux-bubblewrap',
                         'maxRunning': 8, 'outputMaxBytes': 8388608}
        api.save(self.base / 'endpoint.json', self.endpoint)
        self.config = {'host': '127.0.0.1', 'user': 'agentic', 'identityFile': str(self.base / 'key'),
                       'knownHostsFile': str(self.base / 'known'), 'credentialFile': str(self.base / 'token'),
                       'enrollmentFile': str(self.base / 'endpoint.json')}
        api.save(self.base / 'config.json', self.config)
        self.args = SimpleNamespace(transport_config=str(self.base / 'config.json'), checkout=None, dsh=None, profile=None,
                                    endpoint_config=None, service_resources=None, port=3085)

    def init(self):
        with patch('builtins.print'):
            self.assertEqual(t.initialize(self.root, self.args, api), 0)
        return api.manifest(self.root)

    def test_configuration(self):
        for change in ({'host': '-oProxyCommand=evil'}, {'host': 'host\nLocalCommand bad'}, {'user': 'root@host'},
                       {'sshPort': True}, {'sshPort': 0}, {'proxyCommand': 'sh'}, {'identityFile': '/tmp/${SECRET}'}):
            with self.assertRaises((RuntimeError, ValueError)):
                t.configuration({**self.config, **change}, api)
        self.assertFalse((self.root / 'installation.json').exists())
        for change in ({'url': 'http://0.0.0.0:3084'}, {'confinement': 'unconfined'}, {'platform': 'darwin'}, {'endpointId': 'unknown'}):
            api.save(self.base / 'endpoint.json', {**self.endpoint, **change})
            with self.assertRaises((RuntimeError, ValueError)):
                t.configuration(self.config, api)

    def test_pins(self):
        first = self.init()
        self.assertEqual(self.init(), first)
        t.validate(self.root, first)
        for name in ('ssh.conf', 'known_hosts'):
            original = (self.root / name).read_text()
            api.atomic(self.root / name, original + '\nchanged')
            with self.assertRaises(RuntimeError): t.validate(self.root, first)
            with self.assertRaises(RuntimeError): self.init()
            api.atomic(self.root / name, original)
        for name in ('key', 'token'):
            original = (self.base / name).read_text()
            api.atomic(self.base / name, original + 'changed')
            with self.assertRaises(RuntimeError): t.validate(self.root, first)
            with self.assertRaises(RuntimeError): self.init()
            api.atomic(self.base / name, original)
        self.assertEqual(api.manifest(self.root), first)

    def test_permissions(self):
        for name, field in (('key', 'identityFile'), ('known', 'knownHostsFile'), ('token', 'credentialFile')):
            file = self.base / name
            file.chmod(0o644)
            with self.assertRaises(RuntimeError): t.configuration(self.config, api)
            file.chmod(0o600)
            link = self.base / ('link-' + name)
            link.symlink_to(file)
            with self.assertRaises(RuntimeError): t.configuration({**self.config, field: str(link)}, api)

    def test_parser(self):
        value = self.init()
        result = subprocess.run([value['cli'], '-G', *t.command(self.root, value)[1:]], capture_output=True, text=True, check=True)
        parsed = dict(line.split(' ', 1) for line in result.stdout.splitlines())
        self.assertEqual(parsed['hostname'], '127.0.0.1')
        self.assertEqual(parsed['localforward'].replace('[', '').replace(']', ''), '127.0.0.1:3085 127.0.0.1:3084')
        self.assertEqual(parsed['stricthostkeychecking'], 'true')
        self.assertEqual(parsed['batchmode'], 'yes')
        self.assertEqual(parsed['identityagent'], 'none')
        self.assertEqual(parsed['forwardagent'], 'no')
        self.assertEqual(parsed['userknownhostsfile'], str(self.root / 'known_hosts'))
        self.assertEqual(parsed['certificatefile'], 'none')
        self.assertNotIn(self.secret, (self.root / 'ssh.conf').read_text())
        with patch.dict(os.environ, {'SSH_AUTH_SOCK': '/wrong/agent', 'DEEPSEEK_API_KEY': 'synthetic', 'SSH_ASKPASS': '/wrong/helper'}):
            self.assertEqual(set(api.environment(self.root, value)), {'PATH', 'LANG', 'LC_ALL'})

    def test_resume(self):
        value = self.init()
        api.save(self.root / 'installation.json', {**value, 'phase': 'preparing'})
        (self.root / 'ssh.conf').unlink()
        self.assertEqual(self.init(), value)
        with self.assertRaises(RuntimeError): t.manifest(self.base / 'other', value)
        self.args.port = 3086
        with self.assertRaises(RuntimeError): self.init()

    def test_health(self):
        expected = self.endpoint['endpointId']
        answer = {'endpointId': expected, 'result': {'id': expected, 'protocol': 1, 'platform': 'linux', 'confinement': 'linux-bubblewrap',
                  'capabilities': {key: True for key in ('filesystem', 'process', 'administration', 'effectOwnership', 'credentialBindings', 'snapshotVerification')}}}
        result = copy.deepcopy(answer)
        requests = []
        secret = self.secret
        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                requests.append(json.loads(self.rfile.read(int(self.headers['content-length']))))
                if self.headers.get('authorization') != 'Bearer ' + secret or self.headers.get('x-dsh-endpoint') != expected:
                    self.send_response(401); self.end_headers(); return
                if result.get('redirect'):
                    self.send_response(302); self.send_header('location', 'http://127.0.0.1:1/'); self.end_headers(); return
                self.send_response(200); self.end_headers(); self.wfile.write(json.dumps(result).encode())
            def log_message(self, *_): pass
        server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        thread = Thread(target=server.serve_forever); thread.start()
        try:
            self.args.port = server.server_port
            value = self.init()
            self.assertEqual(t.health(self.root, value, api.NoRedirect)['endpoint']['endpointId'], expected)
            exported = t.enrollment(self.root, value, t.health(self.root, value, api.NoRedirect))
            self.assertEqual(exported['credentialFile'], self.config['credentialFile'])
            self.assertEqual(exported['url'], 'http://127.0.0.1:' + str(server.server_port))
            self.assertNotIn(self.secret, json.dumps(exported))
            for mutation in ({'confinement': 'unconfined'}, {'id': str(uuid())}, {'protocol': 2}, {'capabilities': {}}, {'ownership': {}}, {'resources': {}}):
                result = {**answer, 'result': {**answer['result'], **mutation}}
                self.assertIsNone(t.health(self.root, value, api.NoRedirect))
            for result in ({'redirect': True}, {**answer, 'error': {'code': 'denied'}}, {**answer, 'padding': 'x' * 17000}):
                self.assertIsNone(t.health(self.root, value, api.NoRedirect))
            budget = {'cpuPercent': 100, 'memoryBytes': 268435456, 'processes': 64}
            resource_pin = {'kind': 'linux-cgroup-v2', 'ready': True, 'policy': {'cgroupRoot': '/sys/fs/cgroup/owned/workers', 'pool': budget, 'command': budget}}
            value['transport']['endpoint']['resources'] = resource_pin
            result = {**answer, 'result': {**answer['result'], 'resources': {**resource_pin, 'memoryBytes': 128, 'processes': 2, 'activeScopes': 1}}}
            self.assertEqual(t.health(self.root, value, api.NoRedirect)['endpoint']['resources']['activeScopes'], 1)
            result['result']['resources']['activeScopes'] = 3
            self.assertEqual(t.health(self.root, value, api.NoRedirect)['endpoint']['resources']['activeScopes'], 3)
            result['result']['resources']['ready'] = False
            self.assertIsNone(t.health(self.root, value, api.NoRedirect))
            result['result']['resources']['ready'] = True
            result['result']['resources']['policy'] = {**resource_pin['policy'], 'cgroupRoot': '/sys/fs/cgroup/unrelated'}
            self.assertIsNone(t.health(self.root, value, api.NoRedirect))
            self.assertTrue(all(request == {'op': 'identity'} for request in requests))
        finally:
            server.shutdown(); server.server_close(); thread.join()

    def test_stop_after_corruption(self):
        value = self.init()
        api.atomic(self.root / 'ssh.conf', 'damaged')
        api.atomic(self.base / 'token', 'damaged')
        with patch.object(api, 'single', return_value=None), patch('builtins.print'):
            api.stop(self.root, api.manifest(self.root), SimpleNamespace(stop_timeout=1))
        self.assertTrue((self.root / 'manually-stopped').exists())
        self.assertIsNone(t.health(self.root, value, api.NoRedirect))


def uuid():
    return '00000000-0000-4000-8000-000000000000'


suite = unittest.TestSuite([TransportTests('test_' + case)])
result = unittest.TextTestRunner().run(suite)
sys.exit(0 if result.wasSuccessful() else 1)
