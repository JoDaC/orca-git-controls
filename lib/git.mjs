// Git layer for the Orca Git Controls plugin.
// Every function takes the repository path (the Orca workspace checkout) as `cwd`.
// Failures throw GitError, which carries git's stderr verbatim so the panel can show it.

import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'

const GIT_CANDIDATES = ['/opt/homebrew/bin/git', '/usr/local/bin/git', '/usr/bin/git']

let gitBinary = null
export function gitPath() {
  if (gitBinary) return gitBinary
  gitBinary = process.env.ORCA_GIT_CONTROLS_GIT || GIT_CANDIDATES.find((p) => existsSync(p)) || 'git'
  return gitBinary
}

export class GitError extends Error {
  constructor(args, code, stdout, stderr) {
    const text = (stderr || stdout || '').trim()
    super(text || `git ${args.join(' ')} failed with exit code ${code}`)
    this.name = 'GitError'
    this.args = args
    this.exitCode = code
    this.stdout = stdout
    this.stderr = stderr
  }
}

/** Runs git and resolves { stdout, stderr, code }. Rejects with GitError on a non-zero exit. */
export function git(cwd, args, { input, allowFail = false, timeoutMs = 120_000, env } = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(
      gitPath(),
      args,
      {
        cwd,
        maxBuffer: 64 * 1024 * 1024,
        timeout: timeoutMs,
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: '0',
          GIT_EDITOR: 'true',
          GIT_SEQUENCE_EDITOR: 'true',
          GIT_MERGE_AUTOEDIT: 'no',
          LC_ALL: 'C',
          ...env
        }
      },
      (error, stdout, stderr) => {
        const code = error ? (typeof error.code === 'number' ? error.code : 1) : 0
        if (error && typeof error.code !== 'number' && !allowFail) {
          // spawn failure (ENOENT) or timeout
          const e = new GitError(args, code, stdout, stderr || error.message)
          return reject(e)
        }
        if (code !== 0 && !allowFail) return reject(new GitError(args, code, stdout, stderr))
        resolve({ stdout, stderr, code })
      }
    )
    if (input !== undefined) {
      child.stdin.end(input)
    }
  })
}

async function out(cwd, args, opts) {
  return (await git(cwd, args, opts)).stdout
}

// ---------------------------------------------------------------------------
// Repository info

export async function repoInfo(cwd) {
  const raw = await out(cwd, [
    'rev-parse',
    '--show-toplevel',
    '--absolute-git-dir',
    '--git-common-dir'
  ])
  const [toplevel, gitDir, commonDirRaw] = raw.trim().split('\n')
  const commonDir = path.resolve(toplevel, commonDirRaw)
  const head = await currentHead(toplevel)
  return { toplevel, gitDir, commonDir, ...head, state: repoState(gitDir) }
}

