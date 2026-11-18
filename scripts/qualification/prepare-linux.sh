#!/usr/bin/env bash
# Provision only a disposable native qualification machine. Never run on a production/user-service host.
set -euo pipefail
if [[ ${DSH_DISPOSABLE_QUALIFICATION:-} != 1 || $(id -u) == 0 ]]; then
  printf '%s\n' 'Run as the disposable VM test user with DSH_DISPOSABLE_QUALIFICATION=1.' >&2
  exit 1
fi
. /etc/os-release
if [[ $ID != ubuntu || $VERSION_ID != 22.04 ]]; then
  printf '%s\n' 'This qualification bootstrap supports Ubuntu 22.04 only.' >&2
  exit 1
fi
case $(uname -m) in
  aarch64) agentic_node_arch=arm64; agentic_node_sha=eb187837a2230d4047161ac0be008584e16b46f726e9c9490ee35dc6b17d9ba8 ;;
  x86_64) agentic_node_arch=x64; agentic_node_sha=48cc0e21e048790e54c0cf5749c2725005313d652651c40b7a21feb9697aaf75 ;;
  *) printf '%s\n' 'Unsupported qualification architecture.' >&2; exit 1 ;;
esac
sudo -n apt-get update
sudo -n env DEBIAN_FRONTEND=noninteractive apt-get install --yes bubblewrap ripgrep openssh-server ca-certificates curl xz-utils dbus-user-session git build-essential python3
sudo -n install -d -m 0755 /run/sshd
agentic_node_version=24.22.2
if [[ $(/usr/local/bin/node --version 2>/dev/null || true) != v${agentic_node_version} ]]; then
  agentic_download=$(mktemp -d)
  trap 'rm -rf -- "$agentic_download"' EXIT
  agentic_node_file="node-v${agentic_node_version}-linux-${agentic_node_arch}.tar.xz"
  curl --fail --location --proto '=https' --tlsv1.2 --output "$agentic_download/$agentic_node_file" "https://nodejs.org/dist/v${agentic_node_version}/${agentic_node_file}"
  printf '%s  %s\n' "$agentic_node_sha" "$agentic_download/$agentic_node_file" | sha256sum --check --strict
  sudo -n tar -xJf "$agentic_download/$agentic_node_file" -C /usr/local --strip-components=1 --no-same-owner
fi
export PATH="/usr/local/bin:$PATH"
sudo -n env PATH="$PATH" npm install --global --no-audit --no-fund pnpm@11.25.0
agentic_user_uid=$(id -u)
agentic_dropin="/etc/systemd/system/user@${agentic_user_uid}.service.d"
sudo -n install -d -m 0755 "$agentic_dropin"
printf '[Service]\nDelegate=cpu memory pids\n' | sudo -n tee "$agentic_dropin/90-agentic-qualification.conf" >/dev/null
sudo -n systemctl daemon-reload
sudo -n loginctl enable-linger "$(id -un)"
# systemd 249 can race cgroup cleanup on restart after changing delegation. Observe its old group disappearing first.
# The opt-in above acknowledges that stopping this disposable manager stops all of its user services.
agentic_old_group=$(systemctl show "user@${agentic_user_uid}.service" --property=ControlGroup --value)
sudo -n systemctl stop "user@${agentic_user_uid}.service"
if [[ -n $agentic_old_group ]]; then
  [[ $agentic_old_group == /user.slice/* && $agentic_old_group != *..* ]]
  for ((agentic_wait=0; agentic_wait<150; agentic_wait++)); do
    [[ ! -e /sys/fs/cgroup${agentic_old_group} ]] && break
    sleep 0.2
  done
  if [[ -e /sys/fs/cgroup${agentic_old_group} ]]; then
    printf '%s\n' 'Old user-manager cgroup has not drained and disappeared; inspect it before restarting.' >&2
    exit 1
  fi
fi
sudo -n systemctl start "user@${agentic_user_uid}.service"
export XDG_RUNTIME_DIR="/run/user/${agentic_user_uid}"
export DBUS_SESSION_BUS_ADDRESS="unix:path=$XDG_RUNTIME_DIR/bus"
systemctl --user show --property=ControlGroup --value
node --version
pnpm --version
bwrap --version
