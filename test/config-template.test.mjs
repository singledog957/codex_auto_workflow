import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { resolveUserConfig } from '../lib/config.mjs'

const workflowRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const execFileAsync = promisify(execFile)

test('ships an inactive project-neutral example with optional aggregate gates', async () => {
  const example = JSON.parse(await readFile(join(workflowRoot, 'config.json.example'), 'utf8'))
  const config = resolveUserConfig(example)

  assert.deepEqual(Object.keys(example.verification.profiles), ['basic'])
  for (const commands of Object.values(config.verification.profiles)) {
    assert.ok(Array.isArray(commands) && commands.length > 0)
  }
  assert.deepEqual(config.verification.checkpoint, [])
  assert.deepEqual(config.verification.final, [])
  await assert.rejects(
    execFileAsync('git', ['ls-files', '--error-unmatch', 'config.json'], { cwd: workflowRoot }),
  )
})
