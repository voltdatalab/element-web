# Copyright 2026 Volt Data Lab
# SPDX-License-Identifier: AGPL-3.0-only
"""Explicit integration check against the installed real Firecracker worker."""
import argparse
import hashlib
import json
import socket
import uuid


def request(address, agent, op, key=None, **args):
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
        client.settimeout(60)
        client.connect(address)
        payload = {'agentId': agent, 'op': op, 'requestId': key or str(uuid.uuid4()), **args}
        client.sendall(json.dumps(payload).encode() + b'\n')
        line = client.makefile('rb').readline(512000)
        result = json.loads(line)
        if not result.get('ok'):
            raise RuntimeError('worker_operation_failed')
        return result['result']


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--socket', default='/run/firecracker-lab/worker.sock')
    parser.add_argument('--agent', required=True, help='A registered lab agent UUID')
    parser.add_argument('--peer', required=True, help='A second lab-only UUID, reserved for isolation validation')
    args = parser.parse_args()
    assert args.agent != args.peer
    initial = request(args.socket, args.agent, 'ensure')
    request(args.socket, args.peer, 'ensure')
    name = 'isolamento-' + uuid.uuid4().hex[:8] + '.txt'
    content = 'Persistência real ' + str(uuid.uuid4()) + '\n'
    written = request(args.socket, args.agent, 'write', path=name, content=content)
    expected = hashlib.sha256(content.encode()).hexdigest()
    assert written['sha256'] == expected
    try:
        request(args.socket, args.peer, 'read', path=name)
    except RuntimeError:
        pass
    else:
        raise AssertionError('Cross-agent file access succeeded')
    restart_key = str(uuid.uuid4())
    restarted = request(args.socket, args.agent, 'restart', key=restart_key)
    assert restarted['bootId'] != initial['bootId']
    assert restarted == request(args.socket, args.agent, 'restart', key=restart_key)
    assert request(args.socket, args.agent, 'ensure')['bootId'] == restarted['bootId']
    recovered = request(args.socket, args.agent, 'read', path=name)
    assert recovered['content'] == content and recovered['sha256'] == expected
    request(args.socket, args.peer, 'stop')
    print(json.dumps({'agent': args.agent, 'peer': args.peer, 'sha256': expected,
                      'initialBootId': initial['bootId'], 'restartedBootId': restarted['bootId'],
                      'persistence': True, 'isolation': True, 'restartReplay': True}))


if __name__ == '__main__':
    main()
