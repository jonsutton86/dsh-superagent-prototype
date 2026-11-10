# Managed SSH transport

The persistent launcher now has a `transport` role for connecting a coordinator to a prepared Linux execution endpoint.
It runs OpenSSH with one explicit local forward: coordinator `127.0.0.1:3085` to endpoint-host `127.0.0.1:3084`, with
configurable unprivileged ports. The endpoint API stays on loopback. Existing endpoint administration, managed worlds,
paired process/filesystem providers, job ownership and durable effect receipts continue to operate through this connection.
DeepSeek Harness still executes the work; SSH does not become a second execution runtime.

## Trust and preparation

First prepare and verify the Linux endpoint using [067](067-managed-endpoint-launch.md), optionally with the resource/service
setup in [070](070-delegated-endpoint-service.md). Export its `enrollment.json`. The coordinator needs local private copies
of that metadata and the endpoint administrator credential, obtained through an already authenticated administrative
connection. Do not paste the credential into commands, source code or chat. The transport never prints its value.

Use a dedicated SSH key for unattended forwarding. The current service mode reads that private key directly, without an
SSH agent or interactive passphrase prompt. An encrypted key requiring interaction will fail in batch mode. Keep the key
outside the checkout and task workspaces, with mode 0600; keep its parent directory private. Do not reuse a broad-purpose
administrative key. Restrict the public key on the server, for example with this `authorized_keys` prefix before its public
key type and base64 bytes:

```text
restrict,port-forwarding,permitopen="127.0.0.1:3084",command="/usr/bin/false"
```

The forced command prevents use of that key for an interactive shell or file transfer; forwarding with `ssh -N` does not
request a command. An administrator should also restrict that account's SSH forwarding to local forwards, for example
`AllowTcpForwarding local` and `PermitOpen 127.0.0.1:3084` in its reviewed `Match User` configuration. `permitopen` alone
does not constrain reverse forwards. Validate the daemon configuration before reloading it; the launcher does not alter
server accounts, SSH daemon settings, authorized keys or firewall rules. Administrative provisioning and initial private
file transfer use a separate authorized connection.

The private `known_hosts` file must contain the server's independently verified host key for its actual hostname/IP and
SSH port. Compare its SHA-256 fingerprint with the provider console or another trusted channel. `ssh-keyscan` can collect
a candidate key but cannot authenticate it by itself. Unknown and changed server keys are refused; there is no automatic
accept-first-key or overwrite behavior. Only the SSH port needs to be reachable from the coordinator.

## Installation

Create a private JSON configuration on the coordinator, substituting real canonical absolute paths and the host:

```json
{
  "host": "203.0.113.10",
  "user": "agentic",
  "sshPort": 22,
  "identityFile": "/absolute/private/agentic-forwarding-key",
  "knownHostsFile": "/absolute/private/verified_known_hosts",
  "credentialFile": "/absolute/private/endpoint-admin.token",
  "enrollmentFile": "/absolute/private/endpoint-enrollment.json"
}
```

The example IP is a documentation address. Configuration, enrollment, credentials and trust files must be owned by the
current user and inaccessible to other users. Symlinked identity/credential/trust paths, shell options, SSH aliases and
environment expansions in paths are refused. The enrollment must identify a Linux bubblewrap endpoint with an explicit
loopback port. Its ownership and resource-policy binding, when present, are retained. Paths in the enrollment are remote
metadata; `credentialFile` above explicitly selects the private credential on this coordinator.

```sh
umask 077
agentic_checkout="/absolute/path/dsh-superagent-prototype"
agentic_transport_root="$HOME/.local/share/agentic-os-transport"
python3 "$agentic_checkout/scripts/agentic-os" init --role transport \
  --directory "$agentic_transport_root" --transport-config /absolute/private/transport.json --port 3085
python3 "$agentic_checkout/scripts/agentic-os" start --directory "$agentic_transport_root"
python3 "$agentic_checkout/scripts/agentic-os" status --directory "$agentic_transport_root"
python3 "$agentic_checkout/scripts/agentic-os" enrollment --directory "$agentic_transport_root"
```

Transport initialization requires Python and OpenSSH on macOS/Linux, not a second Harness installation or model API key.
It snapshots the verified public host-key file, records SHA-256 pins for configuration, the private SSH identity and the
endpoint credential, and writes private installation metadata. Repeat initialization with the original settings is
idempotent, including interrupted file creation. Changed settings or pins are refused; they do not silently migrate a live
installation. The existing workspace/endpoint roles continue to use their own directories and Harness profiles.

After readiness succeeds, `enrollment` exports the coordinator-local loopback URL, original endpoint UUID, local
credential-file path and current observed resource status. Register those values through the existing endpoint enrollment
UI/API, then create the grant and managed world as documented in [020](020-endpoint-administration.md) and
[022](022-managed-worlds.md). Exporting metadata does not enroll, grant, activate or dispatch anything by itself.

## Lifecycle and failure behavior

