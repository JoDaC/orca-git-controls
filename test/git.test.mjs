import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import * as g from '../lib/git.mjs'

// Every repo lives under one throwaway directory in $TMPDIR.
let root
before(() => {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), 'orca-git-branches-test-')))
})
after(() => {
  if (root && root.startsWith(realpathSync(tmpdir()))) rmSync(root, { recursive: true, force: true })
})

const ENV = {
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1'
}
Object.assign(process.env, ENV)

let n = 0
async function sh(cwd, ...args) {
  return (await g.git(cwd, args)).stdout.trim()
}
function write(dir, file, text) {
  writeFileSync(path.join(dir, file), text)
}
async function commitFile(dir, file, text, msg = `edit ${file}`) {
  write(dir, file, text)
  await sh(dir, 'add', file)
  await sh(dir, 'commit', '-q', '-m', msg)
}

/** A bare "origin", a clone with main pushed, and helpers. */
async function makeRepo() {
  const base = path.join(root, `r${++n}`)
  const origin = `${base}-origin.git`
  const work = `${base}-work`
  await g.git(root, ['init', '-q', '--bare', '-b', 'main', origin])
  await g.git(root, ['init', '-q', '-b', 'main', work])
  await sh(work, 'remote', 'add', 'origin', origin)
  await commitFile(work, 'a.txt', 'one\n', 'initial')
  await sh(work, 'push', '-q', '-u', 'origin', 'main')
  return { origin, work }
}

test('listRefs: local, remote, tags, current and upstream tracking', async () => {
  const { work } = await makeRepo()
  await sh(work, 'branch', 'feature/login')
  await sh(work, 'branch', 'feature/ui/button')
  await sh(work, 'branch', 'bugfix')
  await sh(work, 'push', '-q', 'origin', 'feature/login')
  await sh(work, 'tag', 'v1.0')
  await sh(work, 'fetch', '-q', 'origin')
  const refs = await g.listRefs(work)
  assert.deepEqual(
    refs.local.map((b) => b.name).sort(),
    ['bugfix', 'feature/login', 'feature/ui/button', 'main']
  )
  const main = refs.local.find((b) => b.name === 'main')
  assert.equal(main.current, true)
  assert.equal(main.upstream, 'origin/main')
  assert.deepEqual(refs.remote.map((r) => r.name).sort(), ['origin/feature/login', 'origin/main'])
  assert.equal(refs.remote.find((r) => r.name === 'origin/feature/login').branch, 'feature/login')
  assert.deepEqual(refs.tags.map((t) => t.name), ['v1.0'])
  assert.equal(refs.info.branch, 'main')
})

test('groupByFolder groups by "/" prefix with folders sorted first', () => {
  const tree = g.groupByFolder(
    ['main', 'feature/login', 'feature/ui/button', 'feature/ui/card', 'bugfix/crash'].map((name) => ({ name }))
  )
  assert.deepEqual(tree.items.map((i) => i.name), ['main'])
  assert.deepEqual(tree.folders.map((f) => f.name), ['bugfix', 'feature'])
  const feature = tree.folders[1]
  assert.equal(feature.path, 'feature')
  assert.deepEqual(feature.items.map((i) => i.name), ['feature/login'])
  assert.deepEqual(feature.folders[0].items.map((i) => i.name), ['feature/ui/button', 'feature/ui/card'])
})

test('groupRemotes groups by remote name, then folders', async () => {
  const groups = g.groupRemotes(
    [
      { name: 'codex/x/one', remote: 'codex', branch: 'x/one' },
      { name: 'origin/main', remote: 'origin', branch: 'main' },
      { name: 'origin/feature/a', remote: 'origin', branch: 'feature/a' }
    ],
    ['codex', 'origin']
  )
  assert.deepEqual(groups.map((x) => x.remote), ['origin', 'codex'])
  assert.deepEqual(groups[0].tree.items.map((b) => b.branch), ['main'])
  assert.deepEqual(groups[0].tree.folders[0].items.map((b) => b.branch), ['feature/a'])
  assert.equal(groups[1].tree.folders[0].path, 'codex/x')
})

