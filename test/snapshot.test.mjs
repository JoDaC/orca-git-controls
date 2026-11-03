import { test } from 'node:test'
import assert from 'node:assert/strict'
import { realpathSync } from 'node:fs'
import * as g from '../lib/git.mjs'
import { buildSnapshot } from '../lib/snapshot.mjs'
import { makeRepo, cloneOf, sh, shAllowFail, write, commitFile, fresh } from './helpers/repo.mjs'

const names = (items) => items.map((b) => b.name)

test('snapshot shape: current branch, changes, refs grouped, favorites, recent, ahead/behind, worktree badge', async () => {
  const { work, origin } = await makeRepo()
  for (const b of ['dev', 'zeta', 'feature/a', 'feature/b']) await sh(work, 'branch', b)
  await sh(work, 'push', '-q', 'origin', 'feature/a')
  const other = await cloneOf(origin)
  await commitFile(other, 'o.txt', 'o\n', 'remote commit')
  await sh(other, 'push', '-q', 'origin', 'main')
  await commitFile(work, 'l.txt', 'l\n', 'local commit')
  await sh(work, 'fetch', '-q', 'origin')
  const wt = fresh('wt')
  await sh(work, 'worktree', 'add', '-q', wt, 'zeta')
  for (const b of ['dev', 'feature/a', 'main']) await sh(work, 'checkout', '-q', b)
  write(work, 'a.txt', 'dirty\n')
  write(work, 'new.txt', 'untracked\n')

  const snap = await buildSnapshot(work, { recentCount: 2, favorites: ['zeta', 'feature/b', 'deleted-branch'] })

  assert.equal(snap.current, 'main')
  assert.equal(snap.detached, false)
  assert.equal(snap.head, await sh(work, 'rev-parse', 'HEAD'))
  assert.equal(snap.state, 'clean')
  assert.equal(snap.info.toplevel, work)
  assert.equal(snap.fingerprint, await g.fingerprint(work))
  assert.deepEqual(snap.changes, { total: 2, tracked: 1, untracked: 1 })
  assert.deepEqual(snap.remotes, ['origin'])

  // Favorites float to the top of their folder; unknown favorites are dropped from the list.
  assert.deepEqual(names(snap.local.items), ['zeta', 'dev', 'main'])
  assert.deepEqual(snap.local.folders.map((f) => f.name), ['feature'])
  assert.deepEqual(names(snap.local.folders[0].items), ['feature/b', 'feature/a'])
  assert.deepEqual(snap.favorites.sort(), ['feature/b', 'zeta'])

  assert.deepEqual(names(snap.recent), ['main', 'feature/a'])
  assert.equal(snap.recent[1].favorite, false)

  const main = snap.local.items.find((b) => b.name === 'main')
  assert.equal(main.current, true)
  assert.equal(main.ahead, 1)
  assert.equal(main.behind, 1)
  assert.equal(main.favorite, false)
  const zeta = snap.local.items.find((b) => b.name === 'zeta')
  assert.equal(zeta.checkedOutElsewhere, true)
  assert.equal(zeta.worktreePath, realpathSync(wt))
  assert.equal(zeta.favorite, true)

  assert.equal(snap.remote.length, 1)
  assert.equal(snap.remote[0].remote, 'origin')
  assert.deepEqual(names(snap.remote[0].tree.items), ['origin/main'])
  assert.deepEqual(names(snap.remote[0].tree.folders[0].items), ['origin/feature/a'])
  assert.equal(snap.remote[0].tree.items[0].favorite, false)
})

test('favorites default to main; recentCount defaults to 5', async () => {
  const { work } = await makeRepo()
  for (const b of ['a', 'b', 'c', 'd', 'e', 'f']) {
    await sh(work, 'branch', b)
    await sh(work, 'checkout', '-q', b)
  }
  const snap = await buildSnapshot(work)
  assert.deepEqual(snap.favorites, ['main'])
  assert.equal(snap.local.items[0].name, 'main')
  assert.equal(snap.recent.length, 5)
})

test('tags sort newest first, annotated and lightweight alike', async () => {
  const { work } = await makeRepo()
  await sh(work, 'tag', 'old')
  process.env.GIT_COMMITTER_DATE = '2030-01-01T00:00:00Z'
  try {
    await sh(work, 'tag', '-a', 'newer', '-m', 'annotated')
  } finally {
    delete process.env.GIT_COMMITTER_DATE
  }
  const snap = await buildSnapshot(work)
  assert.deepEqual(names(snap.tags), ['newer', 'old'])
  assert.ok(snap.tags[0].date > snap.tags[1].date)
})

test('snapshot reports an in-progress merge and a detached HEAD', async () => {
  const { work } = await makeRepo()
  await sh(work, 'checkout', '-q', '-b', 'x')
  await commitFile(work, 'a.txt', 'x\n')
  await sh(work, 'checkout', '-q', 'main')
  await commitFile(work, 'a.txt', 'main\n')
  await shAllowFail(work, 'merge', 'x')
  let snap = await buildSnapshot(work)
  assert.equal(snap.state, 'merging')
  assert.equal(snap.changes.tracked, 1)
  await sh(work, 'merge', '--abort')

  await sh(work, 'checkout', '-q', '--detach', 'HEAD~1')
  snap = await buildSnapshot(work)
  assert.equal(snap.current, null)
  assert.equal(snap.detached, true)
  assert.ok(snap.local.items.every((b) => !b.current))
})