The normal `start`, `status`, `stop`, `restart`, `--respect-stop`, `supervise`, `service-install`, `service-status` and
`service-remove` controls apply. Use `service-install` after checking the connection to obtain an owned launchd/systemd
user service. Service installation copies all five launcher modules; unchanged older three/four-module services remain
verifiable, without automatic runtime upgrades. Linux boot persistence still requires an appropriately configured user
manager; macOS uses its login session. Existing services and the main workspace app are independent.

OpenSSH reads only the generated configuration, with no inherited user/system SSH configuration, agent, proxy command,
remote command, password fallback, X11 forwarding or arbitrary environment. It uses strict host-key checking, one explicit
identity, batch mode, no shared control connection, and loopback-only forwarding. Local bind conflicts fail without stopping
unrelated listeners. Process selection includes the installation's unique configuration path and current process identity.
Stop remains available when configuration or credential files are damaged, and preserves the existing data and manual-stop
marker. It closes only the owned SSH connection; it does not cancel or restart remote jobs.

A listener alone is not readiness. An authenticated, bounded, nonredirecting `identity` RPC must match the pinned endpoint
UUID, protocol, Linux confinement, required capabilities, ownership and exact ready resource policy. Moving resource usage
counters are observations, not identity pins. Failed health does not replace a live connection or claim successful work.

Encrypted SSH keepalives detect an unresponsive connection; with a 15-second interval and three unanswered probes, OpenSSH
normally exits after approximately 45 seconds without server responses. The existing supervisor can then reconnect within
its durable automatic-start budget. A failed startup or exhausted budget holds for inspection instead of looping forever.
Endpoint downtime behind a live SSH connection may leave SSH alive; status remains unready, and the supervisor does not
restart the endpoint. A concurrent control operation can return Busy; inspect status and retry the same intended control
after it finishes. A startup observation timeout leaves a live process intact.

Transport recovery issues only identity observations. It never creates replacement work, renews grants, rewrites job IDs,
marks unknown work successful or changes endpoint journals. Existing remote clients retain their request IDs and reconcile
receipts after connectivity returns. A lost connection does not revoke or stop a job already accepted by the endpoint.

## Evidence and remaining work

Local contract tests cover rejected configuration, private-file requirements, pinned trust/credential changes, resumable
initialization, the real OpenSSH configuration parser, bounded identity/ownership/resource checks, redirects, and Stop after
configuration corruption. Their HTTP endpoint is synthetic; it is not native execution evidence.

`DSH_SSH_TRANSPORT_QUALIFICATION=1` additionally starts a real private OpenSSH server with disposable keys and an HTTP
identity fixture. It checks actual forwarding, wrong host-key rejection, endpoint identity mismatch, duplicate start,
transport restart, supervisor recovery after client termination, manual stop, and unchanged original endpoint requests.
With `DSH_NATIVE_SERVICE_QUALIFICATION=1`, it also runs the transport under the actual user service manager and removes the
owned service afterward. No existing SSH daemon configuration or user authorized-key file is changed by the fixture.

Final local `pnpm check` passed typechecking, seven builds and 2,039 tests (25 skipped; 143 test files passed and four
skipped; 129.37 seconds). The combined actual macOS service / pinned Harness / native SSH run passed 16 tests (one Linux
parser case skipped; 21.72 seconds). The seven transport contract cases passed, including changing resource usage without
changing the pinned policy. All four workflow shell blocks passed Bash syntax checking. The existing user app stayed ready
and unpaused; temporary SSH fixtures, service definitions and loaded test services were removed.

The Linux installed-Harness endpoint test now enrolls through real SSH, interrupts the connection during a native job,
reconnects, and verifies a single invocation and the original job receipt through endpoint/coordinator restarts. CI installs
the SSH server prerequisite and enables native transport qualification. That Linux/Harness drill remains unrun while
repository Actions is disabled. A real SSH connection to a local fixture on macOS does not qualify Linux execution,
physical cross-host networking, reboot, prolonged network partitions or clean-host failover.
Runtime/test revision `219d3ae22c553902033e9f13c418099a2f751fd1` is pushed to `feat/full-superagent-architecture`.
GitHub returned zero workflow runs for that SHA; explicit dispatch returned HTTP 422, "Actions has been disabled for this
repository." Native Linux acceptance remains pending; previous successful revisions do not qualify this increment.

Cloud/fleet provisioning, guided administrative bootstrap and credential transfer/rotation, reverse transport for an
otherwise unreachable ownership authority, supported host/path migration, broader network/reboot qualification, disk quotas,
workspace allocation and the rest of the complete Agentic OS architecture remain open. An endpoint configured to use an
ownership authority needs its own authenticated route to that authority; this forward does not create that route.

References: OpenSSH [client options](https://man.openbsd.org/ssh_config),
[SSH command](https://man.openbsd.org/ssh) and [authorized-key restrictions](https://man.openbsd.org/sshd).