test('ahead/behind counts vs upstream, and gone upstreams', async () => {
  const { work, origin } = await makeRepo()
  // Another clone pushes two commits -> we are behind 2.
  const other = path.join(root, `other${n}`)
  await g.git(root, ['clone', '-q', origin, other])
  await commitFile(other, 'b.txt', 'b\n')
  await commitFile(other, 'c.txt', 'c\n')
  await sh(other, 'push', '-q', 'origin', 'main')
  // We commit one locally -> ahead 1.
  await commitFile(work, 'd.txt', 'd\n')
  await sh(work, 'fetch', '-q', 'origin')
  let refs = await g.listRefs(work)
  let main = refs.local.find((b) => b.name === 'main')
  assert.equal(main.ahead, 1)
  assert.equal(main.behind, 2)

  // Upstream deleted on the remote -> gone.
  await sh(work, 'checkout', '-q', '-b', 'temp')
  await sh(work, 'push', '-q', '-u', 'origin', 'temp')
  await sh(work, 'push', '-q', 'origin', '--delete', 'temp')
  await sh(work, 'fetch', '-q', '--prune', 'origin')
  refs = await g.listRefs(work)
  assert.equal(refs.local.find((b) => b.name === 'temp').gone, true)
})

test('parseTrack handles every shape', () => {
  assert.deepEqual(g.parseTrack(''), { ahead: 0, behind: 0, gone: false })
  assert.deepEqual(g.parseTrack('ahead 3'), { ahead: 3, behind: 0, gone: false })
  assert.deepEqual(g.parseTrack('behind 4'), { ahead: 0, behind: 4, gone: false })
  assert.deepEqual(g.parseTrack('ahead 1, behind 2'), { ahead: 1, behind: 2, gone: false })
  assert.deepEqual(g.parseTrack('gone'), { ahead: 0, behind: 0, gone: true })
})

test('recentBranches reads the reflog, newest first, existing branches only', async () => {
  const { work } = await makeRepo()
  for (const b of ['one', 'two', 'three']) await sh(work, 'branch', b)
  await sh(work, 'checkout', '-q', 'one')
  await sh(work, 'checkout', '-q', 'two')
  await sh(work, 'checkout', '-q', 'main')
  await sh(work, 'checkout', '-q', 'three')
  await sh(work, 'checkout', '-q', 'two')
  await sh(work, 'branch', '-D', 'three')
  const refs = await g.listRefs(work)
  const recent = await g.recentBranches(work, { existing: new Set(refs.local.map((b) => b.name)) })
  assert.deepEqual(recent, ['two', 'main', 'one'])
})

test('checkout switches branches; dirty conflicting tree asks for a decision', async () => {
  const { work } = await makeRepo()
  await sh(work, 'checkout', '-q', '-b', 'other')
  await commitFile(work, 'a.txt', 'other version\n')
  await sh(work, 'checkout', '-q', 'main')

  // Clean switch.
  let res = await g.checkout(work, 'other')
  assert.equal(res.status, 'ok')
  assert.equal((await g.currentHead(work)).branch, 'other')
  await g.checkout(work, 'main')

  // Local change to a.txt conflicts with 'other'.
  write(work, 'a.txt', 'my local edit\n')
  res = await g.checkout(work, 'other')
  assert.equal(res.status, 'needs-decision')
  assert.deepEqual(res.files, ['a.txt'])
  assert.equal((await g.currentHead(work)).branch, 'main')
  assert.match(res.message, /would be overwritten/)
})

