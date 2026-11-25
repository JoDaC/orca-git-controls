// Windows + WSL: path mapping, distro detection, and git run through wsl.exe.
// The git tests use a stand-in wsl.exe (a shell script) that runs the command in --cd locally,
// so they need a POSIX shell and are skipped on Windows.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync, readFileSync, existsSync, rmSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import * as w from '../lib/wsl.mjs'
import * as g from '../lib/git.mjs'
import { makeRepo, sh, commitFile, fresh, root } from './helpers/repo.mjs'

test('parseWslPath reads \\\\wsl.localhost and \\\\wsl$ paths, with either slash', () => {
  assert.deepEqual(w.parseWslPath('\\\\wsl.localhost\\Ubuntu-24.04\\home\\me\\repo'), { distro: 'Ubuntu-24.04', linuxPath: '/home/me/repo' })
  assert.deepEqual(w.parseWslPath('\\\\wsl$\\Ubuntu\\home\\me\\repo\\'), { distro: 'Ubuntu', linuxPath: '/home/me/repo' })
  assert.deepEqual(w.parseWslPath('//wsl.localhost/Debian/srv/x'), { distro: 'Debian', linuxPath: '/srv/x' })
  assert.deepEqual(w.parseWslPath('\\\\wsl.localhost\\Ubuntu'), { distro: 'Ubuntu', linuxPath: '/' })
  for (const p of ['/home/me/repo', 'C:\\Users\\me\\repo', '\\\\server\\share\\repo', '', null, undefined]) {
    assert.equal(w.parseWslPath(p), null, String(p))
  }
})

test('toWslPath and parseWslPath round-trip', () => {
  const unc = w.toWslPath('Ubuntu-26.04', '/home/wist/workspace/google/business-card/')
  assert.equal(unc, '\\\\wsl.localhost\\Ubuntu-26.04\\home\\wist\\workspace\\google\\business-card')
  assert.deepEqual(w.parseWslPath(unc), { distro: 'Ubuntu-26.04', linuxPath: '/home/wist/workspace/google/business-card' })
})

test('fromWslGitPath maps git output only for WSL repositories', () => {
  const cwd = '\\\\wsl.localhost\\Ubuntu\\home\\me\\repo'
  assert.equal(w.fromWslGitPath(cwd, '/home/me/repo-wt'), '\\\\wsl.localhost\\Ubuntu\\home\\me\\repo-wt')
  assert.equal(w.fromWslGitPath(cwd, 'relative'), 'relative')
  assert.equal(w.fromWslGitPath('/home/me/repo', '/home/me/repo-wt'), '/home/me/repo-wt')
  assert.equal(w.fromWslGitPath('C:\\repo', 'C:/repo-wt'), 'C:/repo-wt')
})

test('wslCommandArgs runs the command in the distro, in the folder, with env set', () => {
  assert.deepEqual(w.wslCommandArgs('Ubuntu', '/home/me/repo', 'git', ['status', '-z'], { LC_ALL: 'C', SKIP: undefined }), [
    '-d', 'Ubuntu', '--cd', '/home/me/repo', '--exec', 'env', 'LC_ALL=C', 'git', 'status', '-z'
  ])
})

test('decodeWslOutput reads wsl.exe UTF-16 messages and passes UTF-8 through', () => {
  assert.equal(w.decodeWslOutput(Buffer.from('\uFEFFUbuntu\r\n', 'utf16le')), 'Ubuntu\r\n')
  assert.equal(w.decodeWslOutput(Buffer.from('main\n', 'utf8')), 'main\n')
  assert.equal(w.decodeWslOutput(Buffer.alloc(0)), '')
  assert.equal(w.decodeWslOutput(Buffer.from('Ubuntu\n', 'utf16le')), 'Ubuntu\n')
  // NUL-separated git output (-z) is not mistaken for UTF-16.
  assert.equal(w.decodeWslOutput(Buffer.from('?? a\0M  b\0', 'utf8')), '?? a\0M  b\0')
  assert.equal(w.decodeWslOutput(Buffer.from('a\0', 'utf8')), 'a\0')
})