/** { branch, detached, sha }. `branch` is null when HEAD is detached; sha is null on an unborn branch. */
export async function currentHead(cwd) {
  const sym = await git(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD'], { allowFail: true })
  const shaRes = await git(cwd, ['rev-parse', '--verify', '--quiet', 'HEAD'], { allowFail: true })
  const sha = shaRes.code === 0 ? shaRes.stdout.trim() : null
  if (sym.code === 0) return { branch: sym.stdout.trim(), detached: false, sha }
  return { branch: null, detached: true, sha }
}

export function repoState(gitDir) {
  if (existsSync(path.join(gitDir, 'rebase-merge')) || existsSync(path.join(gitDir, 'rebase-apply')))
    return 'rebasing'
  if (existsSync(path.join(gitDir, 'MERGE_HEAD'))) return 'merging'
  if (existsSync(path.join(gitDir, 'CHERRY_PICK_HEAD'))) return 'cherry-picking'
  if (existsSync(path.join(gitDir, 'REVERT_HEAD'))) return 'reverting'
  return 'clean'
}

// ---------------------------------------------------------------------------
// Branch listing

const SEP = '\x1f'
const REF_FORMAT = [
  '%(refname)',
  '%(objectname)',
  '%(upstream)',
  '%(upstream:short)',
  '%(upstream:track,nobracket)',
  '%(HEAD)',
  '%(worktreepath)',
  '%(committerdate:unix)',
  '%(symref)',
  '%(subject)'
].join(SEP)

/** Parses `%(upstream:track,nobracket)`: "ahead 2, behind 1", "gone" or "". */
export function parseTrack(track) {
  const result = { ahead: 0, behind: 0, gone: false }
  if (!track) return result
  if (track.trim() === 'gone') return { ...result, gone: true }
  const ahead = /ahead (\d+)/.exec(track)
  const behind = /behind (\d+)/.exec(track)
  if (ahead) result.ahead = Number(ahead[1])
  if (behind) result.behind = Number(behind[1])
  return result
}

export async function listRemotes(cwd) {
  return (await out(cwd, ['remote'])).split('\n').filter(Boolean)
}

/**
 * Lists local branches, remote branches and tags.
 * Local branches carry ahead/behind vs their upstream ("outgoing"/"incoming") and the
 * worktree that has them checked out, if any.
 */
export async function listRefs(cwd) {
  const [raw, remotes, info] = await Promise.all([
    out(cwd, ['for-each-ref', `--format=${REF_FORMAT}`, 'refs/heads', 'refs/remotes', 'refs/tags']),
    listRemotes(cwd),
    repoInfo(cwd)
  ])
  const local = []
  const remote = []
  const tags = []
  const here = normalizePath(info.toplevel)
  // Longest remote names first so "origin-2/x" is not matched as remote "origin".
  const remoteNames = [...remotes].sort((a, b) => b.length - a.length)
  for (const line of raw.split('\n')) {
    if (!line) continue
    const [ref, sha, upstreamRef, upstream, track, head, worktreePath, date, symref, subject] =
      line.split(SEP)
    if (ref.startsWith('refs/heads/')) {
      const name = ref.slice('refs/heads/'.length)
      const wt = worktreePath ? normalizePath(worktreePath) : null
      local.push({
        name,
        sha,
        upstream: upstream || null,
        upstreamRef: upstreamRef || null,
        ...parseTrack(track),
        current: head === '*',
        worktreePath: wt,
        checkedOutElsewhere: Boolean(wt && wt !== here),
        date: Number(date) || 0,
        subject
      })
    } else if (ref.startsWith('refs/remotes/')) {
      if (symref) continue // origin/HEAD
      const full = ref.slice('refs/remotes/'.length)
      const remoteName = remoteNames.find((r) => full.startsWith(r + '/')) ?? full.split('/')[0]
      remote.push({
        name: full,
        remote: remoteName,
        branch: full.slice(remoteName.length + 1),
        sha,
        date: Number(date) || 0,
        subject
      })
    } else if (ref.startsWith('refs/tags/')) {
      tags.push({ name: ref.slice('refs/tags/'.length), sha, date: Number(date) || 0, subject })
    }
  }
  return { info, local, remote, tags, remotes }
}

export function normalizePath(p) {
  return path.resolve(p).replace(/\/+$/, '')
}

/**
 * Groups names into folders by "/" the way Android Studio does: "feature/login" lands in
 * folder "feature". Returns { folders: [{ name, path, children }], items: [...] } sorted with
 * folders first. `getName` picks the string to split.
 */
export function groupByFolder(items, getName = (x) => x.name, prefix = '') {
  const root = { name: '', path: prefix, folders: new Map(), items: [] }
  for (const item of items) {
    const parts = getName(item).split('/')
    let node = root
    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i]
      if (!node.folders.has(part)) {
        node.folders.set(part, {
          name: part,
          path: node.path ? `${node.path}/${part}` : part,
          folders: new Map(),
          items: []
        })
      }
      node = node.folders.get(part)
    }
    node.items.push(item)
  }
  const finish = (node) => ({
    name: node.name,
    path: node.path,
    folders: [...node.folders.values()]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(finish),
    items: node.items.sort((a, b) => getName(a).localeCompare(getName(b)))
  })
  return finish(root)
}

/** Groups remote branches by remote, then by "/" folders within each remote. */
export function groupRemotes(remoteBranches, remotes) {
  const byRemote = new Map(remotes.map((r) => [r, []]))
  for (const b of remoteBranches) {
    if (!byRemote.has(b.remote)) byRemote.set(b.remote, [])
    byRemote.get(b.remote).push(b)
  }
  return [...byRemote.entries()]
    .sort(([a], [b]) => (a === 'origin' ? -1 : b === 'origin' ? 1 : a.localeCompare(b)))
    .map(([remote, branches]) => ({
      remote,
      tree: groupByFolder(branches, (b) => b.branch, remote)
    }))
}

/**
 * Recently checked-out branches, newest first, from the HEAD reflog
 * ("checkout: moving from A to B"). Only branches that still exist locally are returned.
 */
export async function recentBranches(cwd, { limit = 5, existing } = {}) {
  const res = await git(cwd, ['reflog', 'show', '--format=%gs', '-n', '1000', 'HEAD'], {
    allowFail: true
  })
  if (res.code !== 0) return []
  return parseRecentFromReflog(res.stdout, { limit, existing })
}

