#!/usr/bin/env node
// Node 24+; generates a key-free opt-in patch or reads authenticated catalog metadata. Never writes a profile.
import { abliterationPatch } from '../src/providers/abliteration-config.ts'
import { inspectAbliterationModels } from '../src/providers/abliteration-smoke.ts'

if (process.argv.length === 3 && process.argv[2] === 'config') {
  process.stdout.write(JSON.stringify(abliterationPatch(), null, 2) + '\n')
} else if (process.argv.length === 3 && process.argv[2] === 'models') {
  const result = await inspectAbliterationModels(process.env.ABLIT_KEY)
  process.stdout.write(JSON.stringify(result) + '\n')
  process.exitCode = result.status === 'catalog_received' ? 0 : result.status === 'not_configured' ? 2 : 1
} else {
  process.stderr.write('Usage: node scripts/abliteration-provider.mjs config|models\n')
  process.exitCode = 1
}
