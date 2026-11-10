#!/bin/sh
# Copyright 2026 Volt Data Lab
# SPDX-License-Identifier: AGPL-3.0-only
set -eu
mount -t devtmpfs devtmpfs /dev
mount -t proc proc /proc
mount -t sysfs sysfs /sys
mount -t tmpfs -o size=32m,nosuid,nodev tmpfs /tmp
mount -t tmpfs -o size=16m,nosuid,nodev tmpfs /run
mount -t ext4 -o nodev,nosuid,noexec /dev/vdb /workspace
exec /usr/bin/python3 /guest.py
