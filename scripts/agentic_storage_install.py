"""Explicit root-only installation; never enables, starts, or replaces a service."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import sys

from agentic_endpoint import storage_policy, identifier
from agentic_storage import protected, require
from agentic_storage_service import configuration


def encode(value):
    return (json.dumps(value, sort_keys=True, indent=2) + '\n').encode()


def safe_path(value):
    path = Path(value)
    require(path.is_absolute() and re.fullmatch(r'/[A-Za-z0-9_/-]+', str(value))
            and str(path) == str(value) and '..' not in path.parts and len(str(path)) < 1024)
    return path


def plan(directory, registry, config):
    directory, registry = safe_path(directory), safe_path(registry)
    require(isinstance(config, dict) and set(config) == {'endpointId', 'uid', 'gid', 'policy'})
    require(identifier(config['endpointId']))
    require(all(type(config[key]) is int and 1 <= config[key] <= 2 ** 31 - 1 for key in ('uid', 'gid')))
    policy = storage_policy(config['policy'])
    mount = safe_path(policy['mountRoot'])
    paths = [directory, registry, mount]
    require(all(not left.is_relative_to(right) for left in paths for right in paths if left != right)
            and len(set(paths)) == 3)
    endpoint = config['endpointId']
    name = 'agentic-storage-' + endpoint
    socket = '/run/' + name + '/host.sock'
    unit = f'''[Unit]
Description=Agentic OS storage host {endpoint}
RequiresMountsFor={mount} {registry} {directory}
After=local-fs.target

[Service]
Type=exec
User=root
Group=root
UMask=0077
RuntimeDirectory={name}
RuntimeDirectoryMode=0755
RuntimeDirectoryPreserve=no
ExecStart=/usr/bin/python3 -B {directory}/agentic_storage_service.py --config {directory}/host.json --registry {registry} --socket {socket}
Restart=no
KillMode=control-group
TimeoutStopSec=120
NoNewPrivileges=yes
RestrictAddressFamilies=AF_UNIX
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
'''
    source = Path(__file__).resolve().parent
    files = {file: (source / file).read_bytes() for file in ('agentic_storage.py', 'agentic_storage_service.py')}
    files['host.json'] = encode(config)
    files[name + '.service'] = unit.encode()
    files['endpoint-storage.json'] = encode({'storage': {'endpointId': endpoint, 'socketPath': socket, 'policy': policy}})
    manifest = {'schema': 1, 'directory': str(directory), 'registry': str(registry), 'unit': name + '.service',
                'files': {name: hashlib.sha256(content).hexdigest() for name, content in files.items()}}
    files['manifest.json'] = encode(manifest)
    return files, manifest


def sync_directory(path):
    descriptor = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def read_installed(path):
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(descriptor, 'rb') as stream:
        info = os.fstat(stream.fileno())
        require(stat.S_ISREG(info.st_mode) and info.st_uid == 0 and info.st_nlink == 1
                and stat.S_IMODE(info.st_mode) == 0o600 and info.st_size <= 1024 * 1024)
        return stream.read(1024 * 1024 + 1)


def install(directory, registry, config):
    require(sys.platform == 'linux' and os.getuid() == 0)
    files, manifest = plan(directory, registry, config)
    directory, registry = Path(directory), Path(registry)
    protected(directory.parent); protected(registry.parent)
    # Exclusive mkdir is the installation intent. An interrupted installation is preserved and refused.
    try:
        directory.mkdir(mode=0o700)
    except FileExistsError:
        protected(directory, private=True)
        require(set(item.name for item in directory.iterdir()) == set(files))
        require(all(read_installed(directory / name) == content for name, content in files.items()))
        protected(registry, private=True)
        return manifest
    sync_directory(directory.parent)
    try:
        registry.mkdir(mode=0o700)
        sync_directory(registry.parent)
    except FileExistsError:
        protected(registry, private=True)
    for name, content in files.items():
        descriptor = os.open(directory / name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(descriptor, 'wb') as stream:
            stream.write(content); stream.flush(); os.fsync(stream.fileno())
    sync_directory(directory)
    return manifest


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--directory', required=True)
    parser.add_argument('--registry', default='/var/lib/agentic-os-storage')
    parser.add_argument('--config', required=True)
    args = parser.parse_args()
    try:
        result = install(args.directory, args.registry, configuration(args.config))
        print(json.dumps({'installed': True, 'activated': False, 'unitFile': str(Path(args.directory) / result['unit'])}))
    except Exception:
        print('Storage installation refused; existing files and recovery records were preserved.', file=sys.stderr)
        raise SystemExit(1)
