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

async function createRepository(t, prefix, { dangerFullAccess = false, fakeCodex }) {
  const repo = await mkdtemp(join(tmpdir(), prefix))
  const bin = join(repo, 'fake-bin')
  t.after(() => rm(repo, { recursive: true, force: true }))
  await mkdir(bin)
  await mkdir(join(repo, 'auto-workflow'))
  await writeFile(join(repo, '.gitignore'), 'auto-workflow/.runs/\nfake-bin/\n')
  await writeFile(join(repo, 'doc.md'), '# Boundary test\n')
  await writeFile(join(repo, 'config.json'), JSON.stringify({
    execution: {
      sandbox: dangerFullAccess ? 'danger-full-access' : 'workspace-write',
      allowDangerFullAccess: dangerFullAccess,
      maxHours: 1,
      maxCodexCalls: 4,
      codexTimeoutMinutes: 1,
      verificationTimeoutMinutes: 1,
      checkpointEvery: 99,
    },
    verification: {
      profiles: { docs: ["node -e \"process.exit(0)\""] },
      checkpoint: ["node -e \"process.exit(0)\""],
      final: ["node -e \"process.exit(0)\""],
    },
  }))
  const executable = join(bin, 'codex')
  await writeFile(executable, fakeCodex)
  await chmod(executable, 0o755)
  await run('git', ['init', '-q'], { cwd: repo })
  await run('git', ['config', 'user.name', 'Workflow Test'], { cwd: repo })
  await run('git', ['config', 'user.email', 'workflow@example.test'], { cwd: repo })
  await run('git', ['add', '.'], { cwd: repo })
  await run('git', ['commit', '-qm', 'initial'], { cwd: repo })
  return { repo, bin }
}

async function execute(repo, bin, runName) {
  return run(process.execPath, [
    runnerPath,
    'run',
    'doc.md',
    '--config',
    'config.json',
    '--run-dir',
    `auto-workflow/.runs/${runName}`,
  ], { cwd: repo, env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } })
}

test('blocks and does not commit an implementation task that exceeds its hard file budget', async (t) => {
  const { repo, bin } = await createRepository(t, 'auto-workflow-file-budget-', {
    fakeCodex: `#!/usr/bin/env node
import { writeFile } from 'node:fs/promises'
import { basename } from 'node:path'
const args = process.argv.slice(2)
const valueAfter = (flag) => args[args.indexOf(flag) + 1]
const schema = args.includes('--output-schema') ? valueAfter('--output-schema') : null
const output = valueAfter('--output-last-message')
if (schema && basename(schema) === 'plan.schema.json') {
  await writeFile(output, JSON.stringify({outcome:'work_remaining',summary:'budget',tasks:[{id:'T001',taskType:'implementation',maxFiles:1,title:'bounded change',objective:'Create one marker.',acceptanceCriteria:['one marker exists'],dependencies:[],verificationProfile:'docs',risk:'normal'}]}))
} else {
  await writeFile('one.txt', 'one\\n')
  await writeFile('two.txt', 'two\\n')
  await writeFile(output, 'implemented')
}
console.log(JSON.stringify({type:'turn.completed'}))
`,
  })

  const result = await execute(repo, bin, 'file-budget')

  assert.equal(result.code, 2, result.stderr || result.stdout)
  const state = JSON.parse(await readFile(join(repo, 'auto-workflow/.runs/file-budget/state.json'), 'utf8'))
  assert.equal(state.status, 'BLOCKED')
  assert.match(state.tasks[0].attempts.at(-1).reason, /hard file budget exceeded/i)
  const commitCount = await run('git', ['rev-list', '--count', 'HEAD'], { cwd: repo })
  assert.equal(commitCount.stdout.trim(), '1')
})

test('blocks a checkpoint that writes to the worktree under danger-full-access', async (t) => {
  const { repo, bin } = await createRepository(t, 'auto-workflow-checkpoint-write-', {
    dangerFullAccess: true,
    fakeCodex: `#!/usr/bin/env node
import { writeFile } from 'node:fs/promises'
import { basename } from 'node:path'
const args = process.argv.slice(2)
const valueAfter = (flag) => args[args.indexOf(flag) + 1]
const schema = args.includes('--output-schema') ? valueAfter('--output-schema') : null
const output = valueAfter('--output-last-message')
if (schema && basename(schema) === 'plan.schema.json') {
  await writeFile(output, JSON.stringify({outcome:'work_remaining',summary:'checkpoint',tasks:[{id:'T001',taskType:'checkpoint',maxFiles:1,title:'Checkpoint P1',objective:'Review only.',acceptanceCriteria:['repository is unchanged'],dependencies:[],verificationProfile:'docs',risk:'high'}]}))
} else if (schema && basename(schema) === 'checkpoint.schema.json') {
  await writeFile('forbidden.txt', 'mutation\\n')
  await writeFile(output, JSON.stringify({status:'approved',summary:'approved',findings:[]}))
}
console.log(JSON.stringify({type:'turn.completed'}))
`,
  })

  const result = await execute(repo, bin, 'checkpoint-write')

  assert.equal(result.code, 2, result.stderr || result.stdout)
  const state = JSON.parse(await readFile(join(repo, 'auto-workflow/.runs/checkpoint-write/state.json'), 'utf8'))
  assert.equal(state.status, 'BLOCKED')
  assert.match(state.tasks[0].attempts.at(-1).reason, /modified the Git worktree/i)
  const commitCount = await run('git', ['rev-list', '--count', 'HEAD'], { cwd: repo })
  assert.equal(commitCount.stdout.trim(), '1')
})
