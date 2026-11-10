#!/usr/bin/env node
/** Plan by default. Explicit --execute is required for any provider traffic; output directories cannot be reused. */
import { readFile, stat } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runSupervisionEvaluation, supervisionEvaluationPlan, selectSupervisionEvaluationCases } from '../lib/supervision-evaluation.js'

const help = `Usage: node scripts/supervision-eval.mjs [--execute] [--dsh PATH --provider-config FILE --provider ID --model ID --output NEW_DIRECTORY]
  --credential-env NAME       Pass only this named credential to the isolated runtime.
  --case-deadline-ms N        Per-case deadline (3000–300000; default 60000).
  --max-model-attempts N      Per-case model-attempt cap (1–20; default 6).
  --case ID[,ID...]           Select a bounded subset; applies to planning and execution.
Without --execute, prints a plan and sends no model traffic. Provider JSON must be owner-private,
contain one key-free provider definition, and identify the selected model. A live provider may charge
for model attempts; this command neither purchases a plan nor estimates a monetary cost.
Reports distinguish curated label agreement, operational controls and pending manual evidence review.
`
try {
  const flags = new Map(), boolean = new Set(['--execute', '--help'])
  const known = new Set([...boolean, '--dsh', '--provider-config', '--provider', '--model', '--output', '--credential-env', '--case-deadline-ms', '--max-model-attempts', '--case'])
  for (let index = 2; index < process.argv.length; index++) {
    const flag = process.argv[index]
    if (!known.has(flag) || flags.has(flag)) throw new Error('Invalid or repeated evaluation option')
    if (boolean.has(flag)) flags.set(flag, true)
    else {
      const value = process.argv[++index]
      if (!value || value.startsWith('--')) throw new Error('An evaluation option is missing its value')
      flags.set(flag, value)
    }
  }
  const cases = selectSupervisionEvaluationCases(flags.has('--case') ? flags.get('--case').split(',') : undefined)
  if (flags.has('--help')) process.stdout.write(help)
  else if (!flags.has('--execute')) process.stdout.write(JSON.stringify(supervisionEvaluationPlan(cases, flags.has('--max-model-attempts') ? Number(flags.get('--max-model-attempts')) : undefined), null, 2) + '\n')
  else {
    for (const name of ['--dsh', '--provider-config', '--provider', '--model', '--output']) if (!flags.has(name)) throw new Error('Execution requires a CLI, private provider definition, selected model and new output directory')
    const file = resolve(flags.get('--provider-config')), metadata = await stat(file)
    if (!metadata.isFile() || metadata.size > 65536 || metadata.mode & 0o077 || process.getuid && metadata.uid !== process.getuid()) throw new Error('Provider definition must be an owner-private file of at most 64 KiB')
    let providerConfig
    try { providerConfig = JSON.parse(await readFile(file, 'utf8')) } catch { throw new Error('Provider definition is not valid JSON') }
    const controller = new AbortController(), stop = () => controller.abort()
    process.once('SIGINT', stop); process.once('SIGTERM', stop)
    try {
      const result = await runSupervisionEvaluation({ dsh: flags.get('--dsh'), checkout: resolve(dirname(fileURLToPath(import.meta.url)), '..'),
        provider: flags.get('--provider'), model: flags.get('--model'), providerConfig, credentialEnv: flags.get('--credential-env'), output: flags.get('--output'),
        caseDeadlineMs: flags.has('--case-deadline-ms') ? Number(flags.get('--case-deadline-ms')) : undefined,
        maxRequestsPerCase: flags.has('--max-model-attempts') ? Number(flags.get('--max-model-attempts')) : undefined, cases, signal: controller.signal })
      process.stdout.write(JSON.stringify({ report: result.output, state: result.state, summary: result.summary, manualEvidenceReview: result.manualEvidenceReview }) + '\n')
      if (result.state !== 'completed') process.exitCode = 2
    } finally { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop) }
  }
} catch {
  // Do not print provider JSON, keys, raw subprocess output or provider exceptions.
  process.stderr.write('Supervision evaluation could not run. Check options, private provider configuration, build, CLI and new output directory. No existing report was resumed.\n')
  process.exitCode = 1
}
