"""Trusted Linux XFS provisioner library. Not installed, setuid, or exposed to agents.

The caller must be a privileged, authenticated host service with administrator-owned
configuration. A shared root-owned registry fences all managed endpoint ranges.
"""
import contextlib
import hashlib
import fcntl
import json
import os
from pathlib import Path
import re
import sqlite3
import stat
import subprocess
import sys
import time
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
    def __init__(self, registry, config, *, existing_only=False):
        require(sys.platform == 'linux' and os.getuid() == 0)
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
        self.lock = os.open(self.registry / 'host.lock', (0 if existing_only else os.O_CREAT) | os.O_RDWR | os.O_NOFOLLOW, 0o600)
        try:
            info = os.fstat(self.lock)
            require(stat.S_ISREG(info.st_mode) and info.st_uid == 0 and not info.st_mode & 0o077 and info.st_nlink == 1)
            database = self.registry / 'host.sqlite'
            if database.exists() or database.is_symlink():
                info = database.lstat()
                require(stat.S_ISREG(info.st_mode) and info.st_uid == 0 and not info.st_mode & 0o077 and info.st_nlink == 1)
            if existing_only:
                require(database.exists())
            old_mask = os.umask(0o077)
            try:
                self.db = sqlite3.connect(database.as_uri() + '?mode=rw', uri=True) if existing_only else sqlite3.connect(database)
            finally:
                os.umask(old_mask)
            if existing_only:
                require(self.db.execute('PRAGMA journal_mode').fetchone()[0] == 'wal')
            else:
                self.db.execute('PRAGMA journal_mode=WAL')
            self.db.execute('PRAGMA synchronous=FULL')
            with self.exclusive():
                if existing_only:
                    tables = {row[0] for row in self.db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
                    require({'endpoints', 'namespaces', 'operations', 'repairs'} <= tables)
                else:
                    self.db.executescript('''CREATE TABLE IF NOT EXISTS endpoints (id TEXT PRIMARY KEY, filesystem TEXT NOT NULL, first INTEGER NOT NULL, last INTEGER NOT NULL, config TEXT NOT NULL);
                      CREATE TABLE IF NOT EXISTS namespaces (endpoint TEXT PRIMARY KEY, identities TEXT NOT NULL);
                      CREATE TABLE IF NOT EXISTS operations (endpoint TEXT NOT NULL, request TEXT NOT NULL, workspace TEXT NOT NULL, filesystem TEXT NOT NULL,
                        project INTEGER NOT NULL, intent TEXT NOT NULL, roots TEXT NOT NULL, PRIMARY KEY(endpoint, request), UNIQUE(endpoint, workspace), UNIQUE(filesystem, project));
                      CREATE TABLE IF NOT EXISTS repairs (endpoint TEXT NOT NULL, id TEXT NOT NULL, request TEXT NOT NULL, intent TEXT NOT NULL, phase TEXT NOT NULL,
                        PRIMARY KEY(endpoint,id), UNIQUE(endpoint,request));''')
                encoded = json.dumps(self.config, sort_keys=True)
                saved = self.db.execute('SELECT config FROM endpoints WHERE id=?', (self.endpoint,)).fetchone()
                if saved:
                    require(saved[0] == encoded)
                else:
                    require(not existing_only)
                    require(not self.db.execute('SELECT 1 FROM endpoints WHERE filesystem=? AND first<=? AND last>=?',
                                                (policy['filesystemUUID'], last, first)).fetchone())
                    self.db.execute('INSERT INTO endpoints VALUES (?,?,?,?,?)', (self.endpoint, policy['filesystemUUID'], first, last, encoded))
                    self.db.commit()
                self.check_mount()
                if existing_only:
                    self.check_namespace()
                else:
                    self.prepare_namespace()
                    self.sync_directory(self.registry)
        except BaseException:
            if hasattr(self, 'db'):
                self.db.close()
            os.close(self.lock)
            raise

    def namespace_paths(self):
        base = self.mount / ('dsh-' + self.endpoint)
        return [base, base / 'workspaces', base / 'verification']

    def check_namespace(self):
        row = self.db.execute('SELECT identities FROM namespaces WHERE endpoint=?', (self.endpoint,)).fetchone()
        require(row is not None)
        identities = json.loads(row[0])
        paths = self.namespace_paths()
        require(len(identities) == len(paths) and all(identities))
        for path, expected in zip(paths, identities):
            protected(path)
            info = path.stat()
            require(stat.S_IMODE(info.st_mode) == 0o755)
            require(expected == {'device': str(info.st_dev), 'inode': str(info.st_ino)})

    def prepare_namespace(self):
        if self.db.execute('SELECT 1 FROM namespaces WHERE endpoint=?', (self.endpoint,)).fetchone():
            self.check_namespace()
            return
        # Persist before mkdir. Partial creation remains unknown; never adopt/recreate its paths automatically.
        self.db.execute('INSERT INTO namespaces VALUES (?,?)', (self.endpoint, '[null,null,null]'))
        self.db.commit()
        identities = [None, None, None]
        for index, path in enumerate(self.namespace_paths()):
            path.mkdir(mode=0o755)
            os.chmod(path, 0o755)  # Do not let a restrictive service umask make the prepared namespace inaccessible.
            self.sync_directory(path)
            self.sync_directory(path.parent)
            protected(path)
            info = path.stat()
            identities[index] = {'device': str(info.st_dev), 'inode': str(info.st_ino)}
            self.db.execute('UPDATE namespaces SET identities=? WHERE endpoint=?', (json.dumps(identities), self.endpoint))
            self.db.commit()
        self.check_namespace()

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

    @staticmethod
    def audit_backup_records(database):
        """Validate retained cross-record bindings; no assertion about current filesystem state."""
        def decode(text):
            def unique(pairs):
                result = {}
                for key, value in pairs:
                    require(key not in result); result[key] = value
                return result
            return json.loads(text, object_pairs_hook=unique)
        def identities(text, count):
            values = decode(text)
            require(isinstance(values, list) and len(values) == count)
            require(all(value is None or isinstance(value, dict) and set(value) == {'device', 'inode'}
                        and all(isinstance(item, str) and re.fullmatch(r'[0-9]+', item) for item in value.values()) for value in values))
            return values
        endpoints, ranges, namespaces, operations, workspaces, projects, repairs = {}, {}, {}, {}, set(), set(), set()
        allocation_counts, root_records = {}, {}
        for endpoint, filesystem, first, last, encoded in database.execute('SELECT id,filesystem,first,last,config FROM endpoints'):
            config = decode(encoded)
            require(endpoint not in endpoints and set(config) == {'endpointId', 'uid', 'gid', 'policy'} and config['endpointId'] == endpoint)
            require(str(uuid.UUID(endpoint)) == endpoint and str(uuid.UUID(filesystem)) == filesystem)
            number(config['uid'], 1, 2 ** 31 - 1); number(config['gid'], 1, 2 ** 31 - 1)
            policy = config['policy']
            require(set(policy) == {'kind', 'filesystemUUID', 'mountRoot', 'projectIds', 'pool', 'workspace'})
            require(policy['kind'] == 'linux-xfs-project' and policy['filesystemUUID'] == filesystem)
            require(policy['projectIds'] == {'first': first, 'last': last})
            number(first, 1, 2 ** 32 - 1); number(last, first, 2 ** 32 - 1)
            number(policy['projectIds']['first'], 1, 2 ** 32 - 1); number(policy['projectIds']['last'], first, 2 ** 32 - 1)
            path = policy['mountRoot']
            require(isinstance(path, str) and re.fullmatch(r'/[A-Za-z0-9_/-]+', path) and len(path) <= 4096
                    and not path.endswith('/') and all(part not in ['', '.', '..'] for part in path.split('/')[1:]))
            for key in ['pool', 'workspace']:
                require(set(policy[key]) == {'bytes', 'inodes'})
                require(number(policy[key]['bytes'], 4096, 1024 ** 4) % 4096 == 0)
                number(policy[key]['inodes'], 1, 2 ** 32 - 1)
            require(all(policy['workspace'][key] <= policy['pool'][key] for key in ['bytes', 'inodes']))
            ranges.setdefault(filesystem, []).append((first, last))
            endpoints[endpoint] = policy
        for intervals in ranges.values():
            intervals.sort()
            require(all(previous[1] < following[0] for previous, following in zip(intervals, intervals[1:])))
        for endpoint, encoded in database.execute('SELECT endpoint,identities FROM namespaces'):
            require(endpoint in endpoints and endpoint not in namespaces)
            namespaces[endpoint] = identities(encoded, 3)
        incomplete = 0
        for endpoint, request, workspace, filesystem, project, encoded, roots in database.execute('SELECT endpoint,request,workspace,filesystem,project,intent,roots FROM operations'):
            require(endpoint in namespaces and all(namespaces[endpoint]) and (endpoint, request) not in operations and (endpoint, workspace) not in workspaces
                    and (filesystem, project) not in projects)
            value = decode(encoded); policy = endpoints[endpoint]
            require(value == {'endpointId': endpoint, 'requestId': request, 'requestHash': value.get('requestHash'), 'workspace': workspace, 'projectId': project})
            temporary = StorageHost.__new__(StorageHost); temporary.endpoint = endpoint; temporary.policy = policy
            temporary.validate_request(value)
            require(filesystem == policy['filesystemUUID'])
            root_records[endpoint, request] = identities(roots, 2)
            incomplete += int(any(root is None for root in root_records[endpoint, request]))
            allocation_counts[endpoint] = allocation_counts.get(endpoint, 0) + 1
            operations[endpoint, request] = value; workspaces.add((endpoint, workspace)); projects.add((filesystem, project))
        for endpoint, policy in endpoints.items():
            count = allocation_counts.get(endpoint, 0)
            require(all(count * policy['workspace'][key] <= policy['pool'][key] for key in ['bytes', 'inodes']))
        unresolved = 0
        repaired_requests = set()
        for endpoint, repair, request, encoded, phase in database.execute('SELECT endpoint,id,request,intent,phase FROM repairs'):
            require((endpoint, request) in operations and (endpoint, repair) not in repairs and (endpoint, request) not in repaired_requests)
            # Reject duplicate JSON keys before using the common retained-receipt validator.
            decode(encoded)
            temporary = StorageHost.__new__(StorageHost); temporary.endpoint = endpoint; temporary.policy = endpoints[endpoint]; temporary.db = database
            receipt = temporary.repair_receipt(operations[endpoint, request])
            require(receipt and receipt['repairId'] == repair and receipt['phase'] == phase)
            require(phase == 'started' or all(root_records[endpoint, request]))
            unresolved += int(phase != 'complete'); repairs.add((endpoint, repair)); repaired_requests.add((endpoint, request))
        return {'recordBindingsVerified': True, 'incompleteRootRecords': incomplete, 'unresolvedRepairs': unresolved,
                'liveFilesystemVerified': False, 'restoreVerified': False}

    @staticmethod
    def verify_backup(source, expected_hash, *, audit=False):
        """Offline artifact verification only. Does not authorize import or filesystem recovery."""
        require(isinstance(expected_hash, str) and re.fullmatch(r'[a-f0-9]{64}', expected_hash))
        path = Path(source)
        require(path.is_absolute())
        protected(path.parent, private=True)
        require(not any(Path(str(path) + suffix).exists() or Path(str(path) + suffix).is_symlink()
                        for suffix in ['-wal', '-shm', '-journal']))
        descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
        try:
            before = os.fstat(descriptor)
            require(stat.S_ISREG(before.st_mode) and before.st_uid == 0 and before.st_nlink == 1
                    and not before.st_mode & 0o077 and 0 < before.st_size <= 1024 ** 4)
            require(os.pread(descriptor, 2, 18) == bytes([1, 1]))  # No WAL dependency may be hidden by immutable mode.
            digest = hashlib.sha256(); deadline = time.monotonic() + 120
            while chunk := os.read(descriptor, 1024 * 1024):
                require(time.monotonic() < deadline); digest.update(chunk)
            require(digest.hexdigest() == expected_hash)
            database = sqlite3.connect(path.as_uri() + '?mode=ro&immutable=1', uri=True)
            try:
                database.execute('PRAGMA trusted_schema=OFF')
                database.execute('PRAGMA query_only=ON')
                database.set_progress_handler(lambda: int(time.monotonic() >= deadline), 1000)
                require(database.execute('PRAGMA integrity_check').fetchall() == [('ok',)])
                expected = {'endpoints': ['id', 'filesystem', 'first', 'last', 'config'],
                            'namespaces': ['endpoint', 'identities'],
                            'operations': ['endpoint', 'request', 'workspace', 'filesystem', 'project', 'intent', 'roots'],
                            'repairs': ['endpoint', 'id', 'request', 'intent', 'phase']}
                require({row[0] for row in database.execute("SELECT name FROM sqlite_master WHERE type='table'")} == set(expected))
                require(not database.execute("SELECT 1 FROM sqlite_master WHERE type IN ('view','trigger')").fetchone())
                for table, columns in expected.items():
                    require([row[1] for row in database.execute('PRAGMA table_info(' + table + ')')] == columns)
                counts = {table: database.execute('SELECT count(*) FROM ' + table).fetchone()[0] for table in expected}
                bindings = StorageHost.audit_backup_records(database) if audit else None
            finally:
                database.close()
            after, named = os.fstat(descriptor), path.lstat()
            identity = lambda info: (info.st_dev, info.st_ino, info.st_size, info.st_mode, info.st_mtime_ns, info.st_ctime_ns)
            require(identity(before) == identity(after) == identity(named))
            return {'kind': 'storage-host-registry', 'sha256': expected_hash, 'bytes': before.st_size,
                    'records': counts, 'artifactVerified': True, 'restoreVerified': False, **({'bindings': bindings} if bindings else {})}
        finally:
            os.close(descriptor)

    def backup(self, output):
        """Consistent standalone registry snapshot, not a workspace or whole-system backup."""
        with self.exclusive():
            return self._backup_locked(output)

    def capture_pair(self, output, capture_endpoint):
        """Trusted local caller captures the endpoint while the shared host registry remains frozen.

        The callback must acquire the original endpoint writer lock before snapshotting.
        No RPC exposes this callback; it is an operator integration boundary.
        """
        with self.exclusive():
            host = self._backup_locked(output)
            endpoint = capture_endpoint()
            return {'host': host, 'endpoint': endpoint, 'hostLockHeldThroughEndpointCapture': True,
                    'workspaceFilesIncluded': False, 'executionQuiescenceVerified': False,
                    'restoreVerified': False}

    def _backup_locked(self, output):
        """Consistent standalone registry snapshot, not a workspace or whole-system backup."""
        target = Path(output)
        require(target.is_absolute() and target.name not in ['', '.', '..'])
        parent = protected(target.parent, private=True)
        require(target == parent / target.name)
        require(not target.is_relative_to(self.registry) and not target.is_relative_to(self.mount))
        require(not self.db.in_transaction)
        descriptor = os.open(target, os.O_CREAT | os.O_EXCL | os.O_RDWR | os.O_NOFOLLOW, 0o600)
        try:
            destination = sqlite3.connect(target)
            try:
                deadline = time.monotonic() + 120
                def progress(_status, _remaining, _total):
                    require(time.monotonic() < deadline)
                self.db.backup(destination, pages=256, progress=progress, sleep=0.01)
                require(destination.execute('PRAGMA journal_mode=DELETE').fetchone()[0] == 'delete')
                require(destination.execute('PRAGMA integrity_check').fetchall() == [('ok',)])
                tables = ['endpoints', 'namespaces', 'operations', 'repairs']
                counts = {table: destination.execute('SELECT count(*) FROM ' + table).fetchone()[0] for table in tables}
            finally:
                destination.close()
            info, named = os.fstat(descriptor), target.lstat()
            require((info.st_dev, info.st_ino) == (named.st_dev, named.st_ino) and info.st_nlink == 1
                    and stat.S_ISREG(info.st_mode) and info.st_uid == 0 and not info.st_mode & 0o077)
            os.fsync(descriptor)
            digest = hashlib.sha256()
            while chunk := os.read(descriptor, 1024 * 1024):
                digest.update(chunk)
            self.sync_directory(parent)
            return {'kind': 'storage-host-registry', 'sha256': digest.hexdigest(), 'bytes': info.st_size,
                    'records': counts, 'workspaceFilesIncluded': False, 'restoreVerified': False}
        finally:
            os.close(descriptor)  # Failed/uncertain output is retained; never overwrite or silently delete it.

    def inspect(self, request):
        """Read-only evidence for operator reconciliation; never adopts roots or authorizes repair."""
        with self.exclusive():
            return self._inspect(request)

    def repair_receipt(self, request):
        """Read retained approval identity only; a completed journal phase is not fresh host proof."""
        self.saved(request)
        row = self.db.execute('SELECT id,intent,phase FROM repairs WHERE endpoint=? AND request=?',
                              (self.endpoint, request['requestId'])).fetchone()
        if row is None:
            return None
        repair_id, encoded, phase = row
        require(isinstance(repair_id, str) and re.fullmatch(r'[A-Za-z0-9_-]{1,100}', repair_id))
        require(phase in ['started', 'finishing', 'complete'])
        intent = json.loads(encoded)
        require(isinstance(intent, dict) and set(intent) in [{'request', 'snapshotHash'}, {'request', 'snapshotHash', 'finishSnapshotHash'}] and intent['request'] == request)
        require(isinstance(intent['snapshotHash'], str) and re.fullmatch(r'[a-f0-9]{64}', intent['snapshotHash']))
        finish = intent.get('finishSnapshotHash')
        require('finishSnapshotHash' not in intent or isinstance(finish, str) and re.fullmatch(r'[a-f0-9]{64}', finish))
        require(phase != 'finishing' or finish is not None)
        require(phase != 'started' or finish is None)
        return {'repairId': repair_id, 'phase': phase, 'originalSnapshotHash': intent['snapshotHash'],
                **({'finishSnapshotHash': finish} if finish is not None else {})}

    def _inspect(self, request):
        self.check_namespace()
        expected = self.saved(request)
        require(len(expected) == 2 and all(item is None or isinstance(item, dict)
                and set(item) == {'device', 'inode'} and all(isinstance(value, str) and value.isdigit() for value in item.values())
                for item in expected))
        mount = self.check_mount()
        roots = []
        for path, identity in zip(self.roots(request), expected):
            protected(path.parent)
            item = {'path': str(path), 'recordedIdentity': identity}
            try:
                before = path.lstat()
            except FileNotFoundError:
                roots.append({**item, 'state': 'missing'})
                continue
            actual = {'device': str(before.st_dev), 'inode': str(before.st_ino)}
            item.update({'actualIdentity': actual, 'uid': before.st_uid, 'gid': before.st_gid,
                         'mode': stat.S_IMODE(before.st_mode), 'ctimeNs': str(before.st_ctime_ns),
                         'mtimeNs': str(before.st_mtime_ns)})
            if not stat.S_ISDIR(before.st_mode):
                roots.append({**item, 'state': 'not-directory'})
                continue
            if identity is None:
                roots.append({**item, 'state': 'unrecorded'})
                continue  # An orphan tree is not adopted or traversed merely because its path matches.
            if actual != identity:
                roots.append({**item, 'state': 'identity-mismatch'})
                continue
            require(canonical(path) == path)
            text = run('xfs_io', '-r', '-c', 'stat', path)
            project = re.findall(r'^fsxattr.projid\s*=\s*(\d+)\s*$', text, re.M)
            flags = re.findall(r'^fsxattr.xflags\s*=\s*(0x[0-9a-fA-F]+)', text, re.M)
            require(len(project) == 1 and len(flags) == 1)
            with os.scandir(path) as entries:
                empty = next(entries, None) is None
            after = path.lstat()
            require((before.st_dev, before.st_ino, before.st_uid, before.st_gid, before.st_mode, before.st_ctime_ns, before.st_mtime_ns)
                    == (after.st_dev, after.st_ino, after.st_uid, after.st_gid, after.st_mode, after.st_ctime_ns, after.st_mtime_ns))
            roots.append({**item, 'state': 'recorded', 'projectId': int(project[0]),
                          'inherits': bool(int(flags[0], 16) & 0x200), 'realtime': bool(int(flags[0], 16) & 0x101), 'empty': empty})
        evidence = {'endpointId': self.endpoint, 'request': dict(request), 'policy': json.loads(json.dumps(self.policy)),
                    'mountId': mount['id'], 'roots': roots, 'quota': self.quota(request['projectId']),
                    'repair': self.repair_receipt(request)}
        digest = hashlib.sha256(json.dumps(evidence, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
        return {**evidence, 'snapshotHash': digest, 'authorizesRepair': False}


    def repair(self, request, repair_id, expected_snapshot):
        """Explicit root-operator repair. A recorded repair is observed on replay, never re-executed."""
        require(isinstance(repair_id, str) and re.fullmatch(r'[A-Za-z0-9_-]{1,100}', repair_id))
        require(isinstance(expected_snapshot, str) and re.fullmatch(r'[a-f0-9]{64}', expected_snapshot))
        self.validate_request(request)
        intent = json.dumps({'request': request, 'snapshotHash': expected_snapshot}, sort_keys=True)
        with self.exclusive():
            prior = self.db.execute('SELECT intent, phase FROM repairs WHERE endpoint=? AND id=?', (self.endpoint, repair_id)).fetchone()
            if prior:
                receipt = self.repair_receipt(request)
                require(receipt and receipt['repairId'] == repair_id and receipt['originalSnapshotHash'] == expected_snapshot)
                result = self._observe(request)
                if prior[1] != 'complete':
                    self.db.execute("UPDATE repairs SET phase='complete' WHERE endpoint=? AND id=?", (self.endpoint, repair_id))
                    self.db.commit()
                return result
            require(not self.db.execute('SELECT 1 FROM repairs WHERE endpoint=? AND request=?', (self.endpoint, request['requestId'])).fetchone())
            evidence = self._inspect(request)
            require(evidence['snapshotHash'] == expected_snapshot)
            roots = evidence['roots']
            for root in roots:
                require(root['state'] in ['missing', 'recorded'])
                if root['state'] == 'missing':
                    require(root['recordedIdentity'] is None)  # Lost recorded roots are not recreated.
                else:
                    require(root['uid'] == 0 and root['mode'] == 0o700 and root['empty'] and not root['realtime'])
                    require(root['projectId'] in [0, request['projectId']])
            quota = evidence['quota']
            if quota:
                require(quota['hardBytes'] in [0, self.policy['workspace']['bytes']]
                        and quota['hardInodes'] in [0, self.policy['workspace']['inodes']])
                require(quota['usedInodes'] <= sum(root.get('projectId') == request['projectId'] for root in roots))
            # Every admissible tree is empty and root-private, or never created. Never adopt an orphan tree.
            self.db.execute('INSERT INTO repairs VALUES (?,?,?,?,?)', (self.endpoint, repair_id, request['requestId'], intent, 'started'))
            self.db.commit()
            identities = self.saved(request)
            for index, path in enumerate(self.roots(request)):
                if roots[index]['state'] == 'missing':
                    path.mkdir(mode=0o700); self.sync_directory(path.parent)
                    info = path.stat()
                    identities[index] = {'device': str(info.st_dev), 'inode': str(info.st_ino)}
                    self.db.execute('UPDATE operations SET roots=? WHERE endpoint=? AND request=?',
                                    (json.dumps(identities), self.endpoint, request['requestId']))
                    self.db.commit()
                run('xfs_quota', '-x', '-c', f'project -s -p {path} {request["projectId"]}', self.mount)
            run('xfs_quota', '-x', '-c', f'limit -p bhard={self.policy["workspace"]["bytes"] // 1024}k ihard={self.policy["workspace"]["inodes"]} {request["projectId"]}', self.mount)
            for path in self.roots(request):
                os.chown(path, self.config['uid'], self.config['gid']); self.sync_directory(path)
            result = self._observe(request)
            self.db.execute("UPDATE repairs SET phase='complete' WHERE endpoint=? AND id=?", (self.endpoint, repair_id))
            self.db.commit()
            return result

    def finish_repair(self, request, repair_id, original_snapshot, fresh_snapshot):
        """Separate operator approval for ownership handoff only; never repeat provisioning effects."""
        require(isinstance(fresh_snapshot, str) and re.fullmatch(r'[a-f0-9]{64}', fresh_snapshot))
        with self.exclusive():
            receipt = self.repair_receipt(request)
            require(receipt and receipt['repairId'] == repair_id and receipt['originalSnapshotHash'] == original_snapshot)
            if 'finishSnapshotHash' in receipt:
                require(receipt['finishSnapshotHash'] == fresh_snapshot)
                result = self._observe(request)  # Lost reply or interrupted handoff: observation only.
            else:
                require(receipt['phase'] == 'started')
                evidence = self._inspect(request)
                require(evidence['snapshotHash'] == fresh_snapshot)
                for root in evidence['roots']:
                    require(root['state'] == 'recorded' and root['uid'] == 0 and root['mode'] == 0o700
                            and root['empty'] and not root['realtime'] and root['inherits']
                            and root['projectId'] == request['projectId'])
                quota = evidence['quota']
                require(quota and quota['hardBytes'] == self.policy['workspace']['bytes']
                        and quota['hardInodes'] == self.policy['workspace']['inodes']
                        and quota['usedInodes'] == len(evidence['roots']))
                # Keep original approval immutable within the record; journal the distinct handoff
                # approval before ownership changes. Root-private empty trees exclude worker writers.
                intent = {'request': request, 'snapshotHash': original_snapshot, 'finishSnapshotHash': fresh_snapshot}
                self.db.execute("UPDATE repairs SET intent=?, phase='finishing' WHERE endpoint=? AND id=?",
                                (json.dumps(intent, sort_keys=True), self.endpoint, repair_id))
                self.db.commit()
                for path in self.roots(request):
                    os.chown(path, self.config['uid'], self.config['gid']); self.sync_directory(path)
                result = self._observe(request)
            self.db.execute("UPDATE repairs SET phase='complete' WHERE endpoint=? AND id=?", (self.endpoint, repair_id))
            self.db.commit()
            return result

    def observe(self, request):
        with self.exclusive():
            return self._observe(request)

    def _observe(self, request):
        self.check_namespace()
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
            self.check_namespace()
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
                protected(path.parent)
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
