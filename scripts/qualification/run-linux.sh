#!/usr/bin/env bash
# Run from a prepared source checkout on a disposable Linux host, with a pinned installed Harness CLI.
set -euo pipefail
if [[ ${DSH_DISPOSABLE_QUALIFICATION:-} != 1 || $(id -u) == 0 || $(uname -s) != Linux ]]; then
  printf '%s\n' 'Use a disposable Linux test user with DSH_DISPOSABLE_QUALIFICATION=1.' >&2
  exit 1
fi
: "${DSH_ENDPOINT_QUALIFICATION_CLI:?Supply the pinned installed Harness CLI}"
[[ -x $DSH_ENDPOINT_QUALIFICATION_CLI && -f tests/fixtures/resource-qualification.sh && -f pnpm-lock.yaml ]]
[[ $("$DSH_ENDPOINT_QUALIFICATION_CLI" --version) == 0.2.1-rc.3 ]]
agentic_qa_unit="agentic-qualification-$(python3 -c 'import uuid; print(uuid.uuid4().hex)')"
pnpm typecheck
pnpm build
sudo -n systemd-run --wait --pipe --collect --service-type=exec \
  --unit="$agentic_qa_unit" --uid="$(id -u)" --property='Delegate=cpu memory pids' \
  --property="WorkingDirectory=$PWD" --setenv="PATH=$PATH" --setenv=NO_COLOR=1 \
  --setenv=DSH_REMOTE_ISOLATION=1 --setenv=DSH_ENDPOINT_LAUNCHER_QUALIFICATION=1 --setenv=DSH_SSH_TRANSPORT_QUALIFICATION=1 \
  --setenv=DSH_PUBLICATION_HARNESS_QUALIFICATION=1 \
  --setenv="DSH_ABLITERATION_ADAPTER_PACKAGE=${DSH_ABLITERATION_ADAPTER_PACKAGE:-}" \
  --setenv="DSH_ENDPOINT_QUALIFICATION_CLI=$DSH_ENDPOINT_QUALIFICATION_CLI" \
  /bin/bash "$PWD/tests/fixtures/resource-qualification.sh" pnpm test --maxWorkers=4
export XDG_RUNTIME_DIR="/run/user/$(id -u)"
export DBUS_SESSION_BUS_ADDRESS="unix:path=$XDG_RUNTIME_DIR/bus"
DSH_DELEGATED_SERVICE_QUALIFICATION=1 DSH_NATIVE_SERVICE_QUALIFICATION=1 DSH_INSTALLED_SERVICE_QUALIFICATION=1 \
  DSH_SSH_TRANSPORT_QUALIFICATION=1 DSH_SERVICE_QUALIFICATION_CLI="$DSH_ENDPOINT_QUALIFICATION_CLI" \
  NO_COLOR=1 pnpm exec vitest run tests/delegated-service.spec.ts tests/launcher-service.spec.ts tests/transport-launcher.spec.ts
