// Finds the checkout path of Orca's focused workspace.
// Host API 1.2 gives the focused workspace's branch, display name and terminal ids, but not its
// path, so we match those against `orca worktree list` and `orca terminal list`.

function stripRef(branch) {
  return (branch || '').replace(/^refs\/heads\//, '')
}

/**
 * @param context  workspace.readContext answer: { branch, displayName, terminals: [{ id }] } | null
 * @param worktrees `orca worktree list` entries: { path, branch, displayName, lastActivityAt, isArchived }
 * @param terminals `orca terminal list` entries: { handle, ptyId, tabId, leafId, worktreePath }
 * @returns { path, reason, candidates } where path is null when nothing matches.
 */
export function matchWorkspace(context, worktrees, terminals = []) {
  if (!context) return { path: null, reason: 'no-focused-workspace', candidates: [] }
  const live = worktrees.filter((w) => !w.isArchived && w.path)

  // 1. Terminal ids are unique, so they identify the workspace exactly.
  const ids = new Set((context.terminals || []).map((t) => t.id))
  if (ids.size) {
    const hits = new Set()
    for (const t of terminals) {
      if (!t.worktreePath) continue
      if ([t.handle, t.ptyId, t.tabId, t.leafId, t.id].some((v) => v && ids.has(v))) hits.add(t.worktreePath)
    }
    if (hits.size === 1) return { path: [...hits][0], reason: 'terminal', candidates: [...hits] }
  }

  // 2. Display name and branch.
  const branch = stripRef(context.branch)
  let candidates = live.filter((w) => w.displayName === context.displayName && stripRef(w.branch) === branch)
  if (!candidates.length) candidates = live.filter((w) => w.displayName === context.displayName)
  if (!candidates.length && branch) candidates = live.filter((w) => stripRef(w.branch) === branch)
  if (!candidates.length) return { path: null, reason: 'no-match', candidates: [] }
  if (candidates.length === 1) return { path: candidates[0].path, reason: 'name', candidates: [candidates[0].path] }
  // 3. Ambiguous: the most recently active one is almost always the focused one.
  const sorted = [...candidates].sort((a, b) => (b.lastActivityAt || 0) - (a.lastActivityAt || 0))
  return { path: sorted[0].path, reason: 'ambiguous', candidates: sorted.map((w) => w.path) }
}
