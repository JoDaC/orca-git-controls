import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as g from '../lib/git.mjs'
import { makeRepo, cloneOf, sh, write, commitFile, sleep, waitFor } from './helpers/repo.mjs'
import { start, value, deactivate, NO_WORKSPACE, CTX, orcaWorktree } from './helpers/worker.mjs'

afterEach(() => deactivate())

test('mutating ops and outside changes post git.changed once, 400 ms after the last change', async () => {
  const { work, f } = await start()
  await sleep(700)
  await value(f, 'snapshot')
  f.clear()

  const t0 = Date.now()
  await value(f, 'createBranch', { name: 'b1', checkout: false })
  assert.equal(f.postsOf('git.changed').length, 0)
  const [changed] = await waitFor(() => f.postsOf('git.changed').length && f.postsOf('git.changed'))
  assert.ok(changed.at - t0 >= 400, `${changed.at - t0} ms`)
  assert.deepEqual(changed.payload, { fingerprint: await g.fingerprint(work), path: work })
  await sleep(600)
  assert.equal(f.postsOf('git.changed').length, 1)

  f.clear()
  await sh(work, 'branch', 'outside')
  const [outside] = await waitFor(() => f.postsOf('git.changed').length && f.postsOf('git.changed'))
  assert.equal(outside.payload.fingerprint, await g.fingerprint(work))

  // Reads leave the fingerprint alone, so nothing is posted.
  await sleep(600)
  f.clear()
  await value(f, 'status')
  await value(f, 'log')
  await sleep(700)
  assert.equal(f.postsOf('git.changed').length, 0)
})

test('workspace.changed re-resolves and posts only when the path changes', async () => {
  const second = await makeRepo()
  const first = await makeRepo()
  const { f } = await start({ repo: first, worktrees: [orcaWorktree(first.work), orcaWorktree(second.work, 'second')] })
  await f.emit('workspace.changed', { context: CTX })
  assert.equal(f.postsOf('workspace.changed').length, 0)

  await f.emit('workspace.changed', { context: { displayName: 'second', branch: 'main', terminals: [] } })
  assert.deepEqual(f.postsOf('workspace.changed').map((p) => p.payload), [{ path: second.work }])
  assert.equal((await value(f, 'snapshot')).workspace.path, second.work)

  // The watcher follows the new workspace.
  await sleep(700)
  f.clear()
  await sh(second.work, 'branch', 'outside')
  const [changed] = await waitFor(() => f.postsOf('git.changed').length && f.postsOf('git.changed'))
  assert.equal(changed.payload.path, second.work)

  await f.emit('workspace.changed', {})
  assert.deepEqual(f.postsOf('workspace.changed').at(-1).payload, { path: null })
})

test('the worker registers every manifest command that has no declarative action', async () => {
  const { f } = await start()
  const manifest = JSON.parse(readFileSync(fileURLToPath(new URL('../orca-plugin.json', import.meta.url)), 'utf8'))
  const expected = manifest.contributes.commands.filter((c) => !c.action).map((c) => c.id)
  assert.deepEqual([...f.commands.keys()].sort(), expected.sort())
  for (const c of manifest.contributes.commands.filter((c) => c.action)) assert.equal(f.commands.has(c.id), false)
})

