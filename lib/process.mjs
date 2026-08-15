import { spawn } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'

function stopProcessGroup(child, signal) {
  if (!child.pid) return
  try {
    process.kill(-child.pid, signal)
  } catch {
    child.kill(signal)
  }
}

export async function runCommand({ command, cwd, timeoutMs, logPath }) {
  await mkdir(dirname(logPath), { recursive: true, mode: 0o700 })
  return new Promise((resolve) => {
    const log = createWriteStream(logPath, { flags: 'a', mode: 0o600 })
    log.write(`\n$ ${command}\n`)
    const child = spawn('/bin/bash', ['-lc', command], {
      cwd,
      env: process.env,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let tail = ''
    const capture = (chunk) => {
      log.write(chunk)
      tail = `${tail}${chunk}`.slice(-16000)
    }
    child.stdout.on('data', capture)
    child.stderr.on('data', capture)

    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      stopProcessGroup(child, 'SIGTERM')
      setTimeout(() => stopProcessGroup(child, 'SIGKILL'), 1000).unref()
    }, timeoutMs)

    child.on('error', (error) => {
      clearTimeout(timer)
      log.end(`\n[spawn error] ${error.message}\n`)
      resolve({ ok: false, exitCode: null, timedOut, error: error.message, tail })
    })
    child.on('close', (exitCode, signal) => {
      clearTimeout(timer)
      log.end(`\n[exit ${exitCode ?? signal}]\n`)
      resolve({ ok: exitCode === 0 && !timedOut, exitCode, signal, timedOut, tail })
    })
  })
}

export async function runCommands({ commands, cwd, timeoutMs, logPath }) {
  const results = []
  for (const command of commands) {
    const result = await runCommand({ command, cwd, timeoutMs, logPath })
    results.push({ command, ...result })
    if (!result.ok) return { ok: false, failedCommand: command, results }
  }
  return { ok: true, failedCommand: null, results }
}
