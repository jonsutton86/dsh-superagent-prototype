"""Trusted Linux XFS provisioner library. Not installed, setuid, or exposed to agents.

The caller must be a privileged, authenticated host service with administrator-owned
configuration. A shared root-owned registry fences all managed endpoint ranges.
"""
import contextlib
import fcntl
import json
import os
from pathlib import Path
import re
import sqlite3
import stat
import subprocess
import uuid


def require(value):
    if not value:
        raise RuntimeError('Storage host policy or original operation could not be verified')


def number(value, minimum, maximum):
    require(type(value) is int and minimum <= value <= maximum)
    return value


def canonical(path):
    path = Path(path)
    require(path.is_absolute() and str(path) == os.path.realpath(path))
    require(re.fullmatch(r'/[A-Za-z0-9_/-]+', str(path)) and len(str(path)) <= 4096)
    return path


def protected(path, private=False):
    """Ancestors cannot be replaced by the endpoint user; root-owned sticky /tmp is allowed."""
    path = canonical(path)
    for item in [path, *path.parents]:
        info = item.lstat()
        require(stat.S_ISDIR(info.st_mode) and info.st_uid == 0)
        require(not info.st_mode & 0o022 or (item != path and info.st_mode & stat.S_ISVTX))
    if private:
        require(path.stat().st_mode & 0o077 == 0)
    return path


