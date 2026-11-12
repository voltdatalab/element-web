#!/bin/bash
# Copyright 2026 Volt Data Lab
# SPDX-License-Identifier: AGPL-3.0-only
# Run manually from this directory as root on the explicitly authorized lab host.
set -euo pipefail
[ "$(id -u)" = 0 ]
[ "$(uname -m)" = x86_64 ]
[ -c /dev/kvm ]
if [ -e /opt/firecracker-lab/assets.sha256 ] || [ -e /var/lib/firecracker-lab/machines.sqlite ] ||
   [ -d /opt/clawdia-firecracker-lab ] || [ -d /var/lib/clawdia-fc-lab ]; then
    echo "Existing lab detected. Refusing to replace or split persistent VM assets and state." >&2
    exit 1
fi
install -d -m 0755 /opt/firecracker-lab
install -d -m 0700 /var/lib/firecracker-lab
install -d -m 0750 /run/firecracker-lab
install -d -m 0755 /sys/fs/cgroup/firecracker-lab
build_dir=$(mktemp -d /var/tmp/firecracker-lab-build.XXXXXX)
trap 'rm -rf "$build_dir"' EXIT
release=firecracker-v1.18.0-x86_64.tgz
curl --fail --location --silent --show-error "https://github.com/firecracker-microvm/firecracker/releases/download/v1.18.0/$release" -o "$build_dir/$release"
curl --fail --location --silent --show-error "https://github.com/firecracker-microvm/firecracker/releases/download/v1.18.0/$release.sha256.txt" -o "$build_dir/$release.sha256.txt"
(cd "$build_dir" && sha256sum --check "$release.sha256.txt")
tar -xzf "$build_dir/$release" -C "$build_dir"
install -m 0755 "$build_dir/release-v1.18.0-x86_64/firecracker-v1.18.0-x86_64" /opt/firecracker-lab/firecracker
install -m 0755 "$build_dir/release-v1.18.0-x86_64/jailer-v1.18.0-x86_64" /opt/firecracker-lab/jailer
curl --fail --location --silent --show-error https://s3.amazonaws.com/spec.ccfc.min/firecracker-ci/20261105-6ea6634994fa-0/x86_64/vmlinux-6.1.188 -o /opt/firecracker-lab/vmlinux
chmod 0444 /opt/firecracker-lab/vmlinux
docker build --tag firecracker-lab-guest:lab --file Dockerfile.guest .
container=$(docker create firecracker-lab-guest:lab)
mkdir "$build_dir/rootfs"
docker export "$container" | tar -xf - -C "$build_dir/rootfs"
docker rm "$container"
truncate -s 256M /opt/firecracker-lab/rootfs.ext4
mkfs.ext4 -q -F -d "$build_dir/rootfs" /opt/firecracker-lab/rootfs.ext4
chmod 0444 /opt/firecracker-lab/rootfs.ext4
install -m 0644 worker.py /opt/firecracker-lab/worker.py
install -m 0644 firecracker-lab.service /etc/systemd/system/firecracker-lab.service
(cd /opt/firecracker-lab && sha256sum firecracker jailer vmlinux rootfs.ext4 > assets.sha256)
systemctl daemon-reload
systemctl enable --now firecracker-lab.service
/opt/firecracker-lab/firecracker --version
