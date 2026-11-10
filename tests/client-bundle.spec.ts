import { createRequire } from 'node:module'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runInNewContext, Script } from 'node:vm'
import { JSDOM } from 'jsdom'
import { build } from 'tsdown'
import { expect, it, vi } from 'vitest'
import configurations from '../tsdown.config.ts'
import { watchdogServer } from './fixtures/watchdog.ts'

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

it('mounts the standalone watchdog bundle without an import map or external package resolver', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-watchdog-bundle-')), server = await watchdogServer()
  const dom = new JSDOM('<!doctype html><div id="watchdog-root"></div>', { url: server.url + '/watchdog', runScripts: 'outside-only' })
  const errors: string[] = []
  dom.window.addEventListener('error', event => errors.push(event.message))
  Object.assign(dom.window, { AbortController, AbortSignal,
    fetch: (path: string, init?: RequestInit) => {
      if (!path.startsWith('/watchdog/api/')) throw new Error('Unexpected standalone browser request')
      return server.request(path, init)
    } })
  try {
    const config = configurations.find(config => config.platform === 'browser' && config.format === 'esm')!
    expect(config).toBeDefined()
    await build({ ...config, config: false, outDir: directory, clean: true, logLevel: 'silent' })
    // This entry has no exports. A bare import or implicit Node/package loader fails before the real UI can mount.
    new Script(await readFile(join(directory, 'watchdog-ui.js'), 'utf8')).runInContext(dom.getInternalVMContext(), { timeout: 5000 })
    await vi.waitFor(() => {
      expect(dom.window.document.querySelector('h1')?.textContent).toBe('Watchdog console')
      expect(dom.window.document.body.textContent).toContain('Prepare release evidence')
      expect(errors).toEqual([])
    })
  } finally { dom.window.close(); await server.stop(); await rm(directory, { recursive: true, force: true }) }
}, 30000)
