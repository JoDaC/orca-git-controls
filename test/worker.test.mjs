import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, realpathSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import * as g from '../lib/git.mjs'
import { makeRepo, cloneOf, sh, write, commitFile, fresh } from './helpers/repo.mjs'
import { stub, start, value, deactivate, DEFAULTS, NO_WORKSPACE, CTX, orcaWorktree } from './helpers/worker.mjs'

afterEach(() => deactivate())

test('without a focused repo, only the workspace and settings ops run', async () => {
  const { f } = await start({ context: null, worktrees: [] })
  const snap = await value(f, 'snapshot')
  assert.deepEqual(snap, {
    workspace: { path: null, override: false, reason: 'no-focused-workspace', candidates: [], context: null, worktrees: [] },
    settings: DEFAULTS,
    intent: null,
    repo: null
  })
  for (const op of ['status', 'fingerprint', 'checkout', 'favorite.toggle', 'worktrees', 'newWorktree']) {
    const res = await f.git(op, {})
    assert.equal(res.ok, false)
    assert.match(res.error, NO_WORKSPACE)
  }
  assert.deepEqual(await f.git('bogus'), { ok: false, error: 'Unknown operation: bogus' })
  assert.equal((await value(f, 'workspace.refresh')).workspace.path, null)
  assert.equal((await value(f, 'workspace.select', { path: null })).repo, null)
  assert.equal((await value(f, 'settings.set', { key: 'showTags', value: false })).showTags, false)
  assert.deepEqual(await value(f, 'workspace.open', { path: '/somewhere' }), { opened: true, via: 'new-terminal' })
  // The panel may send no input or no args at all.
  assert.deepEqual(await f.handlers.get('git')(undefined), { ok: false, error: 'Unknown operation: undefined' })
  assert.equal((await f.handlers.get('git')({ op: 'snapshot' })).ok, true)
})

test('snapshot: workspace match, settings merged over defaults, favorites from storage', async () => {
  const { work, f } = await start({ settings: { recentCount: 1 } })
  await sh(work, 'branch', 'dev')
  const snap = await value(f, 'snapshot')
  assert.deepEqual(snap.workspace, {
    path: work,
    override: false,
    reason: 'name',
    candidates: [work],
    context: CTX,
    worktrees: [{ path: work, displayName: 'demo', branch: 'main' }]
  })
  assert.deepEqual(snap.settings, { ...DEFAULTS, recentCount: 1 })
  assert.equal(snap.intent, null)
  assert.equal(snap.repo.current, 'main')
  assert.deepEqual(snap.repo.favorites, ['main'])
  assert.ok(snap.repo.recent.length <= 1)
  assert.equal(await value(f, 'fingerprint'), snap.repo.fingerprint)
})

test('every git op runs through the panel handler and returns { ok, value }', async () => {
  const { work, origin, f } = await start()
  const ok = async (op, args) => {
    const v = await value(f, op, args)
    if (v && typeof v === 'object' && 'status' in v) assert.equal(v.status, 'ok', `${op}: ${JSON.stringify(v)}`)
    return v
  }

  await ok('createBranch', { name: 'topic' })
  write(work, 't.txt', 't\n')
  await ok('commit', { message: 'topic work' })
  await ok('renameBranch', { from: 'topic', to: 'topic2' })
  await ok('checkout', { target: 'main' })
  const cmp = await value(f, 'compare', { base: 'main', other: 'topic2' })
  assert.deepEqual(cmp.onlyInOther.map((c) => c.subject), ['topic work'])
  await commitFile(work, 'm.txt', 'm\n')
  await ok('checkoutAndRebase', { branch: 'topic2', onto: 'main' })
  await ok('checkout', { target: 'main' })
  await ok('merge', { ref: 'topic2' })
  await ok('rebase', { onto: 'topic2' })
  await ok('deleteBranch', { name: 'topic2' })
  await ok('push', {})
  assert.equal(await sh(origin, 'rev-parse', 'main'), await sh(work, 'rev-parse', 'HEAD'))

  await ok('createTag', { name: 'v1', message: 'release' })
  assert.equal(await value(f, 'resolveRevision', { rev: 'v1' }), await sh(work, 'rev-parse', 'HEAD'))
  await ok('deleteTag', { name: 'v1' })
  assert.equal(await value(f, 'resolveRevision', { rev: 'v1' }), null)

  await ok('createBranch', { name: 'pub', checkout: false })
  await ok('push', { branch: 'pub' })
  await ok('fetch')
  await ok('checkoutRemote', { name: 'origin/pub', localName: 'pub2' })
  assert.equal((await g.currentHead(work)).branch, 'pub2')
  await ok('checkout', { target: 'main' })
  await ok('deleteRemoteBranch', { name: 'origin/pub' })
  await ok('updateProject')
  await ok('pull')
  await ok('updateBranch', { name: 'main' })

  write(work, 'a.txt', 'edited\n')
  assert.deepEqual((await value(f, 'status')).map((e) => e.path), ['a.txt'])
  assert.deepEqual((await value(f, 'diffWorkingTree', { ref: 'HEAD' })).files, [{ path: 'a.txt', added: 1, deleted: 1 }])
  const patch = await value(f, 'createPatch')
  assert.match(patch, /\+edited/)
  await ok('stash', { message: 'wip' })
  assert.equal((await value(f, 'stashList')).length, 1)
  await ok('unstash', { pop: false })
  await ok('dropStash', { ref: 'stash@{0}' })
  assert.deepEqual((await value(f, 'rollback', {})).files, ['a.txt'])
  await ok('applyPatch', { patch })
  assert.equal(readFileSync(path.join(work, 'a.txt'), 'utf8'), 'edited\n')
  await ok('reset', { mode: 'hard', ref: 'HEAD' })

  assert.equal((await value(f, 'fileHistory', { file: 'a.txt' }))[0].subject, 'initial')
  assert.equal((await value(f, 'blame', { file: 'a.txt' }))[0].text, 'one')
  assert.ok((await value(f, 'log', { max: 5 })).some((l) => l.subject === 'topic work'))
  assert.deepEqual(await value(f, 'trackedFiles'), ['a.txt', 'm.txt', 't.txt'])

  // An operation that stops on a conflict: continue reports it again, abort clears it.
  await sh(work, 'checkout', '-q', '-b', 'x')
  await commitFile(work, 'a.txt', 'x\n')
  await sh(work, 'checkout', '-q', 'main')
  await commitFile(work, 'a.txt', 'main\n')
  assert.equal((await value(f, 'merge', { ref: 'x' })).status, 'conflict')
  assert.equal((await value(f, 'continue')).status, 'conflict')
  await ok('abort')
  assert.equal((await g.repoInfo(work)).state, 'clean')
})

