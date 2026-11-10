import { createRequire } from 'node:module'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { build } from 'tsdown'
import { expect, it } from 'vitest'
import configurations from '../tsdown.config.ts'

it('loads the production browser factory with only its declared React platform modules', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-client-bundle-'))
  try {
    const config = configurations.find(config => config.platform === 'browser' && config.format === 'cjs')!
    expect(config).toBeDefined()
    await build({ ...config, config: false, outDir: directory, clean: true, logLevel: 'silent' })
    const require = createRequire(import.meta.url), imports: string[] = []
    let loaded = 0, plugin: { apply?: unknown } | undefined
    // Deliberately provide no Node globals or implicit package factories. A raw-source jsdom test
    // would allow host-only imports and miss the installed Harness module-loader failure.
    runInNewContext(await readFile(join(directory, 'client.js'), 'utf8'), {
      window: { __ModuleLoader__: { load(entry: { id: string; factory: (require: (name: string) => unknown) => typeof plugin }) {
        expect(entry.id).toBe('dsh-superagent'); loaded++
        plugin = entry.factory(name => {
          imports.push(name)
          if (!['react', 'react-dom', 'react/jsx-runtime'].includes(name)) throw new Error(`Undeclared browser module: ${name}`)
          return require(name)
        })
      } } },
    }, { timeout: 5000 })
    expect(loaded).toBe(1)
    expect(plugin?.apply).toBeTypeOf('function')
    expect(new Set(imports)).toEqual(new Set(['react', 'react-dom', 'react/jsx-runtime']))
  } finally { await rm(directory, { recursive: true, force: true }) }
}, 30000)