test('windowsEnv fills the per-user variables Orca leaves out of a worker, on Windows only', () => {
  const base = { Path: 'C:\\bin', USERPROFILE: 'C:\\Users\\me' }
  assert.deepEqual(w.windowsEnv(base, 'win32'), {
    Path: 'C:\\bin',
    USERPROFILE: 'C:\\Users\\me',
    APPDATA: 'C:\\Users\\me\\AppData\\Roaming',
    LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local',
    SystemRoot: 'C:\\Windows'
  })
  // Names are case-insensitive and values already there win.
  const set = { Path: 'x', userprofile: 'D:\\u', AppData: 'E:\\roam', localappdata: 'E:\\local', SYSTEMROOT: 'F:\\Win' }
  assert.deepEqual(w.windowsEnv(set, 'win32'), set)
  assert.equal(w.windowsEnv({ windir: 'G:\\Win', USERPROFILE: 'C:\\u' }, 'win32').SystemRoot, 'G:\\Win')
  assert.equal(w.windowsEnv(base, 'darwin'), base)
  assert.equal(w.windowsEnv(base, 'linux'), base)
})

test('parseDistroList drops blanks, NULs and docker-desktop', () => {
  assert.deepEqual(w.parseDistroList('Ubuntu-20.04\r\ndocker-desktop\r\n\r\nUbuntu-26.04\0\r\n'), ['Ubuntu-20.04', 'Ubuntu-26.04'])
})

test('the distro probe does not match its own command line', () => {
  // pgrep -f also sees the `sh -c PROBE` running it; the pattern must not match that text.
  assert.doesNotMatch(w.PROBE, /orca.* serve/)
  assert.equal(w.scoreProbe('ORCA\npaths 2\n'), 102)
  assert.equal(w.scoreProbe('paths 1\n'), 1)
  assert.equal(w.scoreProbe(''), 0)
})

test('resolveDistro prefers the running distro with an Orca server, then one with the paths', async () => {
  w.clearDistroCache()
  delete process.env.ORCA_GIT_CONTROLS_WSL_DISTRO
  const calls = []
  const answers = { A: 'paths 2\n', B: 'ORCA\npaths 1\n', C: 'paths 0\n' }
  const run = async (args) => {
    calls.push(args)
    if (args[0] === '-l') return { code: 0, stdout: 'A\r\nB\r\nC\r\n', stderr: '' }
    return { code: 0, stdout: answers[args[1]], stderr: '' }
  }
  assert.equal(await w.resolveDistro('--environment wsl', ['/home/me/a', 'relative', '/home/me/b'], { run }), 'B')
  assert.deepEqual(calls[0], ['-l', '-q', '--running'])
  assert.deepEqual(calls[1].slice(0, 6), ['-d', 'A', '--exec', 'sh', '-c', w.PROBE])
  assert.deepEqual(calls[1].slice(6), ['probe', '/home/me/a', '/home/me/b'])
  // Cached: no more wsl.exe calls.
  assert.equal(await w.resolveDistro('--environment wsl', [], { run }), 'B')
  assert.equal(calls.length, 4)

  w.clearDistroCache()
  answers.B = 'paths 1\n'
  assert.equal(await w.resolveDistro('k', ['/x'], { run }), 'A')
  w.clearDistroCache()
  assert.equal(await w.resolveDistro('k', ['/x'], { run: async (a) => (a[0] === '-l' ? { code: 0, stdout: 'A\n' } : { code: 0, stdout: 'paths 0\n' }) }), null)
  assert.equal(await w.resolveDistro('k', ['/x'], { run: async () => ({ code: 1, stdout: '' }) }), null)

  process.env.ORCA_GIT_CONTROLS_WSL_DISTRO = 'Pinned'
  assert.equal(await w.resolveDistro('k', [], { run: () => assert.fail('no probe when pinned') }), 'Pinned')
  delete process.env.ORCA_GIT_CONTROLS_WSL_DISTRO
})

// ---- git through wsl.exe --------------------------------------------------------

const posixOnly = { skip: process.platform === 'win32' && 'needs a POSIX shell for the stand-in wsl.exe' }

