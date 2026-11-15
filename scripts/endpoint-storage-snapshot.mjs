#!/usr/bin/env node
// Node 24+; run pnpm build first. Run as the stopped endpoint's service user. No credentials are printed.
import { exportEndpointStorageSnapshot } from '../lib/recovery.js'
if (![4, 5].includes(process.argv.length)) {
  process.stderr.write('Usage: node scripts/endpoint-storage-snapshot.mjs /absolute/endpoint-state /absolute/new-snapshot-directory [capture-selections-json]\n')
  process.exitCode = 2
} else {
  try { process.stdout.write(JSON.stringify(await exportEndpointStorageSnapshot(process.argv[2], process.argv[3], undefined, process.argv[4] === undefined ? undefined : JSON.parse(process.argv[4]))) + '\n') }
  catch { process.stderr.write('Endpoint snapshot failed. Any output is unverified; preserve it and inspect source state before retrying with a new destination.\n'); process.exitCode = 1 }
}
