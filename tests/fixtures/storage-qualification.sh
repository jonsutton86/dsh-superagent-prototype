#!/usr/bin/env bash
# Disposable hosted-CI fixture only; never formats an existing device or operator path.
set -euo pipefail
[[ ${GITHUB_ACTIONS:-} == true && $(id -u) == 0 && $# == 2 ]]
[[ $1 =~ ^[1-9][0-9]*$ && $2 =~ ^[1-9][0-9]*$ ]]
fixture=$(mktemp -d /tmp/agentic-storage-XXXXXXXX)
chmod 0755 "$fixture"
mkdir "$fixture/volume"
cleanup() {
  if mountpoint -q "$fixture/volume"; then
    umount "$fixture/volume" || { echo 'Storage fixture cleanup failed; preserving backing image' >&2; return 1; }
  fi
  rm -rf -- "$fixture"
}
trap cleanup EXIT
truncate -s 512M "$fixture/volume.img"
mkfs.xfs -f "$fixture/volume.img" >/dev/null
mount -o loop,prjquota,nodev,nosuid "$fixture/volume.img" "$fixture/volume"
python3 "$(dirname "$0")/storage-service-contract.py"
python3 "$(dirname "$0")/storage-listener-contract.py"
python3 "$(dirname "$0")/storage-install-contract.py"
python3 "$(dirname "$0")/storage-qualification.py" "$fixture/volume" "$1" "$2"

# Observe the same prepared filesystem through the real Harness subprocess runtime.
xfs_quota -x -c 'enable -p' "$fixture/volume"
# Run the unprivileged client before root-run Vitest creates shared tooling cache directories.
python3 "$(dirname "$0")/storage-service-native.py" "$fixture/volume" "$1" "$2"
DSH_STORAGE_PROBE_ROOT="$fixture/volume" pnpm exec vitest run tests/storage-probe.spec.ts

python3 "$(dirname "$0")/storage-host-native.py" "$fixture/volume" "$1" "$2"

python3 "$(dirname "$0")/storage-install-native.py" "$fixture/volume" "$1" "$2"
