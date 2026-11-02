// Thin wrapper around Orca's public CLI, used for things host API 1.2 does not offer:
// finding the focused workspace's path, opening another worktree, creating worktrees.

import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'

const CANDIDATES = [
  process.env.ORCA_CLI_BIN_DIR && path.join(process.env.ORCA_CLI_BIN_DIR, 'orca'),
  '/Applications/Orca.app/Contents/Resources/bin/orca',
  path.join(process.env.HOME || '', 'Applications/Orca.app/Contents/Resources/bin/orca'),
  '/usr/local/bin/orca',
  '/opt/homebrew/bin/orca'
].filter(Boolean)

export function orcaBinary() {
  return process.env.ORCA_GIT_BRANCHES_ORCA || CANDIDATES.find((p) => existsSync(p)) || 'orca'
}

export class OrcaCliError extends Error {}

/** Runs `orca <args> --json` and returns `result`. */
export function orcaCli(args, { timeoutMs = 30_000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      orcaBinary(),
      [...args, '--json'],
      { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024, cwd: process.env.HOME || '/' },
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

export async function listWorktrees() {
  return (await orcaCli(['worktree', 'list'])).worktrees ?? []
}

export async function listTerminals() {
  return (await orcaCli(['terminal', 'list'])).terminals ?? []
}

/**
 * Shows another worktree in Orca: switches to one of its terminals, or opens a new terminal
 * there when it has none (host API 1.3's workspace.open is not available on Orca 1.4.246).
 */
export async function openWorktree(worktreePath) {
  const terminals = await listTerminals().catch(() => [])
  const match = terminals.find((t) => t.worktreePath && path.resolve(t.worktreePath) === path.resolve(worktreePath) && t.connected !== false)
  if (match) {
    await orcaCli(['terminal', 'switch', '--terminal', match.handle])
    return { opened: true, via: 'terminal' }
  }
  await orcaCli(['terminal', 'create', '--worktree', `path:${worktreePath}`, '--focus'])
  return { opened: true, via: 'new-terminal' }
}

export async function createWorktree({ repoPath, name, baseBranch }) {
  const args = ['worktree', 'create', '--repo', `path:${repoPath}`, '--name', name, '--activate']
  if (baseBranch) args.push('--base-branch', baseBranch)
  return orcaCli(args, { timeoutMs: 180_000 })
}
