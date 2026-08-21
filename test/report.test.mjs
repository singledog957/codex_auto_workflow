import assert from 'node:assert/strict'
import test from 'node:test'

import { renderReport } from '../lib/report.mjs'

test('reports the final review round, mode, stable blockers, and advisories', () => {
  const report = renderReport({
    sourceDocument: 'doc/spec.md',
    status: 'BLOCKED',
    startedAt: '2026-08-21T00:00:00.000Z',
    updatedAt: '2026-08-21T01:00:00.000Z',
    codexCalls: 3,
    tasks: [],
    finalVerification: { status: 'passed' },
    finalReview: {
      status: 'rejected',
      mode: 'closure',
      round: 2,
      summary: 'One registered blocker remains.',
      blockers: ['FR-001 [required] Missing recovery proof: Add the proof.'],
      advisories: ['Simplify the helper in a separate change.'],
    },
  })

  assert.match(report, /Independent review: rejected \(closure round 2\)/)
  assert.match(report, /FR-001 \[required\]/)
  assert.match(report, /Review advisories/)
  assert.match(report, /Simplify the helper/)
})
