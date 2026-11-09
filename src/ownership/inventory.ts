import { randomBytes } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import { OwnershipError, OwnershipStamp } from './protocol.ts'

const revision = z.string().regex(/^[a-f0-9]{32}$/), digest = z.string().regex(/^[a-f0-9]{64}$/)
export const InventoryRequest = z.object({ op: z.literal('recovery.inventory'), revision: revision.optional(), offset: z.number().int().min(0).max(50_000).default(0) }).strict()
export type InventoryRequest = z.infer<typeof InventoryRequest>
export const InventoryItem = z.object({ kind: z.enum(['command', 'mutation', 'grant', 'publication', 'destination']), id: z.string().min(1).max(300),
  requestHash: digest, phase: z.string().min(1).max(40), settled: z.boolean(), resultHash: digest.optional(),
  grantId: z.string().max(100).optional(), epoch: z.number().int().positive().optional(), ownership: OwnershipStamp.optional() }).strict()
export type InventoryItem = z.infer<typeof InventoryItem>
export const InventoryPage = z.object({ revision, total: z.number().int().min(0).max(50_000), offset: z.number().int().nonnegative(),
  items: z.array(InventoryItem).max(50), nextOffset: z.number().int().positive().nullable(), quiescent: z.boolean(),
  identity: z.object({ id: z.string().uuid(), kind: z.enum(['endpoint', 'publication']),
    authorityId: z.string().uuid(), coordinatorId: z.string().max(100), resourceId: z.string().max(100) }).strict() }).strict()
export type InventoryPage = z.infer<typeof InventoryPage>
interface Source { kind: InventoryItem['kind']; table: string; project(value: any): InventoryItem }

/** Revision-bound, payload-free resource inventories. Every relevant SQLite mutation invalidates prior pages, including across restart. */
export class ResourceInventory {
  constructor(private readonly db: DatabaseSync, private readonly sources: Source[]) {
    db.exec('CREATE TABLE IF NOT EXISTS resource_inventory_revision (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL)')
    db.prepare('INSERT INTO resource_inventory_revision VALUES (1,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value').run(randomBytes(16).toString('hex'))
    for (const source of sources) {
      if (!/^[a-z_]+$/.test(source.table)) throw new Error('Invalid inventory table')
      for (const action of ['INSERT', 'UPDATE', 'DELETE']) db.exec(`CREATE TRIGGER IF NOT EXISTS inventory_${source.table}_${action}
        AFTER ${action} ON ${source.table} BEGIN UPDATE resource_inventory_revision SET value=lower(hex(randomblob(16))) WHERE id=1; END`)
    }
  }
  page(request: z.infer<typeof InventoryRequest>, identity: InventoryPage['identity'], quiescent: boolean): InventoryPage {
    const revision = String(this.db.prepare('SELECT value FROM resource_inventory_revision WHERE id=1').get()!.value)
    if (request.offset && !request.revision || request.revision && request.revision !== revision)
      throw new OwnershipError(409, 'inventory_changed', 'Resource inventory changed; restart the recovery audit')
    const union = this.sources.map(source => `SELECT '${source.kind}' AS kind,id,value FROM ${source.table}`).join(' UNION ALL ')
    const total = Number(this.db.prepare(`SELECT count(*) AS n FROM (${union})`).get()!.n)
    if (total > 50_000) throw new OwnershipError(409, 'inventory_capacity', 'Resource inventory exceeds the recovery audit bound')
    if (request.offset > total) throw new OwnershipError(409, 'inventory_cursor', 'Inventory cursor exceeds the current inventory')
    const rows = this.db.prepare(`SELECT * FROM (${union}) ORDER BY kind,id LIMIT 50 OFFSET ?`).all(request.offset)
    const items = rows.map(row => this.sources.find(source => source.kind === row.kind)!.project(JSON.parse(String(row.value))))
    return InventoryPage.parse({ revision, total, offset: request.offset, items, quiescent, identity,
      nextOffset: request.offset + items.length < total ? request.offset + items.length : null })
  }
}