test('smart checkout stashes, switches and reports unstash conflicts', async () => {
  const { work } = await makeRepo()
  await sh(work, 'checkout', '-q', '-b', 'other')
  await commitFile(work, 'a.txt', 'other version\n')
  await commitFile(work, 'z.txt', 'z\n')
  await sh(work, 'checkout', '-q', 'main')

  // Non-conflicting smart checkout keeps the change: edit b.txt (only on main side).
  await commitFile(work, 'b.txt', 'b\n')
  write(work, 'b.txt', 'b edited\n')
  write(work, 'a.txt', 'conflicting edit\n')
  const res = await g.checkout(work, 'other', { mode: 'smart' })
  assert.equal((await g.currentHead(work)).branch, 'other')
  // a.txt differs on both sides -> unstash conflict, stash kept.
  assert.equal(res.status, 'unstash-conflict')
  assert.ok(res.conflicts.includes('a.txt'), JSON.stringify(res))
  assert.equal((await g.stashList(work)).length, 1)
})

test('smart checkout without conflicts restores changes and drops the stash', async () => {
  const { work } = await makeRepo()
  await commitFile(work, 'b.txt', 'b\n')
  await sh(work, 'checkout', '-q', '-b', 'other')
  await commitFile(work, 'a.txt', 'other version\n')
  await sh(work, 'checkout', '-q', 'main')
  write(work, 'b.txt', 'b edited\n')
  const res = await g.checkout(work, 'other', { mode: 'smart' })
  assert.equal(res.status, 'ok')
  assert.equal(readFileSync(path.join(work, 'b.txt'), 'utf8'), 'b edited\n')
  assert.equal((await g.stashList(work)).length, 0)
})

test('force checkout discards local changes', async () => {
  const { work } = await makeRepo()
  await sh(work, 'checkout', '-q', '-b', 'other')
  await commitFile(work, 'a.txt', 'other version\n')
  await sh(work, 'checkout', '-q', 'main')
  write(work, 'a.txt', 'local\n')
  const res = await g.checkout(work, 'other', { mode: 'force' })
  assert.equal(res.status, 'ok')
  assert.equal(readFileSync(path.join(work, 'a.txt'), 'utf8'), 'other version\n')
})

test('branch checked out in another worktree is reported with its path', async () => {
  const { work } = await makeRepo()
  await sh(work, 'branch', 'busy')
  const wt = path.join(root, `wt${n}`)
  await sh(work, 'worktree', 'add', '-q', wt, 'busy')
  const res = await g.checkout(work, 'busy')
  assert.equal(res.status, 'worktree-conflict')
  assert.equal(res.worktreePath, realpathSync(wt))
  const refs = await g.listRefs(work)
  const busy = refs.local.find((b) => b.name === 'busy')
  assert.equal(busy.checkedOutElsewhere, true)
  assert.equal(busy.worktreePath, realpathSync(wt))
  // git's own error text is parsed the same way.
  assert.equal(
    g.parseWorktreeConflict(`fatal: 'busy' is already checked out at '${wt}'`),
    wt
  )
  assert.equal(g.parseWorktreeConflict(`fatal: 'busy' is already used by worktree at '/x/y'`), '/x/y')
  const del = await g.deleteBranch(work, 'busy', { force: true })
  assert.equal(del.status, 'worktree-conflict')
})

test('checkoutRemote creates a tracking branch', async () => {
  const { work, origin } = await makeRepo()
  const other = path.join(root, `other${n}`)
  await g.git(root, ['clone', '-q', origin, other])
  await sh(other, 'checkout', '-q', '-b', 'feature/remote-only')
  await commitFile(other, 'r.txt', 'r\n')
  await sh(other, 'push', '-q', 'origin', 'feature/remote-only')
  await sh(work, 'fetch', '-q', 'origin')
  const res = await g.checkoutRemote(work, 'origin/feature/remote-only')
  assert.equal(res.status, 'ok')
  const refs = await g.listRefs(work)
  const b = refs.local.find((x) => x.name === 'feature/remote-only')
  assert.equal(b.current, true)
  assert.equal(b.upstream, 'origin/feature/remote-only')
})

