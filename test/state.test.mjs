import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createRunState,
  markAttemptFailed,
  markTaskCompleted,
  nextRunnableTask,
  recoverInterruptedState,
  terminalStatus,
  validatePlan,
} from '../lib/state.mjs'

const plan = {
  summary: 'small plan',
  tasks: [
    {
      id: 'T001',
      title: 'foundation',
      objective: 'Build the foundation.',
      acceptanceCriteria: ['foundation exists'],
      dependencies: [],
      verificationProfile: 'backend',
      risk: 'normal',
    },
    {
      id: 'T002',
      title: 'dependent',
      objective: 'Build on the foundation.',
      acceptanceCriteria: ['dependent behavior exists'],
      dependencies: ['T001'],
      verificationProfile: 'frontend',
      risk: 'normal',
    },
  ],
}

test('schedules only tasks whose dependencies completed', () => {
  const state = createRunState({ sourceDocument: 'doc/plan.md', plan, now: '2026-08-16T00:00:00.000Z' })

  assert.equal(nextRunnableTask(state).id, 'T001')
  markTaskCompleted(state, 'T001', { commit: 'abc123', now: '2026-08-16T00:10:00.000Z' })
  assert.equal(nextRunnableTask(state).id, 'T002')
})

test('accepts an empty remaining-work plan and rejects dependency cycles', () => {
  assert.doesNotThrow(() => validatePlan({ summary: 'already complete', tasks: [] }))
  assert.throws(() => validatePlan({
    summary: 'cyclic',
    tasks: [
      { ...plan.tasks[0], dependencies: ['T002'] },
      { ...plan.tasks[1], dependencies: ['T001'] },
    ],
  }), /dependency cycle/i)
})

test('recovers an interrupted running task as pending without losing evidence', () => {
  const state = createRunState({ sourceDocument: 'doc/plan.md', plan, now: '2026-08-16T00:00:00.000Z' })
  state.tasks[0].status = 'running'
  state.tasks[0].attempts.push({ model: 'gpt-5.6-luna', status: 'started', log: 'attempt.jsonl' })

  recoverInterruptedState(state, '2026-08-16T01:00:00.000Z')

  assert.equal(state.tasks[0].status, 'pending')
  assert.equal(state.tasks[0].attempts[0].status, 'interrupted')
  assert.match(state.events.at(-1).message, /interrupted/i)
})

test('a failed dependency blocks completion instead of silently skipping work', () => {
  const state = createRunState({ sourceDocument: 'doc/plan.md', plan, now: '2026-08-16T00:00:00.000Z' })
  markAttemptFailed(state, 'T001', {
    model: 'gpt-5.6-sol',
    reason: 'verification failed',
    terminal: true,
    now: '2026-08-16T00:20:00.000Z',
  })

  assert.equal(nextRunnableTask(state), null)
  assert.equal(terminalStatus(state), 'BLOCKED')
})

test('reports complete only after tasks, final gates, and final review pass', () => {
  const state = createRunState({ sourceDocument: 'doc/plan.md', plan, now: '2026-08-16T00:00:00.000Z' })
  markTaskCompleted(state, 'T001', { now: '2026-08-16T00:10:00.000Z' })
  markTaskCompleted(state, 'T002', { now: '2026-08-16T00:20:00.000Z' })

  assert.equal(terminalStatus(state), 'RUNNING')
  state.finalVerification = { status: 'passed' }
  assert.equal(terminalStatus(state), 'RUNNING')
  state.finalReview = { status: 'approved', blockers: [] }
  assert.equal(terminalStatus(state), 'COMPLETE')
})
