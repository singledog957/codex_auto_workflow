import { spawn } from 'node:child_process'

function git(args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve(stdout.trim())
      else reject(new Error(`git ${args[0]} failed: ${stderr.trim()}`))
    })
  })
}

export function gitStatus(cwd) {
  return git(['status', '--porcelain=v1'], cwd)
}

export async function gitChangedFiles(cwd) {
  const [tracked, untracked] = await Promise.all([
    git(['diff', 'HEAD', '--name-only'], cwd),
    git(['ls-files', '--others', '--exclude-standard'], cwd),
  ])
  return [...new Set([...tracked.split('\n'), ...untracked.split('\n')].filter(Boolean))].sort()
}

export function gitHead(cwd) {
  return git(['rev-parse', 'HEAD'], cwd)
}

export function gitBranch(cwd) {
  return git(['branch', '--show-current'], cwd)
}

export function gitInvariantViolation(before, after) {
  if (before.branch !== after.branch) return 'Agent switched Git branches before controller verification.'
  if (before.head !== after.head) return 'Agent changed Git HEAD before controller verification.'
  return null
}

export async function commitCheckpoint(cwd, task) {
  await git(['add', '-A'], cwd)
  const staged = await git(['diff', '--cached', '--name-only'], cwd)
  if (!staged) return { commit: await gitHead(cwd), changed: false }
  const safeTitle = task.title.replace(/[\r\n]+/g, ' ').slice(0, 72)
  await git(['commit', '-m', `auto: complete ${task.id} ${safeTitle}`], cwd)
  return { commit: await gitHead(cwd), changed: true }
}
