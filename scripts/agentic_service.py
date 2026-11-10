"""Foreground supervision and opt-in per-user launchd/systemd installation.

Supervision restores the same Harness installation. It never resets Engine state, clears a manual
stop, replaces endpoint identity, or retries a live but unhealthy process. Service-manager files
contain paths and bounded lifecycle settings only; provider credentials stay in the Harness home.
"""
import fcntl
import hashlib
import json
import os
from pathlib import Path
import plistlib
import re
import shutil
import signal
import stat
import subprocess
import sys
import time


class Busy(RuntimeError):
    pass


def identity(pid):
    result = subprocess.run(['ps', '-p', str(pid), '-o', 'lstart='], env={**os.environ, 'LC_ALL': 'C'},
                            capture_output=True, text=True)
    return {'pid': pid, 'started': ' '.join(result.stdout.split())} if result.returncode == 0 and result.stdout.strip() else None


def snapshot(root, api):
    if not (root / 'supervision.json').exists():
        return None
    try:
        value = api.read_json(root / 'supervision.json')
        owner = value['supervisor']
        with api.private_log(root / 'supervisor.lock') as lock:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                running = False
            except BlockingIOError:
                running = identity(owner['pid']) == owner
        return {**value, 'running': running}
    except (OSError, ValueError, KeyError, TypeError, RuntimeError):
        return {'running': False, 'phase': 'unknown'}


def reset(root, api):
    # Only a successful explicit start/restart clears an automatic-recovery hold.
    (root / 'supervision-hold.json').unlink(missing_ok=True)
    if (root / 'supervision-attempts.json').exists():
        api.save(root / 'supervision-attempts.json', [])


def attempts(root, api):
    path = root / 'supervision-attempts.json'
    values = api.read_json(path) if path.exists() else []
    if not isinstance(values, list) or len(values) > 20 or any(type(item) not in (int, float) or not 0 < item < float('inf') for item in values):
        raise RuntimeError('Invalid automatic-start budget.')
    return values


def supervise(root, args, api):
    with api.private_log(root / 'supervisor.lock') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise RuntimeError('Another supervisor already owns this installation.') from None
        owner = identity(os.getpid())
        if not owner:
            raise RuntimeError('Cannot establish supervisor process identity.')
        shutdown = False
        def request_shutdown(_signum, _frame):
            nonlocal shutdown
            shutdown = True
        handlers = {sig: signal.signal(sig, request_shutdown) for sig in (signal.SIGTERM, signal.SIGINT)}
        args.respect_stop = True
        args.shutting_down = lambda: shutdown
        previous = None
        def report(phase, process=None, reason=None):
            nonlocal previous
            value = {'schema': 1, 'supervisor': owner, 'phase': phase, 'process': process, 'reason': reason}
            if value != previous:
                api.save(root / 'supervision.json', value)
                previous = value
        def hold(reason):
            api.save(root / 'supervision-hold.json', {'reason': reason})
            report('held', reason=reason)
        def observe():
            installation = api.manifest(root)
            process = api.single(root, installation)
            if (root / 'manually-stopped').exists():
                report('manually-stopped', process)
            elif (root / 'supervision-hold.json').exists():
                report('held', process, api.read_json(root / 'supervision-hold.json')['reason'])
            elif process:
                # Health/setup/model errors are reported by status, not treated as process death.
                report('running', process)
            else:
                return installation
            return None
        try:
            report('starting')
            while not shutdown:
                try:
                    if observe():
                        with api.operation(root):
                            installation = observe()
                            if not installation:
                                continue
                            now = time.time()
                            history = attempts(root, api)
                            if any(item > now + 1 for item in history):
                                hold('clock-moved-backwards')
                            else:
                                recent = [item for item in history if now - item < args.restart_window]
                                if len(recent) >= args.restart_limit:
                                    hold('automatic-start-budget-exhausted')
                                elif history and now - max(history) < args.restart_delay:
                                    report('backoff')
                                else:
                                    api.save(root / 'supervision-attempts.json', [*recent, now])
                                    report('starting')
                                    try:
                                        api.launch(root, installation, args)
                                    except (OSError, ValueError, KeyError, TypeError, RuntimeError, subprocess.CalledProcessError):
                                        if not shutdown:
                                            # Failed starts leave any live process intact. Operator inspection is required.
                                            hold('startup-failed-check-private-log-and-status')
                                    else:
                                        report('running', api.single(root, api.manifest(root)))
                except Busy:
                    pass  # An explicit operation controls startup/shutdown; never race its lock.
                except (OSError, ValueError, KeyError, TypeError, RuntimeError, subprocess.CalledProcessError):
                    hold('installation-or-process-identity-needs-review')
                if not shutdown:
                    time.sleep(0.25)
            deadline = time.monotonic() + args.stop_timeout
            while True:
                try:
                    with api.operation(root):
                        report('stopping')
                        api.stop(root, api.manifest(root), args, intentional=False)
                        report('stopped')
                        return 0
                except Busy:
                    if time.monotonic() >= deadline:
                        report('held', reason='shutdown-operation-lock-timeout-process-left-intact')
                        return 1
                    time.sleep(0.25)
                except (OSError, ValueError, KeyError, TypeError, RuntimeError, subprocess.CalledProcessError):
                    report('held', reason='graceful-shutdown-failed-process-left-intact')
                    return 1
        finally:
            for sig, handler in handlers.items():
                signal.signal(sig, handler)


