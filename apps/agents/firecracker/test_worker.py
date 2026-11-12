# Copyright 2026 Volt Data Lab
# SPDX-License-Identifier: AGPL-3.0-only
from pathlib import Path
import tempfile
import os
import stat
import signal
from types import SimpleNamespace
from unittest.mock import patch
import unittest
import uuid
import worker


class FakeWorker(worker.Worker):
    def __init__(self):
        super().__init__()
        self.running = set()
        self.boots = 0
        self.stops = 0

    def alive(self, row):
        return bool(row and row['id'] in self.running)

    def recover(self, row):
        return row

    def boot(self, row):
        self.boots += 1
        self.running.add(row['id'])
        self.db.execute("UPDATE machines SET observed='ready' WHERE id=?", (row['id'],))
        self.db.commit()

    def stop(self, agent):
        self.stops += 1
        self.running.discard(agent)

    def guest(self, row, op, key, **args):
        return {'bootId': row['generation']}


class LabConfigurationTests(unittest.TestCase):
    def test_fresh_install_uses_firecracker_lab_paths_and_keeps_resource_limits(self):
        config = worker.lab_configuration({}, lambda path: False)
        self.assertEqual(config['STATE'], Path('/var/lib/firecracker-lab'))
        self.assertEqual(config['ASSETS'], Path('/opt/firecracker-lab'))
        self.assertEqual(config['SOCKET'], Path('/run/firecracker-lab/worker.sock'))
        self.assertEqual(config['CGROUP'], Path('/sys/fs/cgroup/firecracker-lab'))
        self.assertEqual(config['CLIENT_UID'], 1000)
        self.assertEqual(config['MAX_MACHINES'], 4)

    def test_existing_legacy_state_keeps_its_assets_socket_and_cgroup_together(self):
        config = worker.lab_configuration({}, lambda path: path == Path('/var/lib/clawdia-fc-lab'))
        self.assertEqual(config['STATE'], Path('/var/lib/clawdia-fc-lab'))
        self.assertEqual(config['ASSETS'], Path('/opt/clawdia-firecracker-lab'))
        self.assertEqual(config['SOCKET'], Path('/run/clawdia-firecracker-lab/worker.sock'))
        self.assertEqual(config['CGROUP'], Path('/sys/fs/cgroup/clawdia-fc-lab'))

    def test_ambiguous_default_states_require_an_explicit_choice(self):
        with self.assertRaisesRegex(ValueError, 'ambiguous_lab_state'):
            worker.lab_configuration({}, lambda path: True)

    def test_explicit_canonical_settings_win_over_legacy_settings(self):
        config = worker.lab_configuration({
            'FIRECRACKER_LAB_STATE': '/selected/state', 'CLAWDIA_FC_STATE': '/old/state',
            'FIRECRACKER_LAB_SOCKET': '/selected/worker.sock', 'CLAWDIA_FC_SOCKET': '/old/worker.sock',
            'FIRECRACKER_LAB_MAX_MACHINES': '4', 'CLAWDIA_FC_MAX_MACHINES': '2',
        }, lambda path: True)
        self.assertEqual(config['STATE'], Path('/selected/state'))
        self.assertEqual(config['SOCKET'], Path('/selected/worker.sock'))
        self.assertEqual(config['MAX_MACHINES'], 4)

    def test_legacy_custom_state_keeps_the_legacy_defaults(self):
        config = worker.lab_configuration({'CLAWDIA_FC_STATE': '/existing/custom-state'}, lambda path: False)
        self.assertEqual(config['STATE'], Path('/existing/custom-state'))
        self.assertEqual(config['ASSETS'], Path('/opt/clawdia-firecracker-lab'))
        self.assertEqual(config['CGROUP'], Path('/sys/fs/cgroup/clawdia-fc-lab'))


class WorkerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        worker.BASE = Path(self.temp.name)
        self.w = FakeWorker()
        self.addCleanup(self.w.db.close)
        self.agent = str(uuid.uuid4())

    def test_one_machine_per_agent_and_different_identity_for_another(self):
        one = self.w.ensure(self.agent)
        self.assertEqual(one, self.w.ensure(self.agent))
        two = self.w.ensure(str(uuid.uuid4()))
        self.assertNotEqual(one['generation'], two['generation'])
        self.assertEqual(self.w.boots, 2)
        self.assertEqual(self.w.db.execute('SELECT COUNT(*) FROM machines').fetchone()[0], 2)

    def test_restart_replay_never_restarts_again_even_after_a_later_restart(self):
        initial = self.w.ensure(self.agent)
        first = self.w.restart(self.agent, 'restart-1')
        self.assertNotEqual(initial['bootId'], first['bootId'])
        second = self.w.restart(self.agent, 'restart-2')
        self.assertEqual(self.w.restart(self.agent, 'restart-1'), first)
        self.assertEqual(self.w.ensure(self.agent), second)
        self.assertEqual(self.w.stops, 2)

    def test_unexpected_exit_gets_a_new_generation(self):
        initial = self.w.ensure(self.agent)
        self.w.running.clear()
        recovered = self.w.ensure(self.agent)
        self.assertNotEqual(initial['generation'], recovered['generation'])

    def test_pending_restart_recovers_its_generation(self):
        self.w.ensure(self.agent)
        target = str(uuid.uuid4())
        self.w.db.execute('INSERT INTO restarts (agent,request,generation) VALUES (?,?,?)', (self.agent, 'interrupted', target))
        self.w.db.commit()
        result = self.w.restart(self.agent, 'interrupted')
        self.assertEqual(result['generation'], target)
        self.assertEqual(self.w.restart(self.agent, 'interrupted'), result)

    def test_stop_confirms_exit_after_sigkill_before_recording_stopped(self):
        self.w.ensure(self.agent)
        self.w.db.execute('UPDATE machines SET pid=123 WHERE id=?', (self.agent,))
        self.w.db.commit()
        def kill(pid, sig):
            self.assertEqual(pid, 123)
            if sig == signal.SIGKILL:
                self.w.running.discard(self.agent)
        with patch('worker.os.kill', side_effect=kill) as send, patch('worker.time.monotonic', side_effect=[0, 11, 11]):
            worker.Worker.stop(self.w, self.agent)
        self.assertEqual([call.args[1] for call in send.call_args_list], [signal.SIGTERM, signal.SIGKILL])
        self.assertEqual(self.w.get(self.agent)['observed'], 'stopped')
        self.assertIsNone(self.w.get(self.agent)['pid'])

    def test_stop_keeps_uncertainty_when_sigkill_has_not_quiesced(self):
        self.w.ensure(self.agent)
        self.w.db.execute('UPDATE machines SET pid=123 WHERE id=?', (self.agent,))
        self.w.db.commit()
        with patch('worker.os.kill'), patch('worker.time.monotonic', side_effect=[0, 11, 11, 14]):
            with self.assertRaisesRegex(ValueError, 'machine_stop_uncertain'):
                worker.Worker.stop(self.w, self.agent)
        self.assertEqual(self.w.get(self.agent)['pid'], 123)
        self.assertEqual(self.w.get(self.agent)['observed'], 'ready')

    def test_retired_identity_stays_retired_and_frees_capacity_after_reopen(self):
        identities = [self.agent] + [str(uuid.uuid4()) for _ in range(worker.MAX_MACHINES - 1)]
        for identity in identities:
            self.w.ensure(identity)
        self.w.stop(self.agent)
        with self.w.db:
            self.w.db.execute('INSERT INTO retired_machines VALUES (?,?,?,?)',
                              (self.agent, '2026-11-11T00:00:00Z', '/private/archive', 'verified-manifest'))
            self.w.db.execute('DELETE FROM machines WHERE id=?', (self.agent,))
        boots = self.w.boots
        for op in ['ensure', 'read', 'write', 'restart']:
            with self.subTest(op=op), self.assertRaises(ValueError):
                self.w.handle({'agentId': self.agent, 'op': op, 'requestId': 'old-request', 'path': 'old.txt'})
        self.assertEqual(self.w.boots, boots)
        new_identity = str(uuid.uuid4())
        self.assertEqual(self.w.ensure(new_identity)['agentId'], new_identity)
        self.assertEqual(self.w.db.execute('SELECT COUNT(*) FROM machines').fetchone()[0], worker.MAX_MACHINES)
        reopened = FakeWorker()
        self.addCleanup(reopened.db.close)
        with self.assertRaisesRegex(ValueError, 'machine_retired'):
            reopened.ensure(self.agent)
        self.assertEqual(reopened.boots, 0)

    def test_invalid_id_and_operation_cannot_provision_and_capacity_is_bounded(self):
        for request in [
            {'agentId': '../host', 'op': 'ensure', 'requestId': 'x'},
            {'agentId': self.agent, 'op': 'exec', 'requestId': 'x'},
            {'agentId': self.agent, 'op': 'ensure'},
        ]:
            with self.assertRaises(ValueError):
                self.w.handle(request)
        self.assertEqual(self.w.boots, 0)
        for _ in range(worker.MAX_MACHINES):
            self.w.ensure(str(uuid.uuid4()))
        with self.assertRaises(ValueError):
            self.w.ensure(self.agent)


class JailDeviceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / 'root'
        self.cgroup = Path(self.temp.name) / 'cgroup'
        (self.root / 'dev/net').mkdir(parents=True)
        self.cgroup.mkdir()
        (self.cgroup / 'cgroup.procs').write_text('')

    def test_live_cgroup_blocks_all_device_removal(self):
        (self.cgroup / 'cgroup.procs').write_text('123\n')
        with patch.object(Path, 'unlink') as unlink, self.assertRaisesRegex(ValueError, 'machine_still_running'):
            worker.reset_jail_devices(self.root, self.cgroup)
        unlink.assert_not_called()

    def test_unexpected_regular_file_and_symlink_are_preserved(self):
        tun = self.root / 'dev/net/tun'
        tun.write_text('foreign')
        with self.assertRaisesRegex(ValueError, 'unexpected_jail_device'):
            worker.reset_jail_devices(self.root, self.cgroup)
        self.assertEqual(tun.read_text(), 'foreign')
        tun.unlink()
        tun.symlink_to(self.root / 'workspace.ext4')
        with self.assertRaisesRegex(ValueError, 'unexpected_jail_device'):
            worker.reset_jail_devices(self.root, self.cgroup)
        self.assertTrue(tun.is_symlink())

    def test_only_expected_character_devices_are_removed(self):
        original = Path.lstat
        nodes = {self.root / name: (major, minor) for name, major, minor in
                 [('dev/net/tun', 10, 200), ('dev/kvm', 10, 232), ('dev/urandom', 1, 9)]}
        def lstat(path):
            if path in nodes:
                return SimpleNamespace(st_mode=stat.S_IFCHR | 0o600, st_rdev=os.makedev(*nodes[path]))
            return original(path)
        with patch.object(Path, 'lstat', lstat), patch.object(Path, 'unlink', autospec=True) as unlink:
            worker.reset_jail_devices(self.root, self.cgroup)
        self.assertEqual({call.args[0] for call in unlink.call_args_list}, set(nodes))


if __name__ == '__main__':
    unittest.main()
