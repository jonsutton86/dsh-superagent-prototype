import { z } from 'zod'

/** Kernel-enforced process-tree ceilings; CPU is a percentage of one logical CPU. */
export const ProcessBudget = z.object({
  cpuPercent: z.number().int().min(1).max(6400),
  memoryBytes: z.number().int().min(64 * 1024 * 1024).max(1024 ** 4),
  processes: z.number().int().min(16).max(65536),
}).strict()
export type ProcessBudget = z.infer<typeof ProcessBudget>
export const EndpointResources = z.object({
  cgroupRoot: z.string().min(1).max(4096).refine(value => value.startsWith('/') && !/[\0\n\r]/.test(value)),
  pool: ProcessBudget,
  command: ProcessBudget,
}).strict().refine(value => value.command.cpuPercent <= value.pool.cpuPercent && value.command.memoryBytes <= value.pool.memoryBytes
  && value.command.processes <= value.pool.processes, 'Command limits cannot exceed the shared worker pool')
export type EndpointResources = z.infer<typeof EndpointResources>
export interface ResourceStatus {
  kind: 'linux-cgroup-v2'; policy: EndpointResources; ready: boolean
  memoryBytes: number | null; processes: number | null; activeScopes: number | null
}
export interface ResourceUsage {
  scopes: number; complete: boolean
  cpuMicroseconds: number | null; throttledPeriods: number | null; oomKills: number | null; processLimitEvents: number | null
}
const counter = z.number().int().nonnegative().nullable()
export const ResourceStatusSchema = z.object({ kind: z.literal('linux-cgroup-v2'), policy: EndpointResources, ready: z.boolean(),
  memoryBytes: counter, processes: counter, activeScopes: counter }).strict()
export const ResourceUsageSchema = z.object({ scopes: z.number().int().nonnegative(), complete: z.boolean(),
  cpuMicroseconds: counter, throttledPeriods: counter, oomKills: counter, processLimitEvents: counter }).strict()

/** These exact settings are checked before dispatch and again by the trusted pre-exec helper. */
export function budgetFiles(value: ProcessBudget, killGroup = true): Record<string, string> {
  return { 'cpu.max': `${value.cpuPercent * 1000} 100000`, 'memory.max': String(value.memoryBytes),
    'memory.swap.max': '0', 'memory.oom.group': killGroup ? '1' : '0', 'pids.max': String(value.processes) }
}
