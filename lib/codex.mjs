import { spawn } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'

export function buildCodexArgs({
  cwd,
  model,
  reasoningEffort,
  sandbox,
  outputSchema,
  outputLastMessage,
}) {
  const args = [
    'exec',
    '--json',
    '--ephemeral',
    '--ignore-user-config',
    '--strict-config',
    '--color',
    'never',
    '--model',
    model,
    '--config',
    `model_reasoning_effort="${reasoningEffort}"`,
    '--config',
    'approval_policy="never"',
    '--sandbox',
    sandbox,
    '--cd',
    cwd,
  ]
  if (outputSchema) args.push('--output-schema', outputSchema)
  if (outputLastMessage) args.push('--output-last-message', outputLastMessage)
  args.push('-')
  return args
}

export async function runCodex({ prompt, logPath, timeoutMs, ...options }) {
  await mkdir(dirname(logPath), { recursive: true, mode: 0o700 })
  const args = buildCodexArgs(options)
  return new Promise((resolve) => {
    const log = createWriteStream(logPath, { flags: 'a', mode: 0o600 })
    const stderrLogPath = `${logPath}.stderr.log`
    const stderrLog = createWriteStream(stderrLogPath, { flags: 'a', mode: 0o600 })
    const child = spawn('codex', args, {
      cwd: options.cwd,
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stderrTail = ''
    const appendTail = (chunk) => {
      stderrTail = `${stderrTail}${chunk}`.slice(-12000)
    }
    child.stdout.pipe(log, { end: false })
    child.stderr.on('data', (chunk) => {
      stderrLog.write(chunk)
      appendTail(chunk.toString())
    })
    child.stdin.end(prompt)

    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGTERM')
      setTimeout(() => child.kill('SIGKILL'), 5000).unref()
    }, timeoutMs)

    let settled = false
    const finish = async (result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      await Promise.all([
        new Promise((done) => log.end(done)),
        new Promise((done) => stderrLog.end(done)),
      ])
      resolve({ ...result, stderrTail, stderrLogPath })
    }
    child.on('error', (error) => {
      void finish({ ok: false, exitCode: null, timedOut, error: error.message })
    })
    child.on('close', (exitCode, signal) => {
      void finish({ ok: exitCode === 0 && !timedOut, exitCode, signal, timedOut })
    })
  })
}
