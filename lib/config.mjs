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
    profiles: {
      backend: [
        'npm --prefix backend run typecheck',
        'npm --prefix backend test',
      ],
      frontend: [
        'npm --prefix frontend test',
        'npm --prefix frontend run build',
      ],
      full: [
        'npm --prefix backend run typecheck',
        'npm --prefix backend test',
        'npm --prefix frontend test',
      ],
      docs: ['git diff --check'],
    },
    checkpoint: [
      'npm run lint',
      'npm run build',
      'npm --prefix backend test',
      'npm --prefix frontend test',
      'git diff --check',
    ],
    final: [
      'npm run lint',
      'npm --prefix backend run typecheck',
      'npm run build',
      'npm --prefix backend test',
      'npm --prefix frontend test',
      'git diff --check',
    ],
  },
})

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
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
    if (!Array.isArray(commands) || commands.length === 0 || commands.some((command) => typeof command !== 'string')) {
      throw new Error(`verification profile ${name} must contain commands`)
    }
  }
  return config
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
