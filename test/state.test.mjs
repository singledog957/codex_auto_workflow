import assert from 'node:assert/strict'
import test from 'node:test'

import {
  addCheckpointFindings,
  createRunState,
  effectiveTaskType,
  finalReviewContext,
  isPlanningBootstrapState,
  markAttemptFailed,
  markTaskCompleted,
  nextRunnableTask,
  recoverInterruptedState,
  recordFinalReview,
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

test('accepts a twenty-file task budget and rejects larger tasks', () => {
  const boundedTask = { ...plan.tasks[0], maxFiles: 20 }

  assert.doesNotThrow(() => validatePlan({
    outcome: 'work_remaining',
    summary: 'larger bounded repair',
    tasks: [boundedTask],
  }))
  assert.throws(() => validatePlan({
    outcome: 'work_remaining',
    summary: 'oversized repair',
    tasks: [{ ...boundedTask, maxFiles: 21 }],
  }), /1 to 20/i)
})

test('validates task profiles against the names supplied by user config', () => {
  const customPlan = {
    outcome: 'work_remaining',
    summary: 'custom verification',
    tasks: [{ ...plan.tasks[0], verificationProfile: 'cargo' }],
  }

  assert.doesNotThrow(() => validatePlan(customPlan, ['cargo', 'format']))
  assert.throws(() => validatePlan(customPlan, ['pytest']), /invalid verification profile/i)
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

test('records a baseline review as a stable finding ledger', () => {
  const state = createRunState({ sourceDocument: 'doc/plan.md', plan, now: '2026-08-16T00:00:00.000Z' })

  assert.deepEqual(finalReviewContext(state), {
    mode: 'baseline',
    round: 1,
    previousReviewedCommit: null,
    openFindings: [],
  })

  recordFinalReview(state, {
    status: 'rejected',
    summary: 'One material blocker remains.',
    resolvedFindingIds: [],
    unresolvedFindingIds: [],
    newFindings: [{
      severity: 'required',
      origin: 'baseline',
      title: 'Missing recovery test',
      evidence: 'src/recovery.mjs has no interrupted-write coverage.',
      files: ['src/recovery.mjs'],
      requiredOutcome: 'Add a regression test and preserve recovery state.',
    }],
    advisories: ['Consider simplifying the helper later.'],
  }, {
    reviewedCommit: 'abc123',
    output: 'review-output-round-1.json',
    log: 'logs/final-review-round-1.jsonl',
    now: '2026-08-16T01:00:00.000Z',
  })

  assert.equal(state.finalReview.status, 'rejected')
  assert.equal(state.finalReview.mode, 'baseline')
  assert.match(state.finalReview.blockers[0], /FR-001.*Missing recovery test/)
  assert.equal(state.finalReviewLedger.findings[0].id, 'FR-001')
  assert.equal(state.finalReviewLedger.findings[0].status, 'open')
  assert.deepEqual(finalReviewContext(state), {
    mode: 'closure',
    round: 2,
    previousReviewedCommit: 'abc123',
    openFindings: [state.finalReviewLedger.findings[0]],
  })
})

test('closure review resolves known findings and permits only regressions or critical exceptions', () => {
  const state = createRunState({ sourceDocument: 'doc/plan.md', plan })
  recordFinalReview(state, {
    status: 'rejected',
    summary: 'Baseline blocker.',
    resolvedFindingIds: [],
    unresolvedFindingIds: [],
    newFindings: [{
      severity: 'required',
      origin: 'baseline',
      title: 'Missing recovery test',
      evidence: 'Recovery is not covered.',
      files: ['src/recovery.mjs'],
      requiredOutcome: 'Cover recovery.',
    }],
    advisories: [],
  }, { reviewedCommit: 'abc123' })

  assert.throws(() => recordFinalReview(state, {
    status: 'rejected',
    summary: 'Unrelated required issue.',
    resolvedFindingIds: ['FR-001'],
    unresolvedFindingIds: [],
    newFindings: [{
      severity: 'required',
      origin: 'critical_exception',
      title: 'Pre-existing cleanup',
      evidence: 'This predates the repair.',
      files: ['src/old.mjs'],
      requiredOutcome: 'Refactor it.',
    }],
    advisories: [],
  }, { reviewedCommit: 'def456' }), /critical exception.*critical severity/i)

  recordFinalReview(state, {
    status: 'approved',
    summary: 'The registered blocker is closed with no repair regression.',
    resolvedFindingIds: ['FR-001'],
    unresolvedFindingIds: [],
    newFindings: [],
    advisories: ['A pre-existing cleanup can be tracked separately.'],
  }, { reviewedCommit: 'def456' })

  assert.equal(state.finalReview.status, 'approved')
  assert.deepEqual(state.finalReview.blockers, [])
  assert.equal(state.finalReviewLedger.findings[0].status, 'resolved')
  assert.equal(state.finalReviewLedger.rounds.length, 2)
})

test('closure review must account for every open finding exactly once', () => {
  const state = createRunState({ sourceDocument: 'doc/plan.md', plan })
  recordFinalReview(state, {
    status: 'rejected',
    summary: 'Baseline blocker.',
    resolvedFindingIds: [],
    unresolvedFindingIds: [],
    newFindings: [{
      severity: 'critical',
      origin: 'baseline',
      title: 'Secret disclosure',
      evidence: 'A credential reaches the log.',
      files: ['src/log.mjs'],
      requiredOutcome: 'Redact the credential.',
    }],
    advisories: [],
  }, { reviewedCommit: 'abc123' })

  assert.throws(() => recordFinalReview(state, {
    status: 'approved',
    summary: 'Approved without reconciling the finding.',
    resolvedFindingIds: [],
    unresolvedFindingIds: [],
    newFindings: [],
    advisories: [],
  }, { reviewedCommit: 'def456' }), /account for every open finding/i)
})

test('closure review cannot label an unrelated required finding as a repair regression', () => {
  const state = createRunState({ sourceDocument: 'doc/plan.md', plan })
  recordFinalReview(state, {
    status: 'rejected',
    summary: 'Baseline blocker.',
    resolvedFindingIds: [],
    unresolvedFindingIds: [],
    newFindings: [{
      severity: 'required',
      origin: 'baseline',
      title: 'Missing recovery test',
      evidence: 'Recovery is not covered.',
      files: ['src/recovery.mjs'],
      requiredOutcome: 'Cover recovery.',
    }],
    advisories: [],
  }, { reviewedCommit: 'abc123' })
  const reviewContext = {
    ...finalReviewContext(state),
    repairFiles: ['src/recovery.mjs', 'test/recovery.test.mjs'],
  }

  assert.throws(() => recordFinalReview(state, {
    status: 'rejected',
    summary: 'An unrelated issue was presented as a regression.',
    resolvedFindingIds: ['FR-001'],
    unresolvedFindingIds: [],
    newFindings: [{
      severity: 'required',
      origin: 'repair_regression',
      title: 'Unrelated cleanup',
      evidence: 'This file was not changed by the repair.',
      files: ['src/old.mjs'],
      requiredOutcome: 'Refactor it.',
    }],
    advisories: [],
  }, { reviewedCommit: 'def456', reviewContext }), /repair diff/i)
})

test('recognizes explicit and legacy checkpoint tasks without changing legacy implementation tasks', () => {
  assert.equal(effectiveTaskType({ taskType: 'checkpoint', title: 'Phase gate' }), 'checkpoint')
  assert.equal(effectiveTaskType({ title: 'Checkpoint P4 and qualification' }), 'checkpoint')
  assert.equal(effectiveTaskType({ title: 'Final P8 Definition-of-Done verification' }), 'checkpoint')
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

test('rejects checkpoint findings that omit the hard file budget', () => {
  const state = createRunState({
    sourceDocument: 'doc/plan.md',
    plan: {
      outcome: 'work_remaining',
      summary: 'checkpoint plan',
      tasks: [{
        ...plan.tasks[0],
        taskType: 'checkpoint',
        title: 'Checkpoint P1',
      }],
    },
  })
  state.tasks[0].status = 'running'
  state.tasks[0].attempts.push({ model: 'gpt-5.6-sol', status: 'started' })

  assert.throws(() => addCheckpointFindings(state, 'T001', {
    status: 'gaps_found',
    summary: 'unbounded finding',
    findings: [{
      title: 'Unbounded repair',
      objective: 'Repair something.',
      acceptanceCriteria: ['It is repaired.'],
      verificationProfile: 'docs',
      risk: 'normal',
    }],
  }), /maxFiles/i)
})
