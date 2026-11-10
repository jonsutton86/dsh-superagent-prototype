"""Pinned, loopback-only OpenSSH transport for an enrolled execution endpoint."""
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import urllib.parse
import urllib.request
import uuid
import agentic_endpoint

VERSION = 'ssh-1'


def digest(content):
    return hashlib.sha256(content).hexdigest()


def path(value):
    if not isinstance(value, str) or not Path(value).is_absolute() or any(char in value for char in '\x00\n\r') or '${' in value:
        raise RuntimeError('Transport paths must be absolute and cannot contain newlines, NUL or SSH environment expansions.')
    current = Path(value)
    if current.resolve() != current:
        raise RuntimeError('Transport paths must be canonical, without symbolic links.')
    return current


def credential(file):
    secret = agentic_endpoint.private_bytes(path(file)).decode('ascii').strip()
    if not re.fullmatch(r'[A-Za-z0-9_-]{43,}', secret):
        raise RuntimeError('Use the endpoint administrator credential in a private local file.')
    return secret


def configuration(source, api):
    required = {'host', 'user', 'identityFile', 'knownHostsFile', 'credentialFile', 'enrollmentFile'}
    if not isinstance(source, dict) or set(source) - required - {'sshPort'} or required - set(source):
        raise RuntimeError('Transport configuration requires host, user, identityFile, knownHostsFile, credentialFile and enrollmentFile; sshPort is optional.')
    if not isinstance(source['host'], str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9.:-]{0,252}', source['host']):
        raise RuntimeError('Use a literal SSH hostname or IP address, without SSH configuration aliases or options.')
    if not isinstance(source['user'], str) or not re.fullmatch(r'[A-Za-z_][A-Za-z0-9_-]{0,63}', source['user']):
        raise RuntimeError('Use an explicit SSH service-account name.')
    ssh_port = source.get('sshPort', 22)
    if type(ssh_port) is not int or not 1 <= ssh_port <= 65535:
        raise RuntimeError('SSH port must be between 1 and 65535.')
    for key in required - {'host', 'user'}:
        path(source[key])
    enrollment = api.read_json(Path(source['enrollmentFile']))
    if not isinstance(enrollment, dict) or set(enrollment) - {'file', 'endpointId', 'url', 'credentialFile', 'platform', 'confinement', 'maxRunning', 'outputMaxBytes', 'transport', 'ownership', 'resources'}:
        raise RuntimeError('Use enrollment metadata exported by the managed endpoint launcher.')
    if str(uuid.UUID(enrollment['endpointId'])) != enrollment['endpointId'] or enrollment['platform'] != 'linux' or enrollment['confinement'] != 'linux-bubblewrap':
        raise RuntimeError('Transport enrollment requires a pinned Linux bubblewrap endpoint.')
    url = urllib.parse.urlsplit(enrollment['url'])
    if url.scheme != 'http' or url.hostname != '127.0.0.1' or url.username or url.password or url.path not in ('', '/') or url.query or url.fragment or not url.port or not 1024 <= url.port <= 65535:
        raise RuntimeError('The remote endpoint must listen on an explicit unprivileged loopback port.')
    limits = agentic_endpoint.configuration({key: enrollment[key] for key in ('maxRunning', 'outputMaxBytes')})
    endpoint = {key: enrollment[key] for key in ('endpointId', 'platform', 'confinement')}
    endpoint.update(limits)
    endpoint.pop('allowedEnv')
    if 'ownership' in enrollment:
        owner = enrollment['ownership']
        if not isinstance(owner, dict) or set(owner) != {'authorityId', 'coordinatorId', 'resourceId'} or str(uuid.UUID(owner['authorityId'])) != owner['authorityId'] or not all(isinstance(owner[key], str) and re.fullmatch(r'[A-Za-z0-9_-]{1,100}', owner[key]) for key in ('coordinatorId', 'resourceId')):
            raise RuntimeError('Invalid endpoint ownership binding.')
        endpoint['ownership'] = owner
    if 'resources' in enrollment:
        resource = enrollment['resources']
        if not isinstance(resource, dict) or resource.get('kind') != 'linux-cgroup-v2' or resource.get('ready') is not True:
            raise RuntimeError('Enrollment must describe a ready resource boundary.')
        endpoint['resources'] = {'kind': 'linux-cgroup-v2', 'ready': True,
                                 'policy': agentic_endpoint.configuration({'resources': resource['policy']})['resources']}
    known = agentic_endpoint.private_bytes(Path(source['knownHostsFile']), 65536)
    if not known.strip() or b'\x00' in known:
        raise RuntimeError('Supply a nonempty, independently verified SSH known-hosts file.')
    key = agentic_endpoint.private_bytes(Path(source['identityFile']), 65536)
    if not key.strip():
        raise RuntimeError('Supply a dedicated SSH identity file.')
    return {'host': source['host'], 'user': source['user'], 'sshPort': ssh_port, 'remotePort': url.port,
            'identityFile': source['identityFile'], 'credentialFile': source['credentialFile'], 'endpoint': endpoint,
            'keyHash': digest(key), 'knownHostsHash': digest(known), 'adminHash': digest(credential(source['credentialFile']).encode())}, known


