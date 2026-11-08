/** Compose the complete dedicated Harness remote world; it never changes providers inside an existing Session. */
import { join } from 'node:path'
import type { RemoteGrant } from '../remote/protocol.ts'
import type { CoordinatorOwnershipConfig } from '../ownership/lease.ts'

export function remoteProfile(input: { url: string; endpointId: string; credentialFile: string; directory: string; grant: RemoteGrant; port: number; ownership?: CoordinatorOwnershipConfig }): unknown[] {
  return [
    { id: 'webserver', config: { host: '127.0.0.1', port: input.port } },
    { id: 'dsh-superagent', config: { stateDir: join(input.directory, 'application'), executionMode: 'local', ...(input.ownership ? { ownership: input.ownership } : {}) } },
    { id: 'sandbox-policy', config: { mode: 'danger-full-access', workspaceRoot: input.grant.root } },
    { id: 'permission', config: { defaultPreset: 'danger-full-access', presets: {
      'danger-full-access': { sandbox: 'danger-full-access', approval: 'never', name: 'Endpoint grant', description: 'Execution is bounded by the remote endpoint grant.' },
    } } },
    ...['fs-sandbox', 'subprocess', 'pwsh-sandbox', 'session-title-llm', 'dsh-superagent-worker-preset',
      'dsh-superagent-router-preset', 'preset-standard', 'preset-ptc', 'preset-minimal', 'preset-cordis'].map(id => ({ id, disabled: true })),
    { insert: [{ id: 'operator-remote-world', name: 'dsh-superagent/remote-world', config: {
      url: input.url, endpointId: input.endpointId, credentialFile: input.credentialFile, stateDir: join(input.directory, 'world'),
      ...(input.ownership ? { ownership: { authorityId: input.ownership.authorityId, coordinatorId: input.ownership.coordinatorId } } : {}),
    } }] },
  ]
}
