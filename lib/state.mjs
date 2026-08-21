const TASK_STATUSES = new Set(['pending', 'running', 'completed', 'blocked'])
const TASK_TYPES = new Set(['implementation', 'checkpoint'])
const RISKS = new Set(['normal', 'high'])
const MAX_PLAN_TASKS = 120
const MAX_FILES_PER_TASK = 20
const FINAL_REVIEW_SEVERITIES = new Set(['critical', 'required'])
const FINAL_REVIEW_ORIGINS = new Set(['baseline', 'repair_regression', 'critical_exception'])

function event(state, type, message, now = new Date().toISOString(), details = {}) {
  state.events.push({ at: now, type, message, ...details })
  state.updatedAt = now
}

export function effectiveTaskType(task) {
  if (task.taskType) return task.taskType
  const title = task.title ?? ''
  return /^checkpoint\b/i.test(title) || /^final\b.*\bverification\b/i.test(title)
    ? 'checkpoint'
    : 'implementation'
}

function validateTaskDefinition(task, label = task.id ?? 'Task', verificationProfiles = null) {
  if (!task.title || !task.objective) throw new Error(`${label} must have a title and objective`)
  if (!Array.isArray(task.acceptanceCriteria) || task.acceptanceCriteria.length === 0
    || task.acceptanceCriteria.some((criterion) => typeof criterion !== 'string' || criterion.length === 0)) {
    throw new Error(`${label} must have acceptance criteria`)
  }
  if (task.taskType !== undefined && !TASK_TYPES.has(task.taskType)) {
    throw new Error(`${label} has an invalid task type`)
  }
  if (task.maxFiles !== undefined
    && (!Number.isInteger(task.maxFiles) || task.maxFiles < 1 || task.maxFiles > MAX_FILES_PER_TASK)) {
    throw new Error(`${label} maxFiles must be an integer from 1 to ${MAX_FILES_PER_TASK}`)
  }
  if (typeof task.verificationProfile !== 'string' || task.verificationProfile.length === 0
    || (verificationProfiles && !verificationProfiles.includes(task.verificationProfile))) {
    throw new Error(`${label} has an invalid verification profile`)
  }
  if (!RISKS.has(task.risk)) throw new Error(`${label} has an invalid risk`)
}

export function validateCheckpointReview(review, verificationProfiles = null) {
  if (!review || !['approved', 'gaps_found'].includes(review.status)
    || typeof review.summary !== 'string' || review.summary.length === 0
    || !Array.isArray(review.findings)) {
    throw new Error('Checkpoint review must contain a status, summary, and findings array')
  }
  if (review.status === 'approved' && review.findings.length !== 0) {
    throw new Error('An approved checkpoint cannot contain findings')
  }
  if (review.status === 'gaps_found' && review.findings.length === 0) {
    throw new Error('A gaps_found checkpoint must contain at least one finding')
  }
  if (review.findings.length > 5) throw new Error('A checkpoint review cannot add more than five findings')
  review.findings.forEach((finding, index) => {
    if (finding.maxFiles === undefined) throw new Error(`Checkpoint finding ${index + 1} must define maxFiles`)
    validateTaskDefinition(finding, `Checkpoint finding ${index + 1}`, verificationProfiles)
  })
  return review
}