export function parseRecentFromReflog(text, { limit = 5, existing } = {}) {
  const seen = new Set()
  const result = []
  for (const line of text.split('\n')) {
    const m = /^checkout: moving from (.+) to (.+)$/.exec(line.trim())
    if (!m) continue
    for (const name of [m[2], m[1]]) {
      if (seen.has(name)) continue
      seen.add(name)
      if (existing && !existing.has(name)) continue
      result.push(name)
      if (result.length >= limit) return result
    }
  }
  return result
}

// ---------------------------------------------------------------------------
// Working tree status

/** Changed paths from `git status --porcelain=v1 -z`. */
export async function status(cwd) {
  const raw = await out(cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])
  const entries = []
  const parts = raw.split('\0')
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]
    if (!p) continue
    const x = p[0]
    const y = p[1]
    const file = p.slice(3)
    const entry = { x, y, path: file, untracked: x === '?' }
    if (x === 'R' || x === 'C') {
      entry.from = parts[++i]
    }
    entries.push(entry)
  }
  return entries
}

export async function isDirty(cwd) {
  return (await status(cwd)).some((e) => !e.untracked)
}

// ---------------------------------------------------------------------------
// Worktrees

export async function listWorktrees(cwd) {
  const raw = await out(cwd, ['worktree', 'list', '--porcelain'])
  const list = []
  let cur = null
  for (const line of raw.split('\n')) {
    if (line.startsWith('worktree ')) {
      cur = { path: normalizePath(line.slice(9)), branch: null, head: null, detached: false }
      list.push(cur)
    } else if (!cur) continue
    else if (line.startsWith('HEAD ')) cur.head = line.slice(5)
    else if (line.startsWith('branch ')) cur.branch = line.slice(7).replace(/^refs\/heads\//, '')
    else if (line === 'detached') cur.detached = true
    else if (line === 'bare') cur.bare = true
    else if (line.startsWith('locked')) cur.locked = true
    else if (line.startsWith('prunable')) cur.prunable = true
  }
  return list
}

/** The other worktree that has `branch` checked out, or null. */
export async function worktreeHolding(cwd, branch) {
  const here = normalizePath((await out(cwd, ['rev-parse', '--show-toplevel'])).trim())
  const wts = await listWorktrees(cwd)
  return wts.find((w) => w.branch === branch && w.path !== here) ?? null
}

/** Extracts the worktree path from git's "already checked out" / "already used by worktree" errors. */
export function parseWorktreeConflict(message) {
  const m =
    /is already (?:checked out|used by worktree) at '([^']+)'/.exec(message) ||
    /checked out at '([^']+)'/.exec(message)
  return m ? m[1] : null
}

const OVERWRITE_PATTERNS = [
  /Your local changes to the following files would be overwritten by checkout:\n([\s\S]*?)\nPlease/,
  /The following untracked working tree files would be overwritten by checkout:\n([\s\S]*?)\nPlease/
]

