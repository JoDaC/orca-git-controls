// Everything the branches popup draws, in one JSON answer.

import * as g from './git.mjs'

export async function buildSnapshot(cwd, { recentCount = 5, favorites = ['main'] } = {}) {
  // Fingerprint first: the worker stores it as "already drawn", so it must never be newer than
  // the refs below, or a change made mid-snapshot would never post git.changed.
  const fingerprint = await g.fingerprint(cwd)
  const [refs, changes] = await Promise.all([g.listRefs(cwd), g.status(cwd)])
  const favs = new Set(favorites)
  const localNames = new Set(refs.local.map((b) => b.name))
  const recentNames = await g.recentBranches(cwd, { limit: recentCount, existing: localNames })
  const byName = new Map(refs.local.map((b) => [b.name, b]))
  const decorate = (b) => ({ ...b, favorite: favs.has(b.name) })
  const local = refs.local.map(decorate)
  // Favorites float to the top of their folder.
  const sortKey = (b) => `${b.favorite ? 0 : 1}${b.name}`
  const localTree = sortTree(g.groupByFolder(local), sortKey)
  return {
    fingerprint,
    info: refs.info,
    current: refs.info.branch,
    detached: refs.info.detached,
    head: refs.info.sha,
    state: refs.info.state,
    changes: {
      total: changes.length,
      tracked: changes.filter((c) => !c.untracked).length,
      untracked: changes.filter((c) => c.untracked).length
    },
    remotes: refs.remotes,
    recent: recentNames.map((n) => decorate(byName.get(n))),
    favorites: [...favs].filter((n) => localNames.has(n)),
    local: localTree,
    remote: g.groupRemotes(refs.remote.map((r) => ({ ...r, favorite: favs.has(r.name) })), refs.remotes),
    tags: refs.tags.sort((a, b) => b.date - a.date)
  }
}

function sortTree(tree, key) {
  return {
    ...tree,
    folders: tree.folders.map((f) => sortTree(f, key)),
    items: [...tree.items].sort((a, b) => key(a).localeCompare(key(b)))
  }
}
