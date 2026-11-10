"""Linux execution-endpoint support for the private Agentic OS launcher."""
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import sqlite3
import stat
import sys
import urllib.parse
import urllib.request
import uuid

SYSTEM_MOUNTS = ('/usr', '/bin', '/sbin', '/lib', '/lib64', '/etc', '/dev', '/proc')


def validate_directory(root, config=None):
    if any(root.is_relative_to(Path(path)) for path in SYSTEM_MOUNTS):
        raise RuntimeError('Endpoint installations must be outside the system runtime mounts.')
    if config and config.get('ownership'):
        credential = Path(config['ownership']['credentialFile']).resolve()
        if credential.is_relative_to(root / 'workspaces') or any(credential.is_relative_to(Path(path)) for path in SYSTEM_MOUNTS):
            raise RuntimeError('Ownership credentials must be outside endpoint workspaces and system runtime mounts.')


def require_host():
    if sys.platform != 'linux':
        raise RuntimeError('Execution endpoints require Linux with bubblewrap; there is no unconfined fallback.')
    if not shutil.which('bwrap'):
        raise RuntimeError('Install bubblewrap on the Linux execution host before initializing or starting an endpoint.')
    node = shutil.which('node')
    if not node or not any(Path(node).resolve().is_relative_to(Path(root)) for root in ('/usr', '/bin', '/sbin', '/lib', '/lib64')):
        raise RuntimeError('Endpoint Node.js must be installed inside the system runtime mounts, such as /usr/local/bin/node.')


