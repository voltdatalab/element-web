# Copyright 2026 Volt Data Lab
# SPDX-License-Identifier: AGPL-3.0-only
"""Trusted host controller. Only UUID-bound guest file operations cross this socket."""
import fcntl
import hashlib
import json
import os
from pathlib import Path
import secrets
import signal
import socket
import socketserver
import stat
import sqlite3
import struct
import subprocess
import time
import uuid

BASE = Path(os.environ.get('CLAWDIA_FC_STATE', '/var/lib/clawdia-fc-lab'))
ASSETS = Path(os.environ.get('CLAWDIA_FC_ASSETS', '/opt/clawdia-firecracker-lab'))
SOCKET = Path(os.environ.get('CLAWDIA_FC_SOCKET', '/run/clawdia-firecracker-lab/worker.sock'))
ALLOWED_UID = int(os.environ.get('CLAWDIA_FC_CLIENT_UID', '1000'))
MAX_MACHINES = int(os.environ.get('CLAWDIA_FC_MAX_MACHINES', '4'))
CGROUP = Path('/sys/fs/cgroup/clawdia-fc-lab')


def identity(value):
    if not isinstance(value, str) or str(uuid.UUID(value)) != value:
        raise ValueError('invalid_agent')
    return value


def reset_jail_devices(root, cgroup):
    # Jailer creates these nodes exclusively, so a stopped jail needs fresh ones.
    processes = cgroup / 'cgroup.procs'
    if processes.exists() and processes.read_text().strip():
        raise ValueError('machine_still_running')
    devices = [('dev/net/tun', 10, 200), ('dev/kvm', 10, 232), ('dev/urandom', 1, 9)]
    present = []
    for relative, major, minor in devices:
        path = root / relative
        if any(parent.is_symlink() for parent in (root / 'dev', root / 'dev/net')):
            raise ValueError('unexpected_jail_device')
        try:
            info = path.lstat()
        except FileNotFoundError:
            continue
        if not stat.S_ISCHR(info.st_mode) or info.st_rdev != os.makedev(major, minor):
            raise ValueError('unexpected_jail_device')
        present.append(path)
    for path in present:
        path.unlink()


