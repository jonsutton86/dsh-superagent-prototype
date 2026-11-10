import { dirname, join } from 'node:path'
import type { CgroupIO } from '../../src/remote/resources.ts'

/** Deterministic kernel-interface fixture; it does not claim OS resource enforcement. */
export class FakeCgroup implements CgroupIO {
  platform = 'linux'; uid = 501; type = 0x63677270
  readonly directories = new Set<string>()
  readonly files = new Map<string, string>()
  readonly writes: [string, string][] = []
  constructor(readonly root = '/delegated') { this.mkdir(root) }
  real(path: string) { return path }
  info(path: string) {
    if (!this.directories.has(path) && !this.files.has(path)) throw new Error('Missing fixture path')
    return { uid: this.uid, directory: this.directories.has(path), type: this.type }
  }
  read(path: string) { const value = this.files.get(path); if (value === undefined) throw new Error('Missing fixture file'); return value }
  write(path: string, value: string) {
    this.read(path); this.writes.push([path, value])
    this.files.set(path, path.endsWith('/cgroup.subtree_control') ? value.replaceAll('+', '') : value)
    if (path.endsWith('/cgroup.kill')) this.population(dirname(path), false)
  }
  children(path: string) { return [...this.directories, ...this.files.keys()].filter(item => dirname(item) === path).map(item => item.slice(path.length + 1)) }
  mkdir(path: string) {
    if (this.directories.has(path)) return false
    this.directories.add(path)
    for (const [file, value] of Object.entries({ 'cgroup.type': 'domain', 'cgroup.controllers': 'cpu memory pids', 'cgroup.subtree_control': '',
      'cgroup.procs': '', 'cgroup.events': 'populated 0\nfrozen 0', 'cgroup.kill': '', 'cpu.max': 'max 100000', 'memory.max': 'max',
      'memory.swap.max': 'max', 'memory.oom.group': '0', 'pids.max': 'max', 'memory.current': '0', 'pids.current': '0',
      'cpu.stat': 'usage_usec 0\nnr_throttled 0', 'memory.events': 'oom_kill 0', 'pids.events': 'max 0' })) this.files.set(join(path, file), value)
    return true
  }
  population(path: string, live: boolean) { this.files.set(join(path, 'cgroup.events'), `populated ${live ? 1 : 0}\nfrozen 0`) }
  remove(path: string) {
    if (this.read(join(path, 'cgroup.events')).includes('populated 1') || [...this.directories].some(item => dirname(item) === path)) throw new Error('Busy fixture cgroup')
    this.directories.delete(path)
    for (const key of this.files.keys()) if (dirname(key) === path) this.files.delete(key)
  }
}
