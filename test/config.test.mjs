import assert from 'node:assert/strict'
import test from 'node:test'

import {
  inspectionSandbox,
  modelForAttempt,
  modelForTaskAttempt,
  resolveConfig,
  resolveUserConfig,
  verificationCommands,
} from '../lib/config.mjs'

test('routes bounded attempts from Luna to Terra and Sol', () => {
  const config = resolveConfig({})

  assert.deepEqual(modelForAttempt(config, 0), { model: 'gpt-5.6-luna', reasoningEffort: 'medium' })
  assert.deepEqual(modelForAttempt(config, 1), { model: 'gpt-5.6-luna', reasoningEffort: 'medium' })
  assert.deepEqual(modelForAttempt(config, 2), { model: 'gpt-5.6-terra', reasoningEffort: 'high' })
  assert.deepEqual(modelForAttempt(config, 3), { model: 'gpt-5.6-sol', reasoningEffort: 'high' })
  assert.equal(modelForAttempt(config, 4), null)
})

test('routes high-risk work directly to bounded Sol attempts', () => {
  const config = resolveConfig({})
  const task = { risk: 'high' }

  assert.deepEqual(modelForTaskAttempt(config, task, 0), {
    model: 'gpt-5.6-sol',
    reasoningEffort: 'high',
  })
  assert.equal(modelForTaskAttempt(config, task, 2), null)
})

test('verification commands come from checked-in profiles, not planner output', () => {
  const config = resolveConfig({
    verification: { profiles: { backend: ['safe backend test'] } },
  })

  assert.deepEqual(verificationCommands(config, 'backend'), ['safe backend test'])
  assert.throws(() => verificationCommands(config, 'rm -rf anything'), /unknown verification profile/i)
})

test('rejects unsafe or incomplete configuration', () => {
  assert.throws(() => resolveConfig({ models: { attempts: [] } }), /attempt/i)
  assert.throws(
    () => resolveConfig({ execution: { maxCheckpointReplans: -1 } }),
    /maxCheckpointReplans/i,
  )
  assert.throws(
    () => resolveConfig({ execution: { sandbox: 'danger-full-access' } }),
    /allowDangerFullAccess/i,
  )
})

test('allows an explicit VM compatibility escape hatch and applies it to inspection roles', () => {
  const config = resolveConfig({
    execution: { sandbox: 'danger-full-access', allowDangerFullAccess: true },
  })

  assert.equal(config.execution.sandbox, 'danger-full-access')
  assert.equal(inspectionSandbox(config), 'danger-full-access')
  assert.equal(inspectionSandbox(resolveConfig({})), 'read-only')
})

test('accepts arbitrary user profiles and optional aggregate gates', () => {
  const verification = {
    profiles: {
      unit: ['run unit tests'],
      data_pipeline: ['validate the pipeline'],
    },
  }

  assert.deepEqual(resolveUserConfig({ verification }).verification, {
    profiles: verification.profiles,
    checkpoint: [],
    final: [],
  })
  assert.throws(
    () => resolveUserConfig({ verification: { profiles: {} } }),
    /at least one verification profile/i,
  )
  assert.throws(
    () => resolveUserConfig({
      verification: { profiles: { 'invalid profile': ['custom gate'] } },
    }),
    /invalid verification profile name/i,
  )
  assert.throws(
    () => resolveUserConfig({
      verification: { profiles: { unit: ['  '] } },
    }),
    /profile unit.*commands/i,
  )
  assert.throws(
    () => resolveUserConfig({ verification: { ...verification, final: [''] } }),
    /verification\.final.*command list/i,
  )
})
