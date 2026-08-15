export function plannerPrompt({ sourceDocument, verificationProfiles }) {
  return `You are the planning controller for an unattended repository implementation run.

Read ${sourceDocument} and inspect the current repository. Determine what is already truly implemented from code and tests; do not trust unchecked or checked boxes alone. Produce a dependency-ordered JSON plan containing only remaining work.

Rules:
- Do not edit any file. This is a read-only planning pass.
- Split work into focused tasks that normally touch no more than five files. Split large I-xx items further.
- Each task must have specific acceptance criteria and explicit dependencies.
- Use risk "high" for migrations, concurrency, authorization, secrets, irreversible compatibility, or public contracts; otherwise use "normal".
- verificationProfile must be exactly one of: ${verificationProfiles.join(', ')}.
- Choose backend/frontend/docs when isolated; use full for cross-stack or architectural slices.
- Never propose push, merge, deploy, production data access, secret rotation, test deletion, skipped tests, or weakened assertions.
- The final plan must cover the source document's remaining Definition of Done, not merely its next phase.
- If the document is already fully implemented, return an empty tasks array; the controller will still run final gates and review.
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
Attempt: ${attemptNumber}
${failure}
Constraints:
- Inspect existing code and follow repository conventions.
- Write or update automated tests for changed behavior before/with implementation.
- Keep scope limited to this task. Do not implement later tasks.
- You may run focused checks, but the external controller will independently run authoritative verification.
- Do not mark the source document complete, commit, push, merge, deploy, access production, delete tests, use skip, weaken assertions, or expose secrets.
- If the task is already implemented, verify that with existing code/tests and make no gratuitous edits.
- Finish with a concise summary of changed files and checks you ran.`
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
