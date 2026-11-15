"""SQLite/WAL snapshot behavior; host path/UID enforcement is covered by native CI."""
import contextlib
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
        for table in ['endpoints', 'namespaces', 'operations', 'repairs']:
            self.host.db.execute('CREATE TABLE ' + table + '(id,value)')
            self.host.db.executemany('INSERT INTO ' + table + ' VALUES(?,?)', [('first', 'retained'), ('second', 'uncertain')])
        self.host.db.commit()
        self.host.exclusive = contextlib.nullcontext
        self.host.sync_directory = lambda path: None
        native_stat = storage.os.fstat
        def root_stat(fd):
            info = native_stat(fd)
            return SimpleNamespace(**{key: (0 if key == 'st_uid' else getattr(info, key)) for key in
                ['st_dev', 'st_ino', 'st_nlink', 'st_mode', 'st_uid', 'st_size']})
        self.stack = contextlib.ExitStack(); self.addCleanup(self.stack.close)
        self.stack.enter_context(patch.object(storage, 'protected', side_effect=lambda path, private=False: path))
        self.stack.enter_context(patch.object(storage.os, 'fstat', side_effect=root_stat))

    def test_committed_wal_all_tables_and_endpoints_are_preserved(self):
        before = list(self.host.db.iterdump()), self.host.db.total_changes
        target = self.base / 'snapshot.sqlite'
        result = self.host.backup(target)
        self.assertEqual(result['sha256'], hashlib.sha256(target.read_bytes()).hexdigest())
        self.assertEqual(result['records'], dict.fromkeys(['endpoints', 'namespaces', 'operations', 'repairs'], 2))
        self.assertFalse(result['restoreVerified']); self.assertFalse(result['workspaceFilesIncluded'])
        with sqlite3.connect(target) as saved:
            self.assertEqual(list(saved.iterdump()), before[0])
        self.assertEqual((list(self.host.db.iterdump()), self.host.db.total_changes), before)
        self.assertEqual(target.stat().st_mode & 0o777, 0o600)
        self.assertFalse(Path(str(target) + '-wal').exists())
        with self.assertRaises(FileExistsError): self.host.backup(target)
        self.assertEqual(result['sha256'], hashlib.sha256(target.read_bytes()).hexdigest())

    def test_refuses_source_directory_and_pending_transaction(self):
        with self.assertRaises(RuntimeError): self.host.backup(self.host.registry / 'copy.sqlite')
        self.host.db.execute("INSERT INTO repairs VALUES('pending','uncommitted')")
        with self.assertRaises(RuntimeError): self.host.backup(self.base / 'pending.sqlite')
        self.assertFalse((self.base / 'pending.sqlite').exists())

    def test_failed_snapshot_is_retained_and_cannot_be_overwritten(self):
        self.host.db.execute('DROP TABLE repairs'); self.host.db.commit()
        target = self.base / 'failed.sqlite'
        with self.assertRaises(sqlite3.OperationalError): self.host.backup(target)
        self.assertTrue(target.exists())
        with self.assertRaises(FileExistsError): self.host.backup(target)

if __name__ == '__main__': unittest.main()