def run(program, *args):
    # Only fixed system tools; no shell, inherited PATH, environment credentials, or retries.
    executable = next((str(Path(directory) / program) for directory in ['/usr/sbin', '/usr/bin', '/sbin', '/bin']
                       if (Path(directory) / program).is_file()), None)
    require(executable is not None)
    result = subprocess.run([executable, *map(str, args)], env={'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'LC_ALL': 'C'},
                            capture_output=True, text=True, timeout=10)
    require(result.returncode == 0 and not result.stderr.strip() and len(result.stdout) <= 65536)
    return result.stdout


def quota_row(text, project):
    rows = [line.strip() for line in text.splitlines() if line.strip()]
    if not rows:
        return None
    require(len(rows) == 1)
    match = re.fullmatch(r'#?(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+\d+\s+\[[^\]]*\]\s+(\d+)\s+(\d+)\s+(\d+)\s+\d+\s+\[[^\]]*\]', rows[0])
    require(match and int(match[1]) == project)
    return {'usedBytes': int(match[2]) * 1024, 'hardBytes': int(match[4]) * 1024,
            'usedInodes': int(match[5]), 'hardInodes': int(match[7])}


class StorageHost:
    def __init__(self, registry, config):
        require(os.getuid() == 0)
        require(set(config) == {'endpointId', 'uid', 'gid', 'policy'})
        require(str(uuid.UUID(config['endpointId'])) == config['endpointId'])
        number(config['uid'], 1, 2 ** 31 - 1); number(config['gid'], 1, 2 ** 31 - 1)
        policy = config['policy']
        require(set(policy) == {'kind', 'filesystemUUID', 'mountRoot', 'projectIds', 'pool', 'workspace'})
        require(policy['kind'] == 'linux-xfs-project' and str(uuid.UUID(policy['filesystemUUID'])) == policy['filesystemUUID'])
        require(set(policy['projectIds']) == {'first', 'last'})
        first = number(policy['projectIds']['first'], 1, 2 ** 32 - 1)
        last = number(policy['projectIds']['last'], first, 2 ** 32 - 1)
        for name in ['pool', 'workspace']:
            require(set(policy[name]) == {'bytes', 'inodes'})
            require(number(policy[name]['bytes'], 4096, 1024 ** 4) % 4096 == 0)
            number(policy[name]['inodes'], 1, 2 ** 32 - 1)
        require(all(policy['workspace'][key] <= policy['pool'][key] for key in ['bytes', 'inodes']))
        self.config = json.loads(json.dumps(config))
        self.policy = self.config['policy']
        self.mount = protected(policy['mountRoot'])
        self.registry = protected(registry, private=True)
        require(not self.registry.is_relative_to(self.mount) and not self.mount.is_relative_to(self.registry))
        self.endpoint = config['endpointId']
        # An outer flock covers database decisions and host effects; SQLite commits intent before those effects.
        self.lock = os.open(self.registry / 'host.lock', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
        try:
            info = os.fstat(self.lock)
            require(stat.S_ISREG(info.st_mode) and info.st_uid == 0 and not info.st_mode & 0o077 and info.st_nlink == 1)
            database = self.registry / 'host.sqlite'
            if database.exists() or database.is_symlink():
                info = database.lstat()
                require(stat.S_ISREG(info.st_mode) and info.st_uid == 0 and not info.st_mode & 0o077 and info.st_nlink == 1)
            old_mask = os.umask(0o077)
            try:
                self.db = sqlite3.connect(database)
            finally:
                os.umask(old_mask)
            self.db.execute('PRAGMA journal_mode=WAL'); self.db.execute('PRAGMA synchronous=FULL')
            with self.exclusive():
                self.db.executescript('''CREATE TABLE IF NOT EXISTS endpoints (id TEXT PRIMARY KEY, filesystem TEXT NOT NULL, first INTEGER NOT NULL, last INTEGER NOT NULL, config TEXT NOT NULL);
                  CREATE TABLE IF NOT EXISTS operations (endpoint TEXT NOT NULL, request TEXT NOT NULL, workspace TEXT NOT NULL, filesystem TEXT NOT NULL,
                    project INTEGER NOT NULL, intent TEXT NOT NULL, roots TEXT NOT NULL, PRIMARY KEY(endpoint, request), UNIQUE(endpoint, workspace), UNIQUE(filesystem, project));''')
                encoded = json.dumps(self.config, sort_keys=True)
                saved = self.db.execute('SELECT config FROM endpoints WHERE id=?', (self.endpoint,)).fetchone()
                if saved:
                    require(saved[0] == encoded)
                else:
                    require(not self.db.execute('SELECT 1 FROM endpoints WHERE filesystem=? AND first<=? AND last>=?',
                                                (policy['filesystemUUID'], last, first)).fetchone())
                    self.db.execute('INSERT INTO endpoints VALUES (?,?,?,?,?)', (self.endpoint, policy['filesystemUUID'], first, last, encoded))
                    self.db.commit()
                self.check_mount()
                self.sync_directory(self.registry)
        except BaseException:
            if hasattr(self, 'db'):
                self.db.close()
            os.close(self.lock)
            raise

    @staticmethod
    def sync_directory(path):
        fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)

    @contextlib.contextmanager
    def exclusive(self):
        fcntl.flock(self.lock, fcntl.LOCK_EX)
        try:
            yield
        except BaseException:
            self.db.rollback()
            raise
        finally:
            fcntl.flock(self.lock, fcntl.LOCK_UN)

    def close(self):
        self.db.close(); os.close(self.lock)

    def check_mount(self):
        protected(self.mount)
        data = json.loads(run('findmnt', '--json', '--target', self.mount, '--output', 'TARGET,FSTYPE,UUID,ID'))['filesystems']
        require(len(data) == 1 and data[0]['target'] == str(self.mount) and data[0]['fstype'] == 'xfs'
                and data[0]['uuid'] == self.policy['filesystemUUID'])
        state = run('xfs_quota', '-x', '-c', 'state -p', self.mount)
        require(re.findall(r'^\s*Accounting: (ON|OFF)\s*$', state, re.M) == ['ON'])
        require(re.findall(r'^\s*Enforcement: (ON|OFF)\s*$', state, re.M) == ['ON'])
        return data[0]

    def quota(self, project):
        return quota_row(run('xfs_quota', '-x', '-c', f'report -p -b -i -n -N -L {project} -U {project}', self.mount), project)

    def validate_request(self, request):
        require(set(request) == {'endpointId', 'requestId', 'requestHash', 'workspace', 'projectId'})
        require(request['endpointId'] == self.endpoint)
        for key in ['requestId', 'workspace']:
            require(isinstance(request[key], str) and re.fullmatch(r'[A-Za-z0-9_-]{1,100}', request[key]))
        require(isinstance(request['requestHash'], str) and re.fullmatch(r'[a-f0-9]{64}', request['requestHash']))
        number(request['projectId'], self.policy['projectIds']['first'], self.policy['projectIds']['last'])
        return json.dumps(request, sort_keys=True)

    def roots(self, request):
        base = self.mount / ('dsh-' + self.endpoint)
        return [base / name / request['workspace'] for name in ['workspaces', 'verification']]

    def saved(self, request):
        intent = self.validate_request(request)
        row = self.db.execute('SELECT intent,roots FROM operations WHERE endpoint=? AND request=?',
                              (self.endpoint, request['requestId'])).fetchone()
        require(row and row[0] == intent)
        return json.loads(row[1])

    def observe(self, request):
        with self.exclusive():
            return self._observe(request)

    def _observe(self, request):
        identities = self.saved(request)
        require(len(identities) == 2 and all(identities))
        mount = self.check_mount()
        roots = self.roots(request)
        for path, expected in zip(roots, identities):
            protected(path.parent)
            require(canonical(path) == path)
            info = path.stat()
            require(stat.S_ISDIR(info.st_mode) and str(info.st_dev) == expected['device'] and str(info.st_ino) == expected['inode'])
            require(info.st_uid == self.config['uid'] and info.st_gid == self.config['gid'] and info.st_mode & 0o777 == 0o700)
            text = run('xfs_io', '-r', '-c', 'stat', path)
            project = re.findall(r'^fsxattr.projid\s*=\s*(\d+)\s*$', text, re.M)
            flags = re.findall(r'^fsxattr.xflags\s*=\s*(0x[0-9a-fA-F]+)', text, re.M)
            require(project == [str(request['projectId'])] and len(flags) == 1 and int(flags[0], 16) & 0x200 and not int(flags[0], 16) & 0x101)
            found = json.loads(run('findmnt', '--json', '--target', path, '--output', 'ID'))['filesystems']
            require(len(found) == 1 and found[0]['id'] == mount['id'])
        limits = self.quota(request['projectId'])
        require(limits and limits['hardBytes'] == self.policy['workspace']['bytes'] and limits['hardInodes'] == self.policy['workspace']['inodes'])
        return {'projectId': request['projectId'], 'roots': identities, 'quota': limits, 'mountId': mount['id']}

    def provision(self, request):
        intent = self.validate_request(request)
        with self.exclusive():
            self.check_mount()
            existing = self.db.execute('SELECT 1 FROM operations WHERE endpoint=? AND request=?', (self.endpoint, request['requestId'])).fetchone()
            if existing:
                return self._observe(request)  # Original incomplete effects are never automatically repeated.
            count = self.db.execute('SELECT count(*) FROM operations WHERE endpoint=?', (self.endpoint,)).fetchone()[0]
            require(all((count + 1) * self.policy['workspace'][key] <= self.policy['pool'][key] for key in ['bytes', 'inodes']))
            previous = self.quota(request['projectId'])
            require(previous is None or not any(previous.values()))
            self.db.execute('INSERT INTO operations VALUES (?,?,?,?,?,?,?)', (self.endpoint, request['requestId'], request['workspace'],
                self.policy['filesystemUUID'], request['projectId'], intent, '[null,null]'))
            self.db.commit()
            roots = self.roots(request)
            identities = [None, None]
            for index, path in enumerate(roots):
                for parent in [path.parent.parent, path.parent]:
                    if not parent.exists():
                        parent.mkdir(mode=0o755); self.sync_directory(parent.parent)
                    protected(parent)
                # Never adopt an existing tree, including one left in an uncertain creation window.
                path.mkdir(mode=0o700); self.sync_directory(path.parent)
                info = path.stat()
                identities[index] = {'device': str(info.st_dev), 'inode': str(info.st_ino)}
                self.db.execute('UPDATE operations SET roots=? WHERE endpoint=? AND request=?', (json.dumps(identities), self.endpoint, request['requestId']))
                self.db.commit()
                run('xfs_quota', '-x', '-c', f'project -s -p {path} {request["projectId"]}', self.mount)
            run('xfs_quota', '-x', '-c', f'limit -p bhard={self.policy["workspace"]["bytes"] // 1024}k ihard={self.policy["workspace"]["inodes"]} {request["projectId"]}', self.mount)
            for path in roots:
                os.chown(path, self.config['uid'], self.config['gid']); self.sync_directory(path)
            return self._observe(request)
