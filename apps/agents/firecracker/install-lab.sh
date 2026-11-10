#!/bin/bash
# Copyright 2026 Volt Data Lab
# SPDX-License-Identifier: AGPL-3.0-only
# Run manually from this directory as root on the explicitly authorized lab host.
set -euo pipefail
[ "$(id -u)" = 0 ]
[ "$(uname -m)" = x86_64 ]
[ -c /dev/kvm ]
if [ -f /opt/clawdia-firecracker-lab/assets.sha256 ]; then
    echo "Lab assets already initialized. Refusing to replace disks used by running VMs." >&2
    exit 1
fi
install -d -m 0755 /opt/clawdia-firecracker-lab
install -d -m 0700 /var/lib/clawdia-fc-lab
install -d -m 0750 /run/clawdia-firecracker-lab
install -d -m 0755 /sys/fs/cgroup/clawdia-fc-lab
build_dir=$(mktemp -d /var/tmp/clawdia-fc-build.XXXXXX)
trap 'rm -rf "$build_dir"' EXIT
release=firecracker-v1.18.0-x86_64.tgz
curl --fail --location --silent --show-error "https://github.com/firecracker-microvm/firecracker/releases/download/v1.18.0/$release" -o "$build_dir/$release"
curl --fail --location --silent --show-error "https://github.com/firecracker-microvm/firecracker/releases/download/v1.18.0/$release.sha256.txt" -o "$build_dir/$release.sha256.txt"
(cd "$build_dir" && sha256sum --check "$release.sha256.txt")
tar -xzf "$build_dir/$release" -C "$build_dir"
install -m 0755 "$build_dir/release-v1.18.0-x86_64/firecracker-v1.18.0-x86_64" /opt/clawdia-firecracker-lab/firecracker
install -m 0755 "$build_dir/release-v1.18.0-x86_64/jailer-v1.18.0-x86_64" /opt/clawdia-firecracker-lab/jailer
curl --fail --location --silent --show-error https://s3.amazonaws.com/spec.ccfc.min/firecracker-ci/20261105-6ea6634994fa-0/x86_64/vmlinux-6.1.188 -o /opt/clawdia-firecracker-lab/vmlinux
chmod 0444 /opt/clawdia-firecracker-lab/vmlinux
docker build --tag clawdia-fc-guest:lab --file Dockerfile.guest .
container=$(docker create clawdia-fc-guest:lab)
mkdir "$build_dir/rootfs"
docker export "$container" | tar -xf - -C "$build_dir/rootfs"
docker rm "$container"
truncate -s 256M /opt/clawdia-firecracker-lab/rootfs.ext4
mkfs.ext4 -q -F -d "$build_dir/rootfs" /opt/clawdia-firecracker-lab/rootfs.ext4
chmod 0444 /opt/clawdia-firecracker-lab/rootfs.ext4
install -m 0644 worker.py /opt/clawdia-firecracker-lab/worker.py
install -m 0644 clawdia-firecracker.service /etc/systemd/system/clawdia-firecracker-lab.service
(cd /opt/clawdia-firecracker-lab && sha256sum firecracker jailer vmlinux rootfs.ext4 > assets.sha256)
systemctl daemon-reload
systemctl enable --now clawdia-firecracker-lab.service
/opt/clawdia-firecracker-lab/firecracker --version
