// Orca Git Branches: plugin worker.
// Runs git for the panel (through orca.panels.handle) and for the command palette.

import { watch } from 'node:fs'
import path from 'node:path'
import * as g from '../lib/git.mjs'
import * as cli from '../lib/orca-cli.mjs'
import { matchWorkspace } from '../lib/workspace.mjs'
import { buildSnapshot } from '../lib/snapshot.mjs'

const DEFAULT_SETTINGS = { updateMethod: 'rebase', recentCount: 5, showTags: true, fetchOnOpen: false }

/** @param {import('orca/worker').OrcaWorkerApi} orca */
export default async function activate(orca) {
  const log = (m) => {
    try {
      orca.log(String(m))
    } catch {}
  }

  let focused = { path: null, reason: 'unresolved', candidates: [], context: null }
  let override = null // path picked by the person in the panel
  let pendingIntent = null // a dialog a palette command asked the panel to open
  let watcher = null
  let watchedDir = null
  let lastFingerprint = null
  let changeTimer = null

  const repoPath = () => override || focused.path

  const post = (event, payload) => {
    try {
      orca.panels?.post?.(event, payload)
    } catch (e) {
      log(`post ${event} failed: ${e.message}`)
    }
  }

  const notify = async (title, body) => {
    try {
      await orca.host.call('notifications.show', { title: title.slice(0, 120), ...(body ? { body: body.slice(0, 1000) } : {}) })
    } catch (e) {
      log(`notify failed: ${e.message}`)
    }
  }

  async function readSettings() {
    try {
      const { settings } = await orca.host.call('settings.get', {})
      return { ...DEFAULT_SETTINGS, ...settings }
    } catch {
      return { ...DEFAULT_SETTINGS }
    }
  }

  async function storageGet(key, fallback) {
    try {
      const { value } = await orca.host.call('storage.get', { key })
      return value ?? fallback
    } catch {
      return fallback
    }
  }
  async function storageSet(key, value) {
    await orca.host.call('storage.set', { key, value })
  }

  // ---- focused workspace -------------------------------------------------

  async function resolveFocused(context) {
    try {
      if (context === undefined) context = await orca.host.call('workspace.readContext', {})
      const [worktrees, terminals] = await Promise.all([
        cli.listWorktrees().catch((e) => {
          log(`orca worktree list failed: ${e.message}`)
          return []
        }),
        cli.listTerminals().catch(() => [])
      ])
      focused = { ...matchWorkspace(context, worktrees, terminals), context, worktrees }
    } catch (e) {
      log(`resolve workspace failed: ${e.message}`)
      focused = { path: null, reason: 'error', candidates: [], context: null, error: e.message }
    }
    await rewatch()
    return focused
  }

  // ---- outside-change detection -----------------------------------------

  async function rewatch() {
    const p = repoPath()
    let dir = null
    if (p) {
      try {
        dir = (await g.repoInfo(p)).commonDir
      } catch {
        dir = null
      }
    }
    if (dir === watchedDir) return
    watcher?.close()
    watcher = null
    watchedDir = dir
    lastFingerprint = null
    if (!dir) return
    try {
      watcher = watch(dir, { recursive: true }, (_type, file) => {
        if (file && /(^|\/)(objects|lfs)\//.test(file)) return
        scheduleChange()
      })
      watcher.on('error', (e) => log(`watch error: ${e.message}`))
    } catch (e) {
      log(`watch failed: ${e.message}`)
    }
  }

  function scheduleChange() {
    clearTimeout(changeTimer)
    changeTimer = setTimeout(checkChange, 400)
  }

  async function checkChange() {
    const p = repoPath()
    if (!p) return
    try {
      const fp = await g.fingerprint(p)
      if (fp !== lastFingerprint) {
        lastFingerprint = fp
        post('git.changed', { fingerprint: fp, path: p })
      }
    } catch {}
  }

  // ---- favorites ----------------------------------------------------------

  async function favoritesKey(p) {
    const info = await g.repoInfo(p)
    return `favorites:${info.commonDir}`
  }
  async function getFavorites(p) {
    return storageGet(await favoritesKey(p), ['main'])
  }

  // ---- operations ---------------------------------------------------------

  const ops = {
    async snapshot() {
      const p = repoPath()
      const settings = await readSettings()
      const workspace = {
        path: p,
        override: Boolean(override),
        reason: focused.reason,
        candidates: focused.candidates,
        context: focused.context,
        worktrees: (focused.worktrees || []).map((w) => ({ path: w.path, displayName: w.displayName, branch: (w.branch || '').replace(/^refs\/heads\//, '') }))
      }
      const intent = pendingIntent
      pendingIntent = null
      if (!p) return { workspace, settings, intent, repo: null }
      const favorites = await getFavorites(p)
      const snap = await buildSnapshot(p, { recentCount: settings.recentCount, favorites })
      lastFingerprint = snap.fingerprint
      return { workspace, settings, intent, repo: snap }
    },
    async fingerprint() {
      const p = repoPath()
      return p ? g.fingerprint(p) : null
    },
    async 'workspace.refresh'() {
      await resolveFocused()
      return ops.snapshot()
    },
    async 'workspace.select'({ path: p }) {
      override = p || null
      await rewatch()
      return ops.snapshot()
    },
    async 'workspace.open'({ path: p }) {
      return cli.openWorktree(p)
    },
    async 'settings.set'({ key, value }) {
      await orca.host.call('settings.set', { key, value })
      return readSettings()
    },
    async 'favorite.toggle'({ name }) {
      const p = repoPath()
      const key = await favoritesKey(p)
      const favs = new Set(await storageGet(key, ['main']))
      if (favs.has(name)) favs.delete(name)
      else favs.add(name)
      await storageSet(key, [...favs])
      return [...favs]
    },

    checkout: ({ target, mode, detach }) => g.checkout(repoPath(), target, { mode, detach }),
    checkoutRemote: ({ name, localName, mode }) => g.checkoutRemote(repoPath(), name, { localName, mode }),
    createBranch: ({ name, startPoint, checkout }) => g.createBranch(repoPath(), name, startPoint, { checkout }),
    renameBranch: ({ from, to }) => g.renameBranch(repoPath(), from, to),
    deleteBranch: ({ name, force }) => g.deleteBranch(repoPath(), name, { force }),
    deleteRemoteBranch: ({ name }) => g.deleteRemoteBranch(repoPath(), name),
    merge: ({ ref }) => g.merge(repoPath(), ref),
    rebase: ({ onto }) => g.rebase(repoPath(), onto),
    checkoutAndRebase: ({ branch, onto }) => g.checkoutAndRebase(repoPath(), branch, onto),
    abort: () => g.abortOperation(repoPath()),
    continue: () => g.continueOperation(repoPath()),
    compare: ({ base, other }) => g.compare(repoPath(), base, other),
    diffWorkingTree: ({ ref }) => g.diffWithWorkingTree(repoPath(), ref),
    fetch: () => g.fetchAll(repoPath()),
    async updateProject() {
      return g.updateProject(repoPath(), { method: (await readSettings()).updateMethod })
    },
    async pull() {
      return g.pull(repoPath(), { method: (await readSettings()).updateMethod })
    },
    async updateBranch({ name }) {
      return g.updateBranch(repoPath(), name, { method: (await readSettings()).updateMethod })
    },
    push: ({ branch, force }) => g.push(repoPath(), { branch, force }),
    commit: ({ message, all, amend }) => g.commit(repoPath(), { message, all, amend }),
    createTag: ({ name, ref, message }) => g.createTag(repoPath(), name, { ref, message }),
    deleteTag: ({ name }) => g.deleteTag(repoPath(), name),
    reset: ({ mode, ref }) => g.reset(repoPath(), { mode, ref }),
    resolveRevision: ({ rev }) => g.resolveRevision(repoPath(), rev),
    status: () => g.status(repoPath()),
    stashList: () => g.stashList(repoPath()),
    stash: ({ message, includeUntracked }) => g.stash(repoPath(), { message, includeUntracked }),
    unstash: ({ ref, pop, index }) => g.unstash(repoPath(), { ref, pop, index }),
    dropStash: ({ ref }) => g.dropStash(repoPath(), ref),
    rollback: ({ paths, deleteAdded }) => g.rollback(repoPath(), { paths, deleteAdded }),
    createPatch: () => g.createPatch(repoPath()),
    applyPatch: ({ patch }) => g.applyPatch(repoPath(), patch),
    fileHistory: ({ file }) => g.fileHistory(repoPath(), file),
    blame: ({ file }) => g.blame(repoPath(), file),
    log: ({ ref, max }) => g.log(repoPath(), { ref, max }),
    trackedFiles: () => g.trackedFiles(repoPath()),
    async worktrees() {
      const p = repoPath()
      const [gitList, orcaList] = await Promise.all([g.listWorktrees(p), cli.listWorktrees().catch(() => [])])
      const known = new Map(orcaList.map((w) => [path.resolve(w.path), w]))
      return gitList.map((w) => ({ ...w, inOrca: known.has(w.path), displayName: known.get(w.path)?.displayName ?? null, current: w.path === g.normalizePath(p) }))
    },
    async newWorktree({ name, baseBranch }) {
      const info = await g.repoInfo(repoPath())
      // Orca's own worktree creation, so the new workspace shows up in Orca's sidebar.
      // Orca registers repos by their main checkout: the folder holding the common .git dir.
      const mainCheckout = path.basename(info.commonDir) === '.git' ? path.dirname(info.commonDir) : info.toplevel
      return cli.createWorktree({ repoPath: mainCheckout, name, baseBranch })
    }
  }

  const MUTATING = new Set(['checkout', 'checkoutRemote', 'createBranch', 'renameBranch', 'deleteBranch', 'deleteRemoteBranch', 'merge', 'rebase', 'checkoutAndRebase', 'abort', 'continue', 'fetch', 'updateProject', 'pull', 'updateBranch', 'push', 'commit', 'createTag', 'deleteTag', 'reset', 'stash', 'unstash', 'dropStash', 'rollback', 'applyPatch', 'newWorktree'])

  async function runOp(op, args = {}) {
    const fn = ops[op]
    if (!fn) return { ok: false, error: `Unknown operation: ${op}` }
    if (!['snapshot', 'workspace.refresh', 'workspace.select', 'workspace.open', 'settings.set'].includes(op) && !repoPath()) {
      return { ok: false, error: 'No Git workspace is focused in Orca. Select a workspace in the left sidebar.' }
    }
    try {
      const value = await fn(args || {})
      if (MUTATING.has(op)) scheduleChange()
      return { ok: true, value: value ?? null }
    } catch (e) {
      // Git's own text, verbatim.
      log(`${op} failed: ${e.message}`)
      return { ok: false, error: e.message, command: e.args ? `git ${e.args.join(' ')}` : undefined }
    }
  }

  // ---- panel channel --------------------------------------------------------

  if (orca.panels?.handle) {
    orca.panels.handle('git', async (input) => runOp(input?.op, input?.args))
  } else {
    log('This Orca has no orca.panels.handle; the panel needs Orca 1.4.246 or newer.')
  }

  orca.events.on('workspace.changed', async ({ context }) => {
    const before = repoPath()
    await resolveFocused(context ?? null)
    if (repoPath() !== before) post('workspace.changed', { path: repoPath() })
  })

  await resolveFocused()

  // ---- command palette --------------------------------------------------------

  async function paletteRun(title, op, args, describe) {
    const res = await runOp(op, args)
    if (!res.ok) {
      await notify(`${title} failed`, res.error)
      return res.error
    }
    const v = res.value
    if (v && v.status && v.status !== 'ok') {
      // Needs a decision or reports conflicts: hand it to the panel.
      pendingIntent = { kind: 'result', title, op, args, value: v }
      post('ui.intent', pendingIntent)
      await notify(`${title}: action needed`, 'Open Git Branches in the right sidebar to continue.')
      return v.status
    }
    const text = describe ? describe(v) : (v && v.output) || 'Done'
    await notify(title, text)
    return text
  }

  function intentCommand(id, intent) {
    orca.commands.register(id, async () => {
      pendingIntent = { kind: 'dialog', dialog: intent }
      post('ui.intent', pendingIntent)
      await notify('Git Branches', 'Open Git Branches in the right sidebar to continue.')
      return 'Continue in the Git Branches panel'
    })
  }

  orca.commands.register('git.updateProject', () => paletteRun('Update Project', 'updateProject'))
  orca.commands.register('git.pull', () => paletteRun('Pull', 'pull'))
  orca.commands.register('git.fetch', () => paletteRun('Fetch', 'fetch', {}, (v) => v.output || 'Fetched all remotes'))
  orca.commands.register('git.push', () => paletteRun('Push', 'push'))
  orca.commands.register('git.stash', () => paletteRun('Stash Changes', 'stash', { message: 'Stashed from Orca Git Branches' }))
  orca.commands.register('git.unstash', () => paletteRun('Unstash Changes', 'unstash', { pop: true }))
  for (const [id, dialog] of [
    ['git.branches', 'branches'],
    ['git.vcsPopup', 'vcs'],
    ['git.newBranch', 'newBranch'],
    ['git.newTag', 'newTag'],
    ['git.merge', 'merge'],
    ['git.rebase', 'rebase'],
    ['git.reset', 'reset'],
    ['git.checkoutRevision', 'checkoutRevision'],
    ['git.newWorktree', 'newWorktree'],
    ['git.worktrees', 'worktrees'],
    ['git.log', 'log'],
    ['git.patchCreate', 'patchCreate'],
    ['git.patchApply', 'patchApply'],
    ['git.stashes', 'stashes'],
    ['git.rollback', 'rollback'],
    ['git.fileHistory', 'fileHistory'],
    ['git.blame', 'blame'],
    ['git.rollbackFile', 'rollbackFile'],
    ['git.commitDialog', 'commit']
  ]) {
    intentCommand(id, dialog)
  }
  log(`Git Branches worker started; workspace: ${repoPath() ?? 'none'} (${focused.reason})`)
}

export function deactivate() {}
