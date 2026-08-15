#!/usr/bin/env node

import { access, mkdir, readFile, realpath } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import process from 'node:process'

import { modelForTaskAttempt, resolveConfig, verificationCommands } from './lib/config.mjs'
import { runCodex } from './lib/codex.mjs'
import { readJson, writeJsonAtomic, writeText } from './lib/files.mjs'
import { commitCheckpoint, gitBranch, gitHead, gitInvariantViolation, gitStatus } from './lib/git.mjs'
import { runCommands } from './lib/process.mjs'
import { plannerPrompt, reviewerPrompt, workerPrompt } from './lib/prompts.mjs'
import { renderReport } from './lib/report.mjs'
import {
  createRunState,
  isPlanningBootstrapState,
  markAttemptFailed,
  markTaskCompleted,
  nextRunnableTask,
  recoverInterruptedState,
  startAttempt,
  terminalStatus,
  validatePlan,
} from './lib/state.mjs'

const workflowRoot = dirname(new URL(import.meta.url).pathname)
const defaultConfigPath = join(workflowRoot, 'config.json')
const planSchemaPath = join(workflowRoot, 'schemas', 'plan.schema.json')
const reviewSchemaPath = join(workflowRoot, 'schemas', 'review.schema.json')

function parseOptions(argv) {
  const [command = 'help', positional, ...rest] = argv
  const options = { command, positional }
  for (let index = 0; index < rest.length; index += 1) {
    const flag = rest[index]
    if (flag === '--dry-run') options.dryRun = true
    else if (flag === '--config') options.configPath = rest[++index]
    else if (flag === '--run-dir') options.runDir = rest[++index]
    else if (flag === '--run-id') options.runId = rest[++index]
    else throw new Error(`Unknown option: ${flag}`)
  }
  return options
}

function usage() {
  return `Usage:
  node auto-workflow/runner.mjs run <document> [--config FILE] [--run-dir DIR] [--run-id ID] [--dry-run]
  node auto-workflow/runner.mjs resume <run-directory>
  node auto-workflow/runner.mjs status <run-directory>`
}

async function repositoryRoot(cwd) {
  let current = resolve(cwd)
  while (true) {
    try {
      await access(join(current, '.git'))
      return current
    } catch {
      const parent = dirname(current)
      if (parent === current) throw new Error('Run this command inside a Git repository')
      current = parent
    }
  }
}

function ensureInsideRepository(repoRoot, path, label) {
  const absolute = isAbsolute(path) ? resolve(path) : resolve(repoRoot, path)
  const rel = relative(repoRoot, absolute)
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`${label} must be inside the repository: ${path}`)
  }
  return absolute
}

async function resolveExistingInsideRepository(repoRoot, path, label) {
  const lexical = ensureInsideRepository(repoRoot, path, label)
  const canonical = await realpath(lexical)
  return ensureInsideRepository(repoRoot, canonical, label)
}

function timestampId() {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')
}

async function loadConfig(path) {
  const raw = await readJson(path)
  return resolveConfig(raw)
}

async function saveState(runDir, state) {
  state.status = terminalStatus(state)
  state.updatedAt = new Date().toISOString()
  await writeJsonAtomic(join(runDir, 'state.json'), state)
  await writeText(join(runDir, 'REPORT.md'), renderReport(state))
}

