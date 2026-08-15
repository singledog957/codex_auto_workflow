import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
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
