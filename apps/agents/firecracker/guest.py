# Copyright 2026 Volt Data Lab
# SPDX-License-Identifier: AGPL-3.0-only
"""Bounded workspace operations over the VM's private vsock channel."""
import hashlib
import json
import os
from pathlib import Path
import re
import socket
import sqlite3
import uuid

LIMIT = 65536
ROOT = Path('/workspace')


def workspace_path(value):
    if not isinstance(value, str) or len(value) > 240:
        raise ValueError('invalid_path')
    parts = value.split('/')
    if not parts or any(not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,63}', p) or p in ('.', '..') for p in parts):
        raise ValueError('invalid_path')
    target = ROOT.joinpath(*parts)
    for parent in [target, *target.parents]:
        if parent == ROOT:
            break
        if parent.is_symlink():
            raise ValueError('invalid_path')
    return target


def artifact(target, relative):
    if target.stat().st_size > LIMIT:
        raise ValueError('file_too_large')
    content = target.read_bytes()
    if len(content) > LIMIT:
        raise ValueError('file_too_large')
    return {'path': relative, 'content': content.decode('utf-8'), 'sha256': hashlib.sha256(content).hexdigest()}


def execute(request, database):
    op = request.get('op')
    key = request.get('requestId')
    if not isinstance(key, str) or not 1 <= len(key) <= 256:
        raise ValueError('invalid_request')
    fingerprint = hashlib.sha256(json.dumps(request, sort_keys=True).encode()).hexdigest()
    old = database.execute('SELECT fingerprint,result FROM receipts WHERE id=?', (key,)).fetchone()
    if old:
        if old[0] != fingerprint:
            raise ValueError('request_conflict')
        return json.loads(old[1])
    if op == 'status':
        result = {'bootId': Path('/proc/sys/kernel/random/boot_id').read_text().strip()}
    elif op in ('read', 'write'):
        target = workspace_path(request.get('path'))
        if op == 'write':
            text = request.get('content')
            if not isinstance(text, str) or len(text.encode('utf-8')) > LIMIT:
                raise ValueError('file_too_large')
            target.parent.mkdir(parents=True, exist_ok=True)
            temp = target.parent / ('.write-' + uuid.uuid4().hex)
            try:
                with temp.open('xb') as f:
                    f.write(text.encode('utf-8'))
                    f.flush()
                    os.fsync(f.fileno())
                os.replace(temp, target)
                fd = os.open(target.parent, os.O_RDONLY)
                try:
                    os.fsync(fd)
                finally:
                    os.close(fd)
            finally:
                temp.unlink(missing_ok=True)
        if not target.is_file():
            raise ValueError('file_not_found')
        result = artifact(target, request['path'])
    elif op == 'sync':
        os.sync()
        result = {'synced': True}
    else:
        raise ValueError('operation_not_supported')
    database.execute('INSERT INTO receipts VALUES (?,?,?)', (key, fingerprint, json.dumps(result)))
    database.commit()
    return result


def main():
    ROOT.mkdir(exist_ok=True)
    database = sqlite3.connect(ROOT / '.clawdia-receipts.sqlite')
    database.execute('PRAGMA journal_mode=WAL')
    database.execute('PRAGMA synchronous=FULL')
    database.execute('CREATE TABLE IF NOT EXISTS receipts (id TEXT PRIMARY KEY, fingerprint TEXT, result TEXT)')
    cmdline = dict(x.split('=', 1) for x in Path('/proc/cmdline').read_text().split() if '=' in x)
    token = cmdline['clawdia_token']
    generation = cmdline['clawdia_generation']
    server = socket.socket(socket.AF_VSOCK, socket.SOCK_STREAM)
    server.bind((socket.VMADDR_CID_ANY, 5000))
    server.listen(8)
    while True:
        conn, peer = server.accept()
        with conn:
            conn.settimeout(10)
            try:
                if peer[0] != 2:
                    raise ValueError('unauthorized_peer')
                stream = conn.makefile('rb')
                line = stream.readline(512000)
                if not line.endswith(b'\n'):
                    raise ValueError('invalid_request')
                request = json.loads(line)
                if request.pop('token', None) != token or request.pop('generation', None) != generation:
                    raise ValueError('unauthorized_generation')
                result = execute(request, database)
                response = {'ok': True, 'generation': generation, **result}
            except (ValueError, OSError, sqlite3.Error):
                response = {'ok': False, 'error': 'guest_operation_failed'}
            conn.sendall(json.dumps(response).encode() + b'\n')


if __name__ == '__main__':
    main()
