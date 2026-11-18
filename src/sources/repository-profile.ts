/** Read-only local checkout used when GitHub is not the execution source. */
import { readdir, readFile, realpath, stat } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import type { Settings } from '../policy.ts'
import { SETUP_PROBLEMS } from '../setup.ts'
import { repositoryContract } from './contracts.ts'
import type { SourceKind } from './kind.ts'

export const GITHUB_UNAVAILABLE = SETUP_PROBLEMS.githubUnavailable[1]
const HIDDEN = 'Only non-hidden repository source paths are available'
const TOO_LARGE = 'Repository routing context exceeds 64 KiB; delegate detailed investigation to an authorized worker'

export interface RepositoryProfile { root: string; repository: string; branch: string }

export const repositoryKind: SourceKind = {
  kind: 'repository',
  title: { en: 'Repository profile', zh: '仓库配置' },
  description: { en: 'Read-only local checkout for repository/file and repository/directory.', zh: '供仓库文件和目录读取的只读本地检出。' },
  schema: repositoryContract.schema,
  fields: [
    { key: 'root', type: 'text', label: { en: 'Checkout', zh: '检出目录' }, hint: { en: 'Absolute path of a local clone. Reads stay inside it.', zh: '本地克隆的绝对路径。读取不会超出该目录。' } },
    { key: 'repository', type: 'text', label: { en: 'Repository', zh: '仓库' }, hint: { en: 'owner/name, for example jonsutton86/rea.', zh: 'owner/name，例如 jonsutton86/rea。' } },
    { key: 'branch', type: 'text', label: { en: 'Branch', zh: '分支' } },
  ],
  health: [],
  scope: () => ({ listened: true, observed: false }),
}

export function repositoryProfile(settings: Settings): RepositoryProfile {
  const parsed = repositoryContract.schema.safeParse(settings.sources.repository?.config ?? {})
  const value = (parsed.success ? parsed.data : { root: '', repository: '', branch: 'main' }) as unknown as RepositoryProfile
  return { root: value.root, repository: value.repository, branch: value.branch || 'main' }
}

/** Lists or reads one non-hidden path inside the configured checkout. An empty path is the checkout root. */
export async function readRepositoryProfile(profile: RepositoryProfile, requestPath: string, kind: 'file' | 'directory'): Promise<string> {
  if (!profile.root) throw new Error(GITHUB_UNAVAILABLE)
  if (requestPath.includes('\0')) throw new Error(HIDDEN)
  const parts = requestPath.split('/').filter(part => part && part !== '.')
  if (parts.some(part => part === '..' || part.startsWith('.') || part === 'node_modules')) throw new Error(HIDDEN)
  const base = await realpath(profile.root)
  const target = await realpath(join(base, ...parts))
  const rel = relative(base, target)
  if (rel.startsWith('..') || rel.split(sep).some(part => part === '..' || part.startsWith('.') || part === 'node_modules')) throw new Error(HIDDEN)
  const info = await stat(target)
  if (kind === 'directory') {
    if (!info.isDirectory()) throw new Error(`${requestPath || '/'} is not a directory`)
    const names = (await readdir(target)).filter(name => !name.startsWith('.') && name !== 'node_modules').sort()
    return names.join('\n')
  }
  if (!info.isFile()) throw new Error('Use repository/file/<path> for a file')
  if (info.size > 65536) throw new Error(TOO_LARGE)
  const bytes = await readFile(target)
  if (bytes.includes(0)) throw new Error(HIDDEN)
  return bytes.toString('utf8')
}
