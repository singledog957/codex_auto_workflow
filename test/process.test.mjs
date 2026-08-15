import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { runCommands } from '../lib/process.mjs'

test('runs deterministic commands in order and stops on the first failure', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'auto-workflow-test-'))
  const logPath = join(directory, 'verify.log')
  const result = await runCommands({
    commands: [
      "node -e \"console.log('first')\"",
      "node -e \"console.error('broken'); process.exit(7)\"",
      "node -e \"console.log('must-not-run')\"",
    ],
    cwd: directory,
    timeoutMs: 10_000,
    logPath,
  })

  assert.equal(result.ok, false)
  assert.equal(result.failedCommand.includes('process.exit(7)'), true)
  const log = await readFile(logPath, 'utf8')
  assert.match(log, /first/)
  assert.match(log, /broken/)
  assert.doesNotMatch(log, /must-not-run/)
})

test('terminates a command that exceeds its deadline', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'auto-workflow-test-'))
  const result = await runCommands({
    commands: ["node -e \"setTimeout(() => {}, 10000)\""],
    cwd: directory,
    timeoutMs: 50,
    logPath: join(directory, 'timeout.log'),
  })

  assert.equal(result.ok, false)
  assert.equal(result.results[0].timedOut, true)
})
