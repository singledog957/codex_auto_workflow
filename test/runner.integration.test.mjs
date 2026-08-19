import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const runnerPath = join(dirname(dirname(fileURLToPath(import.meta.url))), 'runner.mjs')

function run(command, args, { cwd, env = process.env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('error', reject)
    child.on('close', (code) => resolve({ code, stdout, stderr }))
  })
}

test('completes planner, worker, fixed gates, commit, and final review with a fake Codex', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'auto-workflow-integration-'))
  const bin = join(repo, 'fake-bin')
  await mkdir(bin)
  await mkdir(join(repo, 'auto-workflow'))
  await writeFile(join(repo, '.gitignore'), 'auto-workflow/.runs/\nfake-bin/\n')
  await writeFile(join(repo, 'doc.md'), '# Tiny implementation\n\nCreate done.txt.\n')
  await writeFile(join(repo, 'config.json'), JSON.stringify({
    execution: {
      maxHours: 1,
      maxCodexCalls: 5,
      codexTimeoutMinutes: 1,
      verificationTimeoutMinutes: 1,
      checkpointEvery: 1,
    },
    verification: {
      profiles: { docs: ["node -e \"process.exit(0)\""] },
      checkpoint: ["node -e \"process.exit(0)\""],
      final: ["node -e \"process.exit(0)\""],
    },
  }))

  const fakeCodex = join(bin, 'codex')
  await writeFile(fakeCodex, `#!/usr/bin/env node
import { writeFile } from 'node:fs/promises'
import { basename } from 'node:path'
const args = process.argv.slice(2)
const valueAfter = (flag) => args[args.indexOf(flag) + 1]
const schema = args.includes('--output-schema') ? valueAfter('--output-schema') : null
const output = valueAfter('--output-last-message')
if (schema && basename(schema) === 'plan.schema.json') {
  await writeFile(output, JSON.stringify({outcome:'work_remaining',summary:'tiny',tasks:[{id:'T001',title:'create marker',objective:'Create done.txt.',acceptanceCriteria:['done.txt exists'],dependencies:[],verificationProfile:'docs',risk:'normal'}]}))
} else if (schema && basename(schema) === 'review.schema.json') {
  await writeFile(output, JSON.stringify({status:'approved',summary:'complete',blockers:[]}))
} else {
  await writeFile('done.txt', 'done\\n')
  await writeFile(output, 'implemented')
}
console.log(JSON.stringify({type:'turn.completed'}))
`)
  await chmod(fakeCodex, 0o755)

  await run('git', ['init', '-q'], { cwd: repo })
  await run('git', ['config', 'user.name', 'Workflow Test'], { cwd: repo })
  await run('git', ['config', 'user.email', 'workflow@example.test'], { cwd: repo })
  await run('git', ['add', '.'], { cwd: repo })
  await run('git', ['commit', '-qm', 'initial'], { cwd: repo })

  const result = await run(process.execPath, [
    runnerPath,
    'run',
    'doc.md',
    '--config',
    'config.json',
    '--run-dir',
    'auto-workflow/.runs/integration',
  ], {
    cwd: repo,
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
  })

  assert.equal(result.code, 0, result.stderr || result.stdout)
  const state = JSON.parse(await readFile(join(repo, 'auto-workflow/.runs/integration/state.json'), 'utf8'))
  assert.equal(state.status, 'COMPLETE')
  assert.equal(state.codexCalls, 3)
  assert.equal(await readFile(join(repo, 'done.txt'), 'utf8'), 'done\n')
  const log = await run('git', ['log', '--oneline', '-2'], { cwd: repo })
  assert.match(log.stdout, /auto: complete T001/)
})