function requireNonEmptyString(value, label) {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${label} must be a non-empty string`)
}

function uniqueStrings(values, label) {
  if (!Array.isArray(values) || values.some((value) => typeof value !== 'string' || value.length === 0)) {
    throw new Error(`${label} must be an array of non-empty strings`)
  }
  if (new Set(values).size !== values.length) throw new Error(`${label} must not contain duplicates`)
  return values
}

function validateNewFinalFinding(finding, index) {
  const label = `Final review finding ${index + 1}`
  if (!finding || typeof finding !== 'object') throw new Error(`${label} must be an object`)
  if (!FINAL_REVIEW_SEVERITIES.has(finding.severity)) throw new Error(`${label} has an invalid severity`)
  if (!FINAL_REVIEW_ORIGINS.has(finding.origin)) throw new Error(`${label} has an invalid origin`)
  requireNonEmptyString(finding.title, `${label} title`)
  requireNonEmptyString(finding.evidence, `${label} evidence`)
  requireNonEmptyString(finding.requiredOutcome, `${label} required outcome`)
  const files = uniqueStrings(finding.files, `${label} files`)
  if (files.length === 0 || files.length > 10) throw new Error(`${label} must reference one to ten files`)
}

export function finalReviewContext(state) {
  const ledger = state.finalReviewLedger
  const rounds = ledger?.rounds ?? []
  const openFindings = (ledger?.findings ?? []).filter((finding) => finding.status === 'open')
  return {
    mode: rounds.length === 0 ? 'baseline' : 'closure',
    round: rounds.length + 1,
    previousReviewedCommit: rounds.at(-1)?.reviewedCommit ?? null,
    openFindings: structuredClone(openFindings),
  }
}

export function validateFinalReview(review, context) {
  if (!review || !['approved', 'rejected'].includes(review.status)) {
    throw new Error('Final review must contain an approved or rejected status')
  }
  requireNonEmptyString(review.summary, 'Final review summary')
  const resolved = uniqueStrings(review.resolvedFindingIds, 'Resolved finding ids')
  const unresolved = uniqueStrings(review.unresolvedFindingIds, 'Unresolved finding ids')
  const advisories = uniqueStrings(review.advisories, 'Final review advisories')
  if (advisories.length > 20) throw new Error('Final review cannot contain more than twenty advisories')
  if (!Array.isArray(review.newFindings) || review.newFindings.length > 20) {
    throw new Error('Final review must contain no more than twenty new findings')
  }
  review.newFindings.forEach(validateNewFinalFinding)

  const overlap = resolved.find((id) => unresolved.includes(id))
  if (overlap) throw new Error(`Finding ${overlap} cannot be both resolved and unresolved`)
  const openIds = context.openFindings.map((finding) => finding.id)
  const accounted = [...resolved, ...unresolved]
  if (accounted.length !== openIds.length
    || accounted.some((id) => !openIds.includes(id))
    || openIds.some((id) => !accounted.includes(id))) {
    throw new Error('A closure review must account for every open finding exactly once')
  }

  if (context.mode === 'baseline') {
    if (review.newFindings.some((finding) => finding.origin !== 'baseline')) {
      throw new Error('Baseline findings must use the baseline origin')
    }
  } else {
    if (review.newFindings.some((finding) => finding.origin === 'baseline')) {
      throw new Error('A closure review cannot add another baseline finding')
    }
    if (review.newFindings.some(
      (finding) => finding.origin === 'critical_exception' && finding.severity !== 'critical',
    )) {
      throw new Error('A critical exception must have critical severity')
    }
    if (review.newFindings.some(
      (finding) => finding.origin === 'repair_regression'
        && !finding.files.some((file) => context.repairFiles?.includes(file)),
    )) {
      throw new Error('A repair regression must reference at least one file in the repair diff')
    }
  }

  const hasBlockers = unresolved.length > 0 || review.newFindings.length > 0
  if ((review.status === 'rejected') !== hasBlockers) {
    throw new Error('Final review status must agree with its unresolved and new findings')
  }
  return review
}

function findingId(number) {
  return `FR-${String(number).padStart(3, '0')}`
}

export function recordFinalReview(
  state,
  review,
  {
    reviewedCommit,
    output = null,
    log = null,
    reviewContext = null,
    now = new Date().toISOString(),
  },
) {
  requireNonEmptyString(reviewedCommit, 'Reviewed commit')
  state.finalReviewLedger ??= { nextFindingNumber: 1, findings: [], rounds: [] }
  const context = reviewContext ?? finalReviewContext(state)
  validateFinalReview(review, context)

  for (const id of review.resolvedFindingIds) {
    const finding = state.finalReviewLedger.findings.find((candidate) => candidate.id === id)
    finding.status = 'resolved'
    finding.resolvedAt = now
    finding.resolvedRound = context.round
  }
  for (const id of review.unresolvedFindingIds) {
    const finding = state.finalReviewLedger.findings.find((candidate) => candidate.id === id)
    finding.lastSeenAt = now
    finding.lastSeenRound = context.round
  }

  const newFindingIds = review.newFindings.map((finding) => {
    const id = findingId(state.finalReviewLedger.nextFindingNumber++)
    state.finalReviewLedger.findings.push({
      id,
      ...structuredClone(finding),
      status: 'open',
      firstSeenAt: now,
      firstSeenRound: context.round,
      lastSeenAt: now,
      lastSeenRound: context.round,
    })
    return id
  })
  state.finalReviewLedger.rounds.push({
    round: context.round,
    mode: context.mode,
    reviewedCommit,
    previousReviewedCommit: context.previousReviewedCommit,
    status: review.status,
    summary: review.summary,
    resolvedFindingIds: [...review.resolvedFindingIds],
    unresolvedFindingIds: [...review.unresolvedFindingIds],
    newFindingIds,
    advisories: [...review.advisories],
    output,
    log,
    reviewedAt: now,
  })

  const openFindings = state.finalReviewLedger.findings.filter((finding) => finding.status === 'open')
  state.finalReview = {
    status: review.status,
    summary: review.summary,
    mode: context.mode,
    round: context.round,
    reviewedCommit,
    blockers: openFindings.map(
      (finding) => `${finding.id} [${finding.severity}] ${finding.title}: ${finding.requiredOutcome}`,
    ),
    advisories: [...review.advisories],
  }
  event(state, 'final_review_recorded', `Recorded ${context.mode} final review round ${context.round}`, now, {
    round: context.round,
    mode: context.mode,
    reviewedCommit,
    newFindingIds,
    resolvedFindingIds: review.resolvedFindingIds,
  })
  return state.finalReview
}

export function validatePlan(plan, verificationProfiles = null) {
  if (!plan || !['work_remaining', 'already_complete', 'blocked'].includes(plan.outcome)
    || typeof plan.summary !== 'string' || plan.summary.length === 0 || !Array.isArray(plan.tasks)) {
    throw new Error('Plan must contain an outcome, a summary, and a task array')
  }
  if (plan.outcome === 'blocked') throw new Error(`Planning was blocked: ${plan.summary}`)
  if (plan.outcome === 'work_remaining' && plan.tasks.length === 0) {
    throw new Error('A work_remaining plan must contain at least one task')
  }
  if (plan.outcome === 'already_complete' && plan.tasks.length !== 0) {
    throw new Error('An already_complete plan cannot contain tasks')
  }
  const ids = new Set()
  if (plan.tasks.length > MAX_PLAN_TASKS) throw new Error(`A plan cannot contain more than ${MAX_PLAN_TASKS} tasks`)
  for (const task of plan.tasks) {
    if (!/^T\d{3,}$/.test(task.id ?? '')) throw new Error(`Invalid task id: ${task.id}`)
    if (ids.has(task.id)) throw new Error(`Duplicate task id: ${task.id}`)
    ids.add(task.id)
    validateTaskDefinition(task, task.id, verificationProfiles)
    if (!Array.isArray(task.dependencies)) throw new Error(`${task.id} dependencies must be an array`)
    if (new Set(task.dependencies).size !== task.dependencies.length) {
      throw new Error(`${task.id} dependencies must be unique`)
    }
  }
  for (const task of plan.tasks) {
    for (const dependency of task.dependencies) {
      if (!ids.has(dependency)) throw new Error(`${task.id} has unknown dependency ${dependency}`)
      if (dependency === task.id) throw new Error(`${task.id} cannot depend on itself`)
    }
  }
  const tasksById = new Map(plan.tasks.map((task) => [task.id, task]))
  const visiting = new Set()
  const visited = new Set()
  const visit = (taskId) => {
    if (visiting.has(taskId)) throw new Error(`Plan contains a dependency cycle at ${taskId}`)
    if (visited.has(taskId)) return
    visiting.add(taskId)
    for (const dependency of tasksById.get(taskId).dependencies) visit(dependency)
    visiting.delete(taskId)
    visited.add(taskId)
  }
  for (const task of plan.tasks) visit(task.id)
  return plan
}

export function addCheckpointFindings(
  state,
  checkpointId,
  review,
  { now = new Date().toISOString(), verificationProfiles = null } = {},
) {
  validateCheckpointReview(review, verificationProfiles)
  if (review.status !== 'gaps_found') throw new Error('Only checkpoint findings can be added to the task queue')
  const checkpointIndex = state.tasks.findIndex((task) => task.id === checkpointId)
  const checkpoint = state.tasks[checkpointIndex]
  if (!checkpoint || effectiveTaskType(checkpoint) !== 'checkpoint') {
    throw new Error(`Unknown checkpoint task ${checkpointId}`)
  }
  const attempt = checkpoint.attempts.at(-1)
  if (checkpoint.status !== 'running' || attempt?.status !== 'started') {
    throw new Error(`Checkpoint ${checkpointId} has no running review attempt`)
  }
  if (state.tasks.length + review.findings.length > MAX_PLAN_TASKS) {
    throw new Error(`Checkpoint findings would exceed the ${MAX_PLAN_TASKS}-task plan limit`)
  }

  let nextNumber = Math.max(...state.tasks.map((task) => Number(task.id.slice(1)))) + 1
  const previousDependencies = [...checkpoint.dependencies]
  const added = review.findings.map((finding) => ({
    ...structuredClone(finding),
    id: `T${String(nextNumber++).padStart(3, '0')}`,
    taskType: 'implementation',
    dependencies: [...previousDependencies],
    status: 'pending',
    attempts: [],
    verification: null,
    commit: null,
  }))

  attempt.status = 'findings'
  attempt.summary = review.summary
  attempt.finishedAt = now
  checkpoint.status = 'pending'
  checkpoint.checkpointReplans = (checkpoint.checkpointReplans ?? 0) + 1
  checkpoint.dependencies = added.map((task) => task.id)
  state.tasks.splice(checkpointIndex, 0, ...added)
  event(
    state,
    'checkpoint_findings_added',
    `${checkpointId}: added ${added.length} bounded repair task(s)`,
    now,
    { taskId: checkpointId, addedTaskIds: added.map((task) => task.id) },
  )
  return added
}

export function createRunState({
  sourceDocument,
  plan,
  verificationProfiles = null,
  now = new Date().toISOString(),
}) {
  validatePlan(plan, verificationProfiles)
  return {
    version: 1,
    sourceDocument,
    planOutcome: plan.outcome,
    planSummary: plan.summary,
    status: 'RUNNING',
    startedAt: now,
    updatedAt: now,
    codexCalls: 0,
    completedSinceCheckpoint: 0,
    tasks: plan.tasks.map((task) => ({
      ...structuredClone(task),
      status: 'pending',
      attempts: [],
      verification: null,
      commit: null,
    })),
    checkpointVerification: [],
    finalVerification: null,
    finalReview: null,
    finalReviewLedger: { nextFindingNumber: 1, findings: [], rounds: [] },
    events: [{ at: now, type: 'run_started', message: `Run created for ${sourceDocument}` }],
  }
}

export function recoverInterruptedState(state, now = new Date().toISOString()) {
  for (const task of state.tasks) {
    if (!TASK_STATUSES.has(task.status)) throw new Error(`Invalid task status: ${task.status}`)
    if (task.status !== 'running') continue
    task.status = 'pending'
    const attempt = task.attempts.at(-1)
    if (attempt?.status === 'started') {
      attempt.status = 'interrupted'
      attempt.finishedAt = now
    }
    event(state, 'task_recovered', `Recovered interrupted task ${task.id}`, now, { taskId: task.id })
  }
  return state
}

export function isPlanningBootstrapState(state) {
  const syntheticFailure = state.tasks.length === 1
    && state.tasks[0].id === 'T000'
    && state.tasks[0].title === 'Planning bootstrap'
    && state.tasks[0].status === 'blocked'
  const legacyEmptyFalseSuccess = state.tasks.length === 0
    && !state.planOutcome
    && !state.finalVerification
  return syntheticFailure || legacyEmptyFalseSuccess
}

export function nextRunnableTask(state) {
  const completed = new Set(state.tasks.filter((task) => task.status === 'completed').map((task) => task.id))
  return state.tasks.find(
    (task) => task.status === 'pending' && task.dependencies.every((dependency) => completed.has(dependency)),
  ) ?? null
}

export function startAttempt(state, taskId, { model, reasoningEffort, log, now = new Date().toISOString() }) {
  const task = state.tasks.find((candidate) => candidate.id === taskId)
  if (!task || task.status !== 'pending') throw new Error(`Task ${taskId} is not pending`)
  task.status = 'running'
  task.attempts.push({ model, reasoningEffort, log, status: 'started', startedAt: now })
  state.codexCalls += 1
  event(state, 'attempt_started', `Started ${taskId} with ${model}`, now, { taskId, model })
}

export function markAttemptFailed(
  state,
  taskId,
  { model, reason, terminal = false, log, now = new Date().toISOString() },
) {
  const task = state.tasks.find((candidate) => candidate.id === taskId)
  if (!task) throw new Error(`Unknown task ${taskId}`)
  const attempt = task.attempts.at(-1)
  if (attempt?.status === 'started') {
    attempt.status = 'failed'
    attempt.reason = reason
    attempt.finishedAt = now
    if (log) attempt.log = log
  } else {
    task.attempts.push({ model, status: 'failed', reason, log, finishedAt: now })
  }
  task.status = terminal ? 'blocked' : 'pending'
  event(state, terminal ? 'task_blocked' : 'attempt_failed', `${taskId}: ${reason}`, now, { taskId, model })
}

export function markTaskCompleted(
  state,
  taskId,
  {
    commit = null,
    verification = null,
    countForCheckpoint = true,
    now = new Date().toISOString(),
  } = {},
) {
  const task = state.tasks.find((candidate) => candidate.id === taskId)
  if (!task) throw new Error(`Unknown task ${taskId}`)
  const attempt = task.attempts.at(-1)
  if (attempt?.status === 'started') {
    attempt.status = 'passed'
    attempt.finishedAt = now
  }
  task.status = 'completed'
  task.completedAt = now
  task.commit = commit
  task.verification = verification
  if (countForCheckpoint) state.completedSinceCheckpoint += 1
  event(state, 'task_completed', `Completed ${taskId}`, now, { taskId, commit })
}

export function terminalStatus(state) {
  const allComplete = state.tasks.every((task) => task.status === 'completed')
  if (allComplete && state.finalVerification?.status === 'passed' && state.finalReview?.status === 'approved') {
    return 'COMPLETE'
  }
  if (state.status === 'DRY_RUN') return 'DRY_RUN'
  if (state.status === 'BLOCKED') return 'BLOCKED'
  if (!nextRunnableTask(state) && state.tasks.some((task) => task.status === 'blocked')) return 'BLOCKED'
  return state.status === 'BUDGET_EXHAUSTED' ? 'BUDGET_EXHAUSTED' : 'RUNNING'
}
