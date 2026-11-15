"""Local socket recovery contracts. Mock only root ownership policy on non-root development hosts."""
import errno
import os
from pathlib import Path
import socket
import stat
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'scripts'))
import agentic_storage_service as service


class Listener(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.path = Path(self.temp.name) / 'host.sock'
        self.protected = patch.object(service, 'protected')
        self.protected.start()
        # Preserve real type/mode/inode checks while substituting only ownership for this non-root test.
        self.real_fstat = os.fstat
        self.real_lstat = Path.lstat
        def root(info):
            values = list(info); values[4] = 0
            return os.stat_result(values)
        self.fstat = patch.object(service.os, 'fstat', side_effect=lambda fd: root(self.real_fstat(fd)))
        self.lstat = patch.object(Path, 'lstat', lambda path: root(self.real_lstat(path)))
        self.fstat.start(); self.lstat.start()

    def tearDown(self):
        self.lstat.stop(); self.fstat.stop(); self.protected.stop(); self.temp.cleanup()

    def bind(self, listen=False):
        sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        sock.bind(str(self.path)); self.path.chmod(0o660)
        if listen:
            sock.listen(1)
        return sock

    def test_reclaims_dead_socket_and_keeps_lock_inode(self):
        self.bind().close()
        with service.listener_claim(self.path, os.getgid()):
            self.assertFalse(self.path.exists())
            inode = Path(str(self.path) + '.lock').stat().st_ino
            with self.assertRaises(BlockingIOError):
                with service.listener_claim(self.path, os.getgid()):
                    self.fail('duplicate listener admitted')
        with service.listener_claim(self.path, os.getgid()):
            self.assertEqual(Path(str(self.path) + '.lock').stat().st_ino, inode)

    def test_live_listener_preserved(self):
        with self.bind(listen=True):
            inode = self.path.stat().st_ino
            with self.assertRaises(RuntimeError):
                with service.listener_claim(self.path, os.getgid()):
                    self.fail('live listener displaced')
            self.assertEqual(self.path.stat().st_ino, inode)

    def test_regular_file_symlink_and_wrong_mode_preserved(self):
        self.path.write_text('original')
        with self.assertRaises(RuntimeError):
            with service.listener_claim(self.path, os.getgid()): pass
        self.assertEqual(self.path.read_text(), 'original')
        self.path.unlink(); self.path.symlink_to('missing')
        with self.assertRaises(RuntimeError):
            with service.listener_claim(self.path, os.getgid()): pass
        self.assertTrue(self.path.is_symlink())
        self.path.unlink(); self.bind().close(); self.path.chmod(0o666)
        with self.assertRaises(RuntimeError):
            with service.listener_claim(self.path, os.getgid()): pass
        self.assertTrue(self.path.exists())

    def test_uncertain_probe_preserved(self):
        self.bind().close()
        with patch.object(socket.socket, 'connect', side_effect=OSError(errno.EACCES, 'denied')):
            with self.assertRaises(RuntimeError):
                with service.listener_claim(self.path, os.getgid()): pass
        self.assertTrue(self.path.exists())


unittest.main()
