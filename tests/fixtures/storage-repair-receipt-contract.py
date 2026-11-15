"""Read-only repair identity contract against SQLite; no root or host effects required."""
import json
from pathlib import Path
import sqlite3
import sys
import unittest
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'scripts'))
from agentic_storage import StorageHost

class RepairReceipt(unittest.TestCase):
    def setUp(self):
        self.host = StorageHost.__new__(StorageHost)
        self.host.endpoint = 'endpoint'
        self.host.policy = {'projectIds': {'first': 100, 'last': 110}}
        self.host.db = sqlite3.connect(':memory:')
        self.addCleanup(self.host.db.close)
        self.host.db.executescript('CREATE TABLE operations(endpoint,request,intent,roots); CREATE TABLE repairs(endpoint,id,request,intent,phase);')
        self.request = {'endpointId': 'endpoint', 'requestId': 'original', 'requestHash': 'a' * 64, 'workspace': 'workspace', 'projectId': 100}
        self.host.db.execute('INSERT INTO operations VALUES(?,?,?,?)', ('endpoint', 'original', json.dumps(self.request, sort_keys=True), '[null,null]'))
        self.intent = {'request': self.request, 'snapshotHash': 'b' * 64}

    def insert(self, intent=None, phase='started', repair_id='repair'):
        self.host.db.execute('INSERT INTO repairs VALUES(?,?,?,?,?)', ('endpoint', repair_id, 'original', json.dumps(intent or self.intent), phase))

    def test_absent_and_retained_receipts_are_read_only(self):
        self.assertIsNone(self.host.repair_receipt(self.request))
        for phase in ['started', 'complete']:
            self.host.db.execute('DELETE FROM repairs')
            self.insert(phase=phase)
            before = (list(self.host.db.iterdump()), self.host.db.total_changes)
            self.assertEqual(self.host.repair_receipt(self.request), {'repairId': 'repair', 'phase': phase, 'originalSnapshotHash': 'b' * 64})
            self.assertEqual((list(self.host.db.iterdump()), self.host.db.total_changes), before)

    def test_invalid_retained_receipts_are_refused(self):
        cases = [({'request': {**self.request, 'workspace': 'other'}, 'snapshotHash': 'b' * 64}, 'started', 'repair'),
                 ({**self.intent, 'snapshotHash': 'invalid'}, 'started', 'repair'),
                 ({**self.intent, 'extra': True}, 'started', 'repair'),
                 ({**self.intent, 'finishSnapshotHash': None}, 'finishing', 'repair'),
                 (self.intent, 'finishing', 'repair'),
                 ({**self.intent, 'finishSnapshotHash': 'c' * 64}, 'started', 'repair'),
                 (self.intent, 'unknown', 'repair'), (self.intent, 'started', '../repair')]
        for intent, phase, repair_id in cases:
            with self.subTest(intent=intent, phase=phase, repair_id=repair_id):
                self.host.db.execute('DELETE FROM repairs'); self.insert(intent, phase, repair_id)
                with self.assertRaises(RuntimeError): self.host.repair_receipt(self.request)

    def test_finish_approval_retains_original_identity(self):
        self.insert({**self.intent, 'finishSnapshotHash': 'c' * 64}, phase='finishing')
        self.assertEqual(self.host.repair_receipt(self.request), {'repairId': 'repair', 'phase': 'finishing',
                         'originalSnapshotHash': 'b' * 64, 'finishSnapshotHash': 'c' * 64})

    def test_changed_original_request_is_refused(self):
        self.insert()
        with self.assertRaises(RuntimeError):
            self.host.repair_receipt({**self.request, 'requestHash': 'c' * 64})

if __name__ == '__main__': unittest.main()