def service_identity(root):
    platform = sys.platform
    suffix = hashlib.sha256(str(root).encode()).hexdigest()[:24]
    if platform == 'darwin':
        label = 'dev.agenticos.' + suffix
        path = Path.home() / 'Library' / 'LaunchAgents' / (label + '.plist')
    elif platform.startswith('linux'):
        label = 'agentic-os-' + suffix + '.service'
        config = Path(os.environ.get('XDG_CONFIG_HOME', str(Path.home() / '.config')))
        if not config.is_absolute():
            raise RuntimeError('XDG_CONFIG_HOME must be absolute for a user service.')
        path = config / 'systemd' / 'user' / label
    else:
        raise RuntimeError('Login/boot services require macOS launchd or Linux systemd.')
    return {'schema': 1, 'root': str(root), 'platform': platform, 'label': label, 'path': str(path)}


def settings(root, args):
    result = service_identity(root)
    source = os.environ.get('PATH', '')
    if not source or any(char in source for char in '\n\r\x00'):
        raise RuntimeError('Service PATH must contain valid executable directories.')
    # pnpm adds a relative .bin directory. Resolve it at installation time, never against the service's cwd.
    search = os.pathsep.join(dict.fromkeys(str(Path(part).resolve()) for part in source.split(os.pathsep) if part))
    python = str(Path(sys.executable).resolve())
    if any(char in result['path'] + str(root) + python for char in '\n\r\x00'):
        raise RuntimeError('Service paths cannot contain newlines or NUL.')
    if str(root).endswith('\\') or str(root).rstrip() != str(root):
        raise RuntimeError('Service installation paths cannot end in whitespace or a backslash.')
    argv = [python, str(root / 'service-runtime' / 'agentic-os'), 'supervise', '--directory', str(root),
            '--timeout', str(args.timeout), '--stop-timeout', str(args.stop_timeout),
            '--restart-delay', str(args.restart_delay), '--restart-limit', str(args.restart_limit), '--restart-window', str(args.restart_window)]
    return {**result, 'argv': argv,
            'environment': {'PATH': search, 'PYTHONUNBUFFERED': '1'}, 'stopTimeout': args.stop_timeout}


def unit_quote(value, command=False):
    # systemd has its own syntax, not shell syntax. Escape specifiers and ExecStart variable expansion.
    value = value.replace('%', '%%').replace('\\', '\\\\').replace('"', '\\"')
    if command:
        value = value.replace('$', '$$')
    return '"' + value + '"'


def definition(value):
    root = Path(value['root'])
    if value['platform'] == 'darwin':
        return plistlib.dumps({'Label': value['label'], 'ProgramArguments': value['argv'], 'WorkingDirectory': str(root),
            'EnvironmentVariables': value['environment'], 'RunAtLoad': True, 'KeepAlive': True,
            'ThrottleInterval': 10, 'ExitTimeOut': int(value['stopTimeout']) + 15, 'AbandonProcessGroup': True,
            'Umask': 0o077, 'ProcessType': 'Standard',
            'StandardOutPath': str(root / 'service.log'), 'StandardErrorPath': str(root / 'service.log')}, sort_keys=True).decode()
    return '\n'.join(['[Unit]', 'Description=Agentic OS Harness supervisor', 'StartLimitIntervalSec=300', 'StartLimitBurst=5', '',
        '[Service]', 'Type=simple', 'WorkingDirectory=' + str(root).replace('%', '%%'),
        'ExecStart=' + ' '.join(unit_quote(part, command=True) for part in value['argv']),
        *['Environment=' + unit_quote(key + '=' + content) for key, content in value['environment'].items()],
        'UMask=0077', 'Restart=always', 'RestartSec=10', 'KillMode=mixed', 'SendSIGKILL=no',
        'TimeoutStopSec=' + str(value['stopTimeout'] + 15),
        'StandardOutput=append:' + str(root / 'service.log').replace('%', '%%'),
        'StandardError=append:' + str(root / 'service.log').replace('%', '%%'), '', '[Install]', 'WantedBy=default.target', ''])


