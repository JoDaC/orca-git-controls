import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync, mkdirSync, writeFileSync, realpathSync } from 'node:fs'
import path from 'node:path'
import * as g from '../lib/git.mjs'
import { makeRepo, cloneOf, sh, shAllowFail, write, commitFile, fresh } from './helpers/repo.mjs'

const read = (dir, file) => readFileSync(path.join(dir, file), 'utf8')
const head = async (dir) => sh(dir, 'rev-parse', 'HEAD')
const state = async (dir) => (await g.repoInfo(dir)).state

/** main and `x` both change a.txt, so integrating one into the other conflicts. */
async function divergedRepo() {
  const repo = await makeRepo()
  const { work } = repo
  await sh(work, 'checkout', '-q', '-b', 'x')
  await commitFile(work, 'a.txt', 'x\n', 'x side')
  await sh(work, 'checkout', '-q', 'main')
  await commitFile(work, 'a.txt', 'main\n', 'main side')
  return repo
}

async function resolve(work, text = 'resolved\n') {
  write(work, 'a.txt', text)
  await sh(work, 'add', 'a.txt')
}

// Each test builds its own repositories, so they can run side by side.
describe('git operations', { concurrency: true }, () => {
  test('repoState reads the marker files in the git dir', () => {
    const dir = fresh('gitdir')
    mkdirSync(dir)
    assert.equal(g.repoState(dir), 'clean')
    for (const [marker, expected] of [
      ['REVERT_HEAD', 'reverting'],
      ['CHERRY_PICK_HEAD', 'cherry-picking'],
      ['MERGE_HEAD', 'merging'],
      ['rebase-apply', 'rebasing']
    ]) {
      writeFileSync(path.join(dir, marker), '')
      assert.equal(g.repoState(dir), expected)
    }
    const merge = fresh('gitdir')
    mkdirSync(path.join(merge, 'rebase-merge'), { recursive: true })
    assert.equal(g.repoState(merge), 'rebasing')
  })

  test('abort and continue are no-ops on a clean repo', async () => {
    const { work } = await makeRepo()
    assert.deepEqual(await g.abortOperation(work), { status: 'ok' })
    assert.deepEqual(await g.continueOperation(work), { status: 'ok' })
  })

  test('rebase conflict: continue after resolving, or abort', async () => {
    const { work } = await divergedRepo()
    await sh(work, 'checkout', '-q', 'x')
    let res = await g.rebase(work, 'main')
    assert.equal(res.status, 'conflict')
    assert.deepEqual(res.conflicts, ['a.txt'])
    assert.equal(await state(work), 'rebasing')
    await resolve(work)
    res = await g.continueOperation(work)
    assert.equal(res.status, 'ok', JSON.stringify(res))
    assert.equal(await state(work), 'clean')
    assert.equal((await g.currentHead(work)).branch, 'x')
    assert.equal(await sh(work, 'rev-parse', 'HEAD~1'), await sh(work, 'rev-parse', 'main'))

    await commitFile(work, 'a.txt', 'x again\n')
    const before = await head(work)
    await sh(work, 'checkout', '-q', 'main')
    await commitFile(work, 'a.txt', 'main again\n')
    assert.equal((await g.checkoutAndRebase(work, 'x', 'main')).status, 'conflict')
    await g.abortOperation(work)
    assert.equal(await state(work), 'clean')
    assert.equal(await sh(work, 'rev-parse', 'x'), before)
  })

  test('rebase onto an unknown ref throws git error', async () => {
    const { work } = await makeRepo()
    await assert.rejects(g.rebase(work, 'nope'), (e) => e instanceof g.GitError && /nope/.test(e.message))
  })

  test('merge conflict: continue with unresolved files still reports the conflict, then commits', async () => {
    const { work } = await divergedRepo()
    assert.equal((await g.merge(work, 'x')).status, 'conflict')
    const stuck = await g.continueOperation(work)
    assert.equal(stuck.status, 'conflict')
    assert.deepEqual(stuck.conflicts, ['a.txt'])
    await resolve(work)
    assert.equal((await g.continueOperation(work)).status, 'ok')
    assert.equal(await state(work), 'clean')
    assert.equal((await sh(work, 'rev-list', '--parents', '-n', '1', 'HEAD')).split(' ').length, 3)
  })

  test('cherry-pick conflict: abort, then continue after resolving', async () => {
    const { work } = await divergedRepo()
    await shAllowFail(work, 'cherry-pick', 'x')
    assert.equal(await state(work), 'cherry-picking')
    await g.abortOperation(work)
    assert.equal(await state(work), 'clean')
    assert.equal(read(work, 'a.txt'), 'main\n')

    await shAllowFail(work, 'cherry-pick', 'x')
    await resolve(work, 'picked\n')
    assert.equal((await g.continueOperation(work)).status, 'ok')
    assert.equal(await state(work), 'clean')
    assert.equal(await sh(work, 'log', '-1', '--format=%s'), 'x side')
  })

  test('revert conflict: abort, then continue after resolving', async () => {
    const { work } = await makeRepo()
    await commitFile(work, 'a.txt', 'two\n', 'two')
    await commitFile(work, 'a.txt', 'three\n', 'three')
    await shAllowFail(work, 'revert', '--no-edit', 'HEAD~1')
    assert.equal(await state(work), 'reverting')
    await g.abortOperation(work)
    assert.equal(await state(work), 'clean')
    assert.equal(read(work, 'a.txt'), 'three\n')

    await shAllowFail(work, 'revert', '--no-edit', 'HEAD~1')
    await resolve(work, 'one\n')
    assert.equal((await g.continueOperation(work)).status, 'ok')
    assert.equal(await state(work), 'clean')
    assert.match(await sh(work, 'log', '-1', '--format=%s'), /^Revert "two"/)
  })

  test('checkoutAndRebase refuses a branch checked out in another worktree', async () => {
    const { work } = await makeRepo()
    await sh(work, 'branch', 'busy')
    const wt = fresh('wt')
    await sh(work, 'worktree', 'add', '-q', wt, 'busy')
    assert.deepEqual(await g.checkoutAndRebase(work, 'busy', 'main'), {
      status: 'worktree-conflict',
      worktreePath: realpathSync(wt),
      branch: 'busy'
    })
  })

  test('diffWithWorkingTree: numstat per file, binary files, patch truncation', async () => {
    const { work } = await makeRepo()
    writeFileSync(path.join(work, 'bin.dat'), Buffer.from([0, 1, 2, 3]))
    await sh(work, 'add', 'bin.dat')
    await sh(work, 'commit', '-q', '-m', 'binary')
    write(work, 'a.txt', 'one\ntwo\n')
    writeFileSync(path.join(work, 'bin.dat'), Buffer.from([0, 9, 9, 9]))
    let diff = await g.diffWithWorkingTree(work, 'HEAD')
    assert.equal(diff.ref, 'HEAD')
    assert.deepEqual(diff.files, [
      { path: 'a.txt', added: 1, deleted: 0 },
      { path: 'bin.dat', added: null, deleted: null }
    ])
    assert.match(diff.patch, /\+two/)

    write(work, 'a.txt', 'x'.repeat(500_000) + '\n')
    diff = await g.diffWithWorkingTree(work, 'HEAD')
    assert.match(diff.patch, /… \(truncated, \d+ more characters\)$/)
    assert.ok(diff.patch.length < 401_000)
  })

  test('checkout detaches for tags, revisions and detach:true; error paths', async () => {
    const { work } = await makeRepo()
    await sh(work, 'tag', 'v1')
    await commitFile(work, 'a.txt', 'two\n')
    const v1 = await sh(work, 'rev-parse', 'v1')

    assert.equal((await g.checkout(work, 'v1')).status, 'ok')
    assert.deepEqual(await g.currentHead(work), { branch: null, detached: true, sha: v1 })
    await g.checkout(work, 'main')
    assert.equal((await g.checkout(work, 'HEAD~1')).status, 'ok')
    assert.equal(await head(work), v1)
    await g.checkout(work, 'main')
    assert.equal((await g.checkout(work, 'main', { detach: true })).status, 'ok')
    assert.equal((await g.currentHead(work)).detached, true)
    await g.checkout(work, 'main')

    // Untracked file in the way: needs a decision, flagged untracked.
    await sh(work, 'checkout', '-q', '-b', 'adds-u')
    await commitFile(work, 'u.txt', 'branch\n')
    await sh(work, 'checkout', '-q', 'main')
    write(work, 'u.txt', 'mine\n')
    const res = await g.checkout(work, 'adds-u')
    assert.equal(res.status, 'needs-decision')
    assert.equal(res.untracked, true)
    assert.deepEqual(res.files, ['u.txt'])

    // Force mode never asks: an unknown target is git's error.
    await assert.rejects(g.checkout(work, 'nope', { mode: 'force' }), g.GitError)
  })

  test('smart checkout: clean tree skips the stash; failed checkout restores changes and throws', async () => {
    const { work } = await makeRepo()
    await sh(work, 'branch', 'other')
    assert.deepEqual(await g.checkout(work, 'other', { mode: 'smart' }), { status: 'ok', output: "Switched to branch 'other'" })
    await g.checkout(work, 'main')

    write(work, 'a.txt', 'staged\n')
    await sh(work, 'add', 'a.txt')
    write(work, 'a.txt', 'unstaged\n')
    await assert.rejects(g.checkout(work, 'nope', { mode: 'smart' }), g.GitError)
    assert.equal(read(work, 'a.txt'), 'unstaged\n')
    assert.equal(await sh(work, 'show', ':a.txt'), 'staged')
    assert.equal((await g.stashList(work)).length, 0)
  })

  test('smart checkout names an untracked file that now exists in the target', async () => {
    const { work } = await makeRepo()
    await sh(work, 'checkout', '-q', '-b', 'adds-u')
    await commitFile(work, 'u.txt', 'branch\n')
    await sh(work, 'checkout', '-q', 'main')
    write(work, 'u.txt', 'mine\n')
    const res = await g.checkout(work, 'adds-u', { mode: 'smart' })
    assert.equal(res.status, 'unstash-conflict')
    assert.deepEqual(res.conflicts, ['u.txt'])
    assert.equal(res.stashKept, true)
    assert.equal((await g.currentHead(work)).branch, 'adds-u')
    assert.equal((await g.stashList(work)).length, 1)
  })

  test('checkoutRemote: existing local name, localName, smart and force modes, decisions and errors', async () => {
    const { work, origin } = await makeRepo()
    const other = await cloneOf(origin)
    await sh(other, 'checkout', '-q', '-b', 'feat')
    await commitFile(other, 'a.txt', 'feat\n')
    await sh(other, 'push', '-q', 'origin', 'feat')
    await sh(work, 'fetch', '-q', 'origin')

    // A local main already exists: it is checked out, no new branch.
    await sh(work, 'checkout', '-q', '-b', 'side')
    assert.equal((await g.checkoutRemote(work, 'origin/main')).status, 'ok')
    assert.equal((await g.currentHead(work)).branch, 'main')

    write(work, 'a.txt', 'local edit\n')
    const decision = await g.checkoutRemote(work, 'origin/feat', { localName: 'mine' })
    assert.equal(decision.status, 'needs-decision')
    assert.deepEqual(decision.files, ['a.txt'])

    const smart = await g.checkoutRemote(work, 'origin/feat', { localName: 'mine', mode: 'smart' })
    assert.equal(smart.status, 'unstash-conflict')
    assert.equal((await g.currentHead(work)).branch, 'mine')
    assert.equal(await sh(work, 'rev-parse', '--abbrev-ref', 'mine@{u}'), 'origin/feat')
    await sh(work, 'checkout', '-q', '--force', 'main')
    await sh(work, 'stash', 'drop', '-q')

    write(work, 'a.txt', 'local edit\n')
    assert.equal((await g.checkoutRemote(work, 'origin/feat', { localName: 'forced', mode: 'force' })).status, 'ok')
    assert.equal(read(work, 'a.txt'), 'feat\n')

    await assert.rejects(g.checkoutRemote(work, 'origin/missing'), g.GitError)
    await assert.rejects(g.checkoutRemote(work, 'upstream/feat'), (e) => e instanceof g.GitError && /No remote matches 'upstream\/feat'/.test(e.message))
  })

  test('createBranch: without checkout, blocked by local changes, bad start point', async () => {
    const { work } = await makeRepo()
    await sh(work, 'checkout', '-q', '-b', 'other')
    await commitFile(work, 'a.txt', 'other\n')
    await sh(work, 'checkout', '-q', 'main')

    assert.deepEqual(await g.createBranch(work, 'quiet', 'other', { checkout: false }), { status: 'ok' })
    assert.equal((await g.currentHead(work)).branch, 'main')
    assert.equal(await sh(work, 'rev-parse', 'quiet'), await sh(work, 'rev-parse', 'other'))
    assert.deepEqual(await g.createBranch(work, 'quiet2', undefined, { checkout: false }), { status: 'ok' })

    write(work, 'a.txt', 'dirty\n')
    const res = await g.createBranch(work, 'from-other', 'other')
    assert.equal(res.status, 'needs-decision')
    assert.deepEqual(res.files, ['a.txt'])

    await assert.rejects(g.createBranch(work, 'x', 'no-such-ref'), g.GitError)
  })

  test('deleteBranch of a missing branch throws; deleteRemoteBranch and deleteTag', async () => {
    const { work, origin } = await makeRepo()
    await assert.rejects(g.deleteBranch(work, 'missing'), (e) => /not found/.test(e.message))

    await sh(work, 'push', '-q', 'origin', 'main:gone-soon')
    const res = await g.deleteRemoteBranch(work, 'origin/gone-soon')
    assert.equal(res.status, 'ok')
    assert.match(res.output, /deleted/)
    assert.equal((await shAllowFail(origin, 'rev-parse', '--verify', '--quiet', 'gone-soon')).code, 1)

    await g.createTag(work, 'light')
    assert.equal(await sh(work, 'cat-file', '-t', 'light'), 'commit')
    assert.deepEqual(await g.deleteTag(work, 'light'), { status: 'ok' })
    assert.equal(await g.refExists(work, 'refs/tags/light'), false)
    await assert.rejects(g.deleteTag(work, 'light'), g.GitError)
  })

  test('resolveRevision returns the commit sha or null', async () => {
    const { work } = await makeRepo()
    await sh(work, 'tag', '-a', 'ann', '-m', 'tag')
    assert.equal(await g.resolveRevision(work, 'ann'), await head(work))
    assert.equal(await g.resolveRevision(work, 'HEAD'), await head(work))
    assert.equal(await g.resolveRevision(work, 'nope'), null)
  })

  test('reset rejects an unknown mode', async () => {
    const { work } = await makeRepo()
    await assert.rejects(g.reset(work, { mode: 'nuke' }), /Unknown reset mode nuke/)
  })

  test('commit: message with add --all, staged only, amend, empty message, nothing to commit', async () => {
    const { work } = await makeRepo()
    write(work, 'a.txt', 'two\n')
    write(work, 'n.txt', 'new\n')
    let res = await g.commit(work, { message: 'all of it' })
    assert.equal(res.status, 'ok')
    assert.equal(await sh(work, 'log', '-1', '--format=%s'), 'all of it')
    assert.deepEqual(await g.status(work), [])

    write(work, 'a.txt', 'three\n')
    write(work, 'n.txt', 'staged\n')
    await sh(work, 'add', 'n.txt')
    await g.commit(work, { message: 'staged only', all: false })
    assert.deepEqual((await g.status(work)).map((e) => e.path), ['a.txt'])

    const before = await head(work)
    await g.commit(work, { amend: true })
    assert.notEqual(await head(work), before)
    assert.equal(await sh(work, 'log', '-1', '--format=%s'), 'staged only')
    assert.deepEqual(await g.status(work), [])
    await g.commit(work, { amend: true, message: 'renamed' })
    assert.equal(await sh(work, 'log', '-1', '--format=%s'), 'renamed')

    await assert.rejects(g.commit(work, { message: '' }), /Commit message is empty/)
    await assert.rejects(g.commit(work, { message: 'nothing' }), (e) => {
      assert.ok(e instanceof g.GitError)
      assert.match(e.message, /nothing to commit/)
      assert.deepEqual(e.args, ['commit', '-m', 'nothing'])
      assert.equal(e.exitCode, 1)
      return true
    })
  })

  test('fetchAll prunes a branch deleted on the remote', async () => {
    const { work, origin } = await makeRepo()
    await sh(work, 'push', '-q', 'origin', 'main:doomed')
    await sh(work, 'fetch', '-q', 'origin')
    assert.ok(await g.refExists(work, 'refs/remotes/origin/doomed'))
    const other = await cloneOf(origin)
    await sh(other, 'push', '-q', 'origin', '--delete', 'doomed')
    const res = await g.fetchAll(work)
    assert.equal(res.status, 'ok')
    assert.match(res.output, /deleted/)
    assert.equal(await g.refExists(work, 'refs/remotes/origin/doomed'), false)
  })

  test('pull and updateProject with merge make a merge commit; with rebase keep history linear', async () => {
    const { work, origin } = await makeRepo()
    const other = await cloneOf(origin)
    const remoteCommit = async (file) => {
      await commitFile(other, file, `${file}\n`)
      await sh(other, 'push', '-q', 'origin', 'main')
    }
    const parents = async () => (await sh(work, 'rev-list', '--parents', '-n', '1', 'HEAD')).split(' ').length - 1

    await remoteCommit('r1.txt')
    await commitFile(work, 'l1.txt', 'l\n')
    assert.equal((await g.pull(work, { method: 'merge' })).status, 'ok')
    assert.equal(await parents(), 2)

    await remoteCommit('r2.txt')
    await commitFile(work, 'l2.txt', 'l\n')
    assert.equal((await g.pull(work)).status, 'ok')
    assert.equal(await parents(), 1)
    assert.ok(existsSync(path.join(work, 'r2.txt')))

    await remoteCommit('r3.txt')
    await commitFile(work, 'l3.txt', 'l\n')
    assert.equal((await g.updateProject(work, { method: 'merge' })).status, 'ok')
    assert.equal(await parents(), 2)
    assert.ok(existsSync(path.join(work, 'r3.txt')))
  })

  test('pull reports conflicts; updateProject handles no upstream and detached HEAD', async () => {
    const { work, origin } = await makeRepo()
    const other = await cloneOf(origin)
    await commitFile(other, 'a.txt', 'theirs\n')
    await sh(other, 'push', '-q', 'origin', 'main')
    await commitFile(work, 'a.txt', 'ours\n')
    const res = await g.pull(work, { method: 'merge' })
    assert.equal(res.status, 'conflict')
    assert.deepEqual(res.conflicts, ['a.txt'])
    await g.abortOperation(work)

    await sh(work, 'checkout', '-q', '-b', 'local-only')
    const up = await g.updateProject(work)
    assert.equal(up.status, 'ok')
    assert.match(up.output, /'local-only' has no upstream, so nothing was pulled\.$/)

    await sh(work, 'checkout', '-q', '--detach')
    await assert.rejects(g.updateProject(work), /HEAD is detached/)
  })

  test('updateBranch: current branch runs Update Project; others need an upstream and no other worktree', async () => {
    const { work, origin } = await makeRepo()
    const other = await cloneOf(origin)
    await commitFile(other, 'n.txt', 'n\n')
    await sh(other, 'push', '-q', 'origin', 'main')

    assert.equal((await g.updateBranch(work, 'main', { method: 'merge' })).status, 'ok')
    assert.ok(existsSync(path.join(work, 'n.txt')))

    await sh(work, 'branch', 'no-up')
    await assert.rejects(g.updateBranch(work, 'no-up'), /Branch 'no-up' has no upstream branch to update from\./)

    await sh(work, 'branch', '--track', 'busy', 'origin/main')
    await sh(work, 'reset', '-q', '--hard', 'HEAD~1')
    await sh(work, 'branch', '-f', 'busy', 'HEAD')
    const wt = fresh('wt')
    await sh(work, 'worktree', 'add', '-q', wt, 'busy')
    assert.equal((await g.updateBranch(work, 'busy')).status, 'worktree-conflict')
  })

  test('push: explicit branch and remote, detached HEAD, no remote, unreachable remote', async () => {
    const { work, origin } = await makeRepo()
    await sh(work, 'remote', 'add', 'backup', fresh('missing-remote'))
    await sh(work, 'branch', 'side')
    let res = await g.push(work, { branch: 'side', remote: 'origin' })
    assert.equal(res.status, 'ok')
    assert.equal((await g.currentHead(work)).branch, 'main')
    assert.equal(await sh(work, 'rev-parse', '--abbrev-ref', 'side@{u}'), 'origin/side')
    assert.equal(await sh(origin, 'rev-parse', 'side'), await head(work))

    // A tracked branch pushes to its upstream's remote and name.
    await sh(work, 'branch', '--track', 'alias', 'origin/side')
    await sh(work, 'checkout', '-q', 'alias')
    await commitFile(work, 'p.txt', 'p\n')
    assert.equal((await g.push(work)).status, 'ok')
    assert.equal(await sh(origin, 'rev-parse', 'side'), await head(work))

    await assert.rejects(g.push(work, { branch: 'main', remote: 'backup' }), (e) => {
      assert.ok(e instanceof g.GitError)
      assert.equal(e.args[0], 'push')
      assert.ok(e.args.includes('backup'))
      assert.match(e.stderr, /does not appear to be a git repository|Could not read from remote/)
      return true
    })

    await sh(work, 'checkout', '-q', '--detach')
    await assert.rejects(g.push(work), /HEAD is detached/)

    const lonely = fresh('lonely')
    await g.git(path.dirname(lonely), ['init', '-q', '-b', 'main', lonely])
    await commitFile(lonely, 'a.txt', 'a\n')
    await assert.rejects(g.push(lonely), /no remote to push to/)
  })

  test('unstash: apply keeps the stash, index restores staging, dropStash, conflicts', async () => {
    const { work } = await makeRepo()
    write(work, 'a.txt', 'staged\n')
    await sh(work, 'add', 'a.txt')
    await g.stash(work, { includeUntracked: false })
    assert.equal(read(work, 'a.txt'), 'one\n')

    let res = await g.unstash(work, { pop: false, index: true })
    assert.equal(res.status, 'ok')
    assert.equal((await g.status(work))[0].x, 'M')
    assert.equal((await g.stashList(work)).length, 1)
    await sh(work, 'reset', '-q', '--hard')

    await g.unstash(work, { pop: false })
    assert.equal((await g.status(work))[0].x, ' ')
    await sh(work, 'reset', '-q', '--hard')

    write(work, 'a.txt', 'second\n')
    await g.stash(work, { message: 'second' })
    assert.equal((await g.stashList(work)).length, 2)
    assert.deepEqual(await g.dropStash(work, 'stash@{1}'), { status: 'ok' })
    const list = await g.stashList(work)
    assert.equal(list.length, 1)
    assert.match(list[0].subject, /second$/)
    await assert.rejects(g.dropStash(work, 'stash@{5}'), g.GitError)

    await commitFile(work, 'a.txt', 'conflicting\n')
    res = await g.unstash(work)
    assert.equal(res.status, 'conflict')
    assert.deepEqual(res.conflicts, ['a.txt'])
  })

  test('rollback: chosen paths only, renames, and deleteAdded', async () => {
    const { work } = await makeRepo()
    await commitFile(work, 'b.txt', 'b\n')
    write(work, 'a.txt', 'changed\n')
    write(work, 'b.txt', 'changed\n')
    let res = await g.rollback(work, { paths: ['a.txt'] })
    assert.deepEqual(res.files, ['a.txt'])
    assert.equal(read(work, 'a.txt'), 'one\n')
    assert.equal(read(work, 'b.txt'), 'changed\n')
    assert.equal(await g.isDirty(work), true)
    await g.rollback(work)
    assert.equal(await g.isDirty(work), false)

    await sh(work, 'mv', 'a.txt', 'renamed.txt')
    const renamed = (await g.status(work)).find((e) => e.x === 'R')
    assert.deepEqual([renamed.path, renamed.from], ['renamed.txt', 'a.txt'])
    await g.rollback(work)
    assert.equal(read(work, 'a.txt'), 'one\n')
    assert.equal(existsSync(path.join(work, 'renamed.txt')), false)
    assert.equal(await g.isDirty(work), false)

    write(work, 'added.txt', 'added\n')
    await sh(work, 'add', 'added.txt')
    write(work, 'kept.txt', 'kept\n')
    await sh(work, 'add', 'kept.txt')
    await g.rollback(work, { paths: ['added.txt'], deleteAdded: true })
    assert.equal(existsSync(path.join(work, 'added.txt')), false)
    assert.equal((await g.status(work)).find((e) => e.path === 'kept.txt').x, 'A')
    await g.rollback(work, { paths: ['kept.txt'] })
    assert.equal((await g.status(work)).find((e) => e.path === 'kept.txt').untracked, true)
  })

  test('applyPatch: check leaves the tree alone, garbage throws, a 3-way conflict is reported', async () => {
    const { work } = await makeRepo()
    write(work, 'a.txt', 'patched\n')
    const patch = await g.createPatch(work)
    await g.rollback(work)

    assert.equal((await g.applyPatch(work, patch, { check: true })).status, 'ok')
    assert.equal(read(work, 'a.txt'), 'one\n')

    await assert.rejects(g.applyPatch(work, 'not a patch\n'), (e) => {
      assert.ok(e instanceof g.GitError)
      assert.deepEqual(e.args, ['apply', '--3way', '--whitespace=nowarn', '-'])
      return true
    })

    await commitFile(work, 'a.txt', 'diverged\n')
    const res = await g.applyPatch(work, patch)
    assert.equal(res.status, 'conflict')
    assert.deepEqual(res.conflicts, ['a.txt'])
  })

  test('trackedFiles lists the index, including names with spaces', async () => {
    const { work } = await makeRepo()
    await commitFile(work, 'with space.txt', 's\n')
    write(work, 'untracked.txt', 'u\n')
    assert.deepEqual(await g.trackedFiles(work), ['a.txt', 'with space.txt'])
  })

  test('GitError carries args, exit code and stderr; spawn failures and timeouts reject too', async () => {
    const { work } = await makeRepo()
    await assert.rejects(g.git(work, ['rev-parse', '--verify', 'nope']), (e) => {
      assert.ok(e instanceof g.GitError)
      assert.equal(e.name, 'GitError')
      assert.deepEqual(e.args, ['rev-parse', '--verify', 'nope'])
      assert.equal(e.exitCode, 128)
      assert.match(e.stderr, /fatal: Needed a single revision/)
      assert.equal(e.message, e.stderr.trim())
      return true
    })
    const silent = new g.GitError(['x'], 3, '', '')
    assert.equal(silent.message, 'git x failed with exit code 3')

    // stdin is left open, so hash-object waits until the timeout kills it.
    await assert.rejects(g.git(work, ['hash-object', '--stdin'], { timeoutMs: 100 }), g.GitError)
    const killed = await g.git(work, ['hash-object', '--stdin'], { timeoutMs: 100, allowFail: true })
    assert.notEqual(killed.code, 0)
    const fed = await g.git(work, ['hash-object', '--stdin'], { input: 'x' })
    assert.match(fed.stdout, /^[0-9a-f]{40}\n$/)
    await assert.rejects(g.git(fresh('missing-dir'), ['status']), g.GitError)
  })

  test('read-only calls take no index.lock, so a mutating op running alongside them succeeds', async () => {
    const { work } = await makeRepo()
    for (let i = 0; i < 20; i++) write(work, `f${i}.txt`, 'x\n')
    await sh(work, 'add', '.')
    await sh(work, 'commit', '-q', '-m', 'many files')
    let stop = false
    const readers = (async () => {
      while (!stop) await Promise.all([g.status(work), g.fingerprint(work), g.isDirty(work), g.diffWithWorkingTree(work, 'HEAD')])
    })()
    try {
      // Rewriting a file each round leaves the index stale, which is when status wants to refresh it.
      for (let i = 0; i < 40; i++) {
        write(work, 'f1.txt', `${i}\n`)
        await sh(work, 'add', 'f1.txt')
        await g.reset(work, { mode: 'mixed' })
      }
    } finally {
      stop = true
      await readers
    }
  })

  test('isRepo is false for a plain folder and a missing path', async () => {
    const { work } = await makeRepo()
    const plain = fresh('plain')
    mkdirSync(plain)
    assert.equal(await g.isRepo(work), true)
    assert.equal(await g.isRepo(plain), false)
    assert.equal(await g.isRepo(fresh('missing')), false)
  })
})
