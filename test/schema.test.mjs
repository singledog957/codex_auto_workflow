import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const workflowRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const forbiddenKeywords = new Set([
  '$schema',
  'uniqueItems',
  'minLength',
  'maxLength',
  'allOf',
  'not',
  'dependentRequired',
  'dependentSchemas',
  'if',
  'then',
  'else',
])

function inspectSchema(node, path = '$') {
  if (!node || typeof node !== 'object') return []
  const findings = []
  for (const [key, value] of Object.entries(node)) {
    if (forbiddenKeywords.has(key)) findings.push(`${path}.${key}`)
    findings.push(...inspectSchema(value, `${path}.${key}`))
  }
  if (node.type === 'object') {
    assert.equal(node.additionalProperties, false, `${path} must set additionalProperties=false`)
    assert.deepEqual(
      [...(node.required ?? [])].sort(),
      Object.keys(node.properties ?? {}).sort(),
      `${path} must require every property`,
    )
  }
  return findings
}

for (const filename of ['plan.schema.json', 'review.schema.json']) {
  test(`${filename} stays inside the strict Structured Outputs subset`, async () => {
    const schema = JSON.parse(await readFile(join(workflowRoot, 'schemas', filename), 'utf8'))
    assert.deepEqual(inspectSchema(schema), [])
  })
}
