import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

export async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'))
}

export async function writeJsonAtomic(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.tmp-${process.pid}`
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  await rename(temporary, path)
}

export async function writeText(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  await writeFile(path, value, { encoding: 'utf8', mode: 0o600 })
}