test('errors come back as { ok: false, error, command } with git text verbatim', async () => {
  const { work, f } = await start()
  let direct
  await g.checkout(work, 'nope').catch((e) => (direct = e))
  assert.deepEqual(await f.git('checkout', { target: 'nope' }), {
    ok: false,
    error: direct.message,
    command: 'git checkout --detach nope --'
  })
  // Errors the plugin raises itself, and Orca CLI errors, have no git command line.
  assert.deepEqual(await f.git('commit', { message: '' }), { ok: false, error: 'Commit message is empty.', command: undefined })
  stub.respond('terminal list', { stdout: { ok: true, result: { terminals: [] } } })
  stub.respond('terminal create', { stdout: { ok: false, error: { message: 'no such worktree' } } })
  assert.deepEqual(await f.git('workspace.open', { path: '/x' }), { ok: false, error: 'no such worktree', command: undefined })
  assert.ok(f.logs.some((l) => l.startsWith('checkout failed: ')))
})

test('settings.set persists and updateMethod drives pull', async () => {
  const { work, origin, f } = await start()
  assert.deepEqual(await value(f, 'settings.set', { key: 'updateMethod', value: 'merge' }), { ...DEFAULTS, updateMethod: 'merge' })
  assert.equal(f.settings.updateMethod, 'merge')
  const other = await cloneOf(origin)
  await commitFile(other, 'r.txt', 'r\n')
  await sh(other, 'push', '-q', 'origin', 'main')
  await commitFile(work, 'l.txt', 'l\n')
  assert.equal((await value(f, 'pull')).status, 'ok')
  assert.equal((await sh(work, 'rev-list', '--parents', '-n', '1', 'HEAD')).split(' ').length, 3)
})

test('favorite.toggle persists per repository, shared by its worktrees', async () => {
  const { work, f } = await start()
  await sh(work, 'branch', 'dev')
  const wt = fresh('wt')
  await sh(work, 'worktree', 'add', '-q', '-b', 'wt-branch', wt)
  const key = `favorites:${path.join(work, '.git')}`

  assert.deepEqual(await value(f, 'favorite.toggle', { name: 'main' }), [])
  assert.deepEqual(await value(f, 'favorite.toggle', { name: 'dev' }), ['dev'])
  assert.deepEqual(f.storage[key], ['dev'])
  assert.deepEqual((await value(f, 'snapshot')).repo.favorites, ['dev'])

  await value(f, 'workspace.select', { path: realpathSync(wt) })
  assert.deepEqual((await value(f, 'snapshot')).repo.favorites, ['dev'])
  assert.deepEqual(await value(f, 'favorite.toggle', { name: 'main' }), ['dev', 'main'])

  const second = await makeRepo()
  await value(f, 'workspace.select', { path: second.work })
  assert.deepEqual((await value(f, 'snapshot')).repo.favorites, ['main'])
})

test('workspace.refresh re-reads the focused workspace; workspace.select pins one until cleared', async () => {
  const second = await makeRepo()
  const first = await makeRepo()
  const { f } = await start({ repo: first, worktrees: [orcaWorktree(first.work), orcaWorktree(second.work, 'second')] })
  assert.equal((await value(f, 'snapshot')).workspace.path, first.work)

  f.state.context = { displayName: 'second', branch: 'main', terminals: [] }
  let snap = await value(f, 'workspace.refresh')
  assert.equal(snap.workspace.path, second.work)
  assert.equal(snap.repo.info.toplevel, second.work)

  snap = await value(f, 'workspace.select', { path: first.work })
  assert.equal(snap.workspace.path, first.work)
  assert.equal(snap.workspace.override, true)
  snap = await value(f, 'workspace.select', {})
  assert.equal(snap.workspace.path, second.work)
  assert.equal(snap.workspace.override, false)
})