test('delete unmerged branch asks first; force deletes', async () => {
  const { work } = await makeRepo()
  await sh(work, 'checkout', '-q', '-b', 'unmerged')
  await commitFile(work, 'u.txt', 'u\n')
  await sh(work, 'checkout', '-q', 'main')
  let res = await g.deleteBranch(work, 'unmerged')
  assert.equal(res.status, 'unmerged')
  assert.ok(await g.refExists(work, 'refs/heads/unmerged'))
  res = await g.deleteBranch(work, 'unmerged', { force: true })
  assert.equal(res.status, 'ok')
  assert.equal(await g.refExists(work, 'refs/heads/unmerged'), false)
})

test('create, rename, merge, rebase, compare', async () => {
  const { work } = await makeRepo()
  let res = await g.createBranch(work, 'topic', 'main')
  assert.equal(res.status, 'ok')
  await commitFile(work, 't.txt', 't\n', 'topic commit')
  await g.renameBranch(work, 'topic', 'topic2')
  assert.equal((await g.currentHead(work)).branch, 'topic2')
  await g.checkout(work, 'main')
  await commitFile(work, 'm.txt', 'm\n', 'main commit')
  const cmp = await g.compare(work, 'main', 'topic2')
  assert.deepEqual(cmp.onlyInOther.map((c) => c.subject), ['topic commit'])
  assert.deepEqual(cmp.onlyInBase.map((c) => c.subject), ['main commit'])
  res = await g.checkoutAndRebase(work, 'topic2', 'main')
  assert.equal(res.status, 'ok')
  assert.equal((await g.currentHead(work)).branch, 'topic2')
  assert.equal((await g.compare(work, 'topic2', 'main')).onlyInOther.length, 0)
  await g.checkout(work, 'main')
  res = await g.merge(work, 'topic2')
  assert.equal(res.status, 'ok')
  assert.ok(existsSync(path.join(work, 't.txt')))
  await assert.rejects(g.createBranch(work, 'bad..name'), g.GitError)
})

test('merge conflict is reported with conflicting files, abort restores', async () => {
  const { work } = await makeRepo()
  await sh(work, 'checkout', '-q', '-b', 'x')
  await commitFile(work, 'a.txt', 'x\n')
  await sh(work, 'checkout', '-q', 'main')
  await commitFile(work, 'a.txt', 'main\n')
  const res = await g.merge(work, 'x')
  assert.equal(res.status, 'conflict')
  assert.deepEqual(res.conflicts, ['a.txt'])
  assert.equal((await g.repoInfo(work)).state, 'merging')
  await g.abortOperation(work)
  assert.equal((await g.repoInfo(work)).state, 'clean')
})

test('git errors are thrown verbatim', async () => {
  const { work } = await makeRepo()
  await assert.rejects(g.checkout(work, 'does-not-exist'), (e) => {
    assert.ok(e instanceof g.GitError)
    assert.match(e.message, /pathspec 'does-not-exist' did not match|invalid reference|unknown revision/)
    return true
  })
})

test('push, rejected push, and force-with-lease', async () => {
  const { work, origin } = await makeRepo()
  await g.createBranch(work, 'pushme')
  await commitFile(work, 'p.txt', 'p\n')
  let res = await g.push(work)
  assert.equal(res.status, 'ok')
  assert.equal((await g.listRefs(work)).local.find((b) => b.name === 'pushme').upstream, 'origin/pushme')
  // Rewrite history -> rejected without force.
  await sh(work, 'commit', '-q', '--amend', '-m', 'rewritten')
  res = await g.push(work)
  assert.equal(res.status, 'rejected')
  res = await g.push(work, { force: true })
  assert.equal(res.status, 'ok')
  assert.equal(await sh(origin, 'log', '-1', '--format=%s', 'pushme'), 'rewritten')
})

