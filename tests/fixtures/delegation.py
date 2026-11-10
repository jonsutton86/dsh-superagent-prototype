"""Explicit simulated-kernel/control tests. This is not evidence of native Linux delegation."""
import copy
import importlib.machinery
import importlib.util
import json
import os
from pathlib import Path
import signal
import sys
from threading import Timer
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

scripts, directory, case = sys.argv[1:]
os.umask(0o077)
sys.path.insert(0, scripts)
import agentic_delegation as d
import agentic_service as s
loader = importlib.machinery.SourceFileLoader('launcher_fixture', str(Path(scripts) / 'agentic-os'))
spec = importlib.util.spec_from_loader(loader.name, loader)
api = importlib.util.module_from_spec(spec)
sys.modules[loader.name] = api
loader.exec_module(api)

class FakeKernel:
    def __init__(self, value):
        self.unit = Path(value['cgroup'])
        self.current = self.unit
        self.files, self.directories, self.writes = {}, set(), []
        self.mkdir(self.unit)
        self.files[self.unit / 'cgroup.procs'] = str(os.getpid())

    def mounted(self):
        pass

    def group(self, pid='self'):
        return self.current

    def domain(self, path):
        if path not in self.directories:
            raise FileNotFoundError(path)
        if self.files[path / 'cgroup.type'] != 'domain':
            raise RuntimeError('Wrong domain')

    def read(self, path):
        return self.files[path]

    def write(self, path, value):
        self.writes.append((path, value))
        if path.name == 'cgroup.procs':
            assert value == str(os.getpid())
            self.files[self.current / 'cgroup.procs'] = ''
            self.current = path.parent
        self.files[path] = value.replace('+', '') if path.name == 'cgroup.subtree_control' else value

    def mkdir(self, path):
        if path not in self.directories:
            self.directories.add(path)
            for name, value in {'cgroup.type': 'domain', 'cgroup.procs': '', 'cgroup.controllers': 'cpu memory pids',
                                'cgroup.subtree_control': '', 'cgroup.events': 'populated 0'}.items():
                self.files[path / name] = value

