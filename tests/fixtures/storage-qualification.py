"""Native XFS investigation, not endpoint integration or a provisioning tool."""
import errno
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time

MIB = 1024 * 1024


def allocate(path, size):
    with open(path, 'wb', buffering=0) as output:
        os.posix_fallocate(output.fileno(), 0, size)
        os.fsync(output.fileno())


def denied(action, codes=(errno.ENOSPC,)):
    try:
        action()
    except OSError as error:
        assert error.errno in codes, (error.errno, codes)
        return
    raise AssertionError('Kernel unexpectedly allowed operation')


def project(path):
    result = subprocess.run(['xfs_io', '-r', '-c', 'stat', str(path)], check=True, capture_output=True, text=True)
    match = re.search(r'fsxattr.projid\s*=\s*(\d+)', result.stdout)
    assert match, result.stdout
    return int(match.group(1))


def worker(mode):
    assert os.getuid() != 0
    root = Path('/work')
    if mode == 'accounting':
        allocate(root / 'accounting/over-limit', 20 * MIB)
        return {'accountingOnlyAllowsExcess': True}
    assert os.statvfs(root).f_bavail * os.statvfs(root).f_frsize > 64 * MIB
    workspace, copy, other = (root / name for name in ['workspace', 'copy', 'other'])
    # Native allocation across two separate trees charged to the same project.
    allocate(workspace / 'source', 10 * MIB)
    assert project(workspace / 'source') == 17
    denied(lambda: allocate(copy / 'too-large', 10 * MIB))
    (copy / 'too-large').unlink()
    allocate(other / 'independent', 10 * MIB)
    # Unlinked-but-open allocation is not released until the final descriptor closes.
    held = open(workspace / 'source', 'rb')
    (workspace / 'source').unlink()
    try:
        denied(lambda: allocate(copy / 'held', 10 * MIB))
        (copy / 'held').unlink()
    finally:
        held.close()
    # XFS inode inactivation can defer quota release after close; observe, never assume it.
    deadline = time.monotonic() + 5
    while True:
        try:
            allocate(copy / 'released', 10 * MIB)
            break
        except OSError as error:
            if error.errno != errno.ENOSPC or time.monotonic() >= deadline:
                raise
            (copy / 'released').unlink()
            os.sync()
            time.sleep(0.05)
    assert project(copy / 'released') == 17
    denied(lambda: os.link(other / 'independent', workspace / 'cross-project'), (errno.EXDEV,))
    # Do not trust xfs_io exit status; observe membership after the attempted change.
    change = subprocess.run(['xfs_io', '-c', 'chproj 18', str(copy / 'released')], capture_output=True)
    assert project(copy / 'released') == 17, 'Sandbox changed quota membership'
    assert change.stderr, 'Expected an explicit membership-change denial'
    # Removing inheritance would let future files escape even when the current project ID is unchanged.
    change = subprocess.run(['xfs_io', '-c', 'chattr -P', str(workspace)], capture_output=True)
    flags = subprocess.run(['xfs_io', '-r', '-c', 'stat', str(workspace)], check=True, capture_output=True, text=True)
    match = re.search(r'fsxattr.xflags\s*=\s*(0x[0-9a-fA-F]+)', flags.stdout)
    assert match and int(match.group(1), 16) & 0x200, 'Sandbox disabled project inheritance'
    assert change.stderr, 'Expected an explicit inheritance-change denial'
    (copy / 'released').unlink()
    # Distinct inode exhaustion with no appreciable data allocation.
    created = []
    try:
        for number in range(256):
            path = workspace / ('inode-' + str(number))
            try:
                path.touch(exist_ok=False)
            except OSError as error:
                assert error.errno == errno.ENOSPC, error
                break
            created.append(path)
        else:
            raise AssertionError('Inode hard limit was not enforced')
        assert 1 < len(created) < 128, len(created)
        denied(lambda: (copy / 'shared-inode-limit').touch(exist_ok=False))
        (other / 'independent-inode').touch(exist_ok=False)
    finally:
        for path in created:
            path.unlink()
    os.sync()
    (copy / 'after-inode-release').touch(exist_ok=False)
    return {'sharedTrees': True, 'independentProject': True, 'inheritedMembership': True,
            'deletedOpenCharged': True, 'hardLinkDenied': True, 'membershipChangeDenied': True, 'inheritanceChangeDenied': True,
            'byteLimitENOSPC': True, 'inodeLimitENOSPC': True, 'inodesCreatedBeforeLimit': len(created)}


def main():
    if sys.argv[1] == '--worker':
        print(json.dumps(worker(sys.argv[2]), sort_keys=True))
        return
    assert os.getuid() == 0 and os.environ.get('GITHUB_ACTIONS') == 'true'
    root = Path(sys.argv[1]).resolve()
    assert str(root).startswith('/tmp/agentic-storage-') and root.name == 'volume'
    uid, gid = map(int, sys.argv[2:4])
    assert uid > 0 and gid > 0

    def quota(command):
        return subprocess.run(['xfs_quota', '-x', '-c', command, str(root)], check=True,
                              capture_output=True, text=True).stdout

    for name, ident in [('workspace', 17), ('copy', 17), ('other', 18), ('accounting', 19)]:
        directory = root / name
        directory.mkdir(mode=0o700)
        os.chown(directory, uid, gid)
        quota('project -s -p ' + str(directory) + ' ' + str(ident))
        assert project(directory) == ident
    for ident in [17, 18, 19]:
        quota('limit -p bhard=16m ihard=128 ' + str(ident))
    state = quota('state -p')
    assert 'Accounting: ON' in state and 'Enforcement: ON' in state, state
    print(state, flush=True)
    print(quota('report -p -b -i -n'), flush=True)

    def run(mode):
        # Same unshared, capability-dropped boundary as endpoint isolation; this fixture is not Harness execution.
        args = ['bwrap', '--unshare-all', '--unshare-user', '--die-with-parent', '--new-session', '--cap-drop', 'ALL']
        for directory in ['/usr', '/bin', '/sbin', '/lib', '/lib64']:
            path = Path(directory)
            if path.exists():
                args += ['--symlink', str(path.resolve()), directory] if path.is_symlink() else ['--ro-bind', directory, directory]
        args += ['--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp', '--dir', '/run',
                 '--ro-bind', str(Path(__file__).resolve()), '/run/test.py', '--bind', str(root), '/work',
                 '--chdir', '/work', '--clearenv', '--setenv', 'PATH', '/usr/sbin:/usr/bin:/sbin:/bin',
                 '--', '/usr/bin/python3', '/run/test.py', '--worker', mode]
        result = subprocess.run(args, user=uid, group=gid, extra_groups=[], capture_output=True, text=True, timeout=60)
        assert result.returncode == 0, result.stderr
        print(result.stdout, flush=True)

    run('enforced')
    quota('disable -p')
    state = quota('state -p')
    assert 'Accounting: ON' in state and 'Enforcement: OFF' in state, state
    run('accounting')
    print(json.dumps({'nativeStorageInvestigation': 'passed', 'endpointIntegration': False}), flush=True)


if __name__ == '__main__':
    main()
