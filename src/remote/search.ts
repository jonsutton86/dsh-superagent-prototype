import { posix } from 'node:path'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { z } from 'zod'
import { tool, type Tool } from '../app/tools/tool.ts'
import type { RemoteWorkspace } from '../environments/remote-workspace.ts'

/** Remote searches resolve paths and the endpoint's own ripgrep; a coordinator-packaged native binary is never forwarded. */
export function remoteSearchTools(cwd: string, workspace: RemoteWorkspace, subprocess: SubprocessRuntime): Tool[] {
  const path = z.string().min(1).optional().describe('Directory or file within the authorized remote workspace; defaults to the assigned directory.')
  const pattern = z.string().min(1).max(2000)
  const run = async (argv: string[], requested: string | undefined, signal: AbortSignal) => {
    workspace.assertPair()
    const target = await workspace.canonical(posix.resolve(cwd, requested ?? '.'))
    const handle = subprocess.spawn({ argv: ['rg', '--no-config', ...argv, '--', target], cwd, graceMs: 1000,
      signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
      stdio: { stdin: 'ignore', stdout: { maxBytes: 1 << 20 }, stderr: { maxBytes: 1 << 14 } } })
    const outcome = await handle.done, output = handle.collected.stdout!.readFrom(0)
    if (outcome.exitCode !== 0 && outcome.exitCode !== 1)
      throw new Error(`Remote search failed (${outcome.exitCode ?? outcome.signal}): ${handle.collected.stderr!.readFrom(0).text}`)
    return { text: output.text, truncated: output.lossy }
  }
  return [tool({ name: 'glob', description: 'Find files by glob inside the remote workspace. Results are bounded; narrow the pattern when truncated.',
    schema: z.object({ pattern, path, limit: z.number().int().min(1).max(500).default(100) }).strict(),
    execute: async (args, signal) => {
      const output = await run(['--files', '--hidden', '--null', '--glob', '!.git/**', '--glob', args.pattern], args.path, signal)
      const paths = output.text.split('\0').slice(output.truncated ? 1 : 0, -1)
      return { paths: paths.slice(0, args.limit), truncated: output.truncated || paths.length > args.limit }
    } }), tool({ name: 'grep', description: 'Search file contents with a ripgrep regular expression in the remote workspace. Bounded matching lines include source paths and line numbers.',
    schema: z.object({ pattern, path, include: z.string().max(2000).optional(), limit: z.number().int().min(1).max(500).default(250) }).strict(),
    execute: async (args, signal) => {
      // -e separates model input from options; the path follows -- independently.
      const output = await run(['--json', '--hidden', '--glob', '!.git/**', ...(args.include ? ['--glob', args.include] : []), '-e', args.pattern], args.path, signal)
      const matches: { path: string; line: number; text: string; truncated: boolean }[] = []
      const decode = (value: { text?: string; bytes?: string }) => value.text ?? Buffer.from(value.bytes ?? '', 'base64').toString('utf8')
      let truncated = output.truncated
      for (const line of output.text.split('\n').slice(output.truncated ? 1 : 0, -1)) {
        const record = JSON.parse(line)
        if (record.type !== 'match') continue
        if (matches.length >= args.limit) { truncated = true; break }
        const text = decode(record.data.lines)
        matches.push({ path: decode(record.data.path), line: record.data.line_number, text: text.slice(0, 2000), truncated: text.length > 2000 })
      }
      return { matches, truncated }
    } })]
}
