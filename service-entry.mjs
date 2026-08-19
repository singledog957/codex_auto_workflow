#!/usr/bin/env node

import { spawn } from 'node:child_process'
import process from 'node:process'

async function readEnvironment() {
  let input = ''
  for await (const chunk of process.stdin) {
    input += chunk
    if (input.length > 1_000_000) throw new Error('Serialized workflow environment is too large')
  }
  const parsed = JSON.parse(input)
  if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') {
    throw new Error('Workflow environment must be a JSON object')
  }
  for (const [key, value] of Object.entries(parsed)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof value !== 'string') {
      throw new Error(`Invalid workflow environment entry: ${key}`)
    }
  }
  return parsed
}

async function main() {
  const [runnerPath, ...runnerArguments] = process.argv.slice(2)
  if (!runnerPath) throw new Error('Runner path is required')
  const environment = await readEnvironment()
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [runnerPath, ...runnerArguments], {
      env: environment,
      stdio: ['ignore', 'inherit', 'inherit'],
    })
    const forwardInterrupt = () => child.kill('SIGINT')
    const forwardTermination = () => child.kill('SIGTERM')
    process.on('SIGINT', forwardInterrupt)
    process.on('SIGTERM', forwardTermination)
    child.on('error', reject)
    child.on('close', (code, signal) => {
      process.off('SIGINT', forwardInterrupt)
      process.off('SIGTERM', forwardTermination)
      resolve(code ?? (signal ? 1 : 0))
    })
  })
}

main()
  .then((code) => { process.exitCode = code })
  .catch((error) => {
    console.error(`auto-workflow service entry failed: ${error.stack ?? error.message}`)
    process.exitCode = 1
  })
