import { terminalStatus } from './state.mjs'

export function renderReport(state) {
  const status = terminalStatus(state)
  const completed = state.tasks.filter((task) => task.status === 'completed')
  const blocked = state.tasks.filter((task) => task.status === 'blocked')
  const pending = state.tasks.filter((task) => task.status === 'pending' || task.status === 'running')
  const lines = [
    '# Overnight Workflow Report',
    '',
    `- Status: **${status}**`,
    `- Source: \`${state.sourceDocument}\``,
    `- Started: ${state.startedAt}`,
    `- Updated: ${state.updatedAt}`,
    `- Codex calls: ${state.codexCalls}`,
    `- Tasks: ${completed.length} completed / ${blocked.length} blocked / ${pending.length} pending`,
    '',
    '## Completed',
    '',
    ...(completed.length ? completed.map((task) => `- ${task.id} ${task.title}${task.commit ? ` (\`${task.commit.slice(0, 10)}\`)` : ''}`) : ['- None']),
    '',
    '## Blocked',
    '',
    ...(blocked.length
      ? blocked.map((task) => `- ${task.id} ${task.title}: ${task.attempts.at(-1)?.reason ?? 'unknown reason'}`)
      : ['- None']),
    '',
    '## Pending',
    '',
    ...(pending.length ? pending.map((task) => `- ${task.id} ${task.title}`) : ['- None']),
    '',
    '## Final gates',
    '',
    `- Verification: ${state.finalVerification?.status ?? 'not run'}`,
    `- Independent review: ${state.finalReview?.status ?? 'not run'}`,
  ]
  if (state.finalReview?.summary) lines.push(`- Review summary: ${state.finalReview.summary}`)
  if (state.finalReview?.blockers?.length) {
    lines.push('', '### Review blockers', '')
    lines.push(...state.finalReview.blockers.map((blocker) => `- ${blocker}`))
  }
  lines.push('')
  return lines.join('\n')
}
