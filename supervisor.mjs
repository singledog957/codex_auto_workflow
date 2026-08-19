#!/usr/bin/env node

import { spawn } from 'node:child_process'
import { basename, dirname, join, resolve } from 'node:path'
import process from 'node:process'

import { readJson, writeJsonAtomic } from './lib/files.mjs'
import { resumeArguments, systemdRunArguments } from './lib/supervision.mjs'
import { terminalStatus } from './lib/state.mjs'

const workflowRoot = dirname(new URL(import.meta.url).pathname)
const runnerPath = join(workflowRoot, 'runner.mjs')
const serviceEntryPath = join(workflowRoot, 'service-entry.mjs')

function runDirectoryFrom(arguments_) {
  if (arguments_[0] === 'resume') return arguments_[1]
  if (arguments_[0] !== 'run') throw new Error('Supervisor supports only run and resume commands')
  const index = arguments_.indexOf('--run-dir')
  if (index === -1 || !arguments_[index + 1]) throw new Error('Supervised runs require --run-dir')
  return arguments_[index + 1]
}

function positiveInteger(value, fallback) {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback
}

function safeUnitPart(value) {
  return value.replace(/[^A-Za-z0-9_.-]/g, '-').slice(0, 100)
}

function sleep(milliseconds) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds))
}

async function readWorkflowState(statePath) {
  try {
    return await readJson(statePath)
  } catch {
    return null
  }
}

async function main() {
  const originalArguments = process.argv.slice(2)
  const runDirectory = runDirectoryFrom(originalArguments)
  const repoRoot = process.cwd()
  const runPath = resolve(repoRoot, runDirectory)
  const statePath = join(runPath, 'state.json')
  const supervisorPath = join(runPath, 'supervisor.json')
  const runId = safeUnitPart(basename(runPath))
  const maxRestarts = positiveInteger(process.env.AUTO_WORKFLOW_MAX_RESTARTS, 3)
  const restartDelayMs = positiveInteger(process.env.AUTO_WORKFLOW_RESTART_DELAY_MS, 5_000)
  const memoryMax = process.env.AUTO_WORKFLOW_MEMORY_MAX || '60%'
  let runnerArguments = originalArguments
  let activeUnit = null
  let stoppingSignal = null

  const saveSupervisor = (value) => writeJsonAtomic(supervisorPath, {
    pid: process.pid,
    updatedAt: new Date().toISOString(),
    ...value,
  })

  const requestStop = (signal) => {
    if (stoppingSignal) return
    stoppingSignal = signal
    if (activeUnit) {
      spawn('systemctl', ['--user', 'stop', `${activeUnit}.service`], {
        stdio: 'ignore',
        detached: true,
      }).unref()
    }
  }
  process.on('SIGINT', () => requestStop('SIGINT'))
  process.on('SIGTERM', () => requestStop('SIGTERM'))

  for (let restart = 0; restart <= maxRestarts; restart += 1) {
    activeUnit = safeUnitPart(`auto-workflow-${runId}-${process.pid}-${restart}`)
    await saveSupervisor({
      status: 'running',
      unit: `${activeUnit}.service`,
      restarts: restart,
      message: restart === 0 ? 'Controller started.' : `Controller restarted after failure (${restart}/${maxRestarts}).`,
    })
    const result = await new Promise((resolveExit) => {
      const child = spawn('systemd-run', systemdRunArguments({
        unit: activeUnit,
        cwd: repoRoot,
        serviceEntryPath,
        runnerPath,
        runnerArguments,
        memoryMax,
      }), { stdio: ['pipe', 'inherit', 'inherit'] })
      child.stdin.on('error', () => {})
      child.stdin.end(JSON.stringify(process.env))
      child.on('error', (error) => resolveExit({ code: null, signal: null, error: error.message }))
      child.on('close', (code, signal) => resolveExit({ code, signal, error: null }))
    })
    activeUnit = null

    if (stoppingSignal) {
      await saveSupervisor({
        status: 'stopped',
        restarts: restart,
        lastExit: result,
        message: `Supervisor stopped by ${stoppingSignal}.`,
      })
      return 130
    }

    const workflowState = await readWorkflowState(statePath)
    const status = workflowState ? terminalStatus(workflowState) : 'RUNNING'
    if (status !== 'RUNNING') {
      await saveSupervisor({
        status: 'stopped',
        restarts: restart,
        lastExit: result,
        message: `Workflow reached ${status}.`,
      })
      return result.code ?? 1
    }

    if (restart === maxRestarts) {
      await saveSupervisor({
        status: 'stopped',
        restarts: restart,
        lastExit: result,
        message: `Controller is still RUNNING in persisted state after ${maxRestarts} automatic restart(s); manual diagnosis is required.`,
      })
      return 1
    }

    await saveSupervisor({
      status: 'restarting',
      restarts: restart,
      lastExit: result,
      message: `Controller exited unexpectedly (${result.code ?? result.signal ?? result.error}); resuming in ${restartDelayMs} ms.`,
    })
    await sleep(restartDelayMs)
    if (stoppingSignal) {
      await saveSupervisor({
        status: 'stopped',
        restarts: restart,
        lastExit: result,
        message: `Supervisor stopped by ${stoppingSignal}.`,
      })
      return 130
    }
    runnerArguments = resumeArguments(originalArguments, runDirectory)
  }
  return 1
}

main()
  .then((code) => { process.exitCode = code })
  .catch(async (error) => {
    console.error(`auto-workflow supervisor failed: ${error.stack ?? error.message}`)
    process.exitCode = 1
  })
