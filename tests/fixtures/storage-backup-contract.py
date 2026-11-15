"""SQLite/WAL snapshot behavior; host path/UID enforcement is covered by native CI."""
import contextlib
import fcntl
import os
import hashlib
from pathlib import Path
import sqlite3
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'scripts'))
import agentic_storage as storage

class Backup(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.host = storage.StorageHost.__new__(storage.StorageHost)
        self.host.registry = self.base / 'registry'; self.host.registry.mkdir()
        self.host.mount = self.base / 'volume'
        self.host.db = sqlite3.connect(self.host.registry / 'host.sqlite'); self.addCleanup(self.host.db.close)
        self.host.db.execute('PRAGMA journal_mode=WAL')
        schemas = {'endpoints': 'id,filesystem,first,last,config', 'namespaces': 'endpoint,identities',
                   'operations': 'endpoint,request,workspace,filesystem,project,intent,roots', 'repairs': 'endpoint,id,request,intent,phase'}
        for table, columns in schemas.items():
            self.host.db.execute('CREATE TABLE ' + table + '(' + columns + ')')
            for label in ['first', 'second']:
                self.host.db.execute('INSERT INTO ' + table + '(' + columns.split(',')[0] + ') VALUES(?)', (label,))
        self.host.db.commit()
        self.host.exclusive = contextlib.nullcontext
        self.host.sync_directory = lambda path: None
        native_stat = storage.os.fstat
        def root_stat(fd):
            info = native_stat(fd)
            return SimpleNamespace(**{key: (0 if key == 'st_uid' else getattr(info, key)) for key in
                ['st_dev', 'st_ino', 'st_nlink', 'st_mode', 'st_uid', 'st_size', 'st_mtime_ns', 'st_ctime_ns']})
        self.stack = contextlib.ExitStack(); self.addCleanup(self.stack.close)
        self.stack.enter_context(patch.object(storage, 'protected', side_effect=lambda path, private=False: path))
        self.stack.enter_context(patch.object(storage.os, 'fstat', side_effect=root_stat))

    def test_pair_keeps_host_lock_through_endpoint_capture(self):
        lockfile = self.base / 'pair.lock'
        self.host.lock = os.open(lockfile, os.O_CREAT | os.O_RDWR, 0o600)
        contender = os.open(lockfile, os.O_RDWR)
        self.addCleanup(os.close, self.host.lock); self.addCleanup(os.close, contender)
        self.host.exclusive = storage.StorageHost.exclusive.__get__(self.host)
        before = list(self.host.db.iterdump())
        def capture():
            with self.assertRaises(BlockingIOError): fcntl.flock(contender, fcntl.LOCK_EX | fcntl.LOCK_NB)
            self.assertTrue((self.base / 'paired.sqlite').exists())
            return {'endpointId': 'original', 'writerLockHeld': True}
        result = self.host.capture_pair(self.base / 'paired.sqlite', capture)
        self.assertTrue(result['hostLockHeldThroughEndpointCapture'])
        self.assertFalse(result['executionQuiescenceVerified']); self.assertFalse(result['restoreVerified'])
        self.assertEqual(result['endpoint']['endpointId'], 'original')
        self.assertEqual(list(self.host.db.iterdump()), before)
        fcntl.flock(contender, fcntl.LOCK_EX | fcntl.LOCK_NB)
        fcntl.flock(contender, fcntl.LOCK_UN)

    def test_pair_failure_releases_lock_and_retains_original_backup(self):
        lockfile = self.base / 'failed-pair.lock'
        self.host.lock = os.open(lockfile, os.O_CREAT | os.O_RDWR, 0o600)
        contender = os.open(lockfile, os.O_RDWR)
        self.addCleanup(os.close, self.host.lock); self.addCleanup(os.close, contender)
        self.host.exclusive = storage.StorageHost.exclusive.__get__(self.host)
        def capture(): raise RuntimeError('endpoint snapshot refused')
        target = self.base / 'failed-pair.sqlite'
        with self.assertRaisesRegex(RuntimeError, 'endpoint snapshot refused'): self.host.capture_pair(target, capture)
        self.assertTrue(target.exists())
        fcntl.flock(contender, fcntl.LOCK_EX | fcntl.LOCK_NB)
        fcntl.flock(contender, fcntl.LOCK_UN)
        with self.assertRaises(FileExistsError): self.host.capture_pair(target, lambda: self.fail('must not retry endpoint'))

    def test_committed_wal_all_tables_and_endpoints_are_preserved(self):
        before = list(self.host.db.iterdump()), self.host.db.total_changes
        target = self.base / 'snapshot.sqlite'
        result = self.host.backup(target)
        self.assertEqual(result['sha256'], hashlib.sha256(target.read_bytes()).hexdigest())
        self.assertEqual(result['records'], dict.fromkeys(['endpoints', 'namespaces', 'operations', 'repairs'], 2))
        self.assertFalse(result['restoreVerified']); self.assertFalse(result['workspaceFilesIncluded'])
        with contextlib.closing(sqlite3.connect(target)) as saved:
            self.assertEqual(list(saved.iterdump()), before[0])
        self.assertEqual((list(self.host.db.iterdump()), self.host.db.total_changes), before)
        self.assertEqual(target.stat().st_mode & 0o777, 0o600)
        self.assertFalse(Path(str(target) + '-wal').exists())
        with self.assertRaises(FileExistsError): self.host.backup(target)
        self.assertEqual(result['sha256'], hashlib.sha256(target.read_bytes()).hexdigest())

    def test_offline_verification_is_read_only_and_requires_original_hash(self):
        target = self.base / 'snapshot.sqlite'; receipt = self.host.backup(target)
        before = target.read_bytes(), target.stat().st_mtime_ns
        verified = storage.StorageHost.verify_backup(target, receipt['sha256'])
        self.assertTrue(verified['artifactVerified']); self.assertFalse(verified['restoreVerified'])
        self.assertEqual(verified['records'], receipt['records'])
        self.assertEqual((target.read_bytes(), target.stat().st_mtime_ns), before)
        with self.assertRaises(RuntimeError): storage.StorageHost.verify_backup(target, 'f' * 64)
        Path(str(target) + '-wal').touch()
        with self.assertRaises(RuntimeError): storage.StorageHost.verify_backup(target, receipt['sha256'])

    def test_offline_verification_rejects_unexpected_schema(self):
        target = self.base / 'snapshot.sqlite'; self.host.backup(target)
        with contextlib.closing(sqlite3.connect(target)) as database: database.execute('CREATE VIEW extra AS SELECT * FROM repairs')
        with self.assertRaises(RuntimeError):
            storage.StorageHost.verify_backup(target, hashlib.sha256(target.read_bytes()).hexdigest())

    def test_refuses_source_directory_and_pending_transaction(self):
        with self.assertRaises(RuntimeError): self.host.backup(self.host.registry / 'copy.sqlite')
        self.host.db.execute("INSERT INTO repairs(endpoint,id) VALUES('pending','uncommitted')")
        with self.assertRaises(RuntimeError): self.host.backup(self.base / 'pending.sqlite')
        self.assertFalse((self.base / 'pending.sqlite').exists())

    def test_failed_snapshot_is_retained_and_cannot_be_overwritten(self):
        self.host.db.execute('DROP TABLE repairs'); self.host.db.commit()
        target = self.base / 'failed.sqlite'
        with self.assertRaises(sqlite3.OperationalError): self.host.backup(target)
        self.assertTrue(target.exists())
        with self.assertRaises(FileExistsError): self.host.backup(target)

if __name__ == '__main__': unittest.main()
