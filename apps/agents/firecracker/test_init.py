# Copyright 2026 Volt Data Lab
# SPDX-License-Identifier: AGPL-3.0-only
import os
from pathlib import Path
import subprocess
import tempfile
import unittest


class InitTests(unittest.TestCase):
    def run_init(self, premounted):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = Path(__file__).with_name('init.sh').read_text()
            self.assertIn('exec /usr/bin/python3 /guest.py', source)
            # Stop before the guest process; exercise the original mount sequence.
            script = root / 'init.sh'
            script.write_text(source.replace('exec /usr/bin/python3 /guest.py', 'exit 0'))
            mount = root / 'mount'
            mount.write_text("#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$MOUNT_LOG\"\nif [ \"$*\" = '-t devtmpfs devtmpfs /dev' ] && [ \"$DEV_PREMOUNTED\" = '1' ]; then exit 32; fi\n")
            mount.chmod(0o755)
            grep = root / 'grep'
            grep.write_text('#!/bin/sh\n[ \"$DEV_PREMOUNTED\" = \"1\" ]\n')
            grep.chmod(0o755)
            log = root / 'mounts.log'
            env = {**os.environ, 'PATH': str(root), 'MOUNT_LOG': str(log), 'DEV_PREMOUNTED': str(int(premounted))}
            result = subprocess.run(['/bin/sh', str(script)], env=env, capture_output=True, text=True, timeout=5)
            return result, log.read_text().splitlines()

    def test_kernel_mounted_devtmpfs_is_not_mounted_again(self):
        result, mounts = self.run_init(True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertNotIn('-t devtmpfs devtmpfs /dev', mounts)
        self.assertIn('-t ext4 -o nodev,nosuid,noexec /dev/vdb /workspace', mounts)

    def test_missing_devtmpfs_is_mounted_before_workspace(self):
        result, mounts = self.run_init(False)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(mounts.count('-t devtmpfs devtmpfs /dev'), 1)
        self.assertLess(mounts.index('-t devtmpfs devtmpfs /dev'), mounts.index('-t ext4 -o nodev,nosuid,noexec /dev/vdb /workspace'))


if __name__ == '__main__':
    unittest.main()
