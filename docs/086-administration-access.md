# 086 Administration access and role/capability boundary

**Status:** optional bearer-token authentication and a deny-by-default role/connector matrix. It keeps the existing
single-owner loopback default when no token is configured. No deployment or credentials were used.

## Configuration

All access configuration comes from the process environment and is never written to settings, the database or logs.

| Variable | Meaning |
| --- | --- |
| `DSH_ORCHESTRATOR_ADMIN_TOKEN` | Optional bearer token, at least 32 characters. Absent: the current loopback/same-origin single-owner boundary only. |
| `DSH_ORCHESTRATOR_ROLE` | `owner` (default), `operator` or `viewer`. |
| `DSH_ORCHESTRATOR_CONNECTORS` | JSON object: `{"github":{"read":true,"execute":false}}`. Connectors absent from the object are denied read and execute for every role. |

Malformed values fail startup with the offending variable name; the token value is never echoed. The token is compared
by SHA-256 digest with `timingSafeEqual`, so neither content nor length is exposed by comparison timing.

## Enforcement

- Every `/orchestrator/api/*` request except the independent supervision routes requires
  `Authorization: Bearer <token>` when a token is configured. Failures return `401` with `WWW-Authenticate: Bearer` and
  append an `access.authenticate` denial fact to the audit log (reason only, never the presented token).
- The loopback-only Web server, same-origin check and mutation ownership proof remain in force in both modes. Token
  authentication does not replace them.
- Capabilities checked at the route boundary:
  - `runtime:operate` — pause and emergency engage/release;
  - `tasks:write` — stop and retry a ticket;
  - `settings:write` — settings blocks and prompts;
  - `audit:read` — `GET /orchestrator/api/audit` (new, paginated);
  - `runtime:read` and `connectors:read` are readable by every role.
- A denied capability returns `403` and appends `access.capability` with the required capability; it does not reveal
  whether the underlying resource exists.
- Connector permissions are checked by `Access.connectorAllows(id, 'read' | 'execute')`. They are explicit grants,
  deny-by-default, and independent of the administrative role — `owner` does not bypass them.

## Browser use

The panel sends a token if the operator sets one in this browser:

```js
localStorage.setItem('dsh-admin-token', '<token>')
```

Removing the item reverts to unauthenticated loopback requests. A dedicated token-entry control and server-side session
cookies are not implemented; the token is read from local storage on each request and is never rendered.

## Qualification

`tests/admin-access.spec.ts` covers the no-token default, missing/wrong/correct bearer tokens, token absence from state
and audit output, role capability denial with audit evidence, connector deny-by-default and explicit grants, and
malformed configuration that does not echo the secret. Existing panel, runtime, environment and stop suites remain the
regression boundary.

## Remaining gaps

- This is not multi-user identity: one token maps to one role. There is no per-user login, session cookie, rotation
  endpoint, revocation list or rate limit.
- Only sensitive routes are capability-checked today; the remaining mutations still rely on authentication plus the
  ownership/same-origin guard and should be mapped to capabilities as connector routes arrive.
- The token is a process environment secret with no file/keychain integration; credential storage and encryption for
  connectors remain open.
- No dedicated UI for token entry, audit browsing or connector permission editing.
