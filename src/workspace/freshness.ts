import type { LibraryRecord } from './library-model.ts'

export type FreshnessReason = 'archived' | 'expired' | 'superseded' | 'conflicted' | 'hash_mismatch' | 'unavailable_source' | 'cycle' | 'limit'
export interface Freshness {
  status: 'current' | 'stale' | 'contested' | 'unknown'
  checked: number; complete: boolean
  issues: { id: string; reason: FreshnessReason }[]
}
export interface FreshnessNode { record: LibraryRecord; archived: boolean; expired: boolean; superseded: boolean; conflicted: boolean }

/** Shared bounded provenance inspection; inaccessible sources never expose their private identity or metadata. */
export class FreshnessInspector {
  private readonly cache = new Map<string, FreshnessNode | null>()
  constructor(private readonly load: (id: string) => FreshnessNode, private readonly admit: (id: string) => boolean,
    private readonly maxDepth = 32) {}
  node(id: string): FreshnessNode | undefined {
    if (this.cache.has(id)) return this.cache.get(id) ?? undefined
    if (!this.admit(id)) return
    try { const node = this.load(id); this.cache.set(id, node); return node }
    catch { this.cache.set(id, null); return }
  }
  inspect(id: string): Freshness {
    const visited = new Set<string>(), active = new Set<string>(), issues: Freshness['issues'] = []
    let complete = true, stale = false, contested = false
    const issue = (at: string, reason: FreshnessReason) => {
      if (issues.length < 32 && !issues.some(value => value.id === at && value.reason === reason)) issues.push({ id: at, reason })
      else if (issues.length >= 32) complete = false
      if (['limit', 'cycle', 'unavailable_source'].includes(reason)) complete = false
      else if (reason === 'conflicted') contested = true
      else stale = true
    }
    const visit = (current: string, depth: number, parent?: string, hash?: string): void => {
      if (active.has(current)) { issue(parent ?? id, 'cycle'); return }
      const node = this.node(current)
      if (!node) { issue(parent ?? id, this.cache.has(current) ? 'unavailable_source' : 'limit'); return }
      if (hash !== undefined && hash !== node.record.hash) issue(current, 'hash_mismatch')
      if (visited.has(current)) return
      visited.add(current); active.add(current)
      for (const reason of ['archived', 'expired', 'superseded', 'conflicted'] as const) if (node[reason]) issue(current, reason)
      if (depth >= this.maxDepth && node.record.sources.length) issue(current, 'limit')
      else for (const edge of node.record.sources) visit(edge.id, depth + 1, current, edge.hash)
      active.delete(current)
    }
    visit(id, 0)
    return { status: !complete ? 'unknown' : stale ? 'stale' : contested ? 'contested' : 'current', checked: visited.size, complete, issues }
  }
}
