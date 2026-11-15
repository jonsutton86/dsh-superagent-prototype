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
    config = configuration(args.config)
    value = configuration(args.request if args.action == 'inspect' else args.approval)
    if args.action == 'repair':
        require(isinstance(value, dict) and set(value) == {'request', 'repairId', 'snapshotHash'})
    host = StorageHost(args.registry, config, existing_only=True)
    try:
        if args.action == 'inspect':
            return {'ok': True, 'inspection': host.inspect(value)}
        result = host.repair(value['request'], value['repairId'], value['snapshotHash'])
        return {'ok': True, 'repairId': value['repairId'], 'requestId': value['request']['requestId'], 'observation': result}
    finally:
        host.close()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--config', required=True)
    parser.add_argument('--registry', required=True)
    actions = parser.add_subparsers(dest='action', required=True)
    actions.add_parser('inspect').add_argument('--request', required=True)
    actions.add_parser('repair').add_argument('--approval', required=True)
    args = parser.parse_args()
    try:
        print(json.dumps(execute(args), sort_keys=True))
        return 0
    except Exception:
        print(json.dumps({'ok': False, 'state': 'unverified',
                          'error': 'Storage inspection or repair refused. Preserve original request and repair IDs; inspect retained state before further action.'}), file=sys.stderr)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
