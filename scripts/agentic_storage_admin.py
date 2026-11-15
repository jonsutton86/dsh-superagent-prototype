"""Local root-operator inspection/repair. No daemon activation, new namespace, or implicit retry."""
import sys
sys.dont_write_bytecode = True
import argparse
import json
import os

from agentic_storage import StorageHost, require
from agentic_storage_service import configuration


def execute(args):
    require(os.getuid() == 0)
    if args.action in ['verify-backup', 'audit-backup']:
        return {'ok': True, 'backup': StorageHost.verify_backup(args.input, args.sha256, audit=args.action == 'audit-backup')}
    require(args.config is not None and args.registry is not None)
    config = configuration(args.config)
    value = None if args.action == 'backup' else configuration(args.request if args.action == 'inspect' else args.approval)
    if args.action == 'repair':
        require(isinstance(value, dict) and set(value) == {'request', 'repairId', 'snapshotHash'})
    if args.action == 'finish-repair':
        require(isinstance(value, dict) and set(value) == {'request', 'repairId', 'snapshotHash', 'finishSnapshotHash'})
    host = StorageHost(args.registry, config, existing_only=True)
    try:
        if args.action == 'backup':
            return {'ok': True, 'backup': host.backup(args.output)}
        if args.action == 'inspect':
            return {'ok': True, 'inspection': host.inspect(value)}
        result = (host.finish_repair(value['request'], value['repairId'], value['snapshotHash'], value['finishSnapshotHash'])
                  if args.action == 'finish-repair' else host.repair(value['request'], value['repairId'], value['snapshotHash']))
        return {'ok': True, 'repairId': value['repairId'], 'requestId': value['request']['requestId'], 'observation': result}
    finally:
        host.close()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--config')
    parser.add_argument('--registry')
    actions = parser.add_subparsers(dest='action', required=True)
    for action in ['verify-backup', 'audit-backup']:
        verify = actions.add_parser(action)
        verify.add_argument('--input', required=True)
        verify.add_argument('--sha256', required=True)
    actions.add_parser('backup').add_argument('--output', required=True)
    actions.add_parser('inspect').add_argument('--request', required=True)
    actions.add_parser('repair').add_argument('--approval', required=True)
    actions.add_parser('finish-repair').add_argument('--approval', required=True)
    args = parser.parse_args()
    try:
        print(json.dumps(execute(args), sort_keys=True))
        return 0
    except Exception:
        print(json.dumps({'ok': False, 'state': 'unverified',
                          'error': 'Storage operation refused; any backup output remains unverified. Preserve original request and repair IDs; inspect retained state before further action.'}), file=sys.stderr)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
