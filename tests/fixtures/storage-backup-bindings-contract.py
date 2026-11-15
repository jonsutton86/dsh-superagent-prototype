"""Offline retained-binding checks; no live filesystem claims."""
import json
from pathlib import Path
import sqlite3
import sys
import unittest
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'scripts'))
from agentic_storage import StorageHost

class Bindings(unittest.TestCase):
    def setUp(self):
        self.db = sqlite3.connect(':memory:'); self.addCleanup(self.db.close)
        self.db.executescript('CREATE TABLE endpoints(id,filesystem,first,last,config); CREATE TABLE namespaces(endpoint,identities); CREATE TABLE operations(endpoint,request,workspace,filesystem,project,intent,roots); CREATE TABLE repairs(endpoint,id,request,intent,phase);')
        self.endpoint = '11111111-1111-4111-8111-111111111111'
        self.filesystem = '22222222-2222-4222-8222-222222222222'
        self.config = {'endpointId': self.endpoint, 'uid': 1001, 'gid': 1001, 'policy': {'kind': 'linux-xfs-project',
            'filesystemUUID': self.filesystem, 'mountRoot': '/srv/quota', 'projectIds': {'first': 100, 'last': 109},
            'pool': {'bytes': 8192, 'inodes': 20}, 'workspace': {'bytes': 4096, 'inodes': 10}}}
        self.db.execute('INSERT INTO endpoints VALUES(?,?,?,?,?)', (self.endpoint,self.filesystem,100,109,json.dumps(self.config)))
        self.db.execute('INSERT INTO namespaces VALUES(?,?)', (self.endpoint,json.dumps([{'device':'1','inode':str(i)} for i in [1,2,3]])))
        self.request = {'endpointId': self.endpoint, 'requestId': 'original', 'workspace': 'work', 'requestHash': 'a'*64, 'projectId': 100}
        self.add_operation(self.request)
        self.intent = {'request': self.request, 'snapshotHash': 'b'*64}
        self.db.execute('INSERT INTO repairs VALUES(?,?,?,?,?)', (self.endpoint,'repair','original',json.dumps(self.intent,sort_keys=True),'started'))

    def add_operation(self, request):
        self.db.execute('INSERT INTO operations VALUES(?,?,?,?,?,?,?)', (self.endpoint,request['requestId'],request['workspace'],self.filesystem,request['projectId'],json.dumps(request,sort_keys=True),'[null,null]'))

    def test_partial_records_are_preserved_without_claiming_restore(self):
        before = list(self.db.iterdump()), self.db.total_changes
        result = StorageHost.audit_backup_records(self.db)
        self.assertTrue(result['recordBindingsVerified']); self.assertEqual(result['unresolvedRepairs'],1)
        self.assertEqual(result['incompleteRootRecords'],1); self.assertFalse(result['restoreVerified'])
        self.assertFalse(result['liveFilesystemVerified'])
        self.assertEqual((list(self.db.iterdump()), self.db.total_changes),before)

    def test_mismatched_rows_duplicates_and_approvals_are_refused(self):
        for statement in ["UPDATE operations SET workspace='other'", "UPDATE operations SET filesystem='other'",
                          "INSERT INTO operations SELECT * FROM operations", "DELETE FROM namespaces",
                          "UPDATE repairs SET phase='unknown'", "INSERT INTO repairs SELECT * FROM repairs"]:
            with self.subTest(statement=statement):
                self.db.execute('SAVEPOINT invalid'); self.db.execute(statement)
                with self.assertRaises(RuntimeError): StorageHost.audit_backup_records(self.db)
                self.db.execute('ROLLBACK TO invalid'); self.db.execute('RELEASE invalid')
        changed = {**self.intent, 'request': {**self.request, 'requestHash': 'c'*64}}
        self.db.execute('UPDATE repairs SET intent=?', (json.dumps(changed),))
        with self.assertRaises(RuntimeError): StorageHost.audit_backup_records(self.db)

    def test_capacity_overflow_and_overlapping_ranges_are_refused(self):
        self.add_operation({**self.request,'requestId':'second','workspace':'two','projectId':101})
        StorageHost.audit_backup_records(self.db)
        self.add_operation({**self.request,'requestId':'third','workspace':'three','projectId':102})
        with self.assertRaises(RuntimeError): StorageHost.audit_backup_records(self.db)
        self.db.execute("DELETE FROM operations WHERE request='third'")
        other = {**self.config,'endpointId':'33333333-3333-4333-8333-333333333333'}
        self.db.execute('INSERT INTO endpoints VALUES(?,?,?,?,?)',(other['endpointId'],self.filesystem,100,109,json.dumps(other)))
        with self.assertRaises(RuntimeError): StorageHost.audit_backup_records(self.db)

if __name__ == '__main__': unittest.main()
