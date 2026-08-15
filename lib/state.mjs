const TASK_STATUSES = new Set(['pending', 'running', 'completed', 'blocked'])

function event(state, type, message, now = new Date().toISOString(), details = {}) {
  state.events.push({ at: now, type, message, ...details })
  state.updatedAt = now
}

export function validatePlan(plan) {
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
  for (const task of plan.tasks) {
    if (!/^T\d{3,}$/.test(task.id ?? '')) throw new Error(`Invalid task id: ${task.id}`)
    if (ids.has(task.id)) throw new Error(`Duplicate task id: ${task.id}`)
    ids.add(task.id)
    if (!task.title || !task.objective) throw new Error(`${task.id} must have a title and objective`)
    if (!Array.isArray(task.acceptanceCriteria) || task.acceptanceCriteria.length === 0
      || task.acceptanceCriteria.some((criterion) => typeof criterion !== 'string' || criterion.length === 0)) {
      throw new Error(`${task.id} must have acceptance criteria`)
    }
    if (!Array.isArray(task.dependencies)) throw new Error(`${task.id} dependencies must be an array`)
    if (new Set(task.dependencies).size !== task.dependencies.length) {
      throw new Error(`${task.id} dependencies must be unique`)
    }
    if (!['backend', 'frontend', 'full', 'docs'].includes(task.verificationProfile)) {
      throw new Error(`${task.id} has an invalid verification profile`)
    }
    if (!['normal', 'high'].includes(task.risk)) throw new Error(`${task.id} has an invalid risk`)
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

export function createRunState({ sourceDocument, plan, now = new Date().toISOString() }) {
  validatePlan(plan)
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
  { commit = null, verification = null, now = new Date().toISOString() } = {},
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
  state.completedSinceCheckpoint += 1
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
