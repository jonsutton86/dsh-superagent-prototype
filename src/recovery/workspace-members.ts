/** Authenticated checkpoint membership for workspace archives, without restore authorization. */
import { createHash } from 'node:crypto'
import { mkdtemp, open, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { z } from 'zod'
import { privateInput } from './crypto.ts'
import { verifyWorkspaceRecovery } from './workspace-verify.ts'

const member = z.string().regex(/^[a-z0-9-]+\.bin$/)
export const WorkspaceArchiveBindings = z.array(z.object({ source: z.string().max(4096).startsWith('/'), manifestMember: member,
  content: z.array(z.object({ name: z.string().regex(/^content-(0|[1-9]\d*)\.bin$/), member }).strict()).max(19999) }).strict()).min(1).max(256).optional()
interface File { member: string; kind: string; bytes: number; sha256: string }
export function validateWorkspaceMembers(bindings: z.infer<typeof WorkspaceArchiveBindings>, files: readonly File[]): void {
  const used = new Set<string>(), sources = new Set<string>(), indexed = new Map(files.map(file => [file.member, file]))
  if (indexed.size !== files.length) throw new Error('Duplicate recovery workspace member catalog')
  for (const binding of bindings ?? []) {
    if (sources.has(binding.source)) throw new Error('Duplicate recovery workspace source')
    sources.add(binding.source)
    const entries = [{ name: 'manifest.json', member: binding.manifestMember, kind: 'workspace-manifest' },
      ...binding.content.map(item => ({ ...item, kind: 'workspace-content' }))]
    const names = new Set<string>()
    for (const item of entries) {
      if (used.has(item.member) || names.has(item.name) || indexed.get(item.member)?.kind !== item.kind)
        throw new Error('Recovery workspace member binding differs')
      used.add(item.member); names.add(item.name)
    }
  }
  if (files.some(file => file.kind.startsWith('workspace-') && !used.has(file.member))) throw new Error('Unbound recovery workspace member')
}
export async function verifyWorkspaceMembers(directory: string, bindings: z.infer<typeof WorkspaceArchiveBindings>, files: readonly File[], signal: AbortSignal) {
  validateWorkspaceMembers(bindings, files)
  const indexed = new Map(files.map(file => [file.member, file]))
  for (const binding of bindings ?? []) {
    const temporary = await mkdtemp(join(tmpdir(), 'dsh-workspace-members-'))
    try {
      for (const item of [{ name: 'manifest.json', member: binding.manifestMember }, ...binding.content]) {
        const file = indexed.get(item.member)!, output = await open(join(temporary, item.name), 'wx', 0o600)
        const hash = createHash('sha256'); let bytes = 0
        try {
          for await (const chunk of privateInput(join(directory, item.member), signal)) {
            bytes += chunk.length
            if (bytes > file.bytes) throw new Error('Recovery workspace member exceeds authenticated size')
            hash.update(chunk); await output.writeFile(chunk)
          }
        } finally { await output.close() }
        if (bytes !== file.bytes || hash.digest('hex') !== file.sha256) throw new Error('Recovery workspace member differs from authenticated digest')
      }
      const verified = await verifyWorkspaceRecovery(temporary, signal)
      if (verified.manifest.source !== binding.source) throw new Error('Recovery workspace source differs from authenticated binding')
    } finally { await rm(temporary, { recursive: true, force: true }) }
  }
}
