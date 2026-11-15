"""Deterministic transport contracts; no root privileges or filesystem changes."""
import importlib.util
import json
from pathlib import Path
import socket
import struct
import sys
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'scripts'))
import agentic_storage_service as service


class Connection:
    def __init__(self, frames, clock=None):
        self.frames = iter(frames)
        self.clock = clock
        self.timeout = None
        self.timeouts = []
        self.reply = None
        self.reads = 0

    def getsockopt(self, *_args):
        return struct.pack('3i', 123, 1001, 1001)

    def settimeout(self, value):
        self.timeout = value
        self.timeouts.append(value)

    def recv(self, _limit):
        self.reads += 1
        if self.clock is not None:
            self.clock[0] += min(2, self.timeout)
            if self.timeout < 2:
                raise socket.timeout()
        return next(self.frames)

    def sendall(self, value):
        self.reply = json.loads(value)


class Contract(unittest.TestCase):
    def host(self):
        return Mock(config={'uid': 1001})

    def respond(self, host, connection):
        with patch.object(socket, 'SO_PEERCRED', 17, create=True):
            service.respond(host, connection)

    def test_slow_sender_cannot_reset_total_deadline(self):
        clock = [0]
        connection = Connection([b' '] * 100, clock)
        host = self.host()
        with patch.object(service.time, 'monotonic', side_effect=lambda: clock[0]):
            self.respond(host, connection)
        self.assertEqual(clock[0], 5)
        self.assertEqual(connection.reads, 3)
        self.assertEqual(connection.timeouts[1:4], [5, 3, 1])
        self.assertEqual(connection.reply, {'ok': False, 'error': 'storage_host_refused'})
        host.provision.assert_not_called(); host.observe.assert_not_called()

    def test_duplicate_authority_keys_are_refused(self):
        for payload in [b'{"op":"observe","op":"provision","request":{}}',
                        b'{"op":"provision","request":{"workspace":"one","workspace":"two"}}']:
            connection = Connection([payload, b''])
            host = self.host(); self.respond(host, connection)
            self.assertEqual(connection.reply, {'ok': False, 'error': 'storage_host_refused'})
            host.provision.assert_not_called(); host.observe.assert_not_called()

    def test_configuration_uses_the_same_duplicate_key_refusal(self):
        with self.assertRaises(RuntimeError):
            service.strict_json('{"uid":1001,"uid":0}')


if __name__ == '__main__':
    unittest.main()
