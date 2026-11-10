# Copyright 2026 Volt Data Lab
# SPDX-License-Identifier: AGPL-3.0-only
from pathlib import Path
import tempfile
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


if __name__ == '__main__':
    unittest.main()
