import assert from 'node:assert/strict'
import test from 'node:test'

import { buildCodexArgs } from '../lib/codex.mjs'

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
