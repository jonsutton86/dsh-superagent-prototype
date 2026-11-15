"""Root-owned local storage service. Installation/activation is a separate operator action."""
import argparse
import contextlib
import datetime
import errno
import fcntl
import json
import os
from pathlib import Path
import signal
import socket
import stat
import struct
import time

from agentic_storage import StorageHost, protected, require


def strict_json(data):
    def unique(pairs):
        value = {}
        for key, item in pairs:
            require(key not in value)
            value[key] = item
        return value
    return json.loads(data, object_pairs_hook=unique)


def configuration(path):
    path = Path(path)
    protected(path.parent)
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, 'rb') as stream:
        info = os.fstat(stream.fileno())
        require(stat.S_ISREG(info.st_mode) and info.st_uid == 0 and info.st_nlink == 1 and not info.st_mode & 0o077 and info.st_size <= 16384)
        data = stream.read(16385)
        require(len(data) <= 16384)
        return strict_json(data)


def respond(host, connection):
    connection.settimeout(5)
    try:
        _, uid, _ = struct.unpack('3i', connection.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, struct.calcsize('3i')))
        require(uid == host.config['uid'])
        data = bytearray()
        deadline = time.monotonic() + 5
        # One length-bounded JSON request; EOF prevents accepting a valid prefix followed by extra commands.
        while True:
            remaining = deadline - time.monotonic()
            require(remaining > 0)
            connection.settimeout(remaining)
            part = connection.recv(4097 - len(data))
            if not part:
                break
            data.extend(part)
            require(len(data) <= 4096)
        value = strict_json(data)
        require(isinstance(value, dict) and set(value) == {'op', 'request'} and value['op'] in ['provision', 'observe'])
        request = value['request']
        require(isinstance(request, dict))
        result = host.provision(request) if value['op'] == 'provision' else host.observe(request)
        roots = host.roots(request)
        observation = {'mountId': result['mountId'], 'filesystemUUID': host.policy['filesystemUUID'],
            'mountRoot': host.policy['mountRoot'], 'projectId': request['projectId'],
            'directories': [{'path': str(path), **identity, 'projectId': request['projectId'], 'inherits': True, 'realtime': False}
                            for path, identity in zip(roots, result['roots'])],
            'quota': {**result['quota'], 'accounting': True, 'enforcement': True},
            'observedAt': datetime.datetime.now(datetime.timezone.utc).isoformat().replace('+00:00', 'Z')}
        reply = {'ok': True, 'endpointId': host.endpoint, 'requestId': request['requestId'],
                 'requestHash': request['requestHash'], 'observation': observation}
    except Exception:
        # Never return host paths, arbitrary command output, configuration or submitted text in errors.
        reply = {'ok': False, 'error': 'storage_host_refused'}
    try:
        connection.settimeout(1)
        connection.sendall(json.dumps(reply, separators=(',', ':')).encode())
    except OSError:
        pass  # Lost response does not undo or repeat an original host operation.


@contextlib.contextmanager
def listener_claim(path, gid):
    """Fence cooperating listeners; only reclaim an unchanged, refused root-owned socket."""
    protected(path.parent)
    require(path.is_absolute() and len(os.fsencode(path)) < 104)
    descriptor = os.open(str(path) + '.lock', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600)
    try:
        info = os.fstat(descriptor)
        require(stat.S_ISREG(info.st_mode) and info.st_uid == 0 and info.st_nlink == 1 and not info.st_mode & 0o077)
        fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        try:
            original = path.lstat()
        except FileNotFoundError:
            original = None
        if original is not None:
            require(stat.S_ISSOCK(original.st_mode) and original.st_uid == 0 and original.st_gid == gid
                    and stat.S_IMODE(original.st_mode) == 0o660 and original.st_nlink == 1)
            with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as probe:
                probe.settimeout(0.5)
                try:
                    probe.connect(str(path))
                except OSError as error:
                    require(error.errno == errno.ECONNREFUSED)
                else:
                    require(False)  # A live listener, including an older service, must never be displaced.
            current = path.lstat()
            require((current.st_dev, current.st_ino, current.st_mode, current.st_uid, current.st_gid, current.st_nlink)
                    == (original.st_dev, original.st_ino, original.st_mode, original.st_uid, original.st_gid, original.st_nlink))
            path.unlink()
        yield
    finally:
        os.close(descriptor)  # Keep the lock inode: unlinking it would let another process bypass the fence.


def serve(config_path, registry, socket_path):
    require(os.getuid() == 0)
    config = configuration(config_path)
    path = Path(socket_path)
    with listener_claim(path, config['gid']):
        serve_claimed(config, registry, path)


def serve_claimed(config, registry, path):
    host = StorageHost(registry, config)
    listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    bound = None
    stopping = False
    def stop(_number, _frame):
        nonlocal stopping
        stopping = True
    previous = {number: signal.signal(number, stop) for number in [signal.SIGTERM, signal.SIGINT]}
    try:
        old_mask = os.umask(0o077)
        try:
            listener.bind(str(path))
        finally:
            os.umask(old_mask)
        info = path.lstat(); bound = (info.st_dev, info.st_ino)
        os.chown(path, 0, config['gid']); os.chmod(path, 0o660)
        listener.listen(8); listener.settimeout(0.25)
        print('storage-host-ready', flush=True)
        while not stopping:
            try:
                connection, _ = listener.accept()
            except socket.timeout:
                continue
            with connection:
                respond(host, connection)
    finally:
        listener.close(); host.close()
        for number, handler in previous.items():
            signal.signal(number, handler)
        if bound and path.exists():
            info = path.lstat()
            if stat.S_ISSOCK(info.st_mode) and (info.st_dev, info.st_ino) == bound:
                path.unlink()


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--config', required=True)
    parser.add_argument('--registry', required=True)
    parser.add_argument('--socket', required=True)
    args = parser.parse_args()
    try:
        serve(args.config, args.registry, args.socket)
    except Exception:
        print('storage-host-unavailable', flush=True)
        raise SystemExit(1)