def quote(value):
    # OpenSSH expands percent tokens after parsing quotes. Environment expansions are rejected by path().
    return '"' + value.replace('%', '%%').replace('\\', '\\\\').replace('"', '\\"') + '"'


def ssh_config(root, value):
    transport = value['transport']
    return '\n'.join(['Host agentic-endpoint', 'HostName ' + transport['host'], 'User ' + transport['user'],
        'Port ' + str(transport['sshPort']), 'IdentityFile ' + quote(transport['identityFile']),
        'UserKnownHostsFile ' + quote(str(path(str(root / 'known_hosts')))), 'GlobalKnownHostsFile /dev/null',
        'LocalForward 127.0.0.1:' + str(value['port']) + ' 127.0.0.1:' + str(transport['remotePort']),
        'StrictHostKeyChecking yes', 'UpdateHostKeys no', 'VerifyHostKeyDNS no', 'CheckHostIP no',
        'IdentitiesOnly yes', 'IdentityAgent none', 'CertificateFile none', 'BatchMode yes',
        'PreferredAuthentications publickey', 'PasswordAuthentication no', 'KbdInteractiveAuthentication no',
        'HostbasedAuthentication no', 'ForwardAgent no', 'ForwardX11 no', 'PermitLocalCommand no',
        'ProxyCommand none', 'ProxyJump none', 'CanonicalizeHostname no', 'ControlMaster no', 'ControlPath none',
        'GatewayPorts no', 'ExitOnForwardFailure yes', 'ConnectTimeout 10', 'ConnectionAttempts 1',
        'ServerAliveInterval 15', 'ServerAliveCountMax 3', 'TCPKeepAlive no', 'LogLevel ERROR', ''])


def manifest(root, value, ready=True):
    if value.get('schema') != 1 or value.get('root') != str(root) or value.get('version') != VERSION or value.get('role') != 'transport' or value.get('profile') != 'agentic-transport' or value.get('checkout') != str(root):
        raise RuntimeError('Unsupported or relocated transport installation.')
    if type(value.get('port')) is not int or not 1024 <= value['port'] <= 65535 or not isinstance(value.get('transport'), dict):
        raise RuntimeError('Invalid transport installation.')
    path(value['cli'])
    if ready and value.get('phase') != 'ready':
        raise RuntimeError('Transport installation is incomplete; repeat init with its original configuration.')
    return value


