import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { spawn } from 'node:child_process'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  controllerHealth,
  resumeArguments,
  systemdRunArguments,
} from '../lib/supervision.mjs'

const supervisorPath = join(dirname(dirname(fileURLToPath(import.meta.url))), 'supervisor.mjs')
const serviceEntryPath = join(dirname(dirname(fileURLToPath(import.meta.url))), 'service-entry.mjs')

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

test('runs each controller attempt in a bounded systemd service cgroup', () => {
  const args = systemdRunArguments({
    unit: 'auto-workflow-example-1',
    cwd: '/tmp/example',
    serviceEntryPath: '/tmp/example/auto-workflow/service-entry.mjs',
    runnerPath: '/tmp/example/auto-workflow/runner.mjs',
    runnerArguments: ['resume', 'auto-workflow/.runs/example'],
    memoryMax: '60%',
  })

  assert.deepEqual(args.slice(0, 5), [
    '--user',
    '--wait',
    '--pipe',
    '--quiet',
    '--collect',
  ])
  assert.ok(args.includes('--service-type=exec'))
  assert.ok(args.includes('--property=KillMode=control-group'))
  assert.ok(args.includes('--property=OOMPolicy=stop'))
  assert.ok(args.includes('--property=MemoryMax=60%'))
  assert.ok(args.includes('--property=MemorySwapMax=60%'))
  assert.deepEqual(args.slice(-5), [
    process.execPath,
    '/tmp/example/auto-workflow/service-entry.mjs',
    '/tmp/example/auto-workflow/runner.mjs',
    'resume',
    'auto-workflow/.runs/example',
  ])
})

test('service entry restores the caller environment from stdin without command-line secrets', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'auto-workflow-service-entry-'))
  const runner = join(directory, 'runner.mjs')
  t.after(() => rm(directory, { recursive: true, force: true }))
  await writeFile(runner, "console.log(process.env.WORKFLOW_TEST_SECRET)\n")

  const child = spawn(process.execPath, [serviceEntryPath, runner], {
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk) => { stdout += chunk })
  child.stderr.on('data', (chunk) => { stderr += chunk })
  child.stdin.end(JSON.stringify({ WORKFLOW_TEST_SECRET: 'available-only-via-stdin' }))
  const code = await new Promise((resolve) => child.on('close', resolve))

  assert.equal(code, 0, stderr)
  assert.equal(stdout, 'available-only-via-stdin\n')
})

test('automatic recovery resumes the same run and preserves explicit session budgets', () => {
  assert.deepEqual(resumeArguments([
    'resume',
    'auto-workflow/.runs/example',
    '--max-hours',
    '12',
    '--max-codex-calls',
    '100',
  ], 'auto-workflow/.runs/example'), [
    'resume',
    'auto-workflow/.runs/example',
    '--max-hours',
    '12',
    '--max-codex-calls',
    '100',
  ])
  assert.deepEqual(
    resumeArguments(['run', 'doc.md', '--run-dir', 'auto-workflow/.runs/example'], 'auto-workflow/.runs/example'),
    ['resume', 'auto-workflow/.runs/example'],
  )
})

test('reports a persisted RUNNING state with a stopped supervisor as offline', () => {
  assert.deepEqual(controllerHealth({
    workflowStatus: 'RUNNING',
    supervisor: { status: 'stopped', message: 'restart limit reached' },
  }), {
    status: 'OFFLINE',
    message: 'restart limit reached',
  })
})

test('supervisor resumes a RUNNING state after its contained controller is killed', async (t) => {
  const repo = await mkdtemp(join(tmpdir(), 'auto-workflow-supervisor-'))
  const bin = join(repo, 'fake-bin')
  const runDirectory = 'auto-workflow/.runs/recovery'
  const runPath = join(repo, runDirectory)
  const statePath = join(runPath, 'state.json')
  const invocationsPath = join(repo, 'systemd-run-invocations')
  t.after(() => rm(repo, { recursive: true, force: true }))

  await mkdir(bin)
  await mkdir(runPath, { recursive: true })
  await writeFile(statePath, JSON.stringify({
    status: 'RUNNING',
    tasks: [{ id: 'T001', status: 'pending', dependencies: [] }],
    finalVerification: null,
    finalReview: null,
  }))
  const fakeSystemdRun = join(bin, 'systemd-run')
  await writeFile(fakeSystemdRun, `#!/usr/bin/env bash
set -euo pipefail
count=0
if [[ -f $FAKE_INVOCATIONS ]]; then count=$(cat "$FAKE_INVOCATIONS"); fi
count=$((count + 1))
echo "$count" > "$FAKE_INVOCATIONS"
if [[ $count -eq 1 ]]; then exit 137; fi
node -e "const fs=require('fs'); const p=process.env.FAKE_STATE; const s=JSON.parse(fs.readFileSync(p)); s.status='RUNNING'; s.tasks[0].status='completed'; s.finalVerification={status:'passed'}; s.finalReview={status:'approved',blockers:[]}; fs.writeFileSync(p, JSON.stringify(s));"
`)
  await chmod(fakeSystemdRun, 0o755)

  const result = await run(process.execPath, [supervisorPath, 'resume', runDirectory], {
    cwd: repo,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      AUTO_WORKFLOW_RESTART_DELAY_MS: '0',
      FAKE_INVOCATIONS: invocationsPath,
      FAKE_STATE: statePath,
    },
  })

  assert.equal(result.code, 0, result.stderr || result.stdout)
  assert.equal(await readFile(invocationsPath, 'utf8'), '2\n')
  const supervisor = JSON.parse(await readFile(join(runPath, 'supervisor.json'), 'utf8'))
  assert.equal(supervisor.status, 'stopped')
  assert.equal(supervisor.restarts, 1)
  assert.match(supervisor.message, /COMPLETE/)
})
