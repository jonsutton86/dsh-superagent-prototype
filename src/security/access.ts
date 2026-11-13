/** Role/capability boundary and optional bearer-token administration authentication. */
import { createHash, timingSafeEqual } from 'node:crypto'
import { z } from 'zod'

export const Role = z.enum(['owner', 'operator', 'viewer'])
export type Role = z.infer<typeof Role>

export const CAPABILITIES = ['runtime:read', 'runtime:operate', 'tasks:write', 'settings:write',
  'connectors:read', 'connectors:execute', 'audit:read', 'secrets:read', 'secrets:write'] as const
export type Capability = (typeof CAPABILITIES)[number]

/** Deny-by-default role matrix; `owner` is broad, `operator` runs work, `viewer` only reads. */
const MATRIX: Readonly<Record<Role, readonly Capability[]>> = {
  owner: CAPABILITIES,
  operator: ['runtime:read', 'runtime:operate', 'tasks:write', 'connectors:read', 'connectors:execute', 'audit:read'],
  viewer: ['runtime:read', 'connectors:read'],
}

export const ConnectorPermission = z.object({ read: z.boolean().default(false), execute: z.boolean().default(false) }).strict()
export type ConnectorPermission = z.infer<typeof ConnectorPermission>
export const AccessConfig = z.object({
  /** Optional administration token. Absent keeps the existing single-owner loopback default. */
  token: z.string().min(32).optional(),
  role: Role.default('owner'),
  /** Per-connector grants; a connector absent here is denied for read and execute for every role. */
  connectors: z.record(z.string(), ConnectorPermission).default({}),
}).strict()
export type AccessConfig = z.infer<typeof AccessConfig>

const NOT_PERSISTED = 'Administration access is configured only from the process environment; the token is never stored in settings or state.'

/**
 * Reads access configuration from `DSH_ORCHESTRATOR_ADMIN_TOKEN`, `DSH_ORCHESTRATOR_ROLE` and
 * `DSH_ORCHESTRATOR_CONNECTORS` (a JSON object of `{ "connector": { "read": true, "execute": false } }`).
 * Malformed configuration fails startup and never echoes a secret value.
 */
export function readAccessConfig(env: NodeJS.ProcessEnv = process.env): AccessConfig {
  const token = env.DSH_ORCHESTRATOR_ADMIN_TOKEN?.trim() || undefined
  const role = env.DSH_ORCHESTRATOR_ROLE?.trim() || 'owner'
  const raw = env.DSH_ORCHESTRATOR_CONNECTORS?.trim()
  let connectors: unknown = {}
  if (raw) {
    try { connectors = JSON.parse(raw) as unknown }
    catch { throw new Error(`DSH_ORCHESTRATOR_CONNECTORS must be a JSON object of connector permissions. ${NOT_PERSISTED}`) }
  }
  const parsed = AccessConfig.safeParse({ token, role, connectors })
  if (!parsed.success) throw new Error(`Invalid administration access configuration (${parsed.error.issues.map(issue => issue.path.join('.') || 'value').join(', ')}). ${NOT_PERSISTED}`)
  return parsed.data
}

/** Immutable access policy. Authentication failures are reasons, not secrets. */
export class Access {
  private readonly digest?: Buffer
  constructor(readonly config: AccessConfig) {
    if (config.token) this.digest = createHash('sha256').update(config.token).digest()
  }

  /** True when the deployment requires a bearer token; the loopback/same-origin guard always remains in force. */
  required(): boolean { return this.digest !== undefined }
  role(): Role { return this.config.role }

  /** Constant-time token check over equal-length SHA-256 digests, so token length or content does not leak by timing. */
  authenticate(authorization: string | undefined): { ok: true; role: Role } | { ok: false; reason: 'missing' | 'invalid' } {
    if (!this.digest) return { ok: true, role: this.config.role }
    const match = /^Bearer ([^\s]+)$/.exec(authorization ?? '')
    if (!match) return { ok: false, reason: 'missing' }
    const given = createHash('sha256').update(match[1]!).digest()
    return timingSafeEqual(this.digest, given) ? { ok: true, role: this.config.role } : { ok: false, reason: 'invalid' }
  }

  allows(capability: Capability): boolean { return MATRIX[this.config.role].includes(capability) }

  /** Connector access is explicit and deny-by-default, independent of the administrative role. */
  connectorAllows(id: string, action: 'read' | 'execute'): boolean { return this.config.connectors[id]?.[action] === true }

  /** State view: never includes the token. */
  view(): { required: boolean; role: Role; connectors: Record<string, ConnectorPermission> } {
    return { required: this.required(), role: this.config.role, connectors: this.config.connectors }
  }
}
