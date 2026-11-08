/** Minimal real local filesystem seam for runtime integration tests; it reads the same files as the fake subprocess. */
import { readFile, realpath } from 'node:fs/promises'
import { resolve } from 'node:path'
import { FsTargetKey, type FileSystem } from '@deepseek-ai/dsh-fs'

export const filesystem: Pick<FileSystem, 'resolve' | 'readText' | 'processPathFromHostPath'> = {
  async resolve(path, options) { const absolute = await realpath(resolve(options?.cwd ?? '.', path)); return { targetKey: FsTargetKey(absolute), displayPath: absolute } },
  async readText(target) { return readFile(target.displayPath, 'utf8') },
  processPathFromHostPath(path) { return path },
}
