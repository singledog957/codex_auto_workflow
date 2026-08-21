import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'

import { gitFilesBetween, gitInvariantViolation, gitWorktreeFingerprint } from '../lib/git.mjs'

const exec = promisify(execFile)

test('detects an agent changing HEAD or switching branches before verification', () => {
  assert.equal(
    gitInvariantViolation(
      { head: 'aaa', branch: 'auto/run' },
      { head: 'bbb', branch: 'auto/run' },
    ),
    'Agent changed Git HEAD before controller verification.',
  )
  assert.equal(
    gitInvariantViolation(
      { head: 'aaa', branch: 'auto/run' },
      { head: 'aaa', branch: 'other' },
    ),
    'Agent switched Git branches before controller verification.',
  )
  assert.equal(
    gitInvariantViolation(
      { head: 'aaa', branch: 'auto/run' },
      { head: 'aaa', branch: 'auto/run' },
    ),
    null,
  )
})

test('worktree fingerprint changes when the contents of an already-dirty file change', async (t) => {
  const repo = await mkdtemp(join(tmpdir(), 'auto-workflow-git-fingerprint-'))
  t.after(() => rm(repo, { recursive: true, force: true }))
  await exec('git', ['init', '-q'], { cwd: repo })
  await exec('git', ['config', 'user.name', 'Workflow Test'], { cwd: repo })
  await exec('git', ['config', 'user.email', 'workflow@example.test'], { cwd: repo })
  await writeFile(join(repo, 'tracked.txt'), 'initial\n')
  await exec('git', ['add', 'tracked.txt'], { cwd: repo })
  await exec('git', ['commit', '-qm', 'initial'], { cwd: repo })
  await writeFile(join(repo, 'tracked.txt'), 'first dirty value\n')
  const before = await gitWorktreeFingerprint(repo)

  await writeFile(join(repo, 'tracked.txt'), 'second dirty value\n')
  const after = await gitWorktreeFingerprint(repo)

  assert.notEqual(after, before)
})

test('lists only files changed between final review commits', async (t) => {
  const repo = await mkdtemp(join(tmpdir(), 'auto-workflow-git-review-diff-'))
  t.after(() => rm(repo, { recursive: true, force: true }))
  await exec('git', ['init', '-q'], { cwd: repo })
  await exec('git', ['config', 'user.name', 'Workflow Test'], { cwd: repo })
  await exec('git', ['config', 'user.email', 'workflow@example.test'], { cwd: repo })
  await writeFile(join(repo, 'baseline.txt'), 'baseline\n')
  await exec('git', ['add', '.'], { cwd: repo })
  await exec('git', ['commit', '-qm', 'baseline'], { cwd: repo })
  const baseline = (await exec('git', ['rev-parse', 'HEAD'], { cwd: repo })).stdout.trim()
  await writeFile(join(repo, 'repair.txt'), 'repair\n')
  await exec('git', ['add', '.'], { cwd: repo })
  await exec('git', ['commit', '-qm', 'repair'], { cwd: repo })
  const repaired = (await exec('git', ['rev-parse', 'HEAD'], { cwd: repo })).stdout.trim()

  assert.deepEqual(await gitFilesBetween(repo, baseline, repaired), ['repair.txt'])
})