test('direct palette commands run git and notify the result', async () => {
  const { work, origin, f } = await start()
  const other = await cloneOf(origin)
  await commitFile(other, 'r.txt', 'r\n')
  await sh(other, 'push', '-q', 'origin', 'main')

  assert.match(await f.run('git.fetch'), /origin\/main|Fetched all remotes/)
  assert.equal(f.notes.at(-1).title, 'Fetch')
  await f.run('git.pull')
  assert.equal(f.notes.at(-1).title, 'Pull')
  assert.ok(existsSync(path.join(work, 'r.txt')))
  await f.run('git.updateProject')
  assert.equal(f.notes.at(-1).title, 'Update Project')

  await commitFile(work, 'l.txt', 'l\n')
  await f.run('git.push')
  assert.equal(f.notes.at(-1).title, 'Push')
  assert.equal(await sh(origin, 'rev-parse', 'main'), await sh(work, 'rev-parse', 'HEAD'))

  write(work, 'a.txt', 'wip\n')
  await f.run('git.stash')
  assert.deepEqual(f.notes.at(-1).title, 'Stash Changes')
  assert.match((await g.stashList(work))[0].subject, /Stashed from Orca Git Controls$/)
  await f.run('git.unstash')
  assert.equal(f.notes.at(-1).title, 'Unstash Changes')
  assert.equal(readFileSync(path.join(work, 'a.txt'), 'utf8'), 'wip\n')
  assert.equal((await g.stashList(work)).length, 0)
  assert.equal(f.postsOf('ui.intent').length, 0)
})

test('a palette result that needs a decision is handed to the panel; failures notify', async () => {
  const { work, f } = await start()
  await sh(work, 'commit', '-q', '--amend', '-m', 'rewritten')
  assert.equal(await f.run('git.push'), 'rejected')
  const [intent] = f.postsOf('ui.intent')
  assert.equal(intent.payload.kind, 'result')
  assert.equal(intent.payload.title, 'Push')
  assert.equal(intent.payload.op, 'push')
  assert.equal(intent.payload.value.status, 'rejected')
  assert.deepEqual(f.notes.at(-1), { title: 'Push: action needed', body: 'Open Git Controls in the right sidebar to continue.' })
  assert.deepEqual((await value(f, 'snapshot')).intent, intent.payload)
  assert.equal((await value(f, 'snapshot')).intent, null)

  await sh(work, 'checkout', '-q', '--detach')
  const msg = await f.run('git.updateProject')
  assert.match(msg, /HEAD is detached/)
  assert.deepEqual(f.notes.at(-1), { title: 'Update Project failed', body: msg })
})

test('intent commands post a dialog intent that the next snapshot hands over once', async () => {
  const { f } = await start()
  const dialogs = {
    'git.branches': 'branches',
    'git.vcsPopup': 'vcs',
    'git.newBranch': 'newBranch',
    'git.newTag': 'newTag',
    'git.merge': 'merge',
    'git.rebase': 'rebase',
    'git.reset': 'reset',
    'git.checkoutRevision': 'checkoutRevision',
    'git.newWorktree': 'newWorktree',
    'git.worktrees': 'worktrees',
    'git.log': 'log',
    'git.patchCreate': 'patchCreate',
    'git.patchApply': 'patchApply',
    'git.stashes': 'stashes',
    'git.rollback': 'rollback',
    'git.fileHistory': 'fileHistory',
    'git.blame': 'blame',
    'git.rollbackFile': 'rollbackFile',
    'git.commitDialog': 'commit'
  }
  for (const [id, dialog] of Object.entries(dialogs)) {
    f.clear()
    assert.equal(await f.run(id), 'Continue in the Git Controls panel')
    assert.deepEqual(f.postsOf('ui.intent').map((p) => p.payload), [{ kind: 'dialog', dialog }])
    assert.deepEqual(f.notes, [{ title: 'Git Controls', body: 'Open Git Controls in the right sidebar to continue.' }])
  }
  assert.deepEqual((await value(f, 'snapshot')).intent, { kind: 'dialog', dialog: 'commit' })
  assert.equal((await value(f, 'snapshot')).intent, null)
})

test('palette commands without a workspace notify the failure', async () => {
  const { f } = await start({ context: null, worktrees: [] })
  assert.match(await f.run('git.fetch'), NO_WORKSPACE)
  assert.equal(f.notes.at(-1).title, 'Fetch failed')
})

test('deactivate stops change detection', async () => {
  const { work, f } = await start()
  await sleep(700)
  f.clear()
  deactivate()
  await sh(work, 'branch', 'after-deactivate')
  await value(f, 'createBranch', { name: 'b', checkout: false })
  await sleep(700)
  assert.equal(f.postsOf('git.changed').length, 0)
})
