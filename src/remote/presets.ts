import type { Context } from '@deepseek-ai/cordis'
import type { RemoteWorld } from './world.ts'
import { posix } from 'node:path'

type Role = 'worker' | 'router' | 'child'
type Plugin = { id: string; name: string; config?: Record<string, unknown> | Plugin[]; group?: boolean; isolate?: Record<string, boolean> }
interface Presets {
  serviceFor?: (agent: unknown, name: string) => unknown
  register(definition: { id: string; name: string; description: string; plugins: Plugin[] }): Promise<() => Promise<void>>
  resolve(id: string): Promise<{ id: string; broken?: string }>
  mount(ctx: Context, id: string): Promise<unknown>
}
const prefix = 'dsh-superagent-remote-'
export const remotePresetBinding = (preset: string | undefined): string | undefined =>
  preset?.match(/^dsh-superagent-remote-(?:worker|router|child)-([a-f0-9]{64})$/)?.[1]
const plugin = (id: string, config?: Record<string, unknown>): Plugin => ({ id, name: `@deepseek-ai/dsh-${id}`, ...(config ? { config } : {}) })

/** Authority-specific Harness presets persist the world identity in the immutable Session header, including child Sessions. */
export class RemotePresets {
  private prepared?: Promise<void>
  private readonly disposers: (() => Promise<void>)[] = []
  constructor(private readonly ctx: Context, private readonly world: RemoteWorld, private readonly scoped = false) {}
  id(role: Role): string { return `${prefix}${role}-${this.world.status().binding}` }
  private registry(): Presets {
    const registry = this.ctx.get('agentPresets') as Presets | undefined
    if (!registry) throw new Error('Remote mission profiles require the Harness agent preset registry')
    if (this.scoped && typeof registry.serviceFor !== 'function') throw new Error('Managed execution worlds require Harness scoped preset service inspection (qualified with 0.2.1-rc.3)')
    return registry
  }
  prepare(): Promise<void> {
    return this.prepared ??= (async () => {
      const registry = this.registry()
      for (const role of ['child', 'worker', 'router'] as const) {
        const dispose = await registry.register({ id: this.id(role), name: `Remote ${role}`, description: 'Managed by the bound dsh-superagent execution world.',
          plugins: this.scoped ? [{ id: 'execution-world', name: 'cordis:group', group: true, isolate: { fs: true, subprocess: true },
            config: [{ id: 'paired-providers', name: 'dsh-superagent/scoped-world', config: { binding: this.world.status().binding } }, ...this.plugins(role)] }]
            : this.plugins(role) })
        const release = this.ctx.effect(() => dispose)
        this.disposers.push(async () => { await release() })
      }
      for (const role of ['child', 'worker', 'router'] as const) {
        const preset = await registry.resolve(this.id(role))
        if (preset.broken) throw new Error(`Remote ${role} preset is unavailable: ${preset.broken}`)
      }
    })().catch(async error => { await this.dispose(); throw error })
  }
  async dispose(): Promise<void> { await Promise.all(this.disposers.splice(0).reverse().map(dispose => dispose())); this.prepared = undefined }
  async mount(ctx: Context, role: Role): Promise<void> { await this.prepare(); await this.registry().mount(ctx, this.id(role)) }
  private plugins(role: Role): Plugin[] {
    const compaction: Plugin = { id: 'compaction', name: 'cordis:group', group: true, isolate: { compaction: true, toolResultPruner: true },
      config: [plugin('compaction-basic'), plugin('command-compact'), plugin('compaction-tool-result-pruner', { thresholdChars: 8192, headChars: 4096, tailChars: 1024 })] }
    // Routing uses host-owned typed tools. It receives no shell or workspace file authority from its preset.
    if (role === 'router') return [plugin('time-context'), plugin('tool-skill'), compaction]
    return [plugin('persona', { prefix: 'You are an agent powered by {{model}}. Follow the authorized mission in this remote execution environment.' }),
      plugin('agent-instructions', { maxBytes: 65536, projectRootMarkers: [] }), plugin('time-context'),
      { id: 'shell', name: 'cordis:group', group: true, isolate: { shell: true },
        config: [plugin('bash-sandbox', { timeoutMs: 5000, maxTimeoutMs: 5000 }), plugin('tool-bash')] },
      plugin('tool-fs'),
      plugin('tool-jobs', { waitTimeoutMs: 5000, maxWaitTimeoutMs: 5000 }),
      plugin('skill-filesystem', { includeDefaultRoots: false, watch: false,
        customSkillDirs: [posix.join(this.world.grant.root, '.dsh/skills'), posix.join(this.world.grant.root, '.agents/skills')] }),
      plugin('tool-skill'), compaction,
      { id: 'delegation', name: 'cordis:group', group: true, isolate: { workflowEngine: true },
        config: [plugin('tool-subagent-control'), plugin('tool-subagent', { provider: 'spawn', toolName: 'subagent', modelSelection: true,
          modelDiscovery: true, agentPreset: this.id('child') })] },
      plugin('tool-todo', { allowParallelInProgress: true }), plugin('tool-web', { fetch: false, searchTimeoutMs: 60000 })]
  }
}