test('resume can override the snapshot budget for one new session', async (t) => {
  const repo = await mkdtemp(join(tmpdir(), 'auto-workflow-resume-budget-'))
  const bin = join(repo, 'fake-bin')
  const runDirectory = 'auto-workflow/.runs/resume-budget'
  const runPath = join(repo, runDirectory)
  t.after(() => rm(repo, { recursive: true, force: true }))

  await mkdir(bin)
  await mkdir(runPath, { recursive: true })
  await writeFile(join(repo, '.gitignore'), 'auto-workflow/.runs/\nfake-bin/\n')
  await writeFile(join(repo, 'doc.md'), '# Resume budget test\n')
  await writeFile(join(runPath, 'config.snapshot.json'), JSON.stringify({
    execution: {
      maxHours: 1,
      maxCodexCalls: 1,
      codexTimeoutMinutes: 1,
      verificationTimeoutMinutes: 1,
    },
  }))
  await writeFile(join(runPath, 'state.json'), JSON.stringify({
    version: 1,
    sourceDocument: 'doc.md',
    planOutcome: 'work_remaining',
    planSummary: 'Exercise resume budgets.',
    status: 'BUDGET_EXHAUSTED',
    startedAt: '2026-08-16T00:00:00.000Z',
    updatedAt: '2026-08-16T00:00:00.000Z',
    codexCalls: 0,
    completedSinceCheckpoint: 0,
    tasks: [{
      id: 'T001',
      title: 'Fail twice',
      objective: 'Use both calls in the overridden session budget.',
      acceptanceCriteria: ['Two attempts are recorded.'],
      dependencies: [],
      verificationProfile: 'docs',
      risk: 'normal',
      status: 'pending',
      attempts: [],
      verification: null,
      commit: null,
    }],
    checkpointVerification: [],
    finalVerification: null,
    finalReview: null,
    events: [],
    sessions: [],
  }))

  const fakeCodex = join(bin, 'codex')
  await writeFile(fakeCodex, '#!/usr/bin/env bash\nexit 1\n')
  await chmod(fakeCodex, 0o755)
  await run('git', ['init', '-q'], { cwd: repo })
  await run('git', ['config', 'user.name', 'Workflow Test'], { cwd: repo })
  await run('git', ['config', 'user.email', 'workflow@example.test'], { cwd: repo })
  await run('git', ['add', '.'], { cwd: repo })
  await run('git', ['commit', '-qm', 'initial'], { cwd: repo })

  const result = await run(process.execPath, [
    runnerPath,
    'resume',
    runDirectory,
    '--max-hours',
    '12',
    '--max-codex-calls',
    '2',
  ], {
    cwd: repo,
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
  })

  assert.equal(result.code, 3, result.stderr || result.stdout)
  const state = JSON.parse(await readFile(join(runPath, 'state.json'), 'utf8'))
  assert.equal(state.status, 'BUDGET_EXHAUSTED')
  assert.equal(state.tasks[0].attempts.length, 2)
  assert.equal(state.codexCalls, 2)
  assert.deepEqual(state.sessions.at(-1).budget, { maxHours: 12, maxCodexCalls: 2 })
})

test('status exposes a dead controller instead of reporting a stale RUNNING state as healthy', async (t) => {
  const repo = await mkdtemp(join(tmpdir(), 'auto-workflow-status-offline-'))
  const runDirectory = 'auto-workflow/.runs/offline'
  const runPath = join(repo, runDirectory)
  t.after(() => rm(repo, { recursive: true, force: true }))

  await mkdir(runPath, { recursive: true })
  await writeFile(join(repo, '.gitignore'), 'auto-workflow/.runs/\n')
  await writeFile(join(runPath, 'state.json'), JSON.stringify({
    sourceDocument: 'doc.md',
    status: 'RUNNING',
    startedAt: '2026-08-19T00:00:00.000Z',
    updatedAt: '2026-08-19T01:00:00.000Z',
    codexCalls: 1,
    tasks: [{
      id: 'T001', title: 'unfinished', status: 'pending', attempts: [], dependencies: [],
    }],
    finalVerification: null,
    finalReview: null,
  }))
  await writeFile(join(runPath, 'supervisor.json'), JSON.stringify({
    status: 'stopped',
    message: 'restart limit reached',
  }))
  await run('git', ['init', '-q'], { cwd: repo })

  const result = await run(process.execPath, [runnerPath, 'status', runDirectory], { cwd: repo })

  assert.equal(result.code, 2, result.stderr || result.stdout)
  assert.match(result.stdout, /Controller: \*\*OFFLINE\*\*/)
  assert.match(result.stdout, /restart limit reached/)
})