function installFakeWsl() {
  const dir = fresh('fake-wsl')
  mkdirSync(dir, { recursive: true })
  const bin = path.join(dir, 'wsl.exe')
  const log = path.join(dir, 'calls.log')
  // Checks the argument shape git() uses, then runs the command in --cd.
  writeFileSync(
    bin,
    `#!/bin/sh
printf '%s\\n' "$*" >> "${log}"
[ "$1" = -d ] || exit 91; shift 2
[ "$1" = --cd ] || exit 92; cd "$2" || exit 93; shift 2
[ "$1" = --exec ] || exit 94; shift
exec "$@"
`,
    { mode: 0o755 }
  )
  process.env.ORCA_GIT_CONTROLS_WSL = bin
  return { calls: () => (existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean) : []) }
}

const asWsl = (p) => w.toWslPath('Fake', p)

test('git runs through wsl.exe for a WSL path and maps the paths it prints', posixOnly, async () => {
  const fake = installFakeWsl()
  const { work } = await makeRepo()
  const wt = `${work}-wt`
  await sh(work, 'worktree', 'add', '-q', '-b', 'side', wt)
  const cwd = asWsl(work)

  const info = await g.repoInfo(cwd)
  assert.equal(info.toplevel, asWsl(work))
  assert.equal(info.gitDir, asWsl(`${work}/.git`))
  assert.equal(info.commonDir, asWsl(`${work}/.git`))
  assert.equal(info.branch, 'main')

  // A linked worktree's common dir is printed relative or absolute; both map to the main .git.
  assert.equal((await g.repoInfo(asWsl(wt))).commonDir, asWsl(`${work}/.git`))

  const wts = await g.listWorktrees(cwd)
  assert.deepEqual(wts.map((x) => x.path), [g.normalizePath(asWsl(work)), g.normalizePath(asWsl(wt))])

  const refs = await g.listRefs(cwd)
  const side = refs.local.find((b) => b.name === 'side')
  assert.equal(side.worktreePath, g.normalizePath(asWsl(wt)))
  assert.equal(side.checkedOutElsewhere, true)
  assert.equal(refs.local.find((b) => b.name === 'main').checkedOutElsewhere, false)

  const conflict = await g.checkout(cwd, 'side')
  assert.equal(conflict.status, 'worktree-conflict')
  assert.equal(conflict.worktreePath, g.normalizePath(asWsl(wt)))

  // Every call went through wsl.exe with the distro, the Linux folder and git's environment.
  const calls = fake.calls()
  assert.ok(calls.length > 5)
  assert.ok(calls.every((c) => c.startsWith(`-d Fake --cd ${work}`) || c.startsWith(`-d Fake --cd ${wt}`)), calls[0])
  assert.match(calls[0], / --exec env GIT_TERMINAL_PROMPT=0 .*GIT_OPTIONAL_LOCKS=0 LC_ALL=C git /)
})

test('stdin, -z output and git errors work the same through wsl.exe', posixOnly, async () => {
  installFakeWsl()
  const { work } = await makeRepo()
  const cwd = asWsl(work)
  await commitFile(work, 'b.txt', 'two\n')
  writeFileSync(path.join(work, 'a.txt'), 'changed\n')
  writeFileSync(path.join(work, 'new file.txt'), 'x\n')

  const st = await g.status(cwd)
  assert.deepEqual(st.map((e) => e.path).sort(), ['a.txt', 'new file.txt'])

  const patch = await g.createPatch(cwd)
  await sh(work, 'checkout', '--', 'a.txt')
  rmSync(path.join(work, 'new file.txt'))
  assert.equal((await g.applyPatch(cwd, patch)).status, 'ok')
  assert.equal(readFileSync(path.join(work, 'a.txt'), 'utf8'), 'changed\n')
  assert.equal(readFileSync(path.join(work, 'new file.txt'), 'utf8'), 'x\n')

  await assert.rejects(g.git(cwd, ['rev-parse', 'no-such-ref']), (e) => {
    assert.ok(e instanceof g.GitError)
    assert.match(e.message, /no-such-ref/)
    return true
  })
  assert.equal((await g.git(cwd, ['rev-parse', 'no-such-ref'], { allowFail: true })).code, 128)
})

test('git through wsl.exe reports a missing wsl.exe as a GitError', posixOnly, async () => {
  process.env.ORCA_GIT_CONTROLS_WSL = path.join(root, 'no-such-wsl.exe')
  await assert.rejects(g.git(asWsl('/tmp'), ['status']), (e) => e instanceof g.GitError && /ENOENT/.test(e.message))
  delete process.env.ORCA_GIT_CONTROLS_WSL
})
