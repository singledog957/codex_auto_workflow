import assert from 'node:assert/strict'
import test from 'node:test'

import { reviewerPrompt } from '../lib/prompts.mjs'

test('baseline reviewer performs one bounded audit and classifies findings', () => {
  const prompt = reviewerPrompt({
    sourceDocument: 'doc/spec.md',
    statePath: '.runs/state.json',
    baseCommit: 'base123',
    reviewContext: {
      mode: 'baseline',
      round: 1,
      previousReviewedCommit: null,
      openFindings: [],
    },
  })

  assert.match(prompt, /baseline review/i)
  assert.match(prompt, /one bounded pass/i)
  assert.match(prompt, /Critical/i)
  assert.match(prompt, /Required/i)
  assert.match(prompt, /Advisory/i)
  assert.match(prompt, /do not reserve known blockers for later/i)
})

test('closure reviewer is confined to known findings and the repair diff', () => {
  const prompt = reviewerPrompt({
    sourceDocument: 'doc/spec.md',
    statePath: '.runs/state.json',
    baseCommit: 'base123',
    reviewContext: {
      mode: 'closure',
      round: 2,
      previousReviewedCommit: 'reviewed123',
      repairFiles: ['src/recovery.mjs', 'test/recovery.test.mjs'],
      openFindings: [{
        id: 'FR-001',
        severity: 'required',
        title: 'Missing recovery test',
        evidence: 'Recovery is not covered.',
        files: ['src/recovery.mjs'],
        requiredOutcome: 'Cover recovery.',
      }],
    },
  })

  assert.match(prompt, /closure review/i)
  assert.match(prompt, /reviewed123\.\.HEAD/)
  assert.match(prompt, /FR-001/)
  assert.match(prompt, /Do not re-audit the whole branch/i)
  assert.match(prompt, /new Critical/i)
  assert.match(prompt, /repair regression/i)
  assert.match(prompt, /Controller-derived repair diff files:[\s\S]*src\/recovery\.mjs/)
  assert.match(prompt, /approve/i)
})
