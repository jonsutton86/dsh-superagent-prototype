/** Rebuild Git's content-addressed file tree from captured bytes, without trusting the working index or local object store. */
import { createHash } from 'node:crypto'

export const gitObjectHash = (algorithm: 'sha1' | 'sha256', kind: 'blob' | 'tree', bytes: Buffer): string =>
  createHash(algorithm).update(`${kind} ${bytes.length}\0`).update(bytes).digest('hex')
export interface GitFile { path: string; mode: '100644' | '100755' | '120000'; hash: string }
interface Tree { entries: Map<string, GitFile | Tree> }
export function capturedGitTree(files: readonly GitFile[], algorithm: 'sha1' | 'sha256'): string {
  const root: Tree = { entries: new Map() }
  for (const file of files) {
    const parts = file.path.split('/'); let directory = root
    for (const name of parts.slice(0, -1)) {
      let child = directory.entries.get(name)
      if (!child) { child = { entries: new Map() }; directory.entries.set(name, child) }
      if (!('entries' in child)) throw new Error('Captured Git file and directory overlap')
      directory = child
    }
    if (directory.entries.has(parts.at(-1)!)) throw new Error('Captured Git paths overlap')
    directory.entries.set(parts.at(-1)!, file)
  }
  const digest = (tree: Tree): string => {
    const sorted = [...tree.entries].sort(([a, left], [b, right]) => Buffer.compare(Buffer.from(a + ('entries' in left ? '/' : '')),
      Buffer.from(b + ('entries' in right ? '/' : ''))))
    const bytes = sorted.flatMap(([name, child]) => [Buffer.from(`${'entries' in child ? '40000' : child.mode} ${name}\0`),
      Buffer.from('entries' in child ? digest(child) : child.hash, 'hex')])
    return gitObjectHash(algorithm, 'tree', Buffer.concat(bytes))
  }
  return digest(root)
}
