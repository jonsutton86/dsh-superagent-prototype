import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { resolve } from 'node:path'
import { expect, it } from 'vitest'

/** Explicit installed-package path prevents silently substituting a mock adapter or installing another runtime. */
it.runIf(!!process.env.DSH_ABLITERATION_ADAPTER_PACKAGE)('qualifies the installed Harness OpenAI adapter on a loopback server with synthetic credentials', async () => {
  const result = await promisify(execFile)(process.execPath, [resolve('tests/fixtures/abliteration-harness.mjs'), process.env.DSH_ABLITERATION_ADAPTER_PACKAGE!],
    { timeout: 30_000, maxBuffer: 65536, env: { PATH: process.env.PATH ?? '' } })
  const receipt = JSON.parse(result.stdout.trim())
  expect(receipt.status).toBe('passed')
  expect(receipt.cases).toEqual(['profile-config-preservation', 'model-resolution', 'streaming-text', 'usage', 'output-cap', 'tool-call-fragments', 'four-images',
    'offloaded-image-omitted', 'tool-history-image-limit', 'single-failed-request', 'missing-credential'])
})
