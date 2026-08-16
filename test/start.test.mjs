import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const workflowRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const startScript = join(workflowRoot, 'start.sh')

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

async function executable(path, contents) {
  await writeFile(path, contents)
  await chmod(path, 0o755)
}

test('starts a detached workflow in a named tmux session', async (t) => {
  const repo = await mkdtemp(join(tmpdir(), 'auto-workflow-start-'))
  const bin = join(repo, 'fake-bin')
  const capture = join(repo, 'tmux-args.txt')
  let worktreePath = null

  t.after(async () => {
    if (worktreePath) await run('git', ['worktree', 'remove', '--force', worktreePath], { cwd: repo })
    await rm(repo, { recursive: true, force: true })
  })

  await mkdir(join(repo, 'auto-workflow'), { recursive: true })
  await mkdir(join(repo, 'backend/node_modules'), { recursive: true })
  await mkdir(join(repo, 'frontend/node_modules'), { recursive: true })
  await mkdir(bin)
  await copyFile(startScript, join(repo, 'auto-workflow/start.sh'))
  await chmod(join(repo, 'auto-workflow/start.sh'), 0o755)
  await writeFile(join(repo, '.gitignore'), 'node_modules/\nfake-bin/\n')
  await writeFile(join(repo, 'backend/.gitkeep'), '')
  await writeFile(join(repo, 'frontend/.gitkeep'), '')
  await writeFile(join(repo, 'doc.md'), '# Test workflow\n')
  await executable(join(bin, 'codex'), '#!/usr/bin/env bash\nexit 0\n')
  await executable(join(bin, 'node'), '#!/usr/bin/env bash\nexit 0\n')
  await executable(join(bin, 'tmux'), `#!/usr/bin/env bash
printf '%s\\n' "$@" > "$TMUX_CAPTURE"
`)

  await run('git', ['init', '-q'], { cwd: repo })
  await run('git', ['config', 'user.name', 'Workflow Test'], { cwd: repo })
  await run('git', ['config', 'user.email', 'workflow@example.test'], { cwd: repo })
  await run('git', ['add', '.'], { cwd: repo })
  await run('git', ['commit', '-qm', 'initial'], { cwd: repo })

  const result = await run('/bin/bash', ['auto-workflow/start.sh', 'doc.md'], {
    cwd: repo,
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, TMUX_CAPTURE: capture },
  })

  assert.equal(result.code, 0, result.stderr || result.stdout)
  const worktreeMatch = result.stdout.match(/^Worktree:\s+(.+)$/m)
  const runDataMatch = result.stdout.match(/^Run data:\s+(.+)$/m)
  assert.ok(worktreeMatch, result.stdout)
  assert.ok(runDataMatch, result.stdout)
  worktreePath = worktreeMatch[1]

  const runId = runDataMatch[1].split('/').at(-1)
  const sessionName = `auto-workflow-${runId}`
  const tmuxArgs = (await readFile(capture, 'utf8')).trim().split('\n')
  assert.deepEqual(tmuxArgs.slice(0, 6), [
    'new-session',
    '-d',
    '-s',
    sessionName,
    '-c',
    worktreePath,
  ])
  assert.match(tmuxArgs[6], /runner\.mjs run doc\.md/)
  assert.match(tmuxArgs[6], /operator\.log/)
  assert.equal(await readFile(join(runDataMatch[1], 'tmux-session'), 'utf8'), `${sessionName}\n`)
  assert.match(result.stdout, new RegExp(`tmux attach-session -t '${sessionName}'`))
})