test('workspace.open goes to an existing terminal of that worktree', async () => {
  const { work, f } = await start()
  stub.ok('terminal list', { terminals: [{ handle: 'h1', worktreePath: work }] })
  assert.deepEqual(await value(f, 'workspace.open', { path: work }), { opened: true, via: 'terminal' })
  assert.deepEqual(stub.calls().at(-1), ['terminal', 'switch', '--terminal', 'h1', '--json'])
})

test('worktrees flags the ones Orca knows and the current one', async () => {
  const { work, f } = await start()
  const wt = fresh('wt')
  await sh(work, 'worktree', 'add', '-q', '-b', 'side', wt)
  const list = await value(f, 'worktrees')
  assert.deepEqual(
    list.map(({ path: p, branch, inOrca, displayName, current }) => ({ p, branch, inOrca, displayName, current })),
    [
      { p: work, branch: 'main', inOrca: true, displayName: 'demo', current: true },
      { p: realpathSync(wt), branch: 'side', inOrca: false, displayName: null, current: false }
    ]
  )
  stub.respond('worktree list', { exit: 1, stderr: 'orca down' })
  assert.equal((await value(f, 'worktrees')).every((w) => !w.inOrca), true)
})

test('newWorktree asks Orca to create it from the main checkout, even from a linked worktree', async () => {
  const { work, origin, f } = await start()
  stub.ok('worktree create', { worktree: { path: '/new' } })
  const wt = fresh('wt')
  await sh(work, 'worktree', 'add', '-q', '-b', 'side', wt)
  await value(f, 'workspace.select', { path: realpathSync(wt) })
  assert.deepEqual(await value(f, 'newWorktree', { name: 'n1', baseBranch: 'main' }), { worktree: { path: '/new' } })
  await value(f, 'workspace.select', { path: work })
  await value(f, 'newWorktree', { name: 'n2' })
  const creates = stub.calls().filter((c) => c[1] === 'create')
  assert.deepEqual(creates, [
    ['worktree', 'create', '--repo', `path:${work}`, '--name', 'n1', '--activate', '--base-branch', 'main', '--json'],
    ['worktree', 'create', '--repo', `path:${work}`, '--name', 'n2', '--activate', '--json']
  ])

  // A worktree of a bare repository has no main checkout, so it is used as is.
  const bareWt = fresh('bare-wt')
  await sh(origin, 'worktree', 'add', '-q', bareWt, 'main')
  await value(f, 'workspace.select', { path: realpathSync(bareWt) })
  await value(f, 'newWorktree', { name: 'n3' })
  assert.equal(stub.calls().at(-1)[3], `path:${realpathSync(bareWt)}`)
})

test('host failures fall back to defaults and are logged, never thrown', async () => {
  const { f } = await start({ failing: ['settings.get', 'storage.get', 'notifications.show', 'panels.post'] })
  const snap = await value(f, 'snapshot')
  assert.deepEqual(snap.settings, DEFAULTS)
  assert.deepEqual(snap.repo.favorites, ['main'])
  await f.run('git.newBranch')
  assert.ok(f.logs.some((l) => l.startsWith('notify failed: ')))
  assert.ok(f.logs.some((l) => l.startsWith('post ui.intent failed: ')))
})

test('workspace resolution failures leave the worker running without a repo', async () => {
  const { f } = await start({ failing: ['workspace.readContext'] })
  const snap = await value(f, 'snapshot')
  assert.equal(snap.workspace.path, null)
  assert.equal(snap.workspace.reason, 'error')
  assert.ok(f.logs.some((l) => l.startsWith('resolve workspace failed: ')))

  f.fail.delete('workspace.readContext')
  stub.respond('worktree list', { exit: 1, stderr: 'orca down' })
  await value(f, 'workspace.refresh')
  assert.ok(f.logs.some((l) => l === 'orca worktree list failed: orca down'))

  // A focused folder that is not a git repo, or no longer exists: the workspace is shown without a repo.
  const plain = fresh('plain')
  mkdirSync(plain)
  for (const dir of [plain, fresh('missing')]) {
    stub.ok('worktree list', { worktrees: [orcaWorktree(dir)] })
    for (const op of ['workspace.refresh', 'snapshot']) {
      const snap = await value(f, op)
      assert.equal(snap.repo, null)
      assert.equal(snap.workspace.path, dir)
      assert.equal(snap.workspace.reason, 'not-a-repo')
      assert.equal(snap.workspace.error, `Not a Git repository: ${dir}`)
      assert.deepEqual(snap.settings, DEFAULTS)
    }
  }
  assert.equal((await f.git('status')).ok, false)
})

test('an Orca without panels.handle is logged; palette commands still register', async () => {
  const { f } = await start({ panels: false })
  assert.ok(f.logs.some((l) => l.includes('has no orca.panels.handle')))
  assert.ok(f.commands.has('git.fetch'))
})