class Worker:
    def __init__(self):
        BASE.mkdir(mode=0o700, parents=True, exist_ok=True)
        self.db = sqlite3.connect(BASE / 'machines.sqlite')
        self.db.execute('PRAGMA journal_mode=WAL')
        self.db.execute('PRAGMA synchronous=FULL')
        self.db.executescript('''
            CREATE TABLE IF NOT EXISTS machines (
                sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL,
                generation TEXT NOT NULL, token TEXT NOT NULL, desired TEXT NOT NULL,
                observed TEXT NOT NULL, pid INTEGER, process_start TEXT
            );
            CREATE TABLE IF NOT EXISTS restarts (
                agent TEXT, request TEXT, generation TEXT, result TEXT, PRIMARY KEY(agent,request)
            );
        ''')
        self.db.row_factory = sqlite3.Row

    def get(self, agent):
        return self.db.execute('SELECT * FROM machines WHERE id=?', (identity(agent),)).fetchone()

    def root(self, agent):
        return BASE / 'jails' / 'firecracker' / agent / 'root'

    def alive(self, row):
        if not row or not row['pid']:
            return False
        try:
            fields = Path(f"/proc/{row['pid']}/stat").read_text().split()
            return fields[21] == row['process_start'] and fields[2] != 'Z'
        except OSError:
            return False

    def recover(self, row):
        if row and not self.alive(row):
            try:
                pid = int((self.root(row['id']) / 'firecracker.pid').read_text())
                if os.readlink(f'/proc/{pid}/root') != str(self.root(row['id'])):
                    return row
                if Path(f'/proc/{pid}').stat().st_uid != 300000 + row['sequence']:
                    return row
                started = Path(f'/proc/{pid}/stat').read_text().split()[21]
                self.db.execute('UPDATE machines SET pid=?,process_start=? WHERE id=?', (pid, started, row['id']))
                self.db.commit()
                return self.get(row['id'])
            except (OSError, ValueError):
                pass
        return row

    def guest(self, row, op, key, **args):
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as sock:
            sock.settimeout(10)
            sock.connect(str(self.root(row['id']) / 'vsock'))
            sock.sendall(b'CONNECT 5000\n')
            stream = sock.makefile('rb')
            if not stream.readline(80).startswith(b'OK '):
                raise ValueError('guest_not_ready')
            payload = {'op': op, 'requestId': key, 'generation': row['generation'], 'token': row['token'], **args}
            sock.sendall(json.dumps(payload).encode() + b'\n')
            line = stream.readline(512000)
            if not line.endswith(b'\n'):
                raise ValueError('invalid_guest_response')
            result = json.loads(line)
            if not result.get('ok') or result.get('generation') != row['generation']:
                raise ValueError('guest_operation_failed')
            return result

    def ensure(self, agent):
        row = self.get(agent)
        if not row:
            if self.db.execute('SELECT COUNT(*) FROM machines').fetchone()[0] >= MAX_MACHINES:
                raise ValueError('machine_capacity_exceeded')
            self.db.execute('INSERT INTO machines (id,generation,token,desired,observed) VALUES (?,?,?,?,?)',
                            (agent, str(uuid.uuid4()), secrets.token_hex(32), 'running', 'preparing'))
            self.db.commit()
            row = self.get(agent)
        row = self.recover(row)
        if self.alive(row):
            result = self.guest(row, 'status', 'status-' + str(uuid.uuid4()))
            self.db.execute("UPDATE machines SET observed='ready' WHERE id=?", (agent,))
            self.db.commit()
            return self.status(row, result)
        if row['observed'] in ('ready', 'stopped'):
            self.db.execute("UPDATE machines SET generation=?,token=?,desired='running',observed='preparing' WHERE id=?",
                            (str(uuid.uuid4()), secrets.token_hex(32), agent))
            self.db.commit()
            row = self.get(agent)
        self.boot(row)
        row = self.get(agent)
        result = self.guest(row, 'status', 'status-' + str(uuid.uuid4()))
        return self.status(row, result)

    def status(self, row, result):
        return {'agentId': row['id'], 'generation': row['generation'], 'bootId': result['bootId'],
                'state': 'ready', 'vcpu': 1, 'memoryMiB': 256, 'workspaceMiB': 256}

    def boot(self, row):
        agent = row['id']
        root = self.root(agent)
        root.mkdir(parents=True, exist_ok=True)
        reset_jail_devices(root, CGROUP / agent)
        uid = 300000 + row['sequence']
        os.chown(root, uid, uid)
        for name in ('vmlinux', 'rootfs.ext4'):
            dest = root / name
            if not dest.exists():
                os.link(ASSETS / name, dest)
        disk = root / 'workspace.ext4'
        if not disk.exists():
            with disk.open('xb') as f:
                f.truncate(256 * 1024 * 1024)
            subprocess.run(['mkfs.ext4', '-q', '-F', str(disk)], check=True, capture_output=True)
        os.chown(disk, uid, uid)
        os.chmod(disk, 0o600)
        for name in ('api.sock', 'vsock', 'firecracker.pid'):
            (root / name).unlink(missing_ok=True)
        config = {
            'boot-source': {'kernel_image_path': '/vmlinux', 'boot_args':
                'console=ttyS0 reboot=k panic=1 pci=off root=/dev/vda ro init=/init '
                f"clawdia_token={row['token']} clawdia_generation={row['generation']}"},
            'drives': [
                {'drive_id': 'rootfs', 'path_on_host': '/rootfs.ext4', 'is_root_device': True, 'is_read_only': True},
                {'drive_id': 'workspace', 'path_on_host': '/workspace.ext4', 'is_root_device': False, 'is_read_only': False}
            ],
            'machine-config': {'vcpu_count': 1, 'mem_size_mib': 256, 'smt': False},
            'vsock': {'guest_cid': row['sequence'] + 3, 'uds_path': '/vsock'}
        }
        conf = root / 'config.json'
        conf.write_text(json.dumps(config))
        os.chown(conf, uid, uid)
        os.chmod(conf, 0o600)
        self.db.execute("UPDATE machines SET observed='booting',pid=NULL,process_start=NULL WHERE id=?", (agent,))
        self.db.commit()
        args = [str(ASSETS / 'jailer'), '--id', agent, '--exec-file', str(ASSETS / 'firecracker'),
                '--uid', str(uid), '--gid', str(uid), '--chroot-base-dir', str(BASE / 'jails'),
                '--new-pid-ns', '--cgroup-version', '2', '--parent-cgroup', 'clawdia-fc-lab',
                '--cgroup', 'cpu.max=100000 100000', '--cgroup', 'memory.max=402653184',
                '--cgroup', 'pids.max=64', '--resource-limit', 'no-file=256', '--resource-limit', 'fsize=268435456',
                '--', '--config-file', '/config.json', '--api-sock', '/api.sock']
        log = (BASE / f'{agent}.log').open('ab')
        proc = subprocess.Popen(args, stdin=subprocess.DEVNULL, stdout=log, stderr=log, close_fds=True)
        log.close()
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            pid_file = root / 'firecracker.pid'
            if pid_file.exists():
                try:
                    pid = int(pid_file.read_text())
                    started = Path(f'/proc/{pid}/stat').read_text().split()[21]
                    self.db.execute('UPDATE machines SET pid=?,process_start=? WHERE id=?', (pid, started, agent))
                    self.db.commit()
                    row = self.get(agent)
                    self.guest(row, 'status', 'boot-' + str(uuid.uuid4()))
                    self.db.execute("UPDATE machines SET observed='ready' WHERE id=?", (agent,))
                    self.db.commit()
                    return
                except (OSError, ValueError):
                    pass
            if proc.poll() is not None and proc.returncode != 0:
                break
            time.sleep(0.15)
        self.stop(agent)
        raise ValueError('machine_boot_failed')

    def stop(self, agent):
        row = self.recover(self.get(agent))
        if row and self.alive(row):
            try:
                self.guest(row, 'sync', 'stop-' + str(uuid.uuid4()))
            except (OSError, ValueError):
                pass
            os.kill(row['pid'], signal.SIGTERM)
            deadline = time.monotonic() + 10
            while self.alive(row) and time.monotonic() < deadline:
                time.sleep(0.1)
            if self.alive(row):
                os.kill(row['pid'], signal.SIGKILL)
                deadline = time.monotonic() + 2
                while self.alive(row) and time.monotonic() < deadline:
                    time.sleep(0.05)
                if self.alive(row):
                    raise ValueError('machine_stop_uncertain')
        self.db.execute("UPDATE machines SET desired='stopped',observed='stopped',pid=NULL,process_start=NULL WHERE id=?", (agent,))
        self.db.commit()

    def restart(self, agent, key):
        row = self.get(agent)
        if not row:
            raise ValueError('machine_not_found')
        old = self.db.execute('SELECT generation,result FROM restarts WHERE agent=? AND request=?', (agent, key)).fetchone()
        if old and old[1]:
            return json.loads(old[1])
        target = old[0] if old else str(uuid.uuid4())
        if not old:
            self.db.execute('INSERT INTO restarts (agent,request,generation) VALUES (?,?,?)', (agent, key, target))
            self.db.commit()
        if row['generation'] != target:
            self.stop(agent)
            self.db.execute("UPDATE machines SET generation=?,token=?,desired='running',observed='preparing' WHERE id=?",
                            (target, secrets.token_hex(32), agent))
            self.db.commit()
        result = self.ensure(agent)
        self.db.execute('UPDATE restarts SET result=? WHERE agent=? AND request=?', (json.dumps(result), agent, key))
        self.db.commit()
        return result

    def handle(self, request):
        if not isinstance(request, dict):
            raise ValueError('invalid_request')
        agent = identity(request.get('agentId'))
        op = request.get('op')
        key = request.get('requestId')
        if not isinstance(key, str) or not 1 <= len(key) <= 256:
            raise ValueError('invalid_request')
        if op == 'ensure':
            return self.ensure(agent)
        if op == 'restart':
            return self.restart(agent, key)
        if op == 'stop':
            self.stop(agent)
            return {'state': 'stopped'}
        if op not in ('read', 'write'):
            raise ValueError('operation_not_supported')
        self.ensure(agent)
        args = {'path': request.get('path')}
        if op == 'write':
            args['content'] = request.get('content')
        return self.guest(self.get(agent), op, key, **args)