/** Files git listed as "would be overwritten by checkout", or null if the error is something else. */
export function parseOverwrittenFiles(message) {
  for (const re of OVERWRITE_PATTERNS) {
    const m = re.exec(message)
    if (m) {
      return {
        untracked: re === OVERWRITE_PATTERNS[1],
        files: m[1]
          .split('\n')
          .map((s) => s.trim())
          .filter(Boolean)
      }
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// Checkout

/**
 * Checks out `target` (a local branch, a tag, or any revision).
 * mode:
 *  - 'normal': plain checkout. If git refuses because local changes would be overwritten,
 *    returns { status: 'needs-decision', files } so the UI can offer Smart/Force checkout.
 *  - 'smart': stash, checkout, unstash. Unstash conflicts are reported, stash kept.
 *  - 'force': discard local changes (`checkout --force`).
 * Returns { status: 'worktree-conflict', worktreePath } when another worktree has the branch.
 */
export async function checkout(cwd, target, { mode = 'normal', detach = false } = {}) {
  const isLocalBranch = await refExists(cwd, `refs/heads/${target}`)
  if (isLocalBranch && !detach) {
    const holder = await worktreeHolding(cwd, target)
    if (holder) return { status: 'worktree-conflict', worktreePath: holder.path, branch: target }
  }
  const args = ['checkout']
  if (mode === 'force') args.push('--force')
  if (detach || !isLocalBranch) args.push('--detach')
  args.push(target, '--')

  if (mode === 'smart') return smartCheckout(cwd, args, target)

  const res = await git(cwd, args, { allowFail: true })
  if (res.code === 0) return { status: 'ok', output: (res.stderr + res.stdout).trim() }
  const message = res.stderr || res.stdout
  const wt = parseWorktreeConflict(message)
  if (wt) return { status: 'worktree-conflict', worktreePath: normalizePath(wt), branch: target }
  const over = parseOverwrittenFiles(message)
  if (over && mode === 'normal') return { status: 'needs-decision', ...over, message: message.trim() }
  throw new GitError(args, res.code, res.stdout, res.stderr)
}

async function smartCheckout(cwd, checkoutArgs, target) {
  const stashMessage = `orca-git-controls: smart checkout to ${target}`
  const before = await stashTop(cwd)
  await git(cwd, ['stash', 'push', '--include-untracked', '-m', stashMessage])
  const after = await stashTop(cwd)
  const stashed = after !== null && after !== before
  const res = await git(cwd, checkoutArgs, { allowFail: true })
  if (res.code !== 0) {
    // Put the changes back where they were, then report git's error verbatim.
    if (stashed) await git(cwd, ['stash', 'pop', '--index'], { allowFail: true })
    throw new GitError(checkoutArgs, res.code, res.stdout, res.stderr)
  }
  if (!stashed) return { status: 'ok', output: (res.stderr + res.stdout).trim() }
  const pop = await git(cwd, ['stash', 'pop'], { allowFail: true })
  if (pop.code === 0) return { status: 'ok', output: (res.stderr + res.stdout).trim(), smart: true }
  const conflicts = (await status(cwd))
    .filter((e) => e.x === 'U' || e.y === 'U' || (e.x === 'A' && e.y === 'A') || (e.x === 'D' && e.y === 'D'))
    .map((e) => e.path)
  // Untracked files that now exist in the target branch: "x already exists, no checkout".
  for (const m of (pop.stderr + pop.stdout).matchAll(/^(.+) already exists, no checkout$/gm)) {
    if (!conflicts.includes(m[1])) conflicts.push(m[1])
  }
  return {
    status: 'unstash-conflict',
    conflicts,
    message: (pop.stderr + pop.stdout).trim(),
    stashKept: true
  }
}

async function stashTop(cwd) {
  const res = await git(cwd, ['rev-parse', '--verify', '--quiet', 'refs/stash'], { allowFail: true })
  return res.code === 0 ? res.stdout.trim() : null
}

export async function refExists(cwd, ref) {
  return (await git(cwd, ['show-ref', '--verify', '--quiet', ref], { allowFail: true })).code === 0
}

/**
 * Checks out a remote branch as a local tracking branch (Android Studio's "Checkout" on a
 * remote branch). If a local branch with that name already tracks it, that branch is checked out.
 */
export async function checkoutRemote(cwd, remoteBranch, { localName, mode = 'normal' } = {}) {
  const { remote, branch } = await splitRemoteBranch(cwd, remoteBranch)
  const name = localName || branch
  if (await refExists(cwd, `refs/heads/${name}`)) {
    return checkout(cwd, name, { mode })
  }
  const args = ['checkout']
  if (mode === 'force') args.push('--force')
  args.push('--track', '-b', name, `${remote}/${branch}`)
  if (mode === 'smart') return smartCheckout(cwd, args, name)
  const res = await git(cwd, args, { allowFail: true })
  if (res.code === 0) return { status: 'ok', output: (res.stderr + res.stdout).trim() }
  const message = res.stderr || res.stdout
  const over = parseOverwrittenFiles(message)
  if (over && mode === 'normal') return { status: 'needs-decision', ...over, message: message.trim() }
  throw new GitError(args, res.code, res.stdout, res.stderr)
}

export async function splitRemoteBranch(cwd, remoteBranch) {
  const remotes = (await listRemotes(cwd)).sort((a, b) => b.length - a.length)
  const remote = remotes.find((r) => remoteBranch.startsWith(r + '/'))
  if (!remote) throw new GitError([], 1, '', `No remote matches '${remoteBranch}'`)
  return { remote, branch: remoteBranch.slice(remote.length + 1) }
}

// ---------------------------------------------------------------------------
// Branch operations

export async function createBranch(cwd, name, startPoint, { checkout: doCheckout = true } = {}) {
  await git(cwd, ['check-ref-format', '--branch', name])
  if (doCheckout) {
    const args = ['checkout', '-b', name]
    if (startPoint) args.push(startPoint)
    const res = await git(cwd, args, { allowFail: true })
    if (res.code === 0) return { status: 'ok', output: (res.stderr + res.stdout).trim() }
    const over = parseOverwrittenFiles(res.stderr)
    if (over) return { status: 'needs-decision', ...over, message: res.stderr.trim() }
    throw new GitError(args, res.code, res.stdout, res.stderr)
  }
  await git(cwd, ['branch', name, ...(startPoint ? [startPoint] : [])])
  return { status: 'ok' }
}

export async function renameBranch(cwd, from, to) {
  await git(cwd, ['branch', '-m', from, to])
  return { status: 'ok' }
}

/**
 * Deletes a local branch. Without `force`, an unmerged branch returns
 * { status: 'unmerged' } so the UI can ask before running `branch -D`.
 */
export async function deleteBranch(cwd, name, { force = false } = {}) {
  const args = ['branch', force ? '-D' : '-d', name]
  const res = await git(cwd, args, { allowFail: true })
  if (res.code === 0) return { status: 'ok', output: res.stdout.trim() }
  if (!force && /not fully merged/.test(res.stderr)) {
    return { status: 'unmerged', message: res.stderr.trim() }
  }
  const wt = parseWorktreeConflict(res.stderr)
  if (wt) return { status: 'worktree-conflict', worktreePath: normalizePath(wt), branch: name }
  throw new GitError(args, res.code, res.stdout, res.stderr)
}

export async function deleteRemoteBranch(cwd, remoteBranch) {
  const { remote, branch } = await splitRemoteBranch(cwd, remoteBranch)
  const res = await git(cwd, ['push', remote, '--delete', branch])
  return { status: 'ok', output: (res.stderr + res.stdout).trim() }
}

export async function merge(cwd, ref) {
  const res = await git(cwd, ['merge', '--no-edit', ref], { allowFail: true })
  return opResult(res, ['merge', ref], cwd)
}

/** Rebases the current branch onto `onto`. */
export async function rebase(cwd, onto) {
  const res = await git(cwd, ['rebase', onto], { allowFail: true })
  return opResult(res, ['rebase', onto], cwd)
}

/** Checks out `branch` and rebases it onto `onto` (Android Studio's "Checkout and Rebase onto"). */
export async function checkoutAndRebase(cwd, branch, onto) {
  const holder = await worktreeHolding(cwd, branch)
  if (holder) return { status: 'worktree-conflict', worktreePath: holder.path, branch }
  const res = await git(cwd, ['rebase', onto, branch], { allowFail: true })
  return opResult(res, ['rebase', onto, branch], cwd)
}

export async function abortOperation(cwd) {
  const info = await repoInfo(cwd)
  if (info.state === 'rebasing') await git(cwd, ['rebase', '--abort'])
  else if (info.state === 'merging') await git(cwd, ['merge', '--abort'])
  else if (info.state === 'cherry-picking') await git(cwd, ['cherry-pick', '--abort'])
  else if (info.state === 'reverting') await git(cwd, ['revert', '--abort'])
  return { status: 'ok' }
}

export async function continueOperation(cwd) {
  const info = await repoInfo(cwd)
  const op = { rebasing: 'rebase', merging: 'merge', 'cherry-picking': 'cherry-pick', reverting: 'revert' }[
    info.state
  ]
  if (!op) return { status: 'ok' }
  if (op === 'merge') {
    const res = await git(cwd, ['commit', '--no-edit'], { allowFail: true })
    return opResult(res, ['commit', '--no-edit'], cwd)
  }
  const res = await git(cwd, [op, '--continue'], { allowFail: true })
  return opResult(res, [op, '--continue'], cwd)
}

/** Turns merge/rebase/pull results into ok or { status: 'conflict', files, message }. */
async function opResult(res, args, cwd) {
  const output = (res.stdout + res.stderr).trim()
  if (res.code === 0) return { status: 'ok', output }
  const st = await status(cwd).catch(() => [])
  const conflicts = st
    .filter((e) => e.x === 'U' || e.y === 'U' || (e.x === 'A' && e.y === 'A') || (e.x === 'D' && e.y === 'D'))
    .map((e) => e.path)
  if (conflicts.length) return { status: 'conflict', conflicts, message: output }
  throw new GitError(args, res.code, res.stdout, res.stderr)
}

// ---------------------------------------------------------------------------
// Compare and diff

const LOG_FORMAT = '%H%x1f%h%x1f%an%x1f%at%x1f%s'

function parseLog(raw) {
  return raw
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const [sha, short, author, at, subject] = l.split('\x1f')
      return { sha, short, author, date: Number(at), subject }
    })
}

/** Commits in `other` not in `base`, and in `base` not in `other` (Compare with <current>). */
export async function compare(cwd, base, other, { max = 500 } = {}) {
  const [incoming, outgoing] = await Promise.all([
    out(cwd, ['log', `--format=${LOG_FORMAT}`, '-n', String(max), `${base}..${other}`]),
    out(cwd, ['log', `--format=${LOG_FORMAT}`, '-n', String(max), `${other}..${base}`])
  ])
  return { base, other, onlyInOther: parseLog(incoming), onlyInBase: parseLog(outgoing) }
}

/** Diff between `ref` and the working tree: per-file stats plus the patch. */
export async function diffWithWorkingTree(cwd, ref) {
  const [numstat, patch] = await Promise.all([
    out(cwd, ['diff', '--numstat', ref, '--']),
    out(cwd, ['diff', ref, '--'])
  ])
  const files = numstat
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const [add, del, ...rest] = l.split('\t')
      return { path: rest.join('\t'), added: add === '-' ? null : Number(add), deleted: del === '-' ? null : Number(del) }
    })
  return { ref, files, patch: truncate(patch) }
}

