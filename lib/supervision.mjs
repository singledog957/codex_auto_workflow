import { spawn } from 'node:child_process'

export function systemdRunArguments({
  unit,
  cwd,
  serviceEntryPath,
  runnerPath,
  runnerArguments,
  memoryMax = '60%',
}) {
  return [
    '--user',
    '--wait',
    '--pipe',
    '--quiet',
    '--collect',
    `--unit=${unit}`,
    '--service-type=exec',
    '--property=KillMode=control-group',
    '--property=OOMPolicy=stop',
    `--property=MemoryMax=${memoryMax}`,
    `--property=MemorySwapMax=${memoryMax}`,
    `--working-directory=${cwd}`,
    process.execPath,
    serviceEntryPath,
    runnerPath,
    ...runnerArguments,
  ]
}

export function resumeArguments(originalArguments, runDirectory) {
  if (originalArguments[0] !== 'resume') return ['resume', runDirectory]
  const budgetArguments = []
  for (let index = 2; index < originalArguments.length; index += 1) {
    const argument = originalArguments[index]
    if (argument !== '--max-hours' && argument !== '--max-codex-calls') continue
    budgetArguments.push(argument, originalArguments[index + 1])
    index += 1
  }
  return ['resume', runDirectory, ...budgetArguments]
}

export function controllerHealth({ workflowStatus, supervisor, tmuxAlive }) {
  if (workflowStatus !== 'RUNNING') {
    return { status: 'STOPPED', message: `Workflow is ${workflowStatus}.` }
  }
  if (tmuxAlive === false) {
    return {
      status: 'OFFLINE',
      message: supervisor?.message ?? 'The persisted state is RUNNING, but its tmux supervisor is not alive.',
    }
  }
  if (supervisor?.status === 'stopped') {
    return { status: 'OFFLINE', message: supervisor.message ?? 'The workflow supervisor stopped.' }
  }
  if (supervisor?.status === 'running' || supervisor?.status === 'restarting' || tmuxAlive === true) {
    return { status: 'ONLINE', message: supervisor?.message ?? 'The workflow supervisor is alive.' }
  }
  return {
    status: 'UNKNOWN',
    message: 'No supervisor liveness record is available for this legacy run.',
  }
}

export function processExit(command, arguments_, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, arguments_, options)
    child.on('error', (error) => resolve({ code: null, signal: null, error: error.message }))
    child.on('close', (code, signal) => resolve({ code, signal, error: null }))
  })
}
