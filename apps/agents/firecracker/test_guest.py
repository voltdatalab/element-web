# Copyright 2026 Volt Data Lab
# SPDX-License-Identifier: AGPL-3.0-only
import hashlib
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest
import guest


class GuestTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        guest.ROOT = Path(self.temp.name)
        self.db = sqlite3.connect(guest.ROOT / '.test-receipts.sqlite')
        self.db.execute('CREATE TABLE receipts (id TEXT PRIMARY KEY, fingerprint TEXT, result TEXT)')
        self.addCleanup(lambda: self.db.close())

    def test_file_receipt_and_content_survive_reopen(self):
        request = {'op': 'write', 'requestId': 'call-1', 'path': 'docs/relatorio.txt', 'content': 'Olá, microVM!'}
        result = guest.execute(request, self.db)
        self.assertEqual(result['sha256'], hashlib.sha256('Olá, microVM!'.encode()).hexdigest())
        self.assertEqual(result, guest.execute(request, self.db))
        self.db.close()
        self.db = sqlite3.connect(guest.ROOT / '.test-receipts.sqlite')
        self.addCleanup(self.db.close)
        read = guest.execute({'op': 'read', 'requestId': 'call-2', 'path': request['path']}, self.db)
        self.assertEqual(read, result)
        self.assertEqual(guest.execute(request, self.db), result)
        with self.assertRaises(ValueError):
            guest.execute({**request, 'content': 'changed'}, self.db)

    def test_escape_hidden_files_and_symlinks_are_rejected(self):
        for p in ['../secret', '/etc/passwd', 'a/../../secret', '.clawdia-receipts.sqlite', 'a//b', 'a/./b']:
            with self.subTest(path=p), self.assertRaises(ValueError):
                guest.workspace_path(p)
        (guest.ROOT / 'link').symlink_to('/tmp')
        with self.assertRaises(ValueError):
            guest.workspace_path('link/host-file')

    def test_limits_and_unsupported_operations(self):
        for request in [
            {'op': 'write', 'path': 'huge.txt', 'content': 'á' * 65536},
            {'op': 'read', 'path': 'missing.txt'},
            {'op': 'bash', 'command': 'id'},
        ]:
            with self.assertRaises(ValueError):
                guest.execute({'requestId': 'invalid', **request}, self.db)
        self.assertEqual(list(guest.ROOT.glob('huge*')), [])


if __name__ == '__main__':
    unittest.main()
