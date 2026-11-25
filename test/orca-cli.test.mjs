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

// ---- Windows + WSL ------------------------------------------------------------------
// On Windows, WSL workspaces live in a separate Orca runtime that a plain list call omits.

const omitted = {
  hostIds: [],
  omittedHostIds: ['local', 'runtime:1', 'ssh:2'],
  omittedHostSelectors: [
    { hostId: 'local', selector: null },
    { hostId: 'runtime:1', selector: '--environment wsl' },
    { hostId: 'ssh:2', selector: null }
  ]
}
const win = (distro = 'Ubuntu-26.04', seen = []) => ({
  platform: 'win32',
  resolveDistro: async (selector, paths) => {
    seen.push([selector, paths])
    return distro
  }
})

test('selectorArgs splits a host selector into CLI flags', () => {
  assert.deepEqual(cli.selectorArgs('--environment wsl'), ['--environment', 'wsl'])
  assert.deepEqual(cli.selectorArgs('--host ssh:abc'), ['--host', 'ssh:abc'])
  assert.equal(cli.selectorArgs(null), null)
  assert.equal(cli.selectorArgs('wsl'), null)
})

test('on Windows, listWorktrees adds the omitted WSL environment with \\\\wsl.localhost paths', async () => {
  stub.ok('worktree list', { worktrees: [{ path: 'C:\\repo', displayName: 'win' }], hostScope: omitted })
  stub.ok('worktree list wsl', { worktrees: [{ path: '/home/me/card', displayName: 'card' }, { path: 'odd', displayName: 'skip' }] })
  const seen = []
  const list = await cli.listWorktrees(win('Ubuntu-26.04', seen))
  assert.deepEqual(list, [
    { path: 'C:\\repo', displayName: 'win' },
    { path: '\\\\wsl.localhost\\Ubuntu-26.04\\home\\me\\card', displayName: 'card', orcaSelector: '--environment wsl', orcaPath: '/home/me/card' }
  ])
  assert.deepEqual(seen, [['--environment wsl', ['/home/me/card']]])
  // Hosts with no selector are not asked; the environment is asked once.
  assert.deepEqual(stub.calls(), [
    ['worktree', 'list', '--json'],
    ['worktree', 'list', '--environment', 'wsl', '--json']
  ])
})

test('on Windows, an environment that is not a local WSL distro, or is down, is left out', async () => {
  stub.ok('worktree list', { worktrees: [{ path: 'C:\\repo' }], hostScope: omitted })
  stub.ok('worktree list wsl', { worktrees: [{ path: '/srv/remote' }] })
  assert.deepEqual(await cli.listWorktrees(win(null)), [{ path: 'C:\\repo' }])
  stub.respond('worktree list wsl', { stderr: 'unreachable', exit: 1 })
  assert.deepEqual(await cli.listWorktrees(win()), [{ path: 'C:\\repo' }])
})

test('off Windows, omitted hosts are not listed, so macOS and Linux behave as before', async () => {
  stub.ok('worktree list', { worktrees: [{ path: '/repo' }], hostScope: omitted })
  assert.deepEqual(await cli.listWorktrees({ platform: 'darwin', resolveDistro: () => assert.fail('no probe') }), [{ path: '/repo' }])
  assert.deepEqual(await cli.listWorktrees({ platform: 'linux' }), [{ path: '/repo' }])
  assert.deepEqual(stub.calls(), [
    ['worktree', 'list', '--json'],
    ['worktree', 'list', '--json']
  ])
})

test('on Windows, listTerminals maps WSL terminal paths the same way', async () => {
  stub.ok('terminal list', { terminals: [], hostScope: omitted })
  stub.ok('terminal list wsl', { terminals: [{ handle: 't1', worktreePath: '/home/me/card' }] })
  assert.deepEqual(await cli.listTerminals(win()), [
    { handle: 't1', worktreePath: '\\\\wsl.localhost\\Ubuntu-26.04\\home\\me\\card', orcaSelector: '--environment wsl', orcaPath: '/home/me/card' }
  ])
})

test('WSL paths go back to the Orca CLI as Linux paths with their --environment', async () => {
  stub.ok('worktree list', { worktrees: [], hostScope: omitted })
  stub.ok('worktree list wsl', { worktrees: [{ path: '/home/me/listed' }] })
  await cli.listWorktrees(win('Ubuntu'))
  assert.deepEqual(cli.orcaLocation('\\\\wsl.localhost\\Ubuntu\\home\\me\\listed'), { orcaPath: '/home/me/listed', extra: ['--environment', 'wsl'] })
  // Not listed yet: still a WSL path, so Orca's "wsl" environment.
  assert.deepEqual(cli.orcaLocation('\\\\wsl.localhost\\Other\\home\\me\\x'), { orcaPath: '/home/me/x', extra: ['--environment', 'wsl'] })
  assert.deepEqual(cli.orcaLocation('/repo'), { orcaPath: '/repo', extra: [] })

  stub.reset()
  stub.ok('worktree create', { worktree: {} })
  await cli.createWorktree({ repoPath: '\\\\wsl.localhost\\Ubuntu\\home\\me\\listed', name: 'x', baseBranch: 'main' })
  stub.respond('terminal list', { stderr: 'down', exit: 1 })
  await cli.openWorktree('\\\\wsl.localhost\\Ubuntu\\home\\me\\listed-x')
  const calls = stub.calls()
  assert.deepEqual(calls[0], ['worktree', 'create', '--repo', 'path:/home/me/listed', '--name', 'x', '--activate', '--base-branch', 'main', '--environment', 'wsl', '--json'])
  assert.deepEqual(calls.at(-1), ['terminal', 'create', '--worktree', 'path:/home/me/listed-x', '--focus', '--environment', 'wsl', '--json'])
})

test('openWorktree switches to a WSL terminal through its environment', async () => {
  stub.ok('terminal list', { terminals: [], hostScope: omitted })
  stub.ok('terminal list wsl', { terminals: [{ handle: 'live', worktreePath: '/home/me/card' }] })
  assert.deepEqual(await cli.openWorktree('\\\\wsl.localhost\\Ubuntu-26.04\\home\\me\\card', win()), { opened: true, via: 'terminal' })
  assert.deepEqual(stub.calls().at(-1), ['terminal', 'switch', '--terminal', 'live', '--environment', 'wsl', '--json'])
})
