import assert from 'node:assert/strict'
import test from 'node:test'

import {
  addCheckpointFindings,
  createRunState,
  effectiveTaskType,
  isPlanningBootstrapState,
  markAttemptFailed,
  markTaskCompleted,
  nextRunnableTask,
  recoverInterruptedState,
  terminalStatus,
  validatePlan,
} from '../lib/state.mjs'

const plan = {
  outcome: 'work_remaining',
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

test('recognizes only the synthetic blocked planning bootstrap as retryable', () => {
  const state = createRunState({
    sourceDocument: 'doc/plan.md',
    plan: {
      outcome: 'work_remaining',
      summary: 'planning failed',
      tasks: [{
        id: 'T000',
        title: 'Planning bootstrap',
        objective: 'Create a plan.',
        acceptanceCriteria: ['plan exists'],
        dependencies: [],
        verificationProfile: 'docs',
        risk: 'high',
      }],
    },
  })
  state.tasks[0].status = 'blocked'

  assert.equal(isPlanningBootstrapState(state), true)
  state.tasks[0].title = 'real task'
  assert.equal(isPlanningBootstrapState(state), false)
})

test('requires a truthful plan outcome and rejects dependency cycles', () => {
  assert.doesNotThrow(() => validatePlan({ outcome: 'already_complete', summary: 'already complete', tasks: [] }))
  assert.throws(
    () => validatePlan({ outcome: 'work_remaining', summary: 'inspection failed', tasks: [] }),
    /at least one task/i,
  )
  assert.throws(
    () => validatePlan({ outcome: 'blocked', summary: 'inspection failed', tasks: [] }),
    /planning was blocked/i,
  )
  assert.throws(() => validatePlan({
    outcome: 'work_remaining',
    summary: 'cyclic',
    tasks: [
      { ...plan.tasks[0], dependencies: ['T002'] },
      { ...plan.tasks[1], dependencies: ['T001'] },
    ],
  }), /dependency cycle/i)
})

test('recognizes a legacy zero-task false success as retryable planning', () => {
  const state = createRunState({
    sourceDocument: 'doc/plan.md',
    plan: { outcome: 'already_complete', summary: 'complete', tasks: [] },
  })
  delete state.planOutcome
  state.finalVerification = null

  assert.equal(isPlanningBootstrapState(state), true)
  state.planOutcome = 'already_complete'
  assert.equal(isPlanningBootstrapState(state), false)
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

test('recognizes explicit and legacy checkpoint tasks without changing legacy implementation tasks', () => {
  assert.equal(effectiveTaskType({ taskType: 'checkpoint', title: 'Phase gate' }), 'checkpoint')
  assert.equal(effectiveTaskType({ title: 'Checkpoint P4 and qualification' }), 'checkpoint')
  assert.equal(effectiveTaskType({ title: 'Implement checkpoint persistence' }), 'implementation')
})

test('turns checkpoint findings into bounded repair tasks before retrying the checkpoint', () => {
  const checkpointPlan = {
    outcome: 'work_remaining',
    summary: 'checkpoint plan',
    tasks: [
      { ...plan.tasks[0], taskType: 'implementation', maxFiles: 5 },
      {
        ...plan.tasks[1],
        taskType: 'checkpoint',
        maxFiles: 1,
        title: 'Checkpoint P1',
        dependencies: ['T001'],
      },
      {
        ...plan.tasks[1],
        id: 'T003',
        taskType: 'implementation',
        maxFiles: 5,
        title: 'later work',
        dependencies: ['T002'],
      },
    ],
  }
  const state = createRunState({
    sourceDocument: 'doc/plan.md',
    plan: checkpointPlan,
    now: '2026-08-16T00:00:00.000Z',
  })
  markTaskCompleted(state, 'T001', { now: '2026-08-16T00:10:00.000Z' })
  state.tasks[1].status = 'running'
  state.tasks[1].attempts.push({ model: 'gpt-5.6-sol', status: 'started' })

  const added = addCheckpointFindings(state, 'T002', {
    status: 'gaps_found',
    summary: 'A release conflict is not recovered.',
    findings: [{
      title: 'Recover release conflicts',
      objective: 'Reload the current revision before retrying release.',
      acceptanceCriteria: ['A stale release retries with the current revision.'],
      verificationProfile: 'frontend',
      risk: 'normal',
      maxFiles: 3,
    }],
  }, { now: '2026-08-16T00:20:00.000Z' })

  assert.deepEqual(added.map((task) => task.id), ['T004'])
  assert.equal(state.tasks.find((task) => task.id === 'T002').status, 'pending')
  assert.deepEqual(state.tasks.find((task) => task.id === 'T002').dependencies, ['T004'])
  assert.deepEqual(state.tasks.find((task) => task.id === 'T004').dependencies, ['T001'])
  assert.equal(state.tasks.find((task) => task.id === 'T004').taskType, 'implementation')
  assert.equal(state.tasks.find((task) => task.id === 'T004').maxFiles, 3)
  assert.equal(state.tasks.find((task) => task.id === 'T003').dependencies[0], 'T002')
  assert.equal(nextRunnableTask(state).id, 'T004')
  assert.equal(state.tasks.find((task) => task.id === 'T002').attempts.at(-1).status, 'findings')
})
