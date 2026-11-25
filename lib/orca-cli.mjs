// Thin wrapper around Orca's public CLI, used for things host API 1.2 does not offer:
// finding the focused workspace's path, opening another worktree, creating worktrees.

import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { parseWslPath, resolveDistro, toWslPath, windowsEnv } from './wsl.mjs'

const CANDIDATES = [
  process.env.ORCA_CLI_BIN_DIR && path.join(process.env.ORCA_CLI_BIN_DIR, 'orca'),
  '/Applications/Orca.app/Contents/Resources/bin/orca',
  path.join(process.env.HOME || '', 'Applications/Orca.app/Contents/Resources/bin/orca'),
  '/usr/local/bin/orca',
  '/opt/homebrew/bin/orca'
].filter(Boolean)

export function orcaBinary() {
  return process.env.ORCA_GIT_CONTROLS_ORCA || CANDIDATES.find((p) => existsSync(p)) || 'orca'
}

export class OrcaCliError extends Error {}

/** Runs `orca <args> --json` and returns `result`. */
export function orcaCli(args, { timeoutMs = 30_000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      orcaBinary(),
      [...args, '--json'],
      { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024, cwd: process.env.HOME || '/', env: windowsEnv(), windowsHide: true },
      (error, stdout, stderr) => {
        let parsed = null
        try {
          parsed = JSON.parse(stdout)
        } catch {
          // fall through
        }
        if (parsed && parsed.ok) return resolve(parsed.result)
        const msg =
          parsed?.error?.message || (stderr || stdout || error?.message || 'orca CLI failed').trim()
        reject(new OrcaCliError(msg))
      }
    )
  })
}

/** "--environment wsl" → ['--environment', 'wsl']; null for anything else. */
export function selectorArgs(selector) {
  const m = typeof selector === 'string' ? /^(--[a-z-]+)\s+(.+)$/.exec(selector.trim()) : null
  return m ? [m[1], m[2]] : null
}

// Where each workspace path the plugin uses came from: { selector, orcaPath }.
// Filled by the list calls, read when a path goes back to the Orca CLI.
const origins = new Map()
const originKey = (p) => p.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase()

/**
 * Entries of one list call. On Windows, Orca keeps WSL workspaces in a separate runtime
 * (`--environment wsl`) that a plain list call leaves out (it names it in
 * hostScope.omittedHostSelectors) and reports their paths Linux style. Those environments are
 * listed too when they run in a local WSL distro, with paths turned into
 * \\wsl.localhost\<distro>\... paths; such entries also carry `orcaSelector` and the original
 * `orcaPath`. Elsewhere nothing changes: other hosts' checkouts are not reachable from here.
 */
async function listAcrossHosts(args, key, pathField, { platform = process.platform, resolveDistro: resolve = resolveDistro } = {}) {
  const first = await orcaCli(args)
  const items = first[key] ?? []
  if (platform !== 'win32') return items
  const selectors = [
    ...new Set(
      (first.hostScope?.omittedHostSelectors ?? [])
        .map((s) => s?.selector)
        .filter((s) => selectorArgs(s)?.[0] === '--environment')
    )
  ]
  if (!selectors.length) return items
  const more = await Promise.all(
    selectors.map(async (selector) => {
      try {
        const list = ((await orcaCli([...args, ...selectorArgs(selector)]))[key] ?? []).filter(
          (e) => typeof e[pathField] === 'string' && e[pathField].startsWith('/')
        )
        if (!list.length) return []
        const distro = await resolve(selector, list.map((e) => e[pathField])).catch(() => null)
        if (!distro) return [] // not a local WSL runtime
        return list.map((e) => {
          const orcaPath = e[pathField]
          const local = toWslPath(distro, orcaPath)
          origins.set(originKey(local), { selector, orcaPath })
          return { ...e, [pathField]: local, orcaSelector: selector, orcaPath }
        })
      } catch {
        return [] // that runtime is down: show the rest
      }
    })
  )
  return items.concat(...more)
}

export async function listWorktrees(opts) {
  return listAcrossHosts(['worktree', 'list'], 'worktrees', 'path', opts)
}

export async function listTerminals(opts) {
  return listAcrossHosts(['terminal', 'list'], 'terminals', 'worktreePath', opts)
}

/** The path and host flags to give the Orca CLI for a path the plugin uses. */
export function orcaLocation(localPath) {
  const known = origins.get(originKey(localPath))
  if (known) return { orcaPath: known.orcaPath, extra: selectorArgs(known.selector) ?? [] }
  // A WSL path the lists have not shown yet: Orca names WSL as the "wsl" environment.
  const wsl = parseWslPath(localPath)
  if (wsl) return { orcaPath: wsl.linuxPath, extra: ['--environment', 'wsl'] }
  return { orcaPath: localPath, extra: [] }
}

/**
 * Shows another worktree in Orca: switches to one of its terminals, or opens a new terminal
 * there when it has none (host API 1.3's workspace.open is not available on Orca 1.4.246).
 */
export async function openWorktree(worktreePath, opts) {
  const terminals = await listTerminals(opts).catch(() => [])
  const match = terminals.find((t) => t.worktreePath && path.resolve(t.worktreePath) === path.resolve(worktreePath) && t.connected !== false)
  if (match) {
    await orcaCli(['terminal', 'switch', '--terminal', match.handle, ...(selectorArgs(match.orcaSelector) ?? [])])
    return { opened: true, via: 'terminal' }
  }
  const { orcaPath, extra } = orcaLocation(worktreePath)
  await orcaCli(['terminal', 'create', '--worktree', `path:${orcaPath}`, '--focus', ...extra])
  return { opened: true, via: 'new-terminal' }
}

export async function createWorktree({ repoPath, name, baseBranch }) {
  const { orcaPath, extra } = orcaLocation(repoPath)
  const args = ['worktree', 'create', '--repo', `path:${orcaPath}`, '--name', name, '--activate']
  if (baseBranch) args.push('--base-branch', baseBranch)
  args.push(...extra)
  return orcaCli(args, { timeoutMs: 180_000 })
}
