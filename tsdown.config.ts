import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { defineConfig } from 'tsdown'
// `?raw` imports a file as its text, as Vite and vitest do; tsdown refuses `.css` ids without @tsdown/css, so this loads them.
const raw = { name: 'raw',
  resolveId: (source: string, importer?: string) => source.endsWith('?raw') && importer ? resolve(dirname(importer), source) : undefined,
  load: (id: string) => id.endsWith('?raw') ? { code: `export default ${JSON.stringify(readFileSync(id.slice(0, -4), 'utf8'))}`, moduleType: 'js' as const }
    : undefined }
export default defineConfig([
  { entry: { index: 'src/index.ts', 'github-watch': 'src/sources/github.ts', 'feishu-watch': 'src/sources/feishu.ts', watchdog: 'src/supervision/plugin.ts',
    'remote-endpoint': 'src/remote/endpoint-plugin.ts', 'remote-world': 'src/remote/provider-plugin.ts', 'remote-client': 'src/remote/admin.ts', 'scoped-world': 'src/remote/scoped-plugin.ts',
    recovery: 'src/recovery/index.ts', sources: 'src/sources/catalog.ts', ownership: 'src/ownership/index.ts', 'ownership-authority': 'src/ownership/authority-plugin.ts', publication: 'src/publication/plugin.ts' },
    outDir: 'lib', format: 'esm', fixedExtension: false, platform: 'node', target: 'es2024', dts: true, clean: true, deps: { neverBundle: [/^@deepseek-ai\//, 'zod', 'proper-lockfile'] } },
  { entry: { client: 'src/client/index.tsx' }, outDir: 'lib', format: 'cjs', platform: 'browser', dts: false, clean: false, plugins: [raw],
    deps: { alwaysBundle: ['zod'], neverBundle: ['react', 'react/jsx-runtime', 'react-dom'] },
    outputOptions: { entryFileNames: 'client.js', banner: 'window.__ModuleLoader__.load({ id: "dsh-superagent", factory: (require) => {', footer: 'return module.exports; } });', intro: 'var module = { exports: {} }; var exports = module.exports;' } },
  // A separate one-entry build keeps the confined helper self-contained: no host shared chunks are mounted into workers.
  { entry: { 'remote-fs-worker': 'src/remote/fs-worker.ts' }, outDir: 'lib', format: 'esm', fixedExtension: false, platform: 'node', target: 'es2024', dts: false, clean: false },
  { entry: { 'remote-command-worker': 'src/remote/command-worker.ts' }, outDir: 'lib', format: 'esm', fixedExtension: false, platform: 'node', target: 'es2024', dts: false, clean: false },
  { entry: { 'remote-resource-worker': 'src/remote/resource-worker.ts' }, outDir: 'lib', format: 'esm', fixedExtension: false, platform: 'node', target: 'es2024', dts: false, clean: false },
  { entry: { 'verification-snapshot-worker': 'src/verification/snapshot-worker.ts' }, outDir: 'lib', format: 'esm', fixedExtension: false, platform: 'node', target: 'es2024', dts: false, clean: false, deps: { alwaysBundle: ['zod'] } },
  // Standalone console remains available when the main profile or its UI has stopped.
  { entry: { 'watchdog-ui': 'src/supervision/console-entry.tsx' }, outDir: 'lib', format: 'esm', fixedExtension: false,
    platform: 'browser', target: 'es2022', dts: false, clean: false, plugins: [raw],
    deps: { alwaysBundle: ['react', 'react-dom', 'react/jsx-runtime', 'react-dom/client', 'scheduler'] },
    define: { 'process.env.NODE_ENV': JSON.stringify('production') } },
])
