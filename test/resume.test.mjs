import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const workflowRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const resumeScript = join(workflowRoot, 'resume.sh')

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

test('resumes an interrupted workflow in its named tmux session', async (t) => {
  const repo = await mkdtemp(join(tmpdir(), 'auto-workflow-resume-'))
  const runDirectory = 'auto-workflow/.runs/20260815T185628Z'
  const runPath = join(repo, runDirectory)
  const nestedDirectory = join(repo, 'nested')
  const bin = join(repo, 'fake-bin')
  const capture = join(repo, 'tmux-args.txt')
  t.after(() => rm(repo, { recursive: true, force: true }))

  await mkdir(join(repo, 'auto-workflow'), { recursive: true })
  await mkdir(runPath, { recursive: true })
  await mkdir(nestedDirectory)
  await mkdir(bin)
  await copyFile(resumeScript, join(repo, 'auto-workflow/resume.sh'))
  await chmod(join(repo, 'auto-workflow/resume.sh'), 0o755)
  await writeFile(join(repo, 'auto-workflow/runner.mjs'), '')
  await writeFile(join(runPath, 'state.json'), '{}\n')
  await writeFile(join(runPath, 'config.snapshot.json'), '{}\n')
  await executable(join(bin, 'node'), '#!/usr/bin/env bash\nexit 0\n')
  await executable(join(bin, 'tmux'), `#!/usr/bin/env bash
if [[ $1 == has-session ]]; then
  exit 1
fi
printf '%s\\n' "$@" > "$TMUX_CAPTURE"
`)

  await run('git', ['init', '-q'], { cwd: repo })
  const result = await run('/bin/bash', [
    '../auto-workflow/resume.sh',
    runDirectory,
    '--max-hours',
    '12',
    '--max-codex-calls',
    '100',
  ], {
    cwd: nestedDirectory,
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, TMUX_CAPTURE: capture },
  })

  assert.equal(result.code, 0, result.stderr || result.stdout)
  const sessionName = 'auto-workflow-20260815T185628Z'
  const tmuxArgs = (await readFile(capture, 'utf8')).trim().split('\n')
  assert.deepEqual(tmuxArgs.slice(0, 6), [
    'new-session',
    '-d',
    '-s',
    sessionName,
    '-c',
    repo,
  ])
  assert.match(tmuxArgs[6], new RegExp(`${repo}/auto-workflow/runner\\.mjs resume ${runDirectory}`))
  assert.match(tmuxArgs[6], /--max-hours 12 --max-codex-calls 100/)
  assert.match(tmuxArgs[6], /operator\.log/)
  assert.equal(await readFile(join(runPath, 'tmux-session'), 'utf8'), `${sessionName}\n`)
  assert.match(result.stdout, new RegExp(`tmux attach-session -t '${sessionName}'`))
})
