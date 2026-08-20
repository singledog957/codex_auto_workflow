const DEFAULT_CONFIG = Object.freeze({
  models: {
    planner: { model: 'gpt-5.6-sol', reasoningEffort: 'high' },
    attempts: [
      { model: 'gpt-5.6-luna', reasoningEffort: 'medium' },
      { model: 'gpt-5.6-luna', reasoningEffort: 'medium' },
      { model: 'gpt-5.6-terra', reasoningEffort: 'high' },
      { model: 'gpt-5.6-sol', reasoningEffort: 'high' },
    ],
    highRiskAttempts: [
      { model: 'gpt-5.6-sol', reasoningEffort: 'high' },
      { model: 'gpt-5.6-sol', reasoningEffort: 'high' },
    ],
    reviewer: { model: 'gpt-5.6-sol', reasoningEffort: 'high' },
  },
  execution: {
    sandbox: 'workspace-write',
    allowDangerFullAccess: false,
    maxHours: 8,
    maxCodexCalls: 30,
    codexTimeoutMinutes: 90,
    verificationTimeoutMinutes: 30,
    checkpointEvery: 3,
    maxCheckpointReplans: 2,
    requireCleanTree: true,
    autoCommit: true,
  },
  verification: {
    profiles: {},
    checkpoint: [],
    final: [],
  },
})

const PROFILE_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isCommandList(value) {
  return Array.isArray(value)
    && value.length > 0
    && value.every((command) => typeof command === 'string' && command.trim().length > 0)
}

function isOptionalCommandList(value) {
  return Array.isArray(value)
    && value.every((command) => typeof command === 'string' && command.trim().length > 0)
}

function merge(base, override) {
  if (!isPlainObject(base) || !isPlainObject(override)) return structuredClone(override)
  const result = structuredClone(base)
  for (const [key, value] of Object.entries(override)) {
    result[key] = key in result ? merge(result[key], value) : structuredClone(value)
  }
  return result
}

function assertModelEntry(entry, label) {
  if (!isPlainObject(entry) || typeof entry.model !== 'string' || entry.model.length === 0) {
    throw new Error(`${label} must define a model`)
  }
  if (!['low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(entry.reasoningEffort)) {
    throw new Error(`${label} has an invalid reasoning effort`)
  }
}

export function resolveConfig(userConfig = {}) {
  const config = merge(DEFAULT_CONFIG, userConfig)
  assertModelEntry(config.models.planner, 'planner')
  assertModelEntry(config.models.reviewer, 'reviewer')
  if (!Array.isArray(config.models.attempts) || config.models.attempts.length === 0) {
    throw new Error('models.attempts must contain at least one bounded attempt')
  }
  config.models.attempts.forEach((entry, index) => assertModelEntry(entry, `attempt ${index + 1}`))
  if (!Array.isArray(config.models.highRiskAttempts) || config.models.highRiskAttempts.length === 0) {
    throw new Error('models.highRiskAttempts must contain at least one bounded attempt')
  }
  config.models.highRiskAttempts.forEach((entry, index) => assertModelEntry(entry, `high-risk attempt ${index + 1}`))

  if (!['workspace-write', 'danger-full-access'].includes(config.execution.sandbox)) {
    throw new Error('execution.sandbox must be workspace-write or danger-full-access')
  }
  if (config.execution.sandbox === 'danger-full-access' && config.execution.allowDangerFullAccess !== true) {
    throw new Error('danger-full-access requires execution.allowDangerFullAccess=true')
  }
  for (const key of ['maxHours', 'maxCodexCalls', 'codexTimeoutMinutes', 'verificationTimeoutMinutes']) {
    if (!Number.isFinite(config.execution[key]) || config.execution[key] <= 0) {
      throw new Error(`execution.${key} must be a positive number`)
    }
  }
  if (!Number.isInteger(config.execution.maxCheckpointReplans)
    || config.execution.maxCheckpointReplans < 0) {
    throw new Error('execution.maxCheckpointReplans must be a non-negative integer')
  }
  if (!isPlainObject(config.verification.profiles)) {
    throw new Error('verification.profiles must be an object')
  }
  for (const [name, commands] of Object.entries(config.verification.profiles)) {
    if (!PROFILE_NAME.test(name)) {
      throw new Error(`Invalid verification profile name: ${name}`)
    }
    if (!isCommandList(commands)) {
      throw new Error(`verification profile ${name} must contain commands`)
    }
  }
  for (const gate of ['checkpoint', 'final']) {
    if (!isOptionalCommandList(config.verification[gate])) {
      throw new Error(`verification.${gate} must be a command list when provided`)
    }
  }
  return config
}

export function resolveUserConfig(userConfig) {
  const verification = userConfig?.verification
  const profiles = verification?.profiles
  if (!isPlainObject(profiles)) {
    throw new Error('User config must define verification.profiles')
  }

  if (Object.keys(profiles).length === 0) {
    throw new Error('User config must define at least one verification profile')
  }
  return resolveConfig(userConfig)
}

export function inspectionSandbox(config) {
  return config.execution.sandbox === 'danger-full-access' ? 'danger-full-access' : 'read-only'
}

export function modelForAttempt(config, attemptIndex) {
  return config.models.attempts[attemptIndex] ?? null
}

export function modelForTaskAttempt(config, task, attemptIndex) {
  const route = task.risk === 'high' ? config.models.highRiskAttempts : config.models.attempts
  return route[attemptIndex] ?? null
}

export function verificationCommands(config, profile) {
  const commands = config.verification.profiles[profile]
  if (!commands) throw new Error(`Unknown verification profile: ${profile}`)
  return [...commands]
}

export function defaultConfig() {
  return structuredClone(DEFAULT_CONFIG)
}
