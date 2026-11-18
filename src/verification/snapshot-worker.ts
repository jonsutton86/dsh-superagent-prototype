/** Standalone confined helper. Its only writable mount is host-created snapshot storage, when requested. */
import { SnapshotSpec } from './model.ts'
import { captureSnapshot } from './snapshot.ts'
const chunks: Buffer[] = []; let bytes = 0
for await (const chunk of process.stdin) { bytes += chunk.length; if (bytes > 128 * 1024) throw new Error('Snapshot request exceeds 128 KiB'); chunks.push(Buffer.from(chunk)) }
try {
  const input = JSON.parse(Buffer.concat(chunks).toString('utf8')), spec = SnapshotSpec.parse(input.spec)
  if (typeof input.source !== 'string' || !input.source.startsWith('/') || input.destination !== undefined && (typeof input.destination !== 'string' || !input.destination.startsWith('/')))
    throw new Error('Absolute host-selected snapshot paths required')
  process.stdout.write(JSON.stringify({ result: await captureSnapshot(input.source, spec, AbortSignal.timeout(spec.timeoutSeconds * 1000), input.destination) }))
} catch (error) { process.stdout.write(JSON.stringify({ error: error instanceof Error ? error.message : String(error) })); process.exitCode = 1 }
