"""Owned systemd user-service cgroup topology; never manages ancestor or unrelated groups."""
import os
from pathlib import Path
import shutil
import stat
import subprocess
import sys

CONTROLLERS = {'cpu', 'memory', 'pids'}
MOUNT = Path('/sys/fs/cgroup')


class Kernel:
    def mounted(self):
        if sys.platform != 'linux' or not any(line.split()[4] == str(MOUNT) and ' - cgroup2 ' in line
                                              for line in Path('/proc/self/mountinfo').read_text().splitlines()):
            raise RuntimeError('Delegated services require Linux with cgroup v2 mounted at /sys/fs/cgroup.')

    def group(self, pid='self'):
        values = [line[3:] for line in Path('/proc', str(pid), 'cgroup').read_text().splitlines() if line.startswith('0::')]
        if len(values) != 1 or not values[0].startswith('/') or '..' in Path(values[0]).parts:
            raise RuntimeError('Cannot establish the process cgroup identity.')
        return MOUNT / values[0].lstrip('/')

    def domain(self, path):
        info = path.lstat()
        if path.resolve() != path or not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or self.read(path / 'cgroup.type') != 'domain':
            raise RuntimeError('Delegation requires canonical, owned cgroup v2 domains.')

    def read(self, path):
        return path.read_text().strip()

    def write(self, path, value):
        with path.open('w') as stream:
            stream.write(value)

    def mkdir(self, path):
        path.mkdir(exist_ok=True)
        self.domain(path)


def scope(root, label, manager_group):
    base = MOUNT / manager_group.lstrip('/')
    if not manager_group.startswith('/') or len(manager_group) > 4096 or any(char in manager_group for char in '\x00\n\r') or base.name != 'init.scope' or '..' in base.parts or base.parent == MOUNT:
        raise RuntimeError('The user manager returned an unsupported cgroup topology.')
    unit = base.parent / 'app.slice' / label
    return {'schema': 1, 'unit': label, 'cgroup': str(unit), 'workerRoot': str(unit / 'worker-pool')}


def plan(root, label):
    kernel = Kernel()
    kernel.mounted()
    executable = shutil.which('systemctl')
    if not executable:
        raise RuntimeError('Delegated service setup requires the systemd user manager.')
    result = subprocess.run([executable, '--user', 'show', 'init.scope', '--property=ControlGroup', '--value'],
                            capture_output=True, text=True, timeout=15)
    if result.returncode:
        raise RuntimeError('Log in as the endpoint service user and make its systemd user manager available before initialization.')
    value = scope(root, label, result.stdout.strip())
    base = Path(value['cgroup']).parent.parent
    kernel.domain(base)
    if not CONTROLLERS <= set(kernel.read(base / 'cgroup.controllers').split()):
        raise RuntimeError('The user manager lacks CPU, memory or pids delegation. Have the host administrator delegate these controllers to user@' + str(os.getuid()) + '.service, then retry init.')
    return value


def validate(installation, label):
    value = installation.get('delegation')
    if value is None:
        return None
    if installation['role'] != 'endpoint' or not isinstance(value, dict) or set(value) != {'schema', 'unit', 'cgroup', 'workerRoot'}:
        raise RuntimeError('Invalid delegated service installation.')
    path = Path(value['cgroup'])
    if value['schema'] != 1 or value['unit'] != label or path.name != label or path.parent.name != 'app.slice' or not path.is_relative_to(MOUNT) or '..' in path.parts or str(path) != value['cgroup']:
        raise RuntimeError('Delegated service identity or cgroup path changed.')
    if value['workerRoot'] != str(path / 'worker-pool') or installation['endpointConfig'].get('resources', {}).get('cgroupRoot') != value['workerRoot']:
        raise RuntimeError('Endpoint resource policy differs from its delegated service.')
    return value


def prepare(value, kernel=None):
    kernel = kernel or Kernel()
    kernel.mounted()
    unit = Path(value['cgroup'])
    control, workers = unit / 'control', Path(value['workerRoot'])
    current = kernel.group()
    if current not in (unit, control):
        raise RuntimeError('Start this endpoint through its owned systemd service; the current process is outside its delegation.')
    kernel.domain(unit)
    if not CONTROLLERS <= set(kernel.read(unit / 'cgroup.controllers').split()):
        raise RuntimeError('The service did not receive CPU, memory and pids controllers; execution remains held.')
    direct = kernel.read(unit / 'cgroup.procs').split()
    if set(direct) - {str(os.getpid())}:
        raise RuntimeError('Other processes occupy the delegated parent; none were moved or killed.')
    kernel.mkdir(control)
    if current == unit:
        kernel.write(control / 'cgroup.procs', str(os.getpid()))
    if kernel.group() != control or str(os.getpid()) not in kernel.read(control / 'cgroup.procs').split():
        raise RuntimeError('Supervisor cgroup entry could not be verified.')
    if kernel.read(unit / 'cgroup.procs'):
        raise RuntimeError('Delegated parent still contains processes; controllers were not enabled.')
    kernel.write(unit / 'cgroup.subtree_control', '+cpu +memory +pids')
    if not CONTROLLERS <= set(kernel.read(unit / 'cgroup.subtree_control').split()):
        raise RuntimeError('Delegated controllers could not be enabled.')
    kernel.mkdir(workers)
    if kernel.read(workers / 'cgroup.procs') or not CONTROLLERS <= set(kernel.read(workers / 'cgroup.controllers').split()):
        raise RuntimeError('The worker subtree is not an empty delegated domain.')
    # Existing worker descendants and their limits belong to the endpoint. Do not remove or alter them here.
    return {'unit': value['unit'], 'control': str(control), 'workerRoot': str(workers)}


def process_inside(value, process, kernel=None):
    if process and (kernel or Kernel()).group(process['pid']) != Path(value['cgroup']) / 'control':
        raise RuntimeError('A matching Harness process exists outside the owned service; it was left intact.')


def drained(value, kernel=None):
    kernel = kernel or Kernel()
    kernel.mounted()
    unit = Path(value['cgroup'])
    try:
        kernel.domain(unit)
    except FileNotFoundError:
        return True  # The verified kernel mount remains; an absent cgroup cannot contain a process.
    fields = dict(line.split() for line in kernel.read(unit / 'cgroup.events').splitlines())
    if fields.get('populated') not in ('0', '1'):
        raise RuntimeError('Cannot verify service resource quiescence; its files were retained.')
    return fields['populated'] == '0'
