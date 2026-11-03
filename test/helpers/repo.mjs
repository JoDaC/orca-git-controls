// Throwaway repositories under one $TMPDIR directory per test file.

import { mkdtempSync, writeFileSync, rmSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import * as g from '../../lib/git.mjs'

const ENV = {
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1'
}
Object.assign(process.env, ENV)

const tmp = realpathSync(tmpdir())
export const root = realpathSync(mkdtempSync(path.join(tmp, 'orca-git-controls-test-')))
process.on('exit', () => {
  if (root.startsWith(tmp)) rmSync(root, { recursive: true, force: true })
})

let n = 0
export const fresh = (name = 'd') => path.join(root, `${name}${++n}`)

export async function sh(cwd, ...args) {
  return (await g.git(cwd, args)).stdout.trim()
}
export async function shAllowFail(cwd, ...args) {
  return g.git(cwd, args, { allowFail: true })
}
export function write(dir, file, text) {
  writeFileSync(path.join(dir, file), text)
}
export async function commitFile(dir, file, text, msg = `edit ${file}`) {
  write(dir, file, text)
  await sh(dir, 'add', file)
  await sh(dir, 'commit', '-q', '-m', msg)
}

/** A bare "origin" and a clone ("work") with main pushed and tracking origin/main. */
export async function makeRepo() {
  const base = fresh('r')
  const origin = `${base}-origin.git`
  const work = `${base}-work`
  await g.git(root, ['init', '-q', '--bare', '-b', 'main', origin])
  await g.git(root, ['init', '-q', '-b', 'main', work])
  await sh(work, 'remote', 'add', 'origin', origin)
  await commitFile(work, 'a.txt', 'one\n', 'initial')
  await sh(work, 'push', '-q', '-u', 'origin', 'main')
  return { origin, work }
}

/** A second clone of `origin`, for making remote-side changes. */
export async function cloneOf(origin) {
  const dir = fresh('other')
  await g.git(root, ['clone', '-q', origin, dir])
  return dir
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export async function waitFor(fn, { timeoutMs = 5000, stepMs = 25 } = {}) {
  const end = Date.now() + timeoutMs
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() > end) throw new Error('waitFor timed out')
    await sleep(stepMs)
  }
}
