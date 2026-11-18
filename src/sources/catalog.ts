/** Passive source registration, available without a running coordinator, polling loops or execution authority. */
import { Service, type Context } from '@deepseek-ai/cordis'
import { randomUUID } from 'node:crypto'
import { workspaceContract, publicationContract, conversationContract, operatorContract, repositoryContract, type SourceContract } from './contracts.ts'

declare module '@deepseek-ai/cordis' { interface Context { superagentSources: SourceCatalog } }
export interface SourceCatalogSnapshot { generation: string; revision: number; contracts: readonly SourceContract[] }
/** Owns the actual loaded source contracts and detects registration changes during maintenance verification. */
export class SourceCatalog extends Service {
  private readonly contracts = new Map<string, SourceContract>()
  private readonly generation = randomUUID()
  private revision = 0
  constructor(ctx: Context) {
    super(ctx, 'superagentSources')
    for (const contract of [workspaceContract, publicationContract, conversationContract, operatorContract, repositoryContract]) this.register(contract)
  }
  register(contract: SourceContract): () => void {
    if (!/^[a-z][a-z0-9-]*$/.test(contract.kind) || this.contracts.has(contract.kind)) throw new Error('Source contract identity is invalid or already registered')
    const id = contract.kind
    this.contracts.set(id, contract); this.revision++
    let active = true
    return () => { if (!active) return; active = false; if (this.contracts.get(id) === contract) { this.contracts.delete(id); this.revision++ } }
  }
  snapshot(): SourceCatalogSnapshot {
    return { generation: this.generation, revision: this.revision, contracts: [...this.contracts.values()].sort((a, b) => a.kind.localeCompare(b.kind)) }
  }
}
export const name = 'dsh-superagent-sources'
export function apply(ctx: Context): void { new SourceCatalog(ctx) }