class DelegationTests(unittest.TestCase):
    def setUp(self):
        self.root = Path(directory)
        self.value = d.scope(self.root, 'agentic-os-test.service', '/user.slice/user-1000.slice/user@1000.service/init.scope')
        self.kernel = FakeKernel(self.value)
        self.installation = {'role': 'endpoint', 'delegation': self.value,
                             'endpointConfig': {'resources': {'cgroupRoot': self.value['workerRoot']}}}
        self.args = SimpleNamespace(action='start', role=None, respect_stop=False, timeout=0.1, stop_timeout=0.1,
                                    restart_delay=0.1, restart_limit=5, restart_window=600)
        self.receipt = {'delegation': self.value, 'label': self.value['unit']}
        api.save(self.root / 'service.json', self.receipt)

    def test_plan(self):
        self.assertEqual(d.validate(self.installation, self.value['unit']), self.value)
        malformed = copy.deepcopy(self.installation)
        malformed['endpointConfig']['resources']['cgroupRoot'] = '/somewhere/else'
        with self.assertRaisesRegex(RuntimeError, 'differs'):
            d.validate(malformed, self.value['unit'])
        with self.assertRaises(RuntimeError):
            d.scope(self.root, self.value['unit'], '/../../init.scope')
        fake = Mock()
        fake.read.return_value = 'memory pids'
        with patch.object(d, 'Kernel', return_value=fake), patch.object(d.shutil, 'which', return_value='/usr/bin/systemctl'), patch.object(d.subprocess, 'run', return_value=SimpleNamespace(returncode=0, stdout='/user.slice/user-1000.slice/user@1000.service/init.scope')):
            with self.assertRaisesRegex(RuntimeError, 'administrator'):
                d.plan(self.root, self.value['unit'])
        with patch.object(s.sys, 'platform', 'linux'):
            actual = s.service_identity(self.root)
            installation = copy.deepcopy(self.installation)
            installation['delegation'] = d.scope(self.root, actual['label'], '/user.slice/user-1000.slice/user@1000.service/init.scope')
            installation['endpointConfig']['resources']['cgroupRoot'] = installation['delegation']['workerRoot']
            self.assertIn('Slice=app.slice\nDelegate=cpu memory pids', s.definition(s.settings(self.root, self.args, installation)))

    def test_prepare(self):
        workers = Path(self.value['workerRoot'])
        self.kernel.mkdir(workers)
        existing = workers / 'existing-endpoint-group'
        self.kernel.mkdir(existing)
        self.kernel.files[existing / 'cgroup.events'] = 'populated 1'
        first = d.prepare(self.value, self.kernel)
        self.assertEqual(first, d.prepare(self.value, self.kernel))
        self.assertEqual(self.kernel.current, self.kernel.unit / 'control')
        self.assertEqual([value for path, value in self.kernel.writes if path.name == 'cgroup.procs'], [str(os.getpid())])
        self.assertEqual(self.kernel.files[existing / 'cgroup.events'], 'populated 1')
        self.assertFalse(any(path.is_relative_to(existing) for path, _ in self.kernel.writes))

    def test_refusals(self):
        for mode in ('outside', 'controllers', 'other-process', 'threaded'):
            kernel = FakeKernel(self.value)
            if mode == 'outside': kernel.current = Path('/unrelated')
            if mode == 'controllers': kernel.files[kernel.unit / 'cgroup.controllers'] = 'memory pids'
            if mode == 'other-process': kernel.files[kernel.unit / 'cgroup.procs'] += '\n999999'
            if mode == 'threaded': kernel.files[kernel.unit / 'cgroup.type'] = 'threaded'
            with self.assertRaises(RuntimeError): d.prepare(self.value, kernel)
            self.assertEqual(kernel.writes, [])
        with self.assertRaisesRegex(RuntimeError, 'left intact'):
            d.process_inside(self.value, {'pid': 42}, self.kernel)

    def test_drain(self):
        self.assertTrue(d.drained(self.value, self.kernel))
        self.kernel.files[self.kernel.unit / 'cgroup.events'] = 'populated 1'
        self.assertFalse(d.drained(self.value, self.kernel))
        self.kernel.files[self.kernel.unit / 'cgroup.events'] = 'unknown 1'
        with self.assertRaises(RuntimeError): d.drained(self.value, self.kernel)
        self.kernel.directories.remove(self.kernel.unit)
        self.assertTrue(d.drained(self.value, self.kernel))
        self.kernel.mounted = Mock(side_effect=RuntimeError('mount unavailable'))
        with self.assertRaises(RuntimeError): d.drained(self.value, self.kernel)

    def test_replay(self):
        with patch.object(s, 'verified', return_value=self.receipt), patch.object(s, 'loaded', return_value={}), patch.object(api, 'manifest', return_value=self.installation), patch.object(s, 'manager', side_effect=RuntimeError('manager unavailable')):
            for _ in range(2):
                with self.assertRaisesRegex(RuntimeError, 'manager unavailable'):
                    s.request_start(self.root, self.args, api)
                current = s.start_request(self.root, api)
                if hasattr(self, 'original'): self.assertEqual(current, self.original)
                self.original = current
        s.cancel_start(self.root, api)
        self.assertEqual(s.start_request(self.root, api)['phase'], 'cancelled')
        api.save(self.root / 'service-start.json', self.original)
        self.args.action = 'restart'
        with patch.object(s, 'verified', return_value=self.receipt), patch.object(s, 'loaded', return_value={}), patch.object(api, 'manifest', return_value=self.installation), patch.object(api, 'stop') as stop:
            with self.assertRaisesRegex(RuntimeError, 'different service'):
                s.request_start(self.root, self.args, api)
            stop.assert_not_called()

    def test_manual_stop(self):
        api.atomic(self.root / 'manually-stopped', 'operator stop')
        self.args.respect_stop = True
        with patch.object(s, 'verified', return_value=self.receipt), patch.object(s, 'loaded', return_value={}), patch.object(api, 'manifest', return_value=self.installation), patch.object(s, 'manager') as manager:
            self.assertEqual(s.request_start(self.root, self.args, api), 0)
            manager.assert_not_called()
            self.assertIsNone(s.start_request(self.root, api))

    def supervise_request(self, fail):
        api.save(self.root / 'supervision-attempts.json', [1])
        api.save(self.root / 'supervision-hold.json', {'reason': 'earlier failure'})
        api.atomic(self.root / 'manually-stopped', 'earlier explicit stop')
        api.save(self.root / 'service-start.json', {'id': '12345678-1234-1234-1234-123456789abc', 'action': 'start', 'phase': 'pending', 'stopStamp': s.stop_stamp(self.root)})
        def launch(*_):
            self.assertFalse(self.args.respect_stop)
            os.kill(os.getpid(), signal.SIGTERM)
            if fail: raise RuntimeError('synthetic startup failure')
            return 0
        with patch.object(api, 'manifest', return_value=self.installation), patch.object(api, 'single', return_value=None), patch.object(api, 'launch', side_effect=launch) as launched, patch.object(api, 'stop'), patch.object(d, 'prepare', return_value={'workerRoot': self.value['workerRoot']}), patch.object(d, 'process_inside'):
            self.assertEqual(s.supervise(self.root, self.args, api), 0)
            self.assertEqual(launched.call_count, 1)
        self.assertEqual(s.start_request(self.root, api)['phase'], 'failed' if fail else 'done')
        self.assertEqual((self.root / 'supervision-hold.json').exists(), fail)
        if not fail: self.assertEqual(api.read_json(self.root / 'supervision-attempts.json'), [])

    def test_success(self):
        self.supervise_request(False)

    def test_failure(self):
        self.supervise_request(True)

    def test_terminal_intent(self):
        for phase in ('failed', 'cancelled'):
            (self.root / 'supervision-hold.json').unlink(missing_ok=True)
            api.save(self.root / 'service-start.json', {'id': '12345678-1234-1234-1234-123456789abc', 'action': 'start', 'phase': phase, 'stopStamp': None})
            timer = Timer(0.15, lambda: os.kill(os.getpid(), signal.SIGTERM))
            with patch.object(api, 'manifest', return_value=self.installation), patch.object(api, 'single', return_value=None), patch.object(api, 'launch') as launch, patch.object(api, 'stop'):
                timer.start()
                try:
                    self.assertEqual(s.supervise(self.root, self.args, api), 0)
                    launch.assert_not_called()
                    self.assertTrue((self.root / 'supervision-hold.json').exists())
                finally:
                    timer.cancel()
                    timer.join()

    def test_stop_fence(self):
        original = {'id': '12345678-1234-1234-1234-123456789abc', 'action': 'start', 'phase': 'pending', 'stopStamp': None}
        api.atomic(self.root / 'service-start.json', 'corrupt request')
        with patch.object(api, 'single', return_value=None):
            api.stop(self.root, self.installation, self.args)
        first = s.stop_stamp(self.root)
        with patch.object(api, 'single', return_value=None):
            api.stop(self.root, self.installation, self.args)
        self.assertNotEqual(first, s.stop_stamp(self.root))
        api.save(self.root / 'service-start.json', original)
        timer = Timer(0.15, lambda: os.kill(os.getpid(), signal.SIGTERM))
        with patch.object(api, 'manifest', return_value=self.installation), patch.object(api, 'single', return_value=None), patch.object(api, 'launch') as launch, patch.object(api, 'stop'):
            timer.start()
            try:
                self.assertEqual(s.supervise(self.root, self.args, api), 0)
                launch.assert_not_called()
                self.assertEqual(s.start_request(self.root, api)['phase'], 'cancelled')
            finally:
                timer.cancel()
                timer.join()

unittest.main(argv=[sys.argv[0], 'DelegationTests.test_' + case])