class Handler(socketserver.StreamRequestHandler):
    def handle(self):
        self.request.settimeout(60)
        peer = struct.unpack('3i', self.request.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
        try:
            if peer[1] not in (0, ALLOWED_UID):
                raise ValueError('unauthorized_peer')
            line = self.rfile.readline(512000)
            if not line.endswith(b'\n'):
                raise ValueError('invalid_request')
            result = self.server.worker.handle(json.loads(line))
            response = {'ok': True, 'result': result}
        except (ValueError, OSError, sqlite3.Error, subprocess.SubprocessError):
            response = {'ok': False, 'error': 'machine_operation_failed'}
        self.wfile.write(json.dumps(response).encode() + b'\n')


def main():
    os.umask(0o077)
    worker = Worker()
    lock = (BASE / 'worker.lock').open('w')
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    CGROUP.mkdir(exist_ok=True)
    (CGROUP / 'cgroup.subtree_control').write_text('+cpu +memory +pids')
    SOCKET.parent.mkdir(mode=0o750, parents=True, exist_ok=True)
    os.chown(SOCKET.parent, 0, ALLOWED_UID)
    os.chmod(SOCKET.parent, 0o750)
    SOCKET.unlink(missing_ok=True)
    with socketserver.UnixStreamServer(str(SOCKET), Handler) as server:
        os.chown(SOCKET, 0, ALLOWED_UID)
        os.chmod(SOCKET, 0o660)
        server.worker = worker
        server.serve_forever()


if __name__ == '__main__':
    main()