def initialize(root, args, api):
    if not args.transport_config or any(item is not None for item in (args.checkout, args.dsh, args.profile, args.endpoint_config, args.service_resources)):
        raise RuntimeError('Transport init requires --transport-config and accepts --port, without Harness installation settings.')
    transport, known = configuration(api.read_json(Path(args.transport_config).expanduser()), api)
    port = args.port or 3085
    if not 1024 <= port <= 65535:
        raise RuntimeError('Transport loopback port must be between 1024 and 65535.')
    executable = shutil.which('ssh')
    if not executable:
        raise RuntimeError('Install OpenSSH before initializing an endpoint transport.')
    value = {'schema': 1, 'root': str(root), 'role': 'transport', 'version': VERSION, 'profile': 'agentic-transport',
             'phase': 'preparing', 'port': port, 'checkout': str(root), 'cli': str(Path(executable).resolve()), 'transport': transport}
    config = ssh_config(root, value)
    value['sshConfigHash'] = digest(config.encode())
    receipt = root / 'installation.json'
    if receipt.exists():
        previous = manifest(root, api.read_json(receipt), ready=False)
        if {**previous, 'phase': 'preparing'} != value:
            raise RuntimeError('Transport settings or trust pins differ; the existing installation was not changed.')
    elif any(item.name != 'operation.lock' for item in root.iterdir()):
        raise RuntimeError('Refusing to initialize an unclaimed nonempty transport directory.')
    else:
        api.save(receipt, value)
    for name, content in (('known_hosts', known.decode('utf8')), ('ssh.conf', config)):
        target = root / name
        if target.exists() and agentic_endpoint.private_bytes(target, 65536) != content.encode():
            raise RuntimeError('Transport trust/configuration files changed; they were retained for inspection.')
        api.atomic(target, content)
    api.private_directory(root / 'logs')
    value['phase'] = 'ready'
    api.save(receipt, value)
    print(json.dumps({'installed': True, 'role': 'transport', 'directory': str(root), 'url': 'http://127.0.0.1:' + str(port),
                      'next': 'Start or service-install, then export enrollment for the coordinator.'}))
    return 0


def validate(root, value):
    current = value['transport']
    if digest(agentic_endpoint.private_bytes(root / 'ssh.conf', 65536)) != value['sshConfigHash'] or (root / 'ssh.conf').read_text() != ssh_config(root, value):
        raise RuntimeError('SSH configuration changed; startup was refused.')
    for file, expected in ((root / 'known_hosts', current['knownHostsHash']), (path(current['identityFile']), current['keyHash'])):
        if digest(agentic_endpoint.private_bytes(file, 65536)) != expected:
            raise RuntimeError('SSH trust or identity changed; use an explicitly reviewed new installation.')
    if digest(credential(current['credentialFile']).encode()) != current['adminHash']:
        raise RuntimeError('Endpoint credential changed; use an explicitly reviewed new installation.')


def command(root, value):
    return [value['cli'], '-F', str(root / 'ssh.conf'), '-N', '-T', 'agentic-endpoint']


def health(root, value, no_redirect):
    try:
        validate(root, value)
        transport, endpoint = value['transport'], value['transport']['endpoint']
        request = urllib.request.Request('http://127.0.0.1:' + str(value['port']) + '/execution/v1', data=b'{"op":"identity"}',
            headers={'authorization': 'Bearer ' + credential(transport['credentialFile']), 'content-type': 'application/json', 'x-dsh-endpoint': endpoint['endpointId']})
        with urllib.request.build_opener(urllib.request.ProxyHandler({}), no_redirect()).open(request, timeout=2) as response:
            content = response.read(16385)
        if len(content) > 16384:
            return None
        envelope = json.loads(content)
        result = envelope.get('result', {})
        if envelope.get('error') is not None or envelope.get('endpointId') != endpoint['endpointId'] or result.get('id') != endpoint['endpointId'] or result.get('protocol') != 1 or result.get('platform') != 'linux' or result.get('confinement') != 'linux-bubblewrap':
            return None
        if not all(result.get('capabilities', {}).get(key) is True for key in ('filesystem', 'process', 'administration', 'effectOwnership', 'credentialBindings', 'snapshotVerification')):
            return None
        observed_resources = result.get('resources')
        resource_pin = {key: observed_resources.get(key) for key in ('kind', 'ready', 'policy')} if isinstance(observed_resources, dict) else observed_resources
        if result.get('ownership') != endpoint.get('ownership') or resource_pin != endpoint.get('resources'):
            return None
        return {'health': {'runtime': {'state': 'ready'}}, 'endpoint': {**endpoint, **({'resources': observed_resources} if observed_resources else {})}}
    except (OSError, ValueError, TypeError, KeyError, AttributeError, RuntimeError):
        return None


def enrollment(root, value, current):
    if not current:
        raise RuntimeError('Start and verify this transport before exporting enrollment details.')
    return {**current['endpoint'], 'url': 'http://127.0.0.1:' + str(value['port']),
            'credentialFile': value['transport']['credentialFile'], 'transport': 'managed-ssh', 'transportDirectory': str(root)}
