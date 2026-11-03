import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { installOrcaStub } from './helpers/orca-stub.mjs'
import * as cli from '../lib/orca-cli.mjs'

const stub = installOrcaStub()
beforeEach(() => {
  process.env.ORCA_GIT_CONTROLS_ORCA = stub.bin
  stub.reset()
})

test('orcaBinary prefers ORCA_GIT_CONTROLS_ORCA, then a known install path, then PATH', () => {
  assert.equal(cli.orcaBinary(), stub.bin)
  delete process.env.ORCA_GIT_CONTROLS_ORCA
  const found = cli.orcaBinary()
  assert.ok(found === 'orca' || found.endsWith('/orca'), found)
})

test('listWorktrees and listTerminals return the result lists and pass --json', async () => {
  stub.ok('worktree list', { worktrees: [{ path: '/a', displayName: 'a' }] })
  stub.ok('terminal list', { terminals: [{ handle: 't1', worktreePath: '/a' }] })
  assert.deepEqual(await cli.listWorktrees(), [{ path: '/a', displayName: 'a' }])
  assert.deepEqual(await cli.listTerminals(), [{ handle: 't1', worktreePath: '/a' }])
  assert.deepEqual(stub.calls(), [
    ['worktree', 'list', '--json'],
    ['terminal', 'list', '--json']
  ])
})

test('list calls default to [] when the result has no list', async () => {
  assert.deepEqual(await cli.listWorktrees(), [])
  assert.deepEqual(await cli.listTerminals(), [])
})

test('openWorktree switches to a connected terminal of that worktree', async () => {
  stub.ok('terminal list', {
    terminals: [
      { handle: 'other', worktreePath: '/repo/b' },
      { handle: 'dead', worktreePath: '/repo/a', connected: false },
      { handle: 'live', worktreePath: '/repo/a/' }
    ]
  })
  assert.deepEqual(await cli.openWorktree('/repo/a'), { opened: true, via: 'terminal' })
  assert.deepEqual(stub.calls()[1], ['terminal', 'switch', '--terminal', 'live', '--json'])
})

test('openWorktree opens a new focused terminal when none is connected there', async () => {
  stub.ok('terminal list', { terminals: [{ handle: 'dead', worktreePath: '/repo/a', connected: false }] })
  assert.deepEqual(await cli.openWorktree('/repo/a'), { opened: true, via: 'new-terminal' })
  assert.deepEqual(stub.calls()[1], ['terminal', 'create', '--worktree', 'path:/repo/a', '--focus', '--json'])
})

test('openWorktree still opens a terminal when listing terminals fails', async () => {
  stub.respond('terminal list', { stderr: 'not running', exit: 1 })
  assert.equal((await cli.openWorktree('/repo/a')).via, 'new-terminal')
})

test('createWorktree passes the main checkout, name and activate, plus the base branch when given', async () => {
  stub.ok('worktree create', { worktree: { path: '/repo-x' } })
  assert.deepEqual(await cli.createWorktree({ repoPath: '/repo', name: 'x' }), { worktree: { path: '/repo-x' } })
  await cli.createWorktree({ repoPath: '/repo', name: 'y', baseBranch: 'dev' })
  assert.deepEqual(stub.calls(), [
    ['worktree', 'create', '--repo', 'path:/repo', '--name', 'x', '--activate', '--json'],
    ['worktree', 'create', '--repo', 'path:/repo', '--name', 'y', '--activate', '--base-branch', 'dev', '--json']
  ])
})

test('errors carry the JSON error message, else stderr, else stdout, else the exec error', async () => {
  const fails = (key, r) => {
    stub.respond(key, r)
    return cli.orcaCli(key.split(' '))
  }
  const rejectsWith = (p, msg) =>
    assert.rejects(p, (e) => {
      assert.ok(e instanceof cli.OrcaCliError)
      assert.match(e.message, msg)
      return true
    })
  await rejectsWith(fails('a b', { stdout: { ok: false, error: { message: 'no such worktree' } }, stderr: 'ignored', exit: 1 }), /^no such worktree$/)
  await rejectsWith(fails('c d', { stdout: 'not json', stderr: '  stderr text \n', exit: 2 }), /^stderr text$/)
  await rejectsWith(fails('e f', { stdout: ' plain stdout ', exit: 2 }), /^plain stdout$/)
  await rejectsWith(fails('g h', { exit: 3 }), /Command failed/)
  // ok:false with exit 0 is still a failure.
  await rejectsWith(fails('i j', { stdout: { ok: false, error: { message: 'refused' } } }), /^refused$/)
  process.env.ORCA_GIT_CONTROLS_ORCA = '/nonexistent/orca'
  await rejectsWith(cli.orcaCli(['worktree', 'list']), /ENOENT/)
})
