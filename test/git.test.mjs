import assert from 'node:assert/strict'
import test from 'node:test'

import { gitInvariantViolation } from '../lib/git.mjs'

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
