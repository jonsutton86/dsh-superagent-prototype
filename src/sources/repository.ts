/**
 * Read-only repository profile: a local checkout of one repository's default branch.
 * `orchestrator_read repository/file/<path>` and `repository/directory/<path>` read it. No shell and no credentials.
 */
import { closeSync, fstatSync, openSync, readSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { isAbsolute, resolve, sep } from 'node:path'
import { z } from 'zod'
import type { Settings } from '../policy.ts'
import type { SourceKind } from './kind.ts'

export const REPOSITORY = 'repository'
/** What a local installation answers when GitHub is not configured and no repository profile is set. */
export const LOCAL_GITHUB_UNAVAILABLE = 'GitHub is unavailable in local execution mode. Use a repository profile for GitHub work.'
const PAGE = 64 * 1024
const BranchSchema = z.string().trim().max(200).refine(value => value === '' || /^[A-Za-z0-9._/-]+$/.test(value) && !value.split('/').includes('..'), 'A branch name')
export const RepositoryConfigSchema = z.object({
  root: z.string().trim().refine(path => path === '' || path.startsWith('/'), 'An absolute path, or empty until a checkout is configured').default(''),
  repository: z.string().trim().regex(/^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)?$/, 'owner/name').default(''),
  branch: BranchSchema.default(''),
}).strict()
export type RepositoryConfig = z.infer<typeof RepositoryConfigSchema>

export const repositoryKind: SourceKind<RepositoryConfig> = {
  kind: REPOSITORY,
  title: { zh: '仓库配置', en: 'Repository profile' },
  description: { zh: '只读本地检出，供 repository/file 和 repository/directory 读取默认分支。不访问 GitHub，不保存凭据。', en: 'A read-only local checkout. repository/file and repository/directory read the default branch from it. No GitHub calls and no credentials.' },
  schema: RepositoryConfigSchema,
  fields: [
    { key: 'root', type: 'text', label: { zh: '检出目录', en: 'Checkout' },
      hint: { zh: '默认分支的绝对路径。只读非隐藏源码，单页最多 64 KiB。', en: 'Absolute path of a default-branch checkout. Read-only non-hidden source, at most 64 KiB a page.' } },
    { key: 'repository', type: 'text', pattern: '[A-Za-z0-9_.\\-]+/[A-Za-z0-9_.\\-]+', label: { zh: '仓库', en: 'Repository' },
      hint: { zh: 'owner/name，写在读取结果上。', en: 'owner/name, named on each read.' } },
    { key: 'branch', type: 'text', label: { zh: '默认分支', en: 'Default branch' },
      hint: { zh: '检出对应的分支名，例如 main。读取不运行 git。', en: 'Branch this checkout is, such as main. Reads do not run git.' } },
  ],
  health: [],
}

/** True when the GitHub source is on and names a repository, which is preferred over fetching a public URL. */
export function githubSourceConfigured(settings: Settings): boolean {
  const github = settings.sources.github
  if (!github?.enabled) return false
  const repository = github.config.repository
  return typeof repository === 'string' && repository.trim().length > 0
}

export function repositoryConfig(settings: Settings): RepositoryConfig {
  const parsed = RepositoryConfigSchema.safeParse(settings.sources.repository?.config ?? {})
  return parsed.success ? parsed.data : RepositoryConfigSchema.parse({})
}

/** Why `repository/…` cannot be read yet. */
export function repositoryUnavailable(settings: Settings): string {
  return githubSourceConfigured(settings)
    ? 'No repository profile is configured. Set the repository source root to a checkout of the default branch.'
    : LOCAL_GITHUB_UNAVAILABLE
}

function partsOf(path: string): string[] {
  const parts = path.split('/').filter(part => part && part !== '.')
  if (parts.some(part => part === '..' || part.startsWith('.') || part === 'node_modules')) throw new Error('Only non-hidden repository source paths are available')
  return parts
}

/** Reads one non-hidden file or directory listing from the profile checkout. An empty path is the root. */
export function readRepositoryProfile(settings: Settings, path: string, kind: 'file' | 'directory'): string {
  const config = repositoryConfig(settings)
  if (!config.root) throw new Error(repositoryUnavailable(settings))
  if (!isAbsolute(config.root)) throw new Error('The repository profile root must be an absolute path')
  const parts = partsOf(path)
  if (kind === 'file' && !parts.length) throw new Error('Name a file: repository/file/<path>')
  let root: string
  try { root = realpathSync(config.root) } catch { throw new Error('The repository profile checkout is not available') }
  const resolved = resolve(root, ...parts)
  if (resolved !== root && !resolved.startsWith(root + sep)) throw new Error('Only paths inside the repository profile are available')
  let real: string
  try { real = realpathSync(resolved) } catch { throw new Error('That repository path is not available') }
  if (real !== root && !real.startsWith(root + sep)) throw new Error('Only paths inside the repository profile are available')
  const head = [config.repository, config.branch].filter(Boolean).join(' ')
  if (kind === 'directory') {
    if (!statSync(real).isDirectory()) throw new Error(`${path || '/'} is not a directory`)
    const entries = readdirSync(real, { withFileTypes: true }).map(entry => entry.name).filter(name => !name.startsWith('.') && name !== 'node_modules').sort()
    return [head, '', ...entries].join('\n').slice(0, PAGE)
  }
  const fd = openSync(real, 'r')
  try {
    if (!fstatSync(fd).isFile()) throw new Error(`${path} is not a file`)
    const size = fstatSync(fd).size
    const buf = Buffer.alloc(Math.min(size, PAGE))
    readSync(fd, buf, 0, buf.length, 0)
    if (buf.includes(0)) throw new Error('Only non-hidden repository source text is available')
    const text = buf.toString('utf8')
    return size > PAGE ? `${text}\n[truncated at ${PAGE} bytes]` : text
  } finally { closeSync(fd) }
}

/** Relative path from a `repository/` resource tail such as `directory/` or `file/src/index.ts`. */
export function repositoryTarget(rest: string): { kind: 'file' | 'directory'; path: string } | undefined {
  if (rest === 'directory' || rest === 'directory/') return { kind: 'directory', path: '' }
  if (rest.startsWith('directory/')) return { kind: 'directory', path: rest.slice('directory/'.length) }
  if (rest.startsWith('file/') && rest.length > 'file/'.length) return { kind: 'file', path: rest.slice('file/'.length) }
  return undefined
}