def private_bytes(path, maximum=4096):
    descriptor = os.open(str(path), os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(descriptor, 'rb') as stream:
        info = os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077 or info.st_nlink != 1 or info.st_size > maximum:
            raise RuntimeError('Endpoint credentials must be owner-only regular files with one link.')
        content = stream.read(maximum + 1)
        after = os.fstat(stream.fileno())
        if len(content) > maximum or (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns) != (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns):
            raise RuntimeError('Endpoint credential changed while reading it.')
        return content


def configuration(value):
    if not isinstance(value, dict) or set(value) - {'allowedEnv', 'maxRunning', 'outputMaxBytes', 'ownership'}:
        raise RuntimeError('Endpoint configuration accepts only allowedEnv, maxRunning, outputMaxBytes and ownership.')
    result = {'allowedEnv': value.get('allowedEnv', []), 'maxRunning': value.get('maxRunning', 8), 'outputMaxBytes': value.get('outputMaxBytes', 8388608)}
    if not isinstance(result['allowedEnv'], list) or len(result['allowedEnv']) > 100 or not all(isinstance(name, str) and re.fullmatch(r'[A-Za-z_][A-Za-z0-9_]{0,99}', name) for name in result['allowedEnv']):
        raise RuntimeError('Endpoint allowedEnv must be a bounded list of environment variable names.')
    if type(result['maxRunning']) is not int or not 1 <= result['maxRunning'] <= 32 or type(result['outputMaxBytes']) is not int or not 65536 <= result['outputMaxBytes'] <= 67108864:
        raise RuntimeError('Endpoint limits require 1–32 running commands and 64 KiB–64 MiB retained output per stream.')
    if 'ownership' in value:
        owner = value['ownership']
        keys = {'url', 'authorityId', 'coordinatorId', 'resourceId', 'credentialFile', 'timeoutMs'}
        if not isinstance(owner, dict) or set(owner) - keys or keys - {'timeoutMs'} - set(owner):
            raise RuntimeError('Endpoint ownership requires the complete authority/resource binding.')
        if not all(isinstance(owner[key], str) and owner[key] for key in keys - {'timeoutMs'}):
            raise RuntimeError('Endpoint ownership binding fields must be nonempty strings.')
        if len(owner['url']) > 2048 or any(char.isspace() for char in owner['url']):
            raise RuntimeError('Invalid ownership authority URL.')
        url = urllib.parse.urlsplit(owner['url'])
        if url.username or url.password or url.path not in ('', '/') or url.query or url.fragment or not url.hostname or not (url.scheme == 'https' or (url.scheme == 'http' and url.hostname == '127.0.0.1')):
            raise RuntimeError('Ownership authority must use HTTPS or an authenticated loopback tunnel.')
        uuid.UUID(owner['authorityId'])
        if not all(isinstance(owner[key], str) and re.fullmatch(r'[A-Za-z0-9_-]{1,100}', owner[key]) for key in ('coordinatorId', 'resourceId')):
            raise RuntimeError('Invalid ownership coordinator or resource identifier.')
        if not isinstance(owner['credentialFile'], str) or not Path(owner['credentialFile']).is_absolute():
            raise RuntimeError('Ownership credentialFile must be an absolute private-file path.')
        private_bytes(Path(owner['credentialFile']))
        timeout = owner.get('timeoutMs', 5000)
        if type(timeout) is not int or not 100 <= timeout <= 60000:
            raise RuntimeError('Ownership timeout must be between 100 and 60000 milliseconds.')
        result['ownership'] = {**owner, 'timeoutMs': timeout}
    return result


def launch_patch(root, installation):
    return [
        {'id': 'webserver', 'config': {'host': '127.0.0.1', 'port': installation['port']}},
        {'id': 'dsh-superagent', 'disabled': True},
        {'id': 'dsh-superagent-github', 'disabled': True}, {'id': 'dsh-superagent-feishu', 'disabled': True},
        {'id': 'session-title-llm', 'disabled': True},
        {'insert': [{'id': 'agentic-execution-endpoint', 'name': 'dsh-superagent/remote-endpoint',
                     'config': {'stateDir': str(root / 'state'), 'workspaceRoot': str(root / 'workspaces'), **installation['endpointConfig']}}]},
    ]


def health(root, installation, no_redirect):
    """Verify the native daemon against its private local journal, then its saved first-start pin."""
    try:
        secret = private_bytes(root / 'state' / 'admin.token').decode('ascii').strip()
        if not re.fullmatch(r'[A-Za-z0-9_-]{43,}', secret):
            return None
        fingerprint = hashlib.sha256(secret.encode()).hexdigest()
        database = root / 'state' / 'endpoint.sqlite'
        info = database.lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
            return None
        connection = sqlite3.connect(database.as_uri() + '?mode=ro', uri=True, timeout=1)
        try:
            row = connection.execute("SELECT value FROM endpoint_meta WHERE key='id'").fetchone()
        finally:
            connection.close()
        identity = str(uuid.UUID(row[0])) if row else None
        if not identity or ('endpointId' in installation and (installation['endpointId'] != identity or installation.get('adminHash') != fingerprint)):
            return None
        request = urllib.request.Request('http://127.0.0.1:' + str(installation['port']) + '/execution/v1',
            data=b'{"op":"identity"}', headers={'authorization': 'Bearer ' + secret, 'content-type': 'application/json', 'x-dsh-endpoint': identity})
        with urllib.request.build_opener(urllib.request.ProxyHandler({}), no_redirect()).open(request, timeout=2) as response:
            content = response.read(16385)
        if len(content) > 16384:
            return None
        envelope = json.loads(content)
        result = envelope.get('result', {})
        capabilities = result.get('capabilities', {})
        if envelope.get('endpointId') != identity or result.get('id') != identity or result.get('protocol') != 1 or result.get('platform') != 'linux' or result.get('confinement') != 'linux-bubblewrap':
            return None
        if not all(capabilities.get(key) is True for key in ('filesystem', 'process', 'administration', 'effectOwnership', 'credentialBindings', 'snapshotVerification')):
            return None
        expected = installation['endpointConfig'].get('ownership')
        if result.get('ownership') != ({key: expected[key] for key in ('authorityId', 'coordinatorId', 'resourceId')} if expected else None):
            return None
        return {'health': {'runtime': {'state': 'ready'}}, 'setup': {'machine': {'stateDir': str(root / 'state')}, 'problem': None},
                'endpoint': {'id': identity, 'protocol': 1, 'platform': 'linux', 'confinement': 'linux-bubblewrap'}, 'adminHash': fingerprint}
    except (OSError, ValueError, TypeError, KeyError, AttributeError, RuntimeError, sqlite3.Error):
        return None


def enrollment(root, installation, current):
    if not current or not installation.get('endpointId') or current['endpoint']['id'] != installation['endpointId']:
        raise RuntimeError('Start and verify this endpoint before exporting enrollment details.')
    result = {'endpointId': installation['endpointId'], 'url': 'http://127.0.0.1:' + str(installation['port']),
            'credentialFile': str(root / 'state' / 'admin.token'), 'platform': 'linux', 'confinement': 'linux-bubblewrap',
            'maxRunning': installation['endpointConfig']['maxRunning'], 'outputMaxBytes': installation['endpointConfig']['outputMaxBytes'],
            'transport': 'For another host, use an authenticated tunnel or HTTPS and transport the credential into a private file on the coordinator.'}
    if 'ownership' in installation['endpointConfig']:
        result['ownership'] = {key: installation['endpointConfig']['ownership'][key] for key in ('authorityId', 'coordinatorId', 'resourceId')}
    return result