def destination(path):
    # Existing shared user configuration directories need not be 0700, but must not be writable by others.
    for entry in [*reversed(path.parent.parents), path.parent]:
        if not entry.exists():
            entry.mkdir(mode=0o700)
        info = entry.lstat()
        if stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode) or (info.st_mode & 0o022 and not info.st_mode & stat.S_ISVTX):
            raise RuntimeError('Service configuration has an unsafe parent directory.')
    if path.parent.stat().st_uid != os.getuid():
        raise RuntimeError('Service configuration directory must belong to the current user.')


def verified(root, api, allow_missing=False):
    value = api.read_json(root / 'service.json')
    expected = service_identity(root)
    if any(value.get(key) != expected[key] for key in ('schema', 'root', 'platform', 'label', 'path')):
        raise RuntimeError('Service receipt belongs to a different installation or platform.')
    path = Path(value['path'])
    content = definition(value)
    if hashlib.sha256(content.encode()).hexdigest() != value.get('definitionHash'):
        raise RuntimeError('Service definition was changed; it was left intact.')
    if not allow_missing or path.exists() or path.is_symlink():
        info = path.lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077 or info.st_nlink != 1:
            raise RuntimeError('Service definition must be an owner-only regular file.')
        if path.read_text() != content:
            raise RuntimeError('Service definition was changed; it was left intact.')
    if set(value.get('runtimeHashes', {})) != {'agentic-os', 'agentic_endpoint.py', 'agentic_service.py'}:
        raise RuntimeError('Service runtime receipt is incomplete.')
    for name, digest in value['runtimeHashes'].items():
        if name not in ('agentic-os', 'agentic_endpoint.py', 'agentic_service.py'):
            raise RuntimeError('Unexpected service runtime file.')
        file = root / 'service-runtime' / name
        info = file.lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077 or info.st_nlink != 1 or hashlib.sha256(file.read_bytes()).hexdigest() != digest:
            raise RuntimeError('Installed service runtime was changed; it was left intact.')
    return value


def manager(value, arguments, api, required=True):
    executable = '/bin/launchctl' if value['platform'] == 'darwin' else shutil.which('systemctl')
    if not executable:
        raise RuntimeError('systemctl is unavailable; use supervise under your host service manager.')
    command = [executable, *arguments] if value['platform'] == 'darwin' else [executable, '--user', *arguments]
    try:
        result = subprocess.run(command, stdin=subprocess.DEVNULL, capture_output=True, text=True,
                                timeout=max(30, value['stopTimeout'] + 20))
    except subprocess.TimeoutExpired:
        raise RuntimeError('Service manager observation timed out. Check service-status before retrying; application state was retained.') from None
    if required and result.returncode:
        with api.private_log(Path(value['root']) / 'service-manager.log') as log:
            log.write((result.stdout + result.stderr).encode())
        raise RuntimeError('Service manager command failed; inspect the private service-manager.log. Existing state was retained.')
    return result


def loaded(value, api):
    if value['platform'] == 'darwin':
        result = manager(value, ['print', 'gui/' + str(os.getuid()) + '/' + value['label']], api, required=False)
        if result.returncode:
            return {'loaded': False}
        match = re.search(r'^\s*path = (.+)$', result.stdout, re.M)
        if not match or match.group(1).strip() != value['path']:
            raise RuntimeError('Loaded launchd job has a different definition; it was left intact.')
        return {'loaded': True}
    result = manager(value, ['show', value['label'], '--property=LoadState,ActiveState,FragmentPath,UnitFileState'], api, required=False)
    properties = dict(line.split('=', 1) for line in result.stdout.splitlines() if '=' in line)
    if result.returncode and not properties:
        raise RuntimeError('The systemd user manager is unavailable; log in on the Linux host and check its user session.')
    if properties.get('LoadState') == 'loaded' and properties.get('FragmentPath') != value['path']:
        raise RuntimeError('Loaded systemd unit has a different definition; it was left intact.')
    return {'loaded': properties.get('LoadState') == 'loaded', 'active': properties.get('ActiveState'), 'enabled': properties.get('UnitFileState') == 'enabled'}


