#!/usr/bin/env bash
# Run only inside a dedicated, controller-delegated systemd unit. The caller chooses the unit/user.
set -euo pipefail
qualification_relative=$(awk -F: '$1 == "0" && $2 == "" { print $3 }' /proc/self/cgroup)
[[ "$qualification_relative" == /* && "$qualification_relative" != / ]]
qualification_group="/sys/fs/cgroup${qualification_relative}"
[[ -f "$qualification_group/cgroup.controllers" ]]
mkdir "$qualification_group/qualification-control"
printf '%s\n' "$$" > "$qualification_group/qualification-control/cgroup.procs"
[[ -z "$(cat "$qualification_group/cgroup.procs")" ]]
printf '%s\n' '+cpu +memory +pids' > "$qualification_group/cgroup.subtree_control"
mkdir "$qualification_group/qualification-workers"
export DSH_RESOURCE_QUALIFICATION_ROOT="$qualification_group/qualification-workers"
exec "$@"