function truncate(text, max = 400_000) {
  return text.length > max ? text.slice(0, max) + `\n… (truncated, ${text.length - max} more characters)` : text
}

// ---------------------------------------------------------------------------
// Remote operations

export async function fetchAll(cwd) {
  const res = await git(cwd, ['fetch', '--all', '--prune', '--tags'], { timeoutMs: 300_000 })
  return { status: 'ok', output: (res.stderr + res.stdout).trim() }
}

/**
 * Update Project: fetch, then pull the current branch with rebase or merge.
 * Local changes are stashed and restored around the pull (--autostash).
 */
export async function updateProject(cwd, { method = 'rebase' } = {}) {
  const head = await currentHead(cwd)
  if (!head.branch) throw new GitError([], 1, '', 'HEAD is detached: check out a branch to update it.')
  const fetch = await git(cwd, ['fetch', '--all', '--prune'], { timeoutMs: 300_000 })
  const upstream = await git(cwd, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], {
    allowFail: true
  })
  if (upstream.code !== 0) {
    return {
      status: 'ok',
      output: `${(fetch.stderr + fetch.stdout).trim()}\nFetched. '${head.branch}' has no upstream, so nothing was pulled.`.trim()
    }
  }
  const args = ['pull', method === 'merge' ? '--no-rebase' : '--rebase', '--autostash']
  const res = await git(cwd, args, { allowFail: true, timeoutMs: 300_000 })
  return opResult(res, args, cwd)
}

