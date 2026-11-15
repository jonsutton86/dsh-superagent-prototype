"""Root operator orchestration. The Node exporter always runs without root privileges."""
import hashlib
import json
import os
from pathlib import Path
import re
import selectors
import signal
import stat
import subprocess
import time

from agentic_storage import require


def capture_selections(values):
    require(isinstance(values, list) and 1 <= len(values) <= 256)
    selected = []
    for value in values:
        require(isinstance(value, str) and re.fullmatch(r'[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}:[a-f0-9]{64}', value))
        request, digest = value.split(':')
        selected.append({'requestId': request, 'manifestHash': digest})
    require(len({item['requestId'] for item in selected}) == len(selected))
    return selected


def endpoint_capture(config, node, exporter, state, output, selections=None):
    selected = capture_selections(selections) if selections is not None else None
    paths = [Path(value) for value in [node, exporter, state, output]]
    require(all(path.is_absolute() and str(path) == os.path.realpath(path) for path in paths))
    node, exporter, state, output = paths
    require(node.is_file() and exporter.is_file() and state.is_dir() and not output.exists())
    # No inherited credentials, shell, supplementary groups, or root-owned execution.
    process = subprocess.Popen([str(node), str(exporter), str(state), str(output), *([json.dumps(selected)] if selected is not None else [])],
        stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
        env={'PATH': '/usr/local/bin:/usr/bin:/bin', 'LC_ALL': 'C'}, cwd='/',
        user=config['uid'], group=config['gid'], extra_groups=[], umask=0o077,
        start_new_session=True, close_fds=True)
    deadline = time.monotonic() + 120
    data = bytearray()
    try:
        with selectors.DefaultSelector() as selector:
            selector.register(process.stdout, selectors.EVENT_READ)
            while True:
                remaining = deadline - time.monotonic(); require(remaining > 0)
                events = selector.select(min(remaining, 1))
                if not events: continue
                chunk = os.read(process.stdout.fileno(), 8192)
                if not chunk: break
                data.extend(chunk); require(len(data) <= 65536)
        require(process.wait(timeout=max(0.01, deadline - time.monotonic())) == 0)
        def unique_object(items):
            result = {}
            for key, value in items:
                require(key not in result); result[key] = value
            return result
        receipt = json.loads(data, object_pairs_hook=unique_object)
        require(isinstance(receipt, dict) and type(receipt.get('version')) is int and receipt['version'] == 1
                and receipt.get('endpointId') == config['endpointId'] and receipt.get('writerLockHeld') is True
                and all(receipt.get(key) is False for key in ['workspaceFilesIncluded', 'executionQuiescenceVerified', 'hostRegistryIncluded', 'restoreVerified']))
        handoff = receipt.get('handoff')
        if selected is None:
            require(handoff is None)
        else:
            require(isinstance(handoff, dict) and set(handoff) == {'captures', 'sourceContentsRechecked', 'executionQuiescenceVerified', 'globalSnapshotVerified', 'restoreVerified'}
                    and handoff['sourceContentsRechecked'] is True
                    and all(handoff[key] is False for key in ['executionQuiescenceVerified', 'globalSnapshotVerified', 'restoreVerified']))
            observed = handoff['captures']
            require(isinstance(observed, list) and len(observed) == len(selected))
            for actual, expected in zip(observed, selected):
                require(isinstance(actual, dict) and set(actual) == {'requestId', 'manifestHash', 'inventoryHash'}
                        and all(actual[key] == value for key, value in expected.items())
                        and isinstance(actual['inventoryHash'], str) and re.fullmatch(r'[a-f0-9]{64}', actual['inventoryHash']))
        artifact = receipt.get('endpoint')
        require(isinstance(artifact, dict) and set(artifact) == {'path', 'bytes', 'sha256'})
        expected = output / 'endpoint.sqlite'
        require(artifact['path'] == str(expected) and str(expected) == os.path.realpath(expected)
                and type(artifact['bytes']) is int and 0 < artifact['bytes'] <= 1024 ** 4
                and isinstance(artifact['sha256'], str) and re.fullmatch(r'[a-f0-9]{64}', artifact['sha256']))
        descriptor = os.open(expected, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        try:
            before = os.fstat(descriptor)
            require(stat.S_ISREG(before.st_mode) and before.st_uid == config['uid'] and before.st_nlink == 1
                    and not before.st_mode & 0o077 and before.st_size == artifact['bytes'])
            digest = hashlib.sha256(); size = 0; header = b''
            while chunk := os.read(descriptor, 1024 * 1024):
                require(time.monotonic() < deadline)
                if not size: header = chunk[:20]
                size += len(chunk); require(size <= artifact['bytes']); digest.update(chunk)
            require(size == artifact['bytes'] and digest.hexdigest() == artifact['sha256']
                    and header[:16] == b'SQLite format 3\x00' and header[18:20] == b'\x01\x01')
            identity = lambda info: (info.st_dev, info.st_ino, info.st_size, info.st_mode, info.st_mtime_ns, info.st_ctime_ns)
            require(identity(before) == identity(os.fstat(descriptor)) == identity(expected.lstat()))
        finally:
            os.close(descriptor)
        # Return only validated fields, never arbitrary subprocess text or saved database rows.
        return {'endpointId': config['endpointId'], 'endpoint': artifact, 'writerLockHeld': True,
                'artifactVerified': True, 'executionQuiescenceVerified': False, 'restoreVerified': False,
                **({'handoff': handoff} if selected is not None else {})}
    except BaseException:
        try: os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError: pass
        process.wait()
        raise
    finally:
        process.stdout.close()