test('updateProject pulls with rebase and autostash; updateBranch fast-forwards others', async () => {
  const { work, origin } = await makeRepo()
  await sh(work, 'branch', '--track', 'side', 'origin/main')
  const other = path.join(root, `other${n}`)
  await g.git(root, ['clone', '-q', origin, other])
  await commitFile(other, 'n.txt', 'new\n', 'remote commit')
  await sh(other, 'push', '-q', 'origin', 'main')
  write(work, 'a.txt', 'dirty\n')
  let res = await g.updateProject(work, { method: 'rebase' })
  assert.equal(res.status, 'ok', JSON.stringify(res))
  assert.ok(existsSync(path.join(work, 'n.txt')))
  assert.equal(readFileSync(path.join(work, 'a.txt'), 'utf8'), 'dirty\n')
  res = await g.updateBranch(work, 'side')
  assert.equal(res.status, 'ok')
  assert.equal(await sh(work, 'rev-parse', 'side'), await sh(work, 'rev-parse', 'origin/main'))
})

test('tags, reset modes, stash/unstash, rollback, patch round trip', async () => {
  const { work } = await makeRepo()
  await g.createTag(work, 'v2', { message: 'release 2' })
  assert.deepEqual((await g.listRefs(work)).tags.map((t) => t.name), ['v2'])
  await commitFile(work, 'r.txt', 'r\n', 'to reset')
  await g.reset(work, { mode: 'soft', ref: 'HEAD~1' })
  assert.equal((await g.status(work)).find((e) => e.path === 'r.txt').x, 'A')
  await g.reset(work, { mode: 'hard', ref: 'HEAD' })
  assert.equal(existsSync(path.join(work, 'r.txt')), false)

  write(work, 'a.txt', 'stash me\n')
  await g.stash(work, { message: 'wip' })
  assert.equal(readFileSync(path.join(work, 'a.txt'), 'utf8'), 'one\n')
  assert.equal((await g.stashList(work))[0].subject.endsWith('wip'), true)
  await g.unstash(work)
  assert.equal(readFileSync(path.join(work, 'a.txt'), 'utf8'), 'stash me\n')

  write(work, 'new.txt', 'new file\n')
  const patch = await g.createPatch(work)
  assert.match(patch, /new\.txt/)
  assert.match(patch, /stash me/)
  assert.equal((await g.status(work)).find((e) => e.path === 'new.txt').untracked, true)

  await g.rollback(work)
  assert.equal(readFileSync(path.join(work, 'a.txt'), 'utf8'), 'one\n')
  rmSync(path.join(work, 'new.txt'))
  res(await g.applyPatch(work, patch))
  assert.equal(readFileSync(path.join(work, 'a.txt'), 'utf8'), 'stash me\n')
  assert.ok(existsSync(path.join(work, 'new.txt')))
  function res(r) {
    assert.equal(r.status, 'ok')
  }
})

test('file history and blame', async () => {
  const { work } = await makeRepo()
  await commitFile(work, 'a.txt', 'one\ntwo\n', 'second line')
  const h = await g.fileHistory(work, 'a.txt')
  assert.deepEqual(h.map((c) => c.subject), ['second line', 'initial'])
  const b = await g.blame(work, 'a.txt')
  assert.equal(b.length, 2)
  assert.equal(b[0].subject, 'initial')
  assert.equal(b[1].subject, 'second line')
  assert.equal(b[1].text, 'two')
})

test('log and fingerprint change after outside edits', async () => {
  const { work } = await makeRepo()
  const f1 = await g.fingerprint(work)
  await sh(work, 'branch', 'outside')
  const f2 = await g.fingerprint(work)
  assert.notEqual(f1, f2)
  write(work, 'a.txt', 'changed\n')
  assert.notEqual(await g.fingerprint(work), f2)
  const lines = await g.log(work)
  assert.ok(lines.some((l) => l.subject === 'initial'))
})

test('listWorktrees parses porcelain output', async () => {
  const { work } = await makeRepo()
  const wt = path.join(root, `wtl${n}`)
  await sh(work, 'worktree', 'add', '-q', '-b', 'wtbranch', wt)
  const list = await g.listWorktrees(work)
  assert.equal(list.length, 2)
  assert.equal(list[1].branch, 'wtbranch')
  assert.equal(list[1].path, realpathSync(wt))
})
