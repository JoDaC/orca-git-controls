#!/usr/bin/env node
// Stands in for the `orca` CLI during the end-to-end tests, so the worker never reaches the real
// Orca app. Each call is appended to $FAKE_ORCA_LOG as one JSON line.
//   worktree list    the worktrees in $FAKE_ORCA_WORKTREES (JSON), or none
//   worktree create  runs `git worktree add` next to the repo, like Orca does
//   anything else    succeeds with an empty result

import { appendFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import path from 'node:path'

const args = process.argv.slice(2).filter((a) => a !== '--json')
if (process.env.FAKE_ORCA_LOG) appendFileSync(process.env.FAKE_ORCA_LOG, JSON.stringify(args) + '\n')

const flag = (name) => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}

let result = {}
const [noun, verb] = args
if (noun === 'worktree' && verb === 'list') result = { worktrees: JSON.parse(process.env.FAKE_ORCA_WORKTREES || '[]') }
else if (noun === 'terminal' && verb === 'list') result = { terminals: [] }
else if (noun === 'worktree' && verb === 'create') {
  const repo = flag('--repo').replace(/^path:/, '')
  const name = flag('--name')
  const dir = path.join(path.dirname(repo), name)
  const base = flag('--base-branch')
  try {
    execFileSync(process.env.FAKE_ORCA_GIT || 'git', ['-C', repo, 'worktree', 'add', '-q', '-b', name, dir, ...(base ? [base] : [])], { stdio: 'pipe' })
  } catch (e) {
    process.stdout.write(JSON.stringify({ ok: false, error: { message: String(e.stderr || e.message) } }))
    process.exit(1)
  }
  result = { worktree: { path: dir, branch: name } }
}
process.stdout.write(JSON.stringify({ ok: true, result }))