function previewPlan(markdown) {
  const headings = [...markdown.matchAll(/^####\s+(I-\d+)[：:]\s*(.+)$/gm)]
  const selected = headings.length ? headings : [[null, 'I-00', 'Review source document']]
  return {
    summary: 'Dry-run preview extracted from document headings. The real Sol planner may skip completed work and split large items.',
    tasks: selected.map((match, index) => ({
      id: `T${String(index + 1).padStart(3, '0')}`,
      title: `${match[1]} ${match[2]}`,
      objective: `Assess and implement the remaining scope of ${match[1]}.`,
      acceptanceCriteria: ['The real planning pass will replace this preview with repository-aware criteria.'],
      dependencies: index === 0 ? [] : [`T${String(index).padStart(3, '0')}`],
      verificationProfile: 'full',
      risk: 'normal',
    })),
  }
}

function remainingTime(deadline) {
  return Math.max(0, deadline - Date.now())
}

function cappedTimeout(minutes, deadline) {
  return Math.max(1, Math.min(minutes * 60_000, remainingTime(deadline)))
}

async function verification({ commands, repoRoot, runDir, name, config, deadline }) {
  const result = await runCommands({
    commands,
    cwd: repoRoot,
    timeoutMs: cappedTimeout(config.execution.verificationTimeoutMinutes, deadline),
    logPath: join(runDir, 'logs', `${name}.log`),
  })
  return {
    status: result.ok ? 'passed' : 'failed',
    commands,
    failedCommand: result.failedCommand,
    log: relative(repoRoot, join(runDir, 'logs', `${name}.log`)),
    failureTail: result.results.at(-1)?.tail ?? '',
  }
}

async function createPlan({ sourceDocument, repoRoot, runDir, config, deadline }) {
  const outputPath = join(runDir, 'planner-output.json')
  const logPath = join(runDir, 'logs', 'planner.jsonl')
  const result = await runCodex({
    prompt: plannerPrompt({
      sourceDocument: relative(repoRoot, sourceDocument),
      verificationProfiles: Object.keys(config.verification.profiles),
    }),
    cwd: repoRoot,
    model: config.models.planner.model,
    reasoningEffort: config.models.planner.reasoningEffort,
    sandbox: 'read-only',
    outputSchema: planSchemaPath,
    outputLastMessage: outputPath,
    logPath,
    timeoutMs: cappedTimeout(config.execution.codexTimeoutMinutes, deadline),
  })
  if (!result.ok) throw new Error(`Planning failed. See ${logPath}: ${result.stderrTail}`)
  const plan = await readJson(outputPath)
  validatePlan(plan)
  await writeJsonAtomic(join(runDir, 'plan.json'), plan)
  return plan
}

async function ensureClean(repoRoot, config) {
  if (!config.execution.requireCleanTree) return
  const status = await gitStatus(repoRoot)
  if (status) {
    throw new Error('The worktree is not clean. Commit/stash changes or use auto-workflow/start.sh to create an isolated worktree.')
  }
}

async function runTask({ task, state, repoRoot, runDir, config, deadline, session }) {
  while (task.status === 'pending') {
    const attemptIndex = task.attempts.length
    const route = modelForTaskAttempt(config, task, attemptIndex)
    if (!route) {
      markAttemptFailed(state, task.id, {
        model: task.attempts.at(-1)?.model ?? 'none',
        reason: 'The bounded retry ladder is exhausted.',
        terminal: true,
      })
      return
    }
    if (remainingTime(deadline) === 0 || session.calls >= config.execution.maxCodexCalls) {
      state.status = 'BUDGET_EXHAUSTED'
      return
    }

    const attemptNumber = attemptIndex + 1
    const logPath = join(runDir, 'logs', `${task.id}-attempt-${attemptNumber}-${route.model}.jsonl`)
    const outputPath = join(runDir, 'logs', `${task.id}-attempt-${attemptNumber}-final.txt`)
    startAttempt(state, task.id, {
      model: route.model,
      reasoningEffort: route.reasoningEffort,
      log: relative(repoRoot, logPath),
    })
    session.calls += 1
    await saveState(runDir, state)

    const prior = task.attempts.length > 1 ? task.attempts.at(-2)?.reason : null
    const gitBefore = { head: await gitHead(repoRoot), branch: await gitBranch(repoRoot) }
    const result = await runCodex({
      prompt: workerPrompt({
        sourceDocument: state.sourceDocument,
        task,
        attemptNumber,
        previousFailure: prior,
      }),
      cwd: repoRoot,
      model: route.model,
      reasoningEffort: route.reasoningEffort,
      sandbox: config.execution.sandbox,
      outputLastMessage: outputPath,
      logPath,
      timeoutMs: cappedTimeout(config.execution.codexTimeoutMinutes, deadline),
    })
    const gitAfter = { head: await gitHead(repoRoot), branch: await gitBranch(repoRoot) }
    const invariantViolation = gitInvariantViolation(gitBefore, gitAfter)
    if (invariantViolation) {
      markAttemptFailed(state, task.id, {
        model: route.model,
        reason: invariantViolation,
        terminal: true,
      })
      await saveState(runDir, state)
      return
    }
    if (!result.ok) {
      const reason = result.timedOut
        ? 'Codex attempt timed out.'
        : `Codex exited unsuccessfully (${result.exitCode ?? result.signal ?? result.error}). ${result.stderrTail}`
      const terminal = modelForTaskAttempt(config, task, attemptIndex + 1) === null
      markAttemptFailed(state, task.id, { model: route.model, reason, terminal })
      await saveState(runDir, state)
      continue
    }

    const taskVerification = await verification({
      commands: verificationCommands(config, task.verificationProfile),
      repoRoot,
      runDir,
      name: `${task.id}-attempt-${attemptNumber}-verify`,
      config,
      deadline,
    })
    let combinedVerification = taskVerification
    const checkpointDue = taskVerification.status === 'passed'
      && state.completedSinceCheckpoint + 1 >= config.execution.checkpointEvery
    if (checkpointDue) {
      const checkpoint = await verification({
        commands: config.verification.checkpoint,
        repoRoot,
        runDir,
        name: `${task.id}-checkpoint`,
        config,
        deadline,
      })
      state.checkpointVerification.push({ taskId: task.id, ...checkpoint })
      if (checkpoint.status === 'failed') combinedVerification = checkpoint
    }

    if (combinedVerification.status !== 'passed') {
      const reason = `Independent verification failed at: ${combinedVerification.failedCommand}\n${combinedVerification.failureTail}`
      const terminal = modelForTaskAttempt(config, task, attemptIndex + 1) === null
      markAttemptFailed(state, task.id, { model: route.model, reason, terminal, log: combinedVerification.log })
      await saveState(runDir, state)
      continue
    }

    let commit = await gitHead(repoRoot)
    if (config.execution.autoCommit) {
      const checkpoint = await commitCheckpoint(repoRoot, task)
      commit = checkpoint.commit
    }
    markTaskCompleted(state, task.id, { commit, verification: taskVerification })
    if (checkpointDue) state.completedSinceCheckpoint = 0
    await saveState(runDir, state)
  }
}

async function finalize({ state, repoRoot, runDir, config, deadline, session }) {
  state.finalVerification = await verification({
    commands: config.verification.final,
    repoRoot,
    runDir,
    name: 'final-verification',
    config,
    deadline,
  })
  if (state.finalVerification.status !== 'passed') {
    state.status = 'BLOCKED'
    await saveState(runDir, state)
    return
  }
  if (remainingTime(deadline) === 0 || session.calls >= config.execution.maxCodexCalls) {
    state.status = 'BUDGET_EXHAUSTED'
    await saveState(runDir, state)
    return
  }

  const outputPath = join(runDir, 'review-output.json')
  const logPath = join(runDir, 'logs', 'final-review.jsonl')
  session.calls += 1
  state.codexCalls += 1
  await saveState(runDir, state)
  const result = await runCodex({
    prompt: reviewerPrompt({
      sourceDocument: state.sourceDocument,
      statePath: relative(repoRoot, join(runDir, 'state.json')),
      baseCommit: state.baseCommit,
    }),
    cwd: repoRoot,
    model: config.models.reviewer.model,
    reasoningEffort: config.models.reviewer.reasoningEffort,
    sandbox: 'read-only',
    outputSchema: reviewSchemaPath,
    outputLastMessage: outputPath,
    logPath,
    timeoutMs: cappedTimeout(config.execution.codexTimeoutMinutes, deadline),
  })
  if (!result.ok) {
    state.finalReview = { status: 'rejected', summary: 'Final reviewer failed to complete.', blockers: [result.stderrTail] }
    state.status = 'BLOCKED'
  } else {
    const review = await readJson(outputPath)
    if (!['approved', 'rejected'].includes(review.status)
      || typeof review.summary !== 'string'
      || review.summary.length === 0
      || !Array.isArray(review.blockers)
      || review.blockers.some((blocker) => typeof blocker !== 'string' || blocker.length === 0)) {
      throw new Error('Final reviewer returned invalid structured output')
    }
    state.finalReview = review
    state.status = review.status === 'approved' ? 'COMPLETE' : 'BLOCKED'
  }
  await saveState(runDir, state)
}

async function executeNew(options) {
  const repoRoot = await repositoryRoot(process.cwd())
  const sourceDocument = await resolveExistingInsideRepository(repoRoot, options.positional, 'Source document')
  const configPath = await resolveExistingInsideRepository(repoRoot, options.configPath ?? defaultConfigPath, 'Config')
  const config = await loadConfig(configPath)
  const runId = options.runId ?? timestampId()
  const runDir = ensureInsideRepository(
    repoRoot,
    options.runDir ?? join('auto-workflow', '.runs', `${basename(options.positional, '.md')}-${runId}`),
    'Run directory',
  )
  await mkdir(runDir, { recursive: true, mode: 0o700 })
  const canonicalRunDir = await resolveExistingInsideRepository(repoRoot, runDir, 'Run directory')
  if (canonicalRunDir !== runDir) throw new Error('Run directory must not traverse a symbolic link')
  await writeJsonAtomic(join(runDir, 'config.snapshot.json'), config)

  if (options.dryRun) {
    const plan = previewPlan(await readFile(sourceDocument, 'utf8'))
    await writeJsonAtomic(join(runDir, 'plan.json'), plan)
    const state = createRunState({ sourceDocument: relative(repoRoot, sourceDocument), plan })
    state.status = 'DRY_RUN'
    state.baseCommit = await gitHead(repoRoot)
    state.branch = await gitBranch(repoRoot)
    await saveState(runDir, state)
    console.log(`Dry-run preview: ${relative(repoRoot, join(runDir, 'REPORT.md'))}`)
    return state
  }

  await ensureClean(repoRoot, config)
  const session = { calls: 0 }
  const deadline = Date.now() + config.execution.maxHours * 60 * 60_000
  let plan
  try {
    plan = await createPlan({ sourceDocument, repoRoot, runDir, config, deadline })
    session.calls += 1
  } catch (error) {
    const failurePlan = {
      summary: 'The planning bootstrap failed before an implementation queue could be created.',
      tasks: [{
        id: 'T000',
        title: 'Planning bootstrap',
        objective: 'Create and validate the durable implementation plan.',
        acceptanceCriteria: ['A schema-valid repository-aware plan exists.'],
        dependencies: [],
        verificationProfile: 'docs',
        risk: 'high',
      }],
    }
    const failedState = createRunState({ sourceDocument: relative(repoRoot, sourceDocument), plan: failurePlan })
    failedState.baseCommit = await gitHead(repoRoot)
    failedState.branch = await gitBranch(repoRoot)
    failedState.codexCalls = 1
    failedState.sessions = [{ startedAt: new Date().toISOString(), kind: 'run' }]
    markAttemptFailed(failedState, 'T000', {
      model: config.models.planner.model,
      reason: error.message,
      terminal: true,
    })
    await saveState(runDir, failedState)
    console.log(renderReport(failedState))
    return failedState
  }
  const state = createRunState({ sourceDocument: relative(repoRoot, sourceDocument), plan })
  state.baseCommit = await gitHead(repoRoot)
  state.branch = await gitBranch(repoRoot)
  state.codexCalls = 1
  state.sessions = [{ startedAt: new Date().toISOString(), kind: 'run' }]
  await saveState(runDir, state)
  return executeLoop({ state, repoRoot, runDir, config, deadline, session })
}

async function executeResume(options) {
  const repoRoot = await repositoryRoot(process.cwd())
  const runDir = ensureInsideRepository(repoRoot, options.positional, 'Run directory')
  const config = resolveConfig(await readJson(join(runDir, 'config.snapshot.json')))
  const state = recoverInterruptedState(await readJson(join(runDir, 'state.json')))
  const branch = await gitBranch(repoRoot)
  if (state.branch && branch !== state.branch) {
    throw new Error(`Run belongs to branch ${state.branch}, but the current branch is ${branch}`)
  }
  if (terminalStatus(state) === 'COMPLETE') return state
  state.status = 'RUNNING'
  state.sessions ??= []
  state.sessions.push({ startedAt: new Date().toISOString(), kind: 'resume' })
  const session = { calls: 0 }
  const deadline = Date.now() + config.execution.maxHours * 60 * 60_000

  if (isPlanningBootstrapState(state)) {
    const sourceDocument = await resolveExistingInsideRepository(repoRoot, state.sourceDocument, 'Source document')
    state.codexCalls += 1
    session.calls += 1
    state.events.push({
      at: new Date().toISOString(),
      type: 'planning_retried',
      message: 'Retrying the failed planning bootstrap with the current workflow schema.',
    })
    await saveState(runDir, state)
    let plan
    try {
      plan = await createPlan({ sourceDocument, repoRoot, runDir, config, deadline })
    } catch (error) {
      markAttemptFailed(state, 'T000', {
        model: config.models.planner.model,
        reason: error.message,
        terminal: true,
      })
      await saveState(runDir, state)
      console.log(renderReport(state))
      return state
    }

    const resumedState = createRunState({ sourceDocument: state.sourceDocument, plan })
    resumedState.baseCommit = state.baseCommit
    resumedState.branch = state.branch
    resumedState.codexCalls = state.codexCalls
    resumedState.sessions = state.sessions
    resumedState.events = [
      ...state.events,
      {
        at: new Date().toISOString(),
        type: 'planning_recovered',
        message: `Planning bootstrap recovered with ${plan.tasks.length} task(s).`,
      },
    ]
    await saveState(runDir, resumedState)
    return executeLoop({ state: resumedState, repoRoot, runDir, config, deadline, session })
  }

  await saveState(runDir, state)
  return executeLoop({ state, repoRoot, runDir, config, deadline, session })
}

async function executeLoop(context) {
  const { state, repoRoot, runDir, config, deadline, session } = context
  while (terminalStatus(state) === 'RUNNING') {
    if (remainingTime(deadline) === 0 || session.calls >= config.execution.maxCodexCalls) {
      state.status = 'BUDGET_EXHAUSTED'
      break
    }
    if (state.tasks.every((task) => task.status === 'completed')) break
    const task = nextRunnableTask(state)
    if (!task) {
      state.status = 'BLOCKED'
      state.events.push({
        at: new Date().toISOString(),
        type: 'dependency_deadlock',
        message: 'No runnable task remains, but the plan is incomplete. Check blocked or cyclic dependencies.',
      })
      break
    }
    await runTask({ task, ...context })
  }
  const allTasksComplete = state.tasks.every((task) => task.status === 'completed')
  if (allTasksComplete && state.status === 'RUNNING') await finalize(context)
  await saveState(runDir, state)
  console.log(renderReport(state))
  return state
}

async function showStatus(options) {
  const repoRoot = await repositoryRoot(process.cwd())
  const runDir = ensureInsideRepository(repoRoot, options.positional, 'Run directory')
  const state = await readJson(join(runDir, 'state.json'))
  console.log(renderReport(state))
  return state
}

async function main() {
  const options = parseOptions(process.argv.slice(2))
  if (options.command === 'help' || options.command === '--help' || !options.positional) {
    console.log(usage())
    return 0
  }
  const state = options.command === 'run'
    ? await executeNew(options)
    : options.command === 'resume'
      ? await executeResume(options)
      : options.command === 'status'
        ? await showStatus(options)
        : (() => { throw new Error(`Unknown command: ${options.command}`) })()
  const status = terminalStatus(state)
  return status === 'COMPLETE' || status === 'DRY_RUN' ? 0 : status === 'BUDGET_EXHAUSTED' ? 3 : 2
}

main()
  .then((code) => { process.exitCode = code })
  .catch((error) => {
    console.error(`auto-workflow failed: ${error.stack ?? error.message}`)
    process.exitCode = 1
  })
