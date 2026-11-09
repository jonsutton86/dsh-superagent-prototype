/** Fixed Node program for bringing an input into the already-authorized execution directory. */
function copyInput() {
  const fs = require('node:fs') as typeof import('node:fs')
  const crypto = require('node:crypto') as typeof import('node:crypto')
  const [name, totalText, digest, offsetText, chunkDigest] = process.argv.slice(1)
  const total = Number(totalText), offset = Number(offsetText)
  if (!name || !/^input-[0-9a-f-]{36}-[0-9a-f]{12}(?:\.[A-Za-z0-9]{1,12})?$/.test(name)
    || !digest || !/^[0-9a-f]{64}$/.test(digest) || !Number.isSafeInteger(total) || total < 0 || total > 64 * 1024 * 1024
    || !Number.isSafeInteger(offset) || offset < 0 || offset > total) throw new Error('Invalid attachment transfer')
  const content = fs.readFileSync(0, 'utf8')
  if (content.length > 512 * 1024) throw new Error('Input chunk exceeds its bound')
  const chunk = Buffer.from(content, 'base64')
  if (chunk.toString('base64') !== content || crypto.createHash('sha256').update(chunk).digest('hex') !== chunkDigest || offset + chunk.length > total)
    throw new Error('Input chunk differs from its receipt')
  const regular = (fd: number, links = 1) => {
    const stat = fs.fstatSync(fd)
    if (!stat.isFile() || stat.nlink !== links || stat.size > total) throw new Error('Input target is not a private regular file')
    return stat
  }
  const complete = (fd: number, links = 1) => {
    const before = regular(fd, links)
    if (before.size !== total) return false
    const hash = crypto.createHash('sha256'), buffer = Buffer.alloc(65536); let position = 0
    while (position < total) { const count = fs.readSync(fd, buffer, 0, Math.min(buffer.length, total - position), position); if (!count) break; hash.update(buffer.subarray(0, count)); position += count }
    const after = regular(fd, links)
    return before.size === after.size && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs && position === total && hash.digest('hex') === digest
  }
  const stage = `.${name}.partial`
  const sameLeaf = (path: string, fd: number) => {
    const leaf = fs.lstatSync(path), opened = fs.fstatSync(fd)
    if (!leaf.isFile() || leaf.isSymbolicLink() || leaf.ino !== opened.ino || leaf.dev !== opened.dev) throw new Error('Input file identity changed')
  }
  const syncDirectory = () => { const directory = fs.openSync('.', fs.constants.O_RDONLY); try { fs.fsyncSync(directory) } finally { fs.closeSync(directory) } }
  let destination: number | undefined
  try { destination = fs.openSync(name, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK) }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  if (destination !== undefined) {
    try {
      const target = fs.fstatSync(destination)
      let linked = false
      if (target.nlink === 2) {
        const partial = fs.lstatSync(stage)
        linked = partial.isFile() && !partial.isSymbolicLink() && partial.ino === target.ino && partial.dev === target.dev
      }
      if (!complete(destination, linked ? 2 : 1)) throw new Error('An existing input copy differs; it will not be overwritten')
      sameLeaf(name, destination)
      if (linked) { sameLeaf(stage, destination); fs.unlinkSync(stage); syncDirectory() }
      fs.fchmodSync(destination, 0o400); fs.fsyncSync(destination)
      sameLeaf(name, destination)
      if (!complete(destination)) throw new Error('Input copy changed during verification')
    }
    finally { fs.closeSync(destination) }
    process.stdout.write(JSON.stringify({ complete: true, bytes: total, sha256: digest })); return
  }
  let fd: number
  try { fd = fs.openSync(stage, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_RDWR | fs.constants.O_NOFOLLOW, 0o600) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    fd = fs.openSync(stage, fs.constants.O_RDWR | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK)
  }
  let published = false
  try {
    const stat = regular(fd)
    let written = 0
    if (offset < stat.size) {
      const existing = Buffer.alloc(Math.min(chunk.length, stat.size - offset))
      if (fs.readSync(fd, existing, 0, existing.length, offset) !== existing.length || !existing.equals(chunk.subarray(0, existing.length))) throw new Error('Existing input chunk differs')
      written = existing.length
    } else if (offset !== stat.size) throw new Error('Input transfer has a missing prefix')
    while (written < chunk.length) { const count = fs.writeSync(fd, chunk, written, chunk.length - written, offset + written); if (!count) throw new Error('Input copy made no progress'); written += count }
    fs.fsyncSync(fd)
    if (!chunk.length && offset === total) {
      if (!complete(fd)) throw new Error('Input copy does not match its original digest')
      sameLeaf(stage, fd)
      // link is create-if-absent; a racing destination is never overwritten.
      fs.linkSync(stage, name); sameLeaf(name, fd); sameLeaf(stage, fd); fs.unlinkSync(stage)
      fs.fchmodSync(fd, 0o400); fs.fsyncSync(fd); syncDirectory()
      sameLeaf(name, fd)
      if (!complete(fd)) throw new Error('Input copy changed during publication')
      published = true
    }
  } finally { fs.closeSync(fd) }
  process.stdout.write(JSON.stringify({ complete: published, bytes: offset + chunk.length, sha256: digest }))
}
export const COPY_INPUT_PROGRAM = `(${copyInput.toString()})()`
