# Copyright 2026 Volt Data Lab
# SPDX-License-Identifier: AGPL-3.0-only
"""Validate deployment configuration without starting containers or contacting a worker."""
import json
import os
from pathlib import Path
import subprocess
import unittest


ROOT = Path(__file__).resolve().parents[2]


def configuration(environment=None, arguments=None):
    # Do not load local credentials or .env files into configuration tests.
    env = {key: os.environ[key] for key in ('PATH', 'HOME') if key in os.environ}
    command = [
        'docker', 'compose', '--env-file', '/dev/null',
        '-f', 'apps/agents/compose.yaml', '-f', 'apps/agents/compose.firecracker.yaml',
        *(arguments or []), 'config', '--format', 'json',
    ]
    result = subprocess.run(command, cwd=ROOT, env={**env, **(environment or {})},
                            capture_output=True, text=True, check=True, timeout=30)
    return json.loads(result.stdout)


class ComposeTests(unittest.TestCase):
    def test_defaults_keep_the_existing_matrix_domain_and_canonical_socket(self):
        config = configuration()
        self.assertEqual(config['name'], 'element-agents')
        environment = config['services']['agents']['environment']
        self.assertEqual(environment['MATRIX_SERVER_NAME'], 'clawdia-lab.local')
        self.assertEqual(environment['FIRECRACKER_LAB_SOCKET'], '/run/firecracker-lab/worker.sock')

    def test_distinct_project_names_isolate_both_default_volumes(self):
        configs = [
            configuration(),
            configuration({'ELEMENT_AGENTS_PROJECT_NAME': 'element-agents-review-a'}),
            configuration(arguments=['-p', 'element-agents-review-b']),
        ]
        self.assertEqual([config['name'] for config in configs],
                         ['element-agents', 'element-agents-review-a', 'element-agents-review-b'])
        for volume in ('agents-data', 'synapse-data'):
            names = []
            for config in configs:
                with self.subTest(project=config['name'], volume=volume):
                    entry = config['volumes'][volume]
                    self.assertEqual(entry['name'], config['name'] + '_' + volume)
                    self.assertFalse(entry.get('external', False))
                    names.append(entry['name'])
            self.assertEqual(len(set(names)), len(configs))

    def test_explicit_existing_volumes_and_socket_are_reused(self):
        config = configuration({
            'ELEMENT_AGENTS_STATE_VOLUME': 'clawdia-element-first-slice_agents-data',
            'ELEMENT_AGENTS_SYNAPSE_VOLUME': 'clawdia-element-first-slice_synapse-data',
            'ELEMENT_AGENTS_EXTERNAL_VOLUMES': 'true',
            'FIRECRACKER_LAB_SOCKET_DIR': '/run/clawdia-firecracker-lab',
        })
        for volume in ('agents-data', 'synapse-data'):
            self.assertEqual(config['volumes'][volume],
                             {'name': 'clawdia-element-first-slice_' + volume, 'external': True})
        bind = next(mount for mount in config['services']['agents']['volumes'] if mount['type'] == 'bind')
        self.assertEqual(bind['source'], '/run/clawdia-firecracker-lab')
        self.assertEqual(bind['target'], '/run/firecracker-lab')
        self.assertTrue(bind['read_only'])

    def test_canonical_allowlist_precedence_includes_an_explicit_empty_value(self):
        cases = [
            ({'CLAWDIA_ALLOWED_USERS': '@legacy:test'}, '@legacy:test'),
            ({'CLAWDIA_ALLOWED_USERS': '@legacy:test', 'ELEMENT_AGENTS_ALLOWED_USERS': ''}, ''),
            ({'CLAWDIA_ALLOWED_USERS': '@legacy:test', 'ELEMENT_AGENTS_ALLOWED_USERS': '@current:test'}, '@current:test'),
        ]
        for environment, expected in cases:
            with self.subTest(environment=environment):
                config = configuration(environment)
                self.assertEqual(config['services']['agents']['environment']['ELEMENT_AGENTS_ALLOWED_USERS'], expected)


if __name__ == '__main__':
    unittest.main()