export async function pull(cwd, { method = 'rebase' } = {}) {
  const args = ['pull', method === 'merge' ? '--no-rebase' : '--rebase', '--autostash']
  const res = await git(cwd, args, { allowFail: true, timeoutMs: 300_000 })
  return opResult(res, args, cwd)
}

/**
 * Updates a branch that is not checked out by fast-forwarding it from its upstream
 * (`git fetch <remote> <branch>:<local>`), as Android Studio's per-branch Update does.
 * For the current branch it runs Update Project.
 */
export async function updateBranch(cwd, name, { method = 'rebase' } = {}) {
  const head = await currentHead(cwd)
  if (head.branch === name) return updateProject(cwd, { method })
  const up = await git(cwd, ['for-each-ref', '--format=%(upstream:remotename)%1f%(upstream:remoteref)', `refs/heads/${name}`])
  const [remote, remoteRef] = up.stdout.trim().split('\x1f')
  if (!remote || !remoteRef)
    throw new GitError([], 1, '', `Branch '${name}' has no upstream branch to update from.`)
  const holder = await worktreeHolding(cwd, name)
  if (holder) return { status: 'worktree-conflict', worktreePath: holder.path, branch: name }
  const res = await git(cwd, ['fetch', remote, `${remoteRef}:refs/heads/${name}`], { timeoutMs: 300_000 })
  return { status: 'ok', output: (res.stderr + res.stdout).trim() }
}

/**
 * Pushes `branch` (default: current). Sets upstream on first push.
 * A non-fast-forward rejection returns { status: 'rejected' } so the UI can offer
 * force push, which always uses --force-with-lease.
 */
