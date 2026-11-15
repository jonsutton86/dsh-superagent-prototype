import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import s from '@deepseek-ai/schemastery'
import { RemoteEndpoint } from './endpoint.ts'
import { BubblewrapIsolation } from './isolation.ts'
import { remoteHandler } from './http.ts'
import { RPC_PATH } from './protocol.ts'
import { fileURLToPath } from 'node:url'
import { confinedFilesystem } from './filesystem-runner.ts'
import type { ResourceOwnershipConfig } from '../ownership/gate.ts'
import { CgroupResources } from './resources.ts'
import { EndpointResources } from './resource-model.ts'
import { z } from 'zod'
import { EndpointStorage } from './storage-model.ts'
import { LocalStorageHost } from './storage-host-client.ts'

export const StorageConnection = z.object({ endpointId: z.string().uuid(),
  socketPath: z.string().refine(value => value.startsWith('/') && Buffer.byteLength(value) < 104
    && !/[\0\n\r]/.test(value) && !value.split('/').slice(1).some(part => !part || part === '.' || part === '..')),
  policy: EndpointStorage }).strict()

export const name = 'dsh-superagent-execution-endpoint'
export const inject = ['fs', 'subprocess', 'webServer']
export interface EndpointConfig { stateDir: string; workspaceRoot: string; allowedEnv: string[]; maxRunning: number; outputMaxBytes: number; ownership?: ResourceOwnershipConfig; resources?: EndpointResources; storage?: z.infer<typeof StorageConnection> }
const budget = s.object({ cpuPercent: s.number().min(1).max(6400).step(1).required(),
  memoryBytes: s.number().min(64 * 1024 * 1024).max(1024 ** 4).step(1).required(), processes: s.number().min(16).max(65536).step(1).required() })
const storageBudget = s.object({ bytes: s.number().min(4096).max(1024 ** 4).step(4096).required(),
  inodes: s.number().min(1).max(2 ** 32 - 1).step(1).required() })
export const Config: s<Partial<EndpointConfig>, EndpointConfig> = s.object({
  stateDir: s.string().pattern(/^\//).required().description('Private control directory outside all worker workspaces and system runtime mounts.'),
  workspaceRoot: s.string().pattern(/^\//).required().description('Dedicated parent directory for granted workspaces.'),
  allowedEnv: s.array(s.string()).default([]).description('Additional non-credential environment variable names accepted from the coordinator.'),
  maxRunning: s.number().min(1).max(32).step(1).default(8),
  outputMaxBytes: s.number().min(65536).max(64 * 1024 * 1024).step(1).default(8 * 1024 * 1024),
  resources: s.union([s.object({ cgroupRoot: s.string().pattern(/^\//).required(), pool: budget.required(), command: budget.required(), workspace: s.union([budget]) })]),
  storage: s.union([s.object({ endpointId: s.string().required(), socketPath: s.string().required(),
    policy: s.object({ kind: s.const('linux-xfs-project').required(), filesystemUUID: s.string().required(),
      mountRoot: s.string().required(), projectIds: s.object({ first: s.number().required(), last: s.number().required() }).required(),
      pool: storageBudget.required(), workspace: storageBudget.required() }).required() })]),
  ownership: s.union([s.object({ url: s.string().required(), authorityId: s.string().required(), coordinatorId: s.string().required(),
    resourceId: s.string().required(), credentialFile: s.string().pattern(/^\//).required(), timeoutMs: s.number().min(100).max(60_000).default(5000) })]),
})

/** Mount on a dedicated Linux Harness host; TLS or an authenticated tunnel terminates outside the loopback listener. */
export async function apply(ctx: Context, config: EndpointConfig): Promise<void> {
  if (ctx.webServer.host !== '127.0.0.1') throw new Error('Execution endpoint requires a loopback listener behind TLS or a secure tunnel')
  const storageConfig = config.storage ? StorageConnection.parse(config.storage) : undefined
  const storage = storageConfig ? { endpointId: storageConfig.endpointId, policy: storageConfig.policy, host: new LocalStorageHost(storageConfig.socketPath) } : undefined
  const resources = config.resources ? new CgroupResources(EndpointResources.parse(config.resources)) : undefined
  const resourceHelper = resources ? fileURLToPath(new URL('./remote-resource-worker.js', import.meta.url)) : undefined
  const subprocess = resources ? resources.decorate(ctx.subprocess, resourceHelper!) : ctx.subprocess
  const isolation = new BubblewrapIsolation(subprocess)
  const endpoint = new RemoteEndpoint({ stateDir: config.stateDir, root: config.workspaceRoot, filesystem: ctx.fs, subprocess, resources, resourceHelper, storage,
    isolation, filesystemRpc: confinedFilesystem(subprocess, isolation, fileURLToPath(new URL('./remote-fs-worker.js', import.meta.url))),
    commandHelper: fileURLToPath(new URL('./remote-command-worker.js', import.meta.url)),
    snapshotHelper: fileURLToPath(new URL('./verification-snapshot-worker.js', import.meta.url)),
    allowedEnv: config.allowedEnv, maxRunning: config.maxRunning, outputMaxBytes: config.outputMaxBytes, ownership: config.ownership,
    report: error => ctx.logger.warn('Endpoint ownership monitor: %s', error instanceof Error ? error.message : String(error)) })
  ctx.effect(() => () => endpoint.stop())
  await endpoint.start()
  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: RPC_PATH, handler: remoteHandler(endpoint) }))
  ctx.logger.info('Execution endpoint ready: %s; administration token is in %s/admin.token', endpoint.journal.id, config.stateDir)
}
