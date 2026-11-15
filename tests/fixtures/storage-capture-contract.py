"""Real subprocess/receipt failure checks; privilege dropping is exercised by native CI."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'scripts'))
import agentic_storage_capture as capture

EXPORTER = r'''
import hashlib,json,os,sqlite3,sys
from pathlib import Path
state,output=map(Path,sys.argv[1:3]);mode=(state/'mode').read_text()
if mode=='overflow': print('x'*70000);sys.exit(0)
if mode=='exit': sys.exit(7)
output.mkdir(mode=0o700);file=output/'endpoint.sqlite'
db=sqlite3.connect(file);db.execute('CREATE TABLE retained(id TEXT)');db.commit();db.close();file.chmod(0o600)
data=file.read_bytes()
receipt={'version':1,'endpointId':'11111111-1111-4111-8111-111111111111','writerLockHeld':True,
'workspaceFilesIncluded':False,'executionQuiescenceVerified':False,'hostRegistryIncluded':False,'restoreVerified':False,
'endpoint':{'path':str(file),'bytes':len(data),'sha256':hashlib.sha256(data).hexdigest()}}
if len(sys.argv)==4:
 receipt['handoff']={'captures':[{**item,'inventoryHash':'a'*64} for item in json.loads(sys.argv[3])],
 'sourceContentsRechecked':True,'executionQuiescenceVerified':False,'globalSnapshotVerified':False,'restoreVerified':False}
 if mode=='handoff-missing': del receipt['handoff']
 if mode=='handoff-id': receipt['handoff']['captures'][0]['requestId']='wrong'
 if mode=='handoff-digest': receipt['handoff']['captures'][0]['manifestHash']='b'*64
 if mode=='handoff-claim': receipt['handoff']['globalSnapshotVerified']=True
 if mode=='handoff-extra': receipt['handoff']['captures'][0]['extra']='untrusted'
if mode=='identity':receipt['endpointId']='22222222-2222-4222-8222-222222222222'
if mode=='hash':receipt['endpoint']['sha256']='f'*64
if mode=='size':receipt['endpoint']['bytes']+=1
if mode=='permissions':file.chmod(0o644)
if mode=='claim':receipt['restoreVerified']=True
if mode=='duplicate':print(json.dumps(receipt)[:-1]+',"endpointId":"11111111-1111-4111-8111-111111111111"}');sys.exit(0)
print(json.dumps(receipt))
'''

class Capture(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.base=Path(self.temp.name).resolve();self.state=self.base/'state';self.state.mkdir(mode=0o700)
        self.exporter=self.base/'export.py';self.exporter.write_text(EXPORTER)
        self.config={'uid':os.getuid(),'gid':os.getgid(),'endpointId':'11111111-1111-4111-8111-111111111111'}
        original=subprocess.Popen
        def launch(*args,**kwargs):
            self.assertEqual(kwargs.pop('user'),self.config['uid']);self.assertEqual(kwargs.pop('group'),self.config['gid'])
            self.assertEqual(kwargs.pop('extra_groups'),[])
            self.assertEqual(set(kwargs['env']),{'PATH','LC_ALL'});self.assertTrue(kwargs['close_fds'])
            return original(*args,**kwargs)
        self.patch=patch.object(capture.subprocess,'Popen',side_effect=launch);self.patch.start();self.addCleanup(self.patch.stop)
    def invoke(self,mode,selections=None):
        (self.state/'mode').write_text(mode)
        return capture.endpoint_capture(self.config,str(Path(sys.executable).resolve()),str(self.exporter),str(self.state),str(self.base/mode),selections)
    def test_validated_metadata_only(self):
        result=self.invoke('valid')
        self.assertTrue(result['artifactVerified']);self.assertFalse(result['restoreVerified'])
        self.assertEqual(result['endpointId'],self.config['endpointId'])
    def test_handoff_selection_and_receipt(self):
        selected=['11111111-1111-4111-8111-111111111111:'+('f'*64)]
        result=self.invoke('handoff-valid',selected)
        self.assertEqual(result['handoff']['captures'][0]['manifestHash'],'f'*64)
        self.assertFalse(result['handoff']['globalSnapshotVerified'])
        for mode in ['handoff-missing','handoff-id','handoff-digest','handoff-claim','handoff-extra']:
            with self.subTest(mode=mode),self.assertRaises((RuntimeError,ValueError)):self.invoke(mode,selected)
        for values in [[],selected*2,['invalid'],[selected[0]+':extra']]:
            with self.subTest(values=values),self.assertRaises((RuntimeError,ValueError)):capture.capture_selections(values)
    def test_rejects_changed_receipts_and_artifacts(self):
        for mode in ['identity','hash','size','permissions','claim','duplicate','overflow','exit']:
            with self.subTest(mode=mode),self.assertRaises((RuntimeError,ValueError)):self.invoke(mode)

if __name__=='__main__':unittest.main()
