export function plannerPrompt({ sourceDocument, verificationProfiles }) {
  return `You are the planning controller for an unattended repository implementation run.

Read ${sourceDocument} and inspect the current repository. Determine what is already truly implemented from code and tests; do not trust unchecked or checked boxes alone. Produce a dependency-ordered JSON plan containing only remaining work.

Rules:
- Do not edit any file. This is a read-only planning pass.
- Split work into focused tasks that normally touch no more than five files. Split large I-xx items further.
- Set taskType to implementation for code/docs changes and checkpoint only for read-only phase acceptance.
- Set maxFiles from 1 to 5 as a hard per-task file budget. Split work instead of exceeding it.
- A checkpoint must only verify and record already-implemented outcomes. Never put implementation work in checkpoint acceptance criteria.
- Each task must have specific acceptance criteria and explicit dependencies.
- Use risk "high" for migrations, concurrency, authorization, secrets, irreversible compatibility, or public contracts; otherwise use "normal".
- verificationProfile must be exactly one of: ${verificationProfiles.join(', ')}.
- Choose backend/frontend/docs when isolated; use full for cross-stack or architectural slices.
- Never propose push, merge, deploy, production data access, secret rotation, test deletion, skipped tests, or weakened assertions.
- The final plan must cover the source document's remaining Definition of Done, not merely its next phase.
- Set outcome to work_remaining and return at least one task when work remains.
- Set outcome to already_complete and return an empty tasks array only after repository inspection proves the document is fully implemented.
- Set outcome to blocked with an empty tasks array if repository or document inspection cannot be completed. Never represent an inspection failure as already_complete.
- Return only data matching the supplied JSON schema.`
}

export function workerPrompt({ sourceDocument, task, attemptNumber, previousFailure }) {
  const failure = previousFailure
    ? `\nPrevious independent verification failed. Fix the root cause shown below; do not suppress or skip the check.\n---\n${previousFailure.slice(-12000)}\n---\n`
    : ''
  return `Implement exactly one bounded task from ${sourceDocument} in the current repository.

Task: ${task.id} — ${task.title}
Objective: ${task.objective}
Acceptance criteria:
${task.acceptanceCriteria.map((item) => `- ${item}`).join('\n')}
Dependencies already completed: ${task.dependencies.join(', ') || 'none'}
Risk: ${task.risk}
Hard file budget: ${task.maxFiles ?? 'legacy task; keep changes focused'}
Attempt: ${attemptNumber}
${failure}
Constraints:
- Inspect existing code and follow repository conventions.
- Write or update automated tests for changed behavior before/with implementation.
- Keep scope limited to this task. Do not implement later tasks.
- Do not perform a broad phase review or fix newly noticed out-of-scope defects. Report them in the final summary only.
- If a numeric hard file budget is shown, never modify more files than that budget; stop and report a blocker instead.
- You may run focused checks, but the external controller will independently run authoritative verification.
- Do not mark the source document complete, commit, push, merge, deploy, access production, delete tests, use skip, weaken assertions, or expose secrets.
- If the task is already implemented, verify that with existing code/tests and make no gratuitous edits.
- Finish with a concise summary of changed files and checks you ran.`
}

export function checkpointPrompt({ sourceDocument, task, verificationEvidence }) {
  return `Act as a read-only checkpoint reviewer for one bounded phase gate in ${sourceDocument}.

Checkpoint: ${task.id} — ${task.title}
Objective: ${task.objective}
Acceptance criteria:
${task.acceptanceCriteria.map((item) => `- ${item}`).join('\n')}
Completed dependencies: ${task.dependencies.join(', ') || 'none'}

Controller verification evidence:
---
${verificationEvidence}
---

Rules:
- Do not edit, create, delete, rename, format, or commit any file.
- Inspect only enough code, tests, durable evidence, and Git history to decide these acceptance criteria.
- Do not run broad test suites; the controller already owns deterministic verification.
- Approve only when every criterion is already satisfied and controller verification passed.
- If a material acceptance blocker exists, return gaps_found and one focused repair task per independent gap.
- Each repair task must be implementable within its maxFiles budget of one to five files. Split larger gaps.
- Do not include cosmetic preferences, unrelated improvements, or later-phase work.
- Never repair a finding inline. The controller will schedule findings before retrying this checkpoint.
- Return only data matching the supplied JSON schema.`
}

export function reviewerPrompt({ sourceDocument, statePath, baseCommit }) {
  return `Act as an independent, read-only final reviewer for an unattended implementation run.

Review the current repository against:
- source specification: ${sourceDocument}
- durable run state and task evidence: ${statePath}
- branch changes since base commit: ${baseCommit}

The controller already ran deterministic final gates. Inspect code, tests, git history/diff, and the specification. Do not edit files. Approve only if the remaining requested scope is implemented coherently and no material correctness, security, migration, concurrency, recovery, or test-quality blocker remains. Cosmetic preferences are not blockers.

Return only data matching the supplied JSON schema. If rejected, give concrete blocker descriptions with file paths and required outcomes.`
}
