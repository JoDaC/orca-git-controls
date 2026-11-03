// Starts the real worker against a fake `orca` and the stub Orca CLI.

import assert from 'node:assert/strict'
import activate, { deactivate } from '../../worker/main.mjs'
import { makeRepo } from './repo.mjs'
import { installOrcaStub } from './orca-stub.mjs'
import { fakeOrca } from './fake-orca.mjs'

export { deactivate }
export const stub = installOrcaStub()

export const DEFAULTS = { updateMethod: 'rebase', recentCount: 5, showTags: true, fetchOnOpen: false }
export const NO_WORKSPACE = /^No Git workspace is focused in Orca/
export const CTX = { displayName: 'demo', branch: 'main', terminals: [] }
export const orcaWorktree = (p, displayName = 'demo', branch = 'main') => ({ path: p, displayName, branch: `refs/heads/${branch}`, lastActivityAt: 1 })

export async function start({ repo, worktrees, context = CTX, ...fakeOpts } = {}) {
  const r = repo ?? (await makeRepo())
  stub.reset()
  stub.ok('worktree list', { worktrees: worktrees ?? [orcaWorktree(r.work)] })
  stub.ok('terminal list', { terminals: [] })
  const f = fakeOrca({ context, ...fakeOpts })
  await activate(f.orca)
  return { ...r, f }
}

export async function value(f, op, args) {
  const res = await f.git(op, args)
  assert.equal(res.ok, true, `${op}: ${JSON.stringify(res)}`)
  return res.value
}