export async function push(cwd, { branch, force = false, remote } = {}) {
  const head = await currentHead(cwd)
  const name = branch || head.branch
  if (!name) throw new GitError([], 1, '', 'HEAD is detached: check out a branch to push it.')
  const up = await git(cwd, ['for-each-ref', '--format=%(push:remotename)%1f%(upstream:remotename)%1f%(upstream:remoteref)', `refs/heads/${name}`])
  const [pushRemote, upRemote, upRef] = up.stdout.trim().split('\x1f')
  const remotes = await listRemotes(cwd)
  const target = remote || pushRemote || upRemote || (remotes.includes('origin') ? 'origin' : remotes[0])
  if (!target) throw new GitError([], 1, '', 'This repository has no remote to push to.')
  const args = ['push', '--porcelain']
  if (force) args.push('--force-with-lease')
  if (!upRemote) args.push('--set-upstream')
  const dest = upRef ? upRef.replace(/^refs\/heads\//, '') : name
  args.push(target, `refs/heads/${name}:refs/heads/${dest}`)
  const res = await git(cwd, args, { allowFail: true, timeoutMs: 300_000 })
  const output = (res.stdout + res.stderr).trim()
  if (res.code === 0) return { status: 'ok', output }
  if (!force && /\[rejected\]|non-fast-forward|fetch first|\(stale info\)/.test(output)) {
    return { status: 'rejected', message: output, remote: target, branch: name }
  }
  throw new GitError(args, res.code, res.stdout, res.stderr)
}

// ---------------------------------------------------------------------------
// Tags, reset, revisions

export async function createTag(cwd, name, { ref = 'HEAD', message } = {}) {
  const args = message ? ['tag', '-a', name, '-m', message, ref] : ['tag', name, ref]
  await git(cwd, args)
  return { status: 'ok' }
}

export async function deleteTag(cwd, name) {
  await git(cwd, ['tag', '-d', name])
  return { status: 'ok' }
}

export async function reset(cwd, { mode = 'mixed', ref = 'HEAD' } = {}) {
  if (!['soft', 'mixed', 'hard', 'keep'].includes(mode)) throw new GitError([], 1, '', `Unknown reset mode ${mode}`)
  const res = await git(cwd, ['reset', `--${mode}`, ref])
  return { status: 'ok', output: (res.stdout + res.stderr).trim() }
}

export async function resolveRevision(cwd, rev) {
  const res = await git(cwd, ['rev-parse', '--verify', '--quiet', `${rev}^{commit}`], { allowFail: true })
  return res.code === 0 ? res.stdout.trim() : null
}

// ---------------------------------------------------------------------------
// Commit (used by the panel's Commit dialog)

export async function commit(cwd, { message, all = true, amend = false } = {}) {
  if (!message && !amend) throw new GitError([], 1, '', 'Commit message is empty.')
  if (all) await git(cwd, ['add', '--all'])
  const args = ['commit']
  if (amend) args.push('--amend')
  if (message) args.push('-m', message)
  else args.push('--no-edit')
  const res = await git(cwd, args)
  return { status: 'ok', output: (res.stdout + res.stderr).trim() }
}

// ---------------------------------------------------------------------------
// Stash, rollback, patches

export async function stashList(cwd) {
  const raw = await out(cwd, ['stash', 'list', '--format=%gd%x1f%H%x1f%at%x1f%gs'])
  return raw
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const [ref, sha, at, subject] = l.split('\x1f')
      return { ref, sha, date: Number(at), subject }
    })
}

export async function stash(cwd, { message, includeUntracked = true } = {}) {
  const args = ['stash', 'push']
  if (includeUntracked) args.push('--include-untracked')
  if (message) args.push('-m', message)
  const res = await git(cwd, args)
  return { status: 'ok', output: (res.stdout + res.stderr).trim() }
}

export async function unstash(cwd, { ref = 'stash@{0}', pop = true, index = false } = {}) {
  const args = ['stash', pop ? 'pop' : 'apply']
  if (index) args.push('--index')
  args.push(ref)
  const res = await git(cwd, args, { allowFail: true })
  return opResult(res, args, cwd)
}

export async function dropStash(cwd, ref) {
  await git(cwd, ['stash', 'drop', ref])
  return { status: 'ok' }
}

/**
 * Rolls back local changes. With `paths`, only those files. Tracked files return to HEAD;
 * files added since HEAD are removed when `deleteAdded` is set (otherwise left untracked).
 */
export async function rollback(cwd, { paths, deleteAdded = false } = {}) {
  const head = await currentHead(cwd)
  const st = await status(cwd)
  const targets = paths && paths.length ? new Set(paths) : null
  const chosen = st.filter((e) => !e.untracked && (!targets || targets.has(e.path)))
  const added = chosen.filter((e) => e.x === 'A').map((e) => e.path)
  const tracked = chosen.filter((e) => e.x !== 'A').flatMap((e) => (e.from ? [e.path, e.from] : [e.path]))
  if (added.length) await git(cwd, ['rm', '--cached', '--quiet', '--', ...added])
  if (tracked.length && head.sha) {
    await git(cwd, ['restore', '--source=HEAD', '--staged', '--worktree', '--', ...tracked])
  }
  if (deleteAdded && added.length) await git(cwd, ['clean', '-f', '-q', '--', ...added])
  return { status: 'ok', files: chosen.map((e) => e.path) }
}