def manage(root, args, api):
    with api.private_log(root / 'service-operation.lock') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise RuntimeError('Another service operation is already controlling this installation.') from None
        receipt = root / 'service.json'
        if args.action == 'service-status':
            if not receipt.exists():
                print(json.dumps({'installed': False, 'supervision': snapshot(root, api)}))
                return 0
            value = verified(root, api)
            print(json.dumps({'installed': True, 'label': value['label'], 'file': value['path'], **loaded(value, api), 'supervision': snapshot(root, api)}))
            return 0
        if args.action == 'service-install':
            value = settings(root, args)
            if receipt.exists():
                existing = verified(root, api, allow_missing=True)
                if any(existing[key] != value[key] for key in value):
                    raise RuntimeError('Existing service settings differ; remove the existing service before changing them.')
                value = existing
                if not Path(value['path']).exists():
                    destination(Path(value['path']))
                    api.atomic(Path(value['path']), definition(value))
            else:
                target = Path(value['path'])
                destination(target)
                if target.exists() or target.is_symlink():
                    raise RuntimeError('An unclaimed service definition exists; it was left intact.')
                if loaded(value, api)['loaded']:
                    raise RuntimeError('An unclaimed service is already loaded; it was left intact.')
                runtime = root / 'service-runtime'
                api.private_directory(runtime)
                hashes = {}
                for name in ('agentic-os', 'agentic_endpoint.py', 'agentic_service.py'):
                    content = (Path(api.__file__).resolve().parent / name).read_text()
                    api.atomic(runtime / name, content)
                    hashes[name] = hashlib.sha256(content.encode()).hexdigest()
                content = definition(value)
                value.update({'definitionHash': hashlib.sha256(content.encode()).hexdigest(), 'runtimeHashes': hashes})
                # The receipt is written first so a manager failure is resumable; no existing service is adopted.
                api.save(receipt, value)
                api.atomic(target, content)
            with api.private_log(root / 'service.log'):
                pass
            current = loaded(value, api)
            if value['platform'] == 'darwin':
                if not current['loaded']:
                    manager(value, ['bootstrap', 'gui/' + str(os.getuid()), value['path']], api)
            else:
                manager(value, ['daemon-reload'], api)
                manager(value, ['enable', '--now', value['label']], api)
            print(json.dumps({'installed': True, 'label': value['label'], 'file': value['path'], **loaded(value, api),
                              'scope': 'login' if value['platform'] == 'darwin' else 'user-session; boot requires loginctl enable-linger',
                              'manuallyStopped': (root / 'manually-stopped').exists()}))
            return 0
        if not receipt.exists():
            print(json.dumps({'removed': False, 'reason': 'No owned service installation.'}))
            return 0
        value = verified(root, api)
        current = loaded(value, api)
        with api.operation(root):
            api.stop(root, api.manifest(root), args, intentional=True)
        if value['platform'] == 'darwin':
            if current['loaded']:
                manager(value, ['bootout', 'gui/' + str(os.getuid()) + '/' + value['label']], api)
        else:
            manager(value, ['disable', '--now', value['label']], api)
        deadline = time.monotonic() + value['stopTimeout'] + 15
        while (snapshot(root, api) or {}).get('running') or (value['platform'] == 'darwin' and loaded(value, api)['loaded']):
            if time.monotonic() >= deadline:
                raise RuntimeError('Service removal is still pending; its definition and receipt were retained. Check service-status before retrying.')
            time.sleep(0.1)
        # Recheck our exact files before removal. Never remove changed/unrelated definitions.
        verified(root, api)
        Path(value['path']).unlink()
        receipt.unlink()
        if value['platform'] != 'darwin':
            manager(value, ['daemon-reload'], api)
        print(json.dumps({'removed': True, 'manuallyStopped': True, 'dataRetained': True}))
        return 0
