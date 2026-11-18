# 087 Credential vault and provider configuration

**Status:** file-confined credential storage and validated, explicitly unverified model-provider configuration. No live
provider call, credential purchase or deployment is involved.

## Credential vault

`CredentialVault` stores one secret per named entry under `<stateDir>/credentials/<name>.secret`:

- the directory is created `0700`; each file is `0600`;
- writes go to a random temporary file and are renamed into place, so a crash never exposes a partial value;
- names must match `^[a-z][a-z0-9._-]{0,63}$`, which rejects path traversal and separators;
- symlinked entries are refused before read or write, and reads use `O_NOFOLLOW`;
- `get` is the only value-returning API; `list` returns names, byte counts and timestamps only;
- values are limited to 16 KiB and empty values are refused.

Secrets are never placed in the database, settings, audit detail, state view, provider view or logs. The management API
exposes:

| Route | Capability | Behavior |
| --- | --- | --- |
| `GET /orchestrator/api/credentials` | `secrets:read` | names and metadata only |
| `POST /orchestrator/api/credentials/:name` | `secrets:write` | `{ requestId, value }`; atomic write; audit records name and byte count only |
| `DELETE /orchestrator/api/credentials/:name` | `secrets:write` | removes the entry; audit records the outcome |

Both capabilities are `owner`-only in the current role matrix, and the ordinary loopback/same-origin and optional bearer
token checks still apply. This is a secret-write path, so it is deliberately narrow: no bulk upload, no value read-back
route and no secret in any response body.

## Provider configuration

Provider configuration is read from `DSH_ORCHESTRATOR_PROVIDERS`, a JSON array. Each entry is validated:

```json
[{ "id": "openai-compatible", "baseUrl": "https://<confirmed-endpoint>/v1",
   "models": ["<confirmed-model-id>"], "defaultModel": "<one of models>",
   "credential": "provider-key", "monthlyBudgetUsd": 5 }]
```

- `id` is one of `openai`, `deepseek`, `openrouter`, `openai-compatible`; duplicates are rejected.
- `baseUrl` must be absolute HTTPS, or HTTP only for a loopback host; embedded credentials are rejected.
- `models` must be non-empty and the default, when present, must be one of them.
- `credential` is a vault entry name, never a secret value.
- Malformed configuration fails startup with the offending field path; no value is echoed.

`GET /orchestrator/api/providers` (capability `runtime:read`) returns the redacted view: base URL, models, budget,
credential name and whether that credential is present. **Every entry reports `verified: false`.** Configuration cannot
assert verification; only a live, credentialed check may do that, and none has been performed.

The registry has no method that calls a provider. Endpoint and model identifiers are operator-supplied precisely because
they must be confirmed against current provider documentation first; this increment does not assume any provider's API.

## Qualification

`tests/credentials.spec.ts` covers atomic 0600 storage, names-only listing, rotation, deletion, traversal/empty/oversized
rejection, symlink refusal, provider validation (HTTPS/loopback, URL credentials, default-model membership, duplicate
ids, unknown ids, malformed JSON), redacted API views, audit facts without secret values, and viewer capability denial.
Existing suites remain the regression boundary.

## Remaining gaps

- No encryption at rest or OS keychain integration: protection is filesystem permissions plus the state directory's
  single-owner lock. Full-disk encryption is assumed, not verified.
- No credential rotation schedule, access log for individual reads, or memory zeroization.
- No live provider verification, model-discovery call, fallback routing or budget enforcement wiring; those belong to
  Phase 3 and require explicit credentials.
- No dashboard forms for credential entry or provider editing; the API and environment configuration are the only paths.