test('checkpoint reviews are read-only and schedule bounded repair tasks instead of editing inline', async (t) => {
  const repo = await mkdtemp(join(tmpdir(), 'auto-workflow-checkpoint-'))
  const bin = join(repo, 'fake-bin')
  const runPath = join(repo, 'auto-workflow/.runs/checkpoint')
  t.after(() => rm(repo, { recursive: true, force: true }))

  await mkdir(bin)
  await mkdir(join(repo, 'auto-workflow'))
  await writeFile(join(repo, '.gitignore'), 'auto-workflow/.runs/\nfake-bin/\n')
  await writeFile(join(repo, 'doc.md'), '# Phase checkpoint\n')
  await writeFile(join(repo, 'config.json'), JSON.stringify({
    execution: {
      maxHours: 1,
      maxCodexCalls: 8,
      codexTimeoutMinutes: 1,
      verificationTimeoutMinutes: 1,
      checkpointEvery: 99,
      maxCheckpointReplans: 2,
    },
    verification: {
      profiles: { docs: ["node -e \"process.exit(0)\""] },
      checkpoint: ["node -e \"process.exit(0)\""],
      final: ["node -e \"process.exit(0)\""],
    },
  }))

  const fakeCodex = join(bin, 'codex')
  await writeFile(fakeCodex, `#!/usr/bin/env node
import { appendFile, readFile, writeFile } from 'node:fs/promises'
import { basename } from 'node:path'
const args = process.argv.slice(2)
const valueAfter = (flag) => args[args.indexOf(flag) + 1]
const schema = args.includes('--output-schema') ? valueAfter('--output-schema') : null
const output = valueAfter('--output-last-message')
let prompt = ''
for await (const chunk of process.stdin) prompt += chunk
await appendFile('fake-bin/invocations.log', JSON.stringify({schema:schema ? basename(schema) : null,sandbox:valueAfter('--sandbox'),checkpoint:/read-only checkpoint reviewer/i.test(prompt)}) + '\\n')
if (schema && basename(schema) === 'plan.schema.json') {
  await writeFile(output, JSON.stringify({outcome:'work_remaining',summary:'checkpoint',tasks:[{id:'T001',taskType:'checkpoint',maxFiles:1,title:'Checkpoint P1',objective:'Verify the phase.',acceptanceCriteria:['repair.txt exists'],dependencies:[],verificationProfile:'docs',risk:'high'}]}))
} else if (schema && basename(schema) === 'checkpoint.schema.json') {
  let count = 0
  try { count = Number(await readFile('fake-bin/checkpoint-count', 'utf8')) } catch {}
  await writeFile('fake-bin/checkpoint-count', String(count + 1))
  const review = count === 0
    ? {status:'gaps_found',summary:'marker missing',findings:[{title:'Create repair marker',objective:'Create repair.txt.',acceptanceCriteria:['repair.txt exists'],verificationProfile:'docs',risk:'normal',maxFiles:1}]}
    : {status:'approved',summary:'phase accepted',findings:[]}
  await writeFile(output, JSON.stringify(review))
} else if (schema && basename(schema) === 'review.schema.json') {
  await writeFile(output, JSON.stringify({status:'approved',summary:'complete',blockers:[]}))
} else {
  await writeFile('repair.txt', 'repaired\\n')
  await writeFile(output, 'implemented')
}
console.log(JSON.stringify({type:'turn.completed'}))
`)
  await chmod(fakeCodex, 0o755)

  await run('git', ['init', '-q'], { cwd: repo })
  await run('git', ['config', 'user.name', 'Workflow Test'], { cwd: repo })
  await run('git', ['config', 'user.email', 'workflow@example.test'], { cwd: repo })
  await run('git', ['add', '.'], { cwd: repo })
  await run('git', ['commit', '-qm', 'initial'], { cwd: repo })

  const result = await run(process.execPath, [
    runnerPath,
    'run',
    'doc.md',
    '--config',
    'config.json',
    '--run-dir',
    'auto-workflow/.runs/checkpoint',
  ], { cwd: repo, env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } })

  assert.equal(result.code, 0, result.stderr || result.stdout)
  const state = JSON.parse(await readFile(join(runPath, 'state.json'), 'utf8'))
  const checkpoint = state.tasks.find((task) => task.id === 'T001')
  const repair = state.tasks.find((task) => task.id === 'T002')
  assert.equal(state.status, 'COMPLETE')
  assert.equal(checkpoint.status, 'completed')
  assert.equal(checkpoint.checkpointReplans, 1)
  assert.equal(checkpoint.attempts[0].status, 'findings')
  assert.equal(repair.status, 'completed')
  assert.equal(await readFile(join(repo, 'repair.txt'), 'utf8'), 'repaired\n')

  const invocations = (await readFile(join(bin, 'invocations.log'), 'utf8'))
    .trim().split('\n').map((line) => JSON.parse(line))
  const checkpointCalls = invocations.filter((invocation) => invocation.checkpoint)
  assert.equal(checkpointCalls.length, 2)
  assert.ok(checkpointCalls.every((invocation) => invocation.sandbox === 'read-only'))
  const log = await run('git', ['log', '--oneline'], { cwd: repo })
  assert.match(log.stdout, /auto: complete T002/)
  assert.doesNotMatch(log.stdout, /auto: complete T001/)
})

test('dry-run preview emits the same task controls required from the real planner', async (t) => {
  const repo = await mkdtemp(join(tmpdir(), 'auto-workflow-dry-run-controls-'))
  t.after(() => rm(repo, { recursive: true, force: true }))
  await mkdir(join(repo, 'auto-workflow'))
  await writeFile(join(repo, 'doc.md'), '#### I-01: Small change\n')
  await writeFile(join(repo, 'config.json'), '{}\n')
  await run('git', ['init', '-q'], { cwd: repo })
  await run('git', ['config', 'user.name', 'Workflow Test'], { cwd: repo })
  await run('git', ['config', 'user.email', 'workflow@example.test'], { cwd: repo })
  await run('git', ['add', '.'], { cwd: repo })
  await run('git', ['commit', '-qm', 'initial'], { cwd: repo })

  const result = await run(process.execPath, [
    runnerPath,
    'run',
    'doc.md',
    '--config',
    'config.json',
    '--run-dir',
    'auto-workflow/.runs/dry-run-controls',
    '--dry-run',
  ], { cwd: repo })

  assert.equal(result.code, 0, result.stderr || result.stdout)
  const plan = JSON.parse(await readFile(
    join(repo, 'auto-workflow/.runs/dry-run-controls/plan.json'),
    'utf8',
  ))
  assert.equal(plan.tasks[0].taskType, 'implementation')
  assert.equal(plan.tasks[0].maxFiles, 5)
})