/** A patch of uncommitted changes (staged and unstaged) against HEAD, including new files. */
export async function createPatch(cwd) {
  // Intent-to-add makes untracked files show up in `git diff HEAD`; undo it afterwards.
  const untracked = (await status(cwd)).filter((e) => e.untracked).map((e) => e.path)
  if (untracked.length) await git(cwd, ['add', '--intent-to-add', '--', ...untracked])
  try {
    return await out(cwd, ['diff', '--binary', 'HEAD'])
  } finally {
    if (untracked.length) await git(cwd, ['reset', '--quiet', '--', ...untracked], { allowFail: true })
  }
}

export async function applyPatch(cwd, patch, { check = false } = {}) {
  const args = ['apply', '--3way', '--whitespace=nowarn']
  if (check) args.push('--check')
  args.push('-')
  const res = await git(cwd, args, { input: patch, allowFail: true })
  if (res.code === 0) return { status: 'ok', output: (res.stdout + res.stderr).trim() }
  return opResult(res, args, cwd)
}

// ---------------------------------------------------------------------------
// History, blame, log

export async function fileHistory(cwd, file, { max = 200 } = {}) {
  return parseLog(await out(cwd, ['log', '--follow', `--format=${LOG_FORMAT}`, '-n', String(max), '--', file]))
}

export async function blame(cwd, file) {
  const raw = await out(cwd, ['blame', '--line-porcelain', '--', file])
  const lines = []
  let cur = null
  const commits = new Map()
  for (const line of raw.split('\n')) {
    if (/^[0-9a-f]{40} /.test(line)) {
      const sha = line.slice(0, 40)
      cur = commits.get(sha) || { sha }
      commits.set(sha, cur)
      lines.push({ commit: cur, text: '' })
    } else if (line.startsWith('\t')) {
      lines[lines.length - 1].text = line.slice(1)
    } else if (cur) {
      const sp = line.indexOf(' ')
      const key = line.slice(0, sp)
      const val = line.slice(sp + 1)
      if (key === 'author') cur.author = val
      else if (key === 'author-time') cur.date = Number(val)
      else if (key === 'summary') cur.subject = val
    }
  }
  return lines.map((l, i) => ({
    line: i + 1,
    sha: l.commit.sha,
    short: l.commit.sha.slice(0, 8),
    author: l.commit.author,
    date: l.commit.date,
    subject: l.commit.subject,
    text: l.text
  }))
}

export async function log(cwd, { max = 300, ref } = {}) {
  const args = ['log', '--graph', '--date-order', '--decorate=short', `--format=%h%x1f%d%x1f%s%x1f%an%x1f%ar`, '-n', String(max)]
  if (ref) args.push(ref)
  else args.push('--all')
  const raw = await out(cwd, args)
  return raw.split('\n').filter(Boolean).map((l) => {
    const m = /^([^0-9a-f]*)([0-9a-f]{4,40})\x1f(.*)$/.exec(l)
    if (!m) return { graph: l }
    const [refs, subject, author, when] = m[3].split('\x1f')
    return { graph: m[1], short: m[2], refs: refs.trim().replace(/^\(|\)$/g, ''), subject, author, when }
  })
}

export async function trackedFiles(cwd) {
  return (await out(cwd, ['ls-files', '-z'])).split('\0').filter(Boolean)
}

/** Lightweight fingerprint used to detect changes made outside the plugin. */
export async function fingerprint(cwd) {
  const [refs, head, st] = await Promise.all([
    git(cwd, ['for-each-ref', '--format=%(refname) %(objectname) %(upstream:track)'], { allowFail: true }),
    git(cwd, ['rev-parse', 'HEAD', '--symbolic-full-name', 'HEAD'], { allowFail: true }),
    git(cwd, ['status', '--porcelain=v1', '-z'], { allowFail: true })
  ])
  const text = refs.stdout + '\n' + head.stdout + '\n' + st.stdout.length + ':' + st.stdout.slice(0, 4096)
  let h = 0
  for (let i = 0; i < text.length; i++) h = (Math.imul(h, 31) + text.charCodeAt(i)) | 0
  return String(h >>> 0)
}
