import assert from 'node:assert/strict'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { buildCodexArgs, runCodex } from '../lib/codex.mjs'

test('builds a structured read-only planning invocation', () => {
  const args = buildCodexArgs({
    cwd: '/repo',
    model: 'gpt-5.6-sol',
    reasoningEffort: 'high',
    sandbox: 'read-only',
    outputSchema: '/tmp/plan.schema.json',
    outputLastMessage: '/tmp/plan.json',
  })

  assert.deepEqual(args.slice(0, 2), ['exec', '--json'])
  assert.ok(args.includes('--ephemeral'))
  assert.ok(args.includes('--ignore-user-config'))
  assert.ok(args.includes('--strict-config'))
  assert.ok(args.includes('gpt-5.6-sol'))
  assert.ok(args.includes('model_reasoning_effort="high"'))
  assert.ok(args.includes('approval_policy="never"'))
  assert.ok(args.includes('read-only'))
  assert.ok(args.includes('/tmp/plan.schema.json'))
  assert.ok(!args.some((arg) => arg.includes('dangerously-bypass')))
  assert.equal(args.at(-1), '-')
})

test('worker uses workspace-write without bypassing approvals or sandbox', () => {
  const args = buildCodexArgs({
    cwd: '/repo',
    model: 'gpt-5.6-luna',
    reasoningEffort: 'medium',
    sandbox: 'workspace-write',
    outputLastMessage: '/tmp/result.txt',
  })

  assert.ok(args.includes('workspace-write'))
  assert.ok(!args.includes('--dangerously-bypass-approvals-and-sandbox'))
})

test('keeps stderr diagnostics out of the JSONL event log', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'auto-workflow-codex-log-'))
  const executable = join(directory, 'codex')
  const logPath = join(directory, 'events.jsonl')
  const previousPath = process.env.PATH
  t.after(async () => {
    process.env.PATH = previousPath
    await rm(directory, { recursive: true, force: true })
  })
  await writeFile(
    executable,
    `#!/usr/bin/env node
process.stderr.write('provider warning: retrying\\n')
process.stdout.write(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'done' } }) + '\\n')
`
  )
  await chmod(executable, 0o755)
  process.env.PATH = `${directory}:${previousPath}`

  const result = await runCodex({
    prompt: 'test',
    logPath,
    timeoutMs: 5_000,
    cwd: directory,
    model: 'gpt-5.6-luna',
    reasoningEffort: 'medium',
    sandbox: 'read-only',
  })

  assert.equal(result.ok, true)
  const lines = (await readFile(logPath, 'utf8')).trim().split('\n')
  assert.equal(lines.length, 1)
  assert.doesNotThrow(() => JSON.parse(lines[0]))
  assert.doesNotMatch(lines[0], /provider warning/)
  assert.match(await readFile(`${logPath}.stderr.log`, 'utf8'), /provider warning/)
})
