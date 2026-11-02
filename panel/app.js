// Orca Git Controls: panel.
// Draws the branches panel and Git menu; all git work runs in the worker.

import { icon } from './icons.js'
import { dialog, confirmDialog, errorDialog, el, toast, setBusy } from './ui.js'

const orca = window.orca

// ---------------------------------------------------------------------------
// Worker channel

async function request(op, args = {}, timeoutMs = 120_000) {
  let res
  const input = { op, args }
  if (orca?.plugin?.request) {
    res = await orca.plugin.request('git', input, { timeoutMs })
  } else if (orca?.host?.has?.('plugin.request')) {
    res = (await orca.host.call('plugin.request', { name: 'git', input, timeoutMs })).output
  } else {
    throw new Error('This Orca cannot reach the plugin worker. Git Controls needs Orca 1.4.246 or newer.')
  }
  if (res && typeof res === 'object' && 'output' in res && !('ok' in res)) res = res.output
  if (!res || res.ok !== true) {
    const err = new Error(res?.error || 'The Git Controls worker did not answer.')
    err.command = res?.command
    throw err
  }
  return res.value
}

/** Runs an op with the busy bar, showing git's error verbatim on failure. Returns undefined on error. */
async function run(op, args, { quiet = false, title } = {}) {
  setBusy(true)
  try {
    return await request(op, args)
  } catch (e) {
    if (!quiet) await errorDialog(title || 'Git failed', e.message, e.command)
    return undefined
  } finally {
    setBusy(false)
  }
}

// ---------------------------------------------------------------------------
// State

const store = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem(key)
      return v == null ? fallback : JSON.parse(v)
    } catch {
      return fallback
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value))
    } catch {}
  }
}

const state = {
  data: null, // { workspace, settings, repo }
  loading: true,
  loadError: null,
  query: '',
  collapsed: new Set(store.get('collapsed', ['sec:tags'])),
  view: { kind: 'list' }, // list | menu | vcs | viewer
  selected: 0,
  rows: []
}

const $ = (id) => document.getElementById(id)
const viewEl = $('view')
const searchEl = $('search')

function saveCollapsed() {
  store.set('collapsed', [...state.collapsed])
}

function repo() {
  return state.data?.repo
}
function current() {
  return repo()?.current
}
function currentLabel() {
  const r = repo()
  if (!r) return 'HEAD'
  return r.current || (r.head ? r.head.slice(0, 8) : 'HEAD')
}

// ---------------------------------------------------------------------------
// Loading and refresh

let loadSeq = 0
async function load({ refreshWorkspace = false } = {}) {
  const seq = ++loadSeq
  try {
    const data = await request(refreshWorkspace ? 'workspace.refresh' : 'snapshot', {}, 60_000)
    if (seq !== loadSeq) return
    state.data = data
    state.loadError = null
    if (data.intent) setTimeout(() => handleIntent(data.intent), 0)
  } catch (e) {
    if (seq !== loadSeq) return
    state.loadError = e.message
  } finally {
    if (seq === loadSeq) {
      state.loading = false
      render()
    }
  }
}

let refreshTimer = null
function scheduleRefresh(delay = 150) {
  clearTimeout(refreshTimer)
  refreshTimer = setTimeout(() => load(), delay)
}

async function afterChange() {
  await load()
}

// ---------------------------------------------------------------------------
// Header

function renderHeader() {
  const ws = state.data?.workspace
  const r = repo()
  const btn = $('workspace')
  btn.replaceChildren()
  const name = ws?.path ? ws.path.split('/').filter(Boolean).pop() : 'No workspace'
  btn.append(
    el('span', { class: 'kind' }, icon(r?.detached ? 'commit' : 'branch', 14)),
    el('span', { class: 'ws-name' }, name),
    el('span', { class: 'ws-branch' }, r ? (r.detached ? `detached at ${r.head?.slice(0, 8)}` : r.current) : '')
  )
  btn.title = ws?.path
    ? `${ws.path}${ws.override ? ' (picked by you)' : ''}${ws.reason === 'ambiguous' ? '\nSeveral workspaces match the focused one; click to pick.' : ''}\nClick to change`
    : 'Click to pick a workspace'
  $('fetch').replaceChildren(icon('fetch', 16))
  $('settings').replaceChildren(icon('gear', 16))

  const banner = $('banner')
  banner.replaceChildren()
  if (r && r.state && r.state !== 'clean') {
    const op = { rebasing: 'Rebase', merging: 'Merge', 'cherry-picking': 'Cherry-pick', reverting: 'Revert' }[r.state]
    banner.append(
      el('span', { class: 'grow' }, `${op} in progress. Resolve conflicts, then continue.`),
      el('button', { class: 'btn', onclick: () => doContinue() }, 'Continue'),
      el('button', { class: 'btn', onclick: () => doAbort(op) }, 'Abort')
    )
    banner.hidden = false
  } else {
    banner.hidden = true
  }
}

// ---------------------------------------------------------------------------
// Row model for the main list

const ACTIONS = [
  { id: 'updateProject', label: 'Update Project…', icon: 'update', run: () => doUpdateProject() },
  { id: 'commit', label: 'Commit…', icon: 'commit', run: () => doCommit() },
  { id: 'push', label: 'Push…', icon: 'push', run: () => doPush() },
  { id: 'newBranch', label: 'New Branch…', icon: 'plus', run: () => doNewBranch() },
  { id: 'checkoutRevision', label: 'Checkout Tag or Revision…', icon: 'tag', run: () => doCheckoutRevision() }
]

/** The Git menu (VCS operations popup). */
function gitMenu() {
  return [
    { label: 'Commit…', run: doCommit },
    { label: 'Push…', run: doPush },
    { label: 'Update Project…', run: doUpdateProject },
    { label: 'Pull…', run: doPull },
    { label: 'Fetch', run: doFetch },
    { sep: true },
    { label: 'Merge…', run: doMergePick },
    { label: 'Rebase…', run: doRebasePick },
    { sep: true },
    { label: 'Branches…', run: () => setView({ kind: 'list' }) },
    { label: 'New Branch…', run: () => doNewBranch() },
    { label: 'New Tag…', run: () => doNewTag() },
    { label: 'Reset HEAD…', run: doReset },
    { sep: true },
    { label: 'New Worktree…', run: doNewWorktree },
    { label: 'Worktrees…', run: showWorktrees },
    { label: 'Show Git Log', run: showLog },
    { sep: true },
    { label: 'Patch › Create Patch from Local Changes…', run: doCreatePatch },
    { label: 'Patch › Apply Patch…', run: doApplyPatch },
    { sep: true },
    { label: 'Uncommitted Changes › Stash Changes…', run: doStash },
    { label: 'Uncommitted Changes › Unstash Changes…', run: showStashes },
    { label: 'Uncommitted Changes › Rollback…', run: doRollback },
    { sep: true },
    { label: 'Current File › Show History…', run: () => pickFile('fileHistory') },
    { label: 'Current File › Annotate with Git Blame…', run: () => pickFile('blame') },
    { label: 'Current File › Rollback…', run: () => pickFile('rollbackFile') }
  ]
}

function matches(text) {
  return !state.query || text.toLowerCase().includes(state.query.toLowerCase())
}

function treeHasMatch(tree, nameOf) {
  return tree.items.some((i) => matches(nameOf(i))) || tree.folders.some((f) => treeHasMatch(f, nameOf))
}

function buildRows() {
  const r = repo()
  const rows = []
  const q = state.query
  const push = (row) => rows.push(row)

  // Actions
  const actions = ACTIONS.filter((a) => matches(a.label))
  const menuMatches = q ? gitMenu().filter((m) => !m.sep && matches(m.label) && !ACTIONS.some((a) => a.label === m.label)) : []
  if (actions.length || menuMatches.length || !q) {
    push({ type: 'section', label: 'Actions', static: true })
    for (const a of actions) push({ type: 'action', label: a.label, icon: a.icon, run: a.run })
    for (const m of menuMatches) push({ type: 'action', label: m.label, icon: 'menu', run: m.run })
    if (!q) push({ type: 'action', label: 'Git Menu', icon: 'menu', chevron: true, run: () => setView({ kind: 'vcs' }) })
  }
  if (!r) return rows

  // Recent
  const recent = r.recent.filter((b) => matches(b.name))
  if (recent.length) {
    push({ type: 'section', label: 'Recent', key: 'sec:recent' })
    if (!state.collapsed.has('sec:recent') || q) for (const b of recent) push(branchRow(b, 1, 'recent'))
  }

  // Local
  if (!q || treeHasMatch(r.local, (b) => b.name)) {
    push({ type: 'section', label: 'Local', key: 'sec:local' })
    if (!state.collapsed.has('sec:local') || q) pushTree(rows, r.local, 1, 'local', (b) => b.name, (b, d) => branchRow(b, d, 'local'))
  }

  // Remote
  const remoteGroups = r.remote.filter((grp) => !q || treeHasMatch(grp.tree, (b) => b.name))
  if (remoteGroups.length) {
    push({ type: 'section', label: 'Remote', key: 'sec:remote' })
    if (!state.collapsed.has('sec:remote') || q) {
      for (const grp of remoteGroups) {
        const key = `remote:${grp.remote}`
        const open = q || !state.collapsed.has(key)
        push({ type: 'folder', label: grp.remote, key, depth: 1, open, isRemote: true })
        if (open) pushTree(rows, grp.tree, 2, `remote:${grp.remote}`, (b) => b.name, (b, d) => remoteRow(b, d))
      }
    }
  }

  // Tags
  if (state.data.settings.showTags !== false) {
    const tags = r.tags.filter((t) => matches(t.name))
    if (tags.length) {
      push({ type: 'section', label: 'Tags', key: 'sec:tags' })
      if (!state.collapsed.has('sec:tags') || q) for (const t of tags.slice(0, q ? 200 : 500)) push(tagRow(t, 1))
    }
  }
  return rows
}

function pushTree(rows, tree, depth, scope, nameOf, makeRow) {
  const q = state.query
  // Favorites first, then folders, then the rest.
  const favs = tree.items.filter((i) => i.favorite)
  for (const item of favs) if (matches(nameOf(item))) rows.push(makeRow(item, depth))
  for (const folder of tree.folders) {
    if (q && !treeHasMatch(folder, nameOf)) continue
    const key = `folder:${scope}:${folder.path}`
    const open = q || !state.collapsed.has(key)
    rows.push({ type: 'folder', label: folder.name, key, depth, open })
    if (open) pushTree(rows, folder, depth + 1, scope, nameOf, makeRow)
  }
  for (const item of tree.items) if (!item.favorite && matches(nameOf(item))) rows.push(makeRow(item, depth))
}

function branchRow(b, depth, scope) {
  return { type: 'branch', branch: b, depth, scope, label: depth > 1 || scope === 'local' ? b.name.split('/').pop() : b.name, full: b.name }
}
function remoteRow(b, depth) {
  return { type: 'remote', branch: b, depth, label: b.branch.split('/').pop(), full: b.name }
}
function tagRow(t, depth) {
  return { type: 'tag', tag: t, depth, label: t.name, full: t.name }
}

// ---------------------------------------------------------------------------
// Rendering

function highlight(text) {
  const q = state.query
  if (!q) return [text]
  const i = text.toLowerCase().indexOf(q.toLowerCase())
  if (i < 0) return [text]
  return [text.slice(0, i), el('mark', {}, text.slice(i, i + q.length)), text.slice(i + q.length)]
}

function render() {
  renderHeader()
  const scroll = viewEl.scrollTop
  viewEl.replaceChildren()
  if (state.view.kind === 'menu') return renderMenu(state.view)
  if (state.view.kind === 'vcs') return renderVcs()
  if (state.view.kind === 'viewer') return renderViewer(state.view)

  if (state.loading && !state.data) {
    viewEl.append(el('div', { class: 'empty' }, 'Loading branches…'))
    return
  }
  if (state.loadError) {
    viewEl.append(
      el('div', { class: 'empty' }, el('p', {}, 'Could not load the repository:'), el('pre', { class: 'code' }, state.loadError), el('button', { class: 'btn', onclick: () => load({ refreshWorkspace: true }) }, 'Retry'))
    )
    return
  }
  const rows = buildRows()
  state.rows = rows
  if (!repo()) {
    const ws = state.data?.workspace
    viewEl.append(
      el(
        'div',
        { class: 'empty' },
        el('p', {}, ws?.reason === 'no-focused-workspace' ? 'No workspace is focused in Orca.' : 'The focused Orca workspace is not a Git checkout this panel can find.'),
        el('button', { class: 'btn', onclick: pickWorkspace }, 'Pick a workspace…')
      )
    )
    return
  }
  const selectable = rows.filter((r) => r.type !== 'section')
  if (state.selected >= selectable.length) state.selected = Math.max(0, selectable.length - 1)
  let idx = 0
  for (const row of rows) {
    const node = renderRow(row)
    if (row.type !== 'section') {
      const myIdx = idx++
      node.dataset.idx = String(myIdx)
      if (myIdx === state.selected && (state.query || document.activeElement === viewEl || state.keyboard)) node.classList.add('selected')
    }
    viewEl.append(node)
  }
  if (rows.length === 0 || (state.query && selectable.length === 0)) {
    viewEl.append(el('div', { class: 'empty' }, `Nothing matches “${state.query}”.`))
  }
  viewEl.scrollTop = scroll
}

function indent(depth) {
  return `${8 + depth * 14}px`
}

function renderRow(row) {
  if (row.type === 'section') {
    const collapsed = row.key && state.collapsed.has(row.key) && !state.query
    return el(
      'div',
      { class: `section${row.static ? ' static' : ''}`, onclick: row.key ? () => toggle(row.key) : null },
      row.static ? null : icon(collapsed ? 'chevron-right' : 'chevron-down', 10),
      row.label
    )
  }
  if (row.type === 'action') {
    return el(
      'div',
      { class: 'row', style: { paddingLeft: indent(0) }, onclick: () => activate(row) },
      el('span', { class: 'kind' }, icon(row.icon, 14)),
      el('span', { class: 'label' }, ...highlight(row.label)),
      el('span', { class: 'spacer' }),
      row.chevron ? el('span', { class: 'chev' }, icon('chevron-right', 12)) : null
    )
  }
  if (row.type === 'folder') {
    return el(
      'div',
      { class: 'row', style: { paddingLeft: indent(row.depth - 1) }, onclick: () => toggle(row.key) },
      el('span', { class: 'twisty' }, icon(row.open ? 'chevron-down' : 'chevron-right', 10)),
      el('span', { class: 'kind folder' }, icon(row.isRemote ? 'remote' : 'folder', 14)),
      el('span', { class: 'label' }, row.label)
    )
  }
  if (row.type === 'branch') {
    const b = row.branch
    const node = el(
      'div',
      { class: `row${b.current ? ' current-branch' : ''}`, style: { paddingLeft: indent(row.depth) }, onclick: () => activate(row), title: branchTooltip(b) },
      el('span', { class: `kind${b.current ? ' current' : ''}` }, icon(b.current ? 'current' : 'branch', 14)),
      starButton(b.name, b.favorite),
      el('span', { class: 'label' }, ...highlight(row.scope === 'recent' ? b.name : row.label)),
      b.checkedOutElsewhere ? el('span', { class: 'badge', title: `Checked out in ${b.worktreePath}` }, 'worktree') : null,
      el('span', { class: 'spacer' }),
      counts(b),
      b.upstream ? el('span', { class: `upstream${b.gone ? ' gone' : ''}` }, b.upstream) : null,
      el('span', { class: 'chev' }, icon('chevron-right', 12))
    )
    return node
  }
  if (row.type === 'remote') {
    const b = row.branch
    return el(
      'div',
      { class: 'row', style: { paddingLeft: indent(row.depth) }, onclick: () => activate(row), title: b.name },
      el('span', { class: 'kind' }, icon('branch', 14)),
      starButton(b.name, b.favorite),
      el('span', { class: 'label' }, ...highlight(row.label)),
      el('span', { class: 'spacer' }),
      el('span', { class: 'chev' }, icon('chevron-right', 12))
    )
  }
  if (row.type === 'tag') {
    return el(
      'div',
      { class: 'row', style: { paddingLeft: indent(row.depth) }, onclick: () => activate(row), title: row.tag.subject || row.tag.name },
      el('span', { class: 'kind tag' }, icon('tag', 14)),
      el('span', { class: 'label' }, ...highlight(row.label)),
      el('span', { class: 'spacer' }),
      el('span', { class: 'chev' }, icon('chevron-right', 12))
    )
  }
  return el('div')
}

function branchTooltip(b) {
  const lines = [b.name]
  if (b.upstream) lines.push(`Tracks ${b.upstream}${b.gone ? ' (gone)' : ''}`)
  if (b.behind) lines.push(`${b.behind} incoming commit${b.behind === 1 ? '' : 's'}`)
  if (b.ahead) lines.push(`${b.ahead} outgoing commit${b.ahead === 1 ? '' : 's'}`)
  if (b.checkedOutElsewhere) lines.push(`Checked out in worktree ${b.worktreePath}`)
  if (b.subject) lines.push(`Last commit: ${b.subject}`)
  return lines.join('\n')
}

function counts(b) {
  if (!b.ahead && !b.behind) return null
  return el(
    'span',
    { class: 'counts' },
    b.behind ? el('span', { class: 'in', title: `${b.behind} incoming` }, icon('arrow-down', 11), String(b.behind)) : null,
    b.ahead ? el('span', { class: 'out', title: `${b.ahead} outgoing` }, icon('arrow-up', 11), String(b.ahead)) : null
  )
}

function starButton(name, on) {
  return el(
    'button',
    {
      class: `star${on ? ' on' : ''}`,
      title: on ? 'Remove from favorites' : 'Add to favorites',
      onclick: async (e) => {
        e.stopPropagation()
        const favs = await run('favorite.toggle', { name })
        if (favs) await load()
      }
    },
    icon(on ? 'star-filled' : 'star', 13)
  )
}

function toggle(key) {
  if (state.collapsed.has(key)) state.collapsed.delete(key)
  else state.collapsed.add(key)
  saveCollapsed()
  render()
}

function setView(view) {
  // Each view has its own filter text: the list's query comes back when you return to it.
  if (state.view.kind === 'list' && view.kind !== 'list') state.listQuery = state.query
  const q = view.kind === 'list' ? state.listQuery || '' : ''
  if (view.kind === 'list') state.listQuery = ''
  state.query = q
  searchEl.value = q
  searchEl.placeholder = view.kind === 'list' ? 'Search branches and actions' : 'Filter'
  state.view = view
  state.selected = 0
  searchEl.focus()
  viewEl.scrollTop = 0
  render()
}

function activate(row) {
  if (row.type === 'action') return row.run()
  if (row.type === 'folder') return toggle(row.key)
  if (row.type === 'branch') return setView({ kind: 'menu', target: { type: 'local', branch: row.branch } })
  if (row.type === 'remote') return setView({ kind: 'menu', target: { type: 'remote', branch: row.branch } })
  if (row.type === 'tag') return setView({ kind: 'menu', target: { type: 'tag', tag: row.tag } })
}

// ---------------------------------------------------------------------------
// Per-branch submenu

function menuItems(target) {
  const cur = current()
  const curLabel = currentLabel()
  if (target.type === 'local') {
    const b = target.branch
    const n = b.name
    if (b.current) {
      return [
        { label: `New Branch from '${n}'…`, run: () => doNewBranch(n) },
        { label: 'Show Diff with Working Tree', run: () => showDiff(n) },
        { sep: true },
        { label: 'Update', run: () => doUpdateBranch(n) },
        { label: 'Push…', run: () => doPush(n) },
        { sep: true },
        { label: 'Rename…', run: () => doRename(n) }
      ]
    }
    return [
      b.checkedOutElsewhere
        ? { label: 'Open Its Worktree in Orca', run: () => openWorktree(b.worktreePath) }
        : { label: 'Checkout', run: () => doCheckout(n) },
      { label: `New Branch from '${n}'…`, run: () => doNewBranch(n) },
      { label: `Checkout and Rebase onto '${curLabel}'`, run: () => doCheckoutAndRebase(n, cur), disabled: !cur || b.checkedOutElsewhere },
      { sep: true },
      { label: `Compare with '${curLabel}'`, run: () => showCompare(n) },
      { label: 'Show Diff with Working Tree', run: () => showDiff(n) },
      { sep: true },
      { label: `Rebase '${curLabel}' onto '${n}'`, run: () => doRebase(n), disabled: !cur },
      { label: `Merge '${n}' into '${curLabel}'`, run: () => doMerge(n), disabled: !cur },
      { sep: true },
      { label: 'Update', run: () => doUpdateBranch(n), disabled: !b.upstream },
      { label: 'Push…', run: () => doPush(n) },
      { sep: true },
      { label: 'Rename…', run: () => doRename(n) },
      { label: 'Delete', run: () => doDeleteBranch(n), danger: true }
    ]
  }
  if (target.type === 'remote') {
    const n = target.branch.name
    return [
      { label: 'Checkout', run: () => doCheckoutRemote(n) },
      { label: `New Branch from '${n}'…`, run: () => doNewBranch(n) },
      { sep: true },
      { label: `Compare with '${curLabel}'`, run: () => showCompare(n) },
      { label: 'Show Diff with Working Tree', run: () => showDiff(n) },
      { sep: true },
      { label: `Rebase '${curLabel}' onto '${n}'`, run: () => doRebase(n), disabled: !cur },
      { label: `Merge '${n}' into '${curLabel}'`, run: () => doMerge(n), disabled: !cur },
      { sep: true },
      { label: 'Delete', run: () => doDeleteRemote(n), danger: true }
    ]
  }
  const t = target.tag.name
  return [
    { label: 'Checkout', run: () => doCheckout(t, { detach: true }) },
    { label: `New Branch from '${t}'…`, run: () => doNewBranch(t) },
    { sep: true },
    { label: `Compare with '${curLabel}'`, run: () => showCompare(t) },
    { label: 'Show Diff with Working Tree', run: () => showDiff(t) },
    { label: `Merge '${t}' into '${curLabel}'`, run: () => doMerge(t), disabled: !cur },
    { sep: true },
    { label: 'Delete Tag', run: () => doDeleteTag(t), danger: true }
  ]
}

function renderMenuList(title, sub, items, { onBack } = {}) {
  viewEl.append(
    el(
      'div',
      { class: 'subhead' },
      el('button', { class: 'icon-btn', title: 'Back (Esc)', onclick: onBack || (() => setView({ kind: 'list' })) }, icon('back', 16)),
      el('span', { class: 'title' }, title),
      sub ? el('span', { class: 'sub' }, sub) : null
    )
  )
  const visible = []
  for (const i of items.filter((x) => x.sep || matches(x.label))) {
    if (i.sep && (!visible.length || visible[visible.length - 1].sep)) continue
    visible.push(i)
  }
  if (visible.length && visible[visible.length - 1].sep) visible.pop()
  state.rows = []
  let idx = 0
  for (const item of visible) {
    if (item.sep) {
      viewEl.append(el('div', { class: 'sep' }))
      continue
    }
    const myIdx = idx++
    state.rows.push({ type: 'menu', item })
    const node = el(
      'div',
      {
        class: `row menu-row${item.danger ? ' danger' : ''}${item.disabled ? ' disabled' : ''}`,
        onclick: () => !item.disabled && item.run()
      },
      el('span', { class: 'label' }, ...highlight(item.label))
    )
    node.dataset.idx = String(myIdx)
    if (myIdx === state.selected) node.classList.add('selected')
    viewEl.append(node)
  }
}

function renderMenu(view) {
  const t = view.target
  const name = t.type === 'tag' ? t.tag.name : t.branch.name
  let sub = ''
  if (t.type === 'local') {
    const b = t.branch
    sub = [b.upstream && `→ ${b.upstream}`, b.behind && `↓${b.behind}`, b.ahead && `↑${b.ahead}`].filter(Boolean).join('  ')
  }
  renderMenuList(name, sub, menuItems(t))
}

function renderVcs() {
  renderMenuList('Git', currentLabel(), gitMenu())
}

// ---------------------------------------------------------------------------
// Viewers (compare, diff, log, history, blame, worktrees, stashes)

function renderViewer(view) {
  viewEl.append(
    el(
      'div',
      { class: 'subhead' },
      el('button', { class: 'icon-btn', title: 'Back (Esc)', onclick: () => setView(view.back || { kind: 'list' }) }, icon('back', 16)),
      el('span', { class: 'title' }, view.title),
      view.sub ? el('span', { class: 'sub' }, view.sub) : null
    )
  )
  const body = el('div', { class: 'viewer' })
  view.draw(body)
  viewEl.append(body)
}

function commitList(commits) {
  if (!commits.length) return el('div', { class: 'hint' }, 'No commits')
  return el(
    'div',
    {},
    ...commits.map((c) =>
      el('div', { class: 'commit', title: `${c.sha}\n${c.author} · ${new Date(c.date * 1000).toLocaleString()}` }, el('span', { class: 'sha' }, c.short), el('span', { class: 'subj' }, c.subject), el('span', { class: 'who' }, c.author))
    )
  )
}

function patchView(text) {
  const pre = el('pre', { class: 'code' })
  for (const line of text.split('\n')) {
    let cls = ''
    if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('diff ') || line.startsWith('index ')) cls = 'meta'
    else if (line.startsWith('+')) cls = 'add'
    else if (line.startsWith('-')) cls = 'del'
    else if (line.startsWith('@@')) cls = 'hunk'
    pre.append(cls ? el('span', { class: cls }, line) : line, '\n')
  }
  return pre
}

async function showCompare(other) {
  const base = current() || 'HEAD'
  const res = await run('compare', { base, other })
  if (!res) return
  const back = state.view
  setView({
    kind: 'viewer',
    back,
    title: `${other} ⇄ ${currentLabel()}`,
    draw(body) {
      body.append(el('h3', {}, `In '${other}' but not in '${currentLabel()}' (${res.onlyInOther.length})`), commitList(res.onlyInOther))
      body.append(el('h3', {}, `In '${currentLabel()}' but not in '${other}' (${res.onlyInBase.length})`), commitList(res.onlyInBase))
    }
  })
}

async function showDiff(ref) {
  const res = await run('diffWorkingTree', { ref })
  if (!res) return
  const back = state.view
  setView({
    kind: 'viewer',
    back,
    title: `Diff: ${ref} ↔ working tree`,
    sub: `${res.files.length} file${res.files.length === 1 ? '' : 's'}`,
    draw(body) {
      if (!res.files.length) return body.append(el('div', { class: 'hint' }, 'No differences.'))
      body.append(
        el('h3', {}, 'Files'),
        ...res.files.map((f) =>
          el('div', { class: 'file-row' }, el('span', { class: 'path' }, f.path), f.added != null ? el('span', { class: 'out' }, `+${f.added}`) : null, f.deleted != null ? el('span', { class: 'del', style: { color: 'var(--danger)' } }, `−${f.deleted}`) : null)
        ),
        el('h3', {}, 'Patch'),
        patchView(res.patch)
      )
    }
  })
}

async function showLog() {
  const res = await run('log', { max: 400 })
  if (!res) return
  setView({
    kind: 'viewer',
    back: { kind: 'vcs' },
    title: 'Git Log',
    sub: 'all branches, newest 400',
    draw(body) {
      const pre = el('pre', { class: 'code' })
      for (const l of res) {
        if (!l.short) {
          pre.append(el('span', { class: 'meta' }, l.graph), '\n')
          continue
        }
        pre.append(el('span', { class: 'meta' }, l.graph), el('span', { class: 'hunk' }, l.short), ' ', l.refs ? el('span', { class: 'refs' }, `(${l.refs}) `) : '', l.subject, el('span', { class: 'meta' }, ` — ${l.author}, ${l.when}`), '\n')
      }
      body.append(pre)
    }
  })
}

async function showWorktrees() {
  const res = await run('worktrees')
  if (!res) return
  setView({
    kind: 'viewer',
    back: { kind: 'vcs' },
    title: 'Worktrees',
    draw(body) {
      for (const w of res) {
        body.append(
          el(
            'div',
            { class: 'file-row', style: { alignItems: 'center', padding: '4px 0' } },
            el('span', { class: 'path', title: w.path }, el('strong', {}, w.branch || (w.detached ? `detached ${w.head?.slice(0, 8)}` : '(bare)')), ' ', el('span', { class: 'hint' }, w.path)),
            w.current ? el('span', { class: 'badge' }, 'this') : el('button', { class: 'btn', onclick: () => openWorktree(w.path) }, w.inOrca ? 'Open' : 'Open in Orca')
          )
        )
      }
      body.append(el('div', { style: { marginTop: '8px' } }, el('button', { class: 'btn', onclick: doNewWorktree }, 'New Worktree…')))
    }
  })
}

async function showStashes() {
  const res = await run('stashList')
  if (!res) return
  setView({
    kind: 'viewer',
    back: { kind: 'vcs' },
    title: 'Stashes',
    sub: `${res.length}`,
    draw(body) {
      if (!res.length) body.append(el('div', { class: 'hint' }, 'No stashes.'))
      for (const s of res) {
        body.append(
          el(
            'div',
            { class: 'file-row', style: { alignItems: 'center', padding: '3px 0' } },
            el('span', { class: 'path', title: s.subject }, el('span', { class: 'sha' }, s.ref), ' ', s.subject),
            el('button', { class: 'btn', title: 'Apply and drop', onclick: () => doUnstash(s.ref, true) }, 'Pop'),
            el('button', { class: 'btn', title: 'Apply and keep', onclick: () => doUnstash(s.ref, false) }, 'Apply'),
            el('button', { class: 'btn', title: 'Drop', onclick: () => doDropStash(s.ref) }, icon('trash', 13))
          )
        )
      }
      body.append(el('div', { style: { marginTop: '8px' } }, el('button', { class: 'btn', onclick: doStash }, 'Stash Changes…')))
    }
  })
}

// ---------------------------------------------------------------------------
// Result handling shared by every mutating action

/**
 * Handles a git op result. `retry(extra)` re-runs the op with extra args (mode, force).
 * Returns true when the op finished (ok or reported), false when cancelled.
 */
async function handleResult(title, res, retry) {
  if (res === undefined) return false
  if (!res || res.status === 'ok' || res.status === undefined) {
    toast(firstLines(res?.output) || `${title}: done`)
    if (state.view.kind !== 'viewer') setView({ kind: 'list' })
    await afterChange()
    return true
  }
  switch (res.status) {
    case 'needs-decision': {
      const choice = await dialog({
        title: 'Checkout would overwrite local changes',
        body: [
          el('p', {}, res.untracked ? 'These untracked files would be overwritten:' : 'Your local changes to these files would be overwritten:'),
          el('ul', { class: 'files' }, ...res.files.map((f) => el('li', {}, f))),
          el('p', {}, 'Smart Checkout stashes your changes, checks out, then restores them. Force Checkout discards them.')
        ],
        buttons: [
          { label: 'Cancel', value: 'cancel' },
          { label: 'Force Checkout', value: 'force', kind: 'danger' },
          { label: 'Smart Checkout', value: 'smart', kind: 'primary' }
        ]
      })
      if (choice.button === 'smart') return handleResult(title, await retry({ mode: 'smart' }), retry)
      if (choice.button === 'force') {
        const ok = await confirmDialog('Discard local changes?', `Force Checkout permanently discards your changes to ${res.files.length} file${res.files.length === 1 ? '' : 's'}. This cannot be undone.`, 'Discard and Checkout')
        if (ok) return handleResult(title, await retry({ mode: 'force' }), retry)
      }
      return false
    }
    case 'worktree-conflict': {
      const choice = await dialog({
        title: `'${res.branch}' is checked out in another worktree`,
        body: [el('p', {}, 'Git does not allow one branch in two worktrees. It is checked out at:'), el('pre', {}, res.worktreePath)],
        buttons: [
          { label: 'Cancel', value: 'cancel' },
          { label: 'Open That Worktree in Orca', value: 'open', kind: 'primary' }
        ]
      })
      if (choice.button === 'open') await openWorktree(res.worktreePath)
      return false
    }
    case 'unstash-conflict': {
      await dialog({
        title: 'Checked out, but your changes conflict',
        body: [
          el('p', {}, 'The checkout succeeded. Restoring your stashed changes caused conflicts in:'),
          el('ul', { class: 'files' }, ...(res.conflicts.length ? res.conflicts : ['(see git output)']).map((f) => el('li', {}, f))),
          el('p', {}, 'Your changes are still saved in the stash (Git menu › Uncommitted Changes › Unstash). Resolve the conflicts in the editor.'),
          el('pre', {}, res.message)
        ],
        buttons: [{ label: 'OK', value: 'ok', kind: 'primary' }]
      })
      await afterChange()
      return true
    }
    case 'conflict': {
      const r = await dialog({
        title: `${title}: conflicts`,
        body: [el('p', {}, 'Git stopped with conflicts in:'), el('ul', { class: 'files' }, ...res.conflicts.map((f) => el('li', {}, f))), el('pre', {}, res.message), el('p', {}, 'Resolve them in the editor, then use Continue in the banner, or abort.')],
        buttons: [
          { label: 'Abort', value: 'abort', kind: 'danger' },
          { label: 'Resolve Later', value: 'ok', kind: 'primary' }
        ]
      })
      await afterChange()
      if (r.button === 'abort') await doAbort(title)
      return true
    }
    case 'unmerged': {
      const ok = await confirmDialog('Branch is not fully merged', `${res.message}\n\nDelete it anyway? Its unmerged commits will only be reachable from the reflog.`, 'Delete Anyway')
      if (ok) return handleResult(title, await retry({ force: true }), retry)
      return false
    }
    case 'rejected': {
      const ok = await confirmDialog(
        'Push rejected',
        `${res.message}\n\nThe remote has commits you do not have. Update first, or force push with --force-with-lease (refused if someone pushed since your last fetch). Force push can overwrite other people's commits.`,
        'Force Push (with lease)'
      )
      if (ok) return handleResult(title, await retry({ force: true }), retry)
      return false
    }
    default:
      await errorDialog(title, JSON.stringify(res, null, 2))
      return false
  }
}

function firstLines(text, n = 4) {
  if (!text) return ''
  return text.split('\n').filter(Boolean).slice(-n).join('\n')
}

async function openWorktree(p) {
  const res = await run('workspace.open', { path: p }, { title: 'Could not open the worktree' })
  if (res) toast(`Opened ${p}`)
}

// ---------------------------------------------------------------------------
// Actions

async function doCheckout(target, { detach = false } = {}) {
  const op = (extra = {}) => run('checkout', { target, detach, ...extra }, { title: `Checkout ${target}` })
  await handleResult(`Checked out ${target}`, await op(), op)
}

async function doCheckoutRemote(name) {
  const op = (extra = {}) => run('checkoutRemote', { name, ...extra }, { title: `Checkout ${name}` })
  await handleResult(`Checked out ${name}`, await op(), op)
}

async function doCheckoutAndRebase(branch, onto) {
  const op = () => run('checkoutAndRebase', { branch, onto }, { title: 'Checkout and Rebase' })
  await handleResult(`Rebased ${branch} onto ${onto}`, await op(), op)
}

async function doMerge(ref) {
  const ok = await confirmDialog(`Merge '${ref}' into '${currentLabel()}'?`, null, 'Merge', { danger: false })
  if (!ok) return
  const op = () => run('merge', { ref }, { title: 'Merge' })
  await handleResult('Merge', await op(), op)
}

async function doRebase(onto) {
  const ok = await confirmDialog(`Rebase '${currentLabel()}' onto '${onto}'?`, 'Your branch’s commits are replayed on top of the target. Rewrites history of the current branch.', 'Rebase', { danger: false })
  if (!ok) return
  const op = () => run('rebase', { onto }, { title: 'Rebase' })
  await handleResult('Rebase', await op(), op)
}

async function doUpdateBranch(name) {
  const op = () => run('updateBranch', { name }, { title: `Update ${name}` })
  await handleResult(`Updated ${name}`, await op(), op)
}

async function doDeleteBranch(name) {
  const op = (extra = {}) => run('deleteBranch', { name, ...extra }, { title: `Delete ${name}` })
  await handleResult(`Deleted ${name}`, await op(), op)
}

async function doDeleteRemote(name) {
  const ok = await confirmDialog(`Delete remote branch '${name}'?`, `This runs git push --delete on the remote. Everyone who uses the remote loses the branch.`, 'Delete Remote Branch')
  if (!ok) return
  const op = () => run('deleteRemoteBranch', { name }, { title: `Delete ${name}` })
  await handleResult(`Deleted ${name}`, await op(), op)
}

async function doDeleteTag(name) {
  const ok = await confirmDialog(`Delete tag '${name}'?`, 'Deletes the local tag only.', 'Delete Tag')
  if (!ok) return
  const op = () => run('deleteTag', { name })
  await handleResult(`Deleted tag ${name}`, await op(), op)
}

function branchNameError(v) {
  if (!v.trim()) return 'Enter a name'
  if (/\s/.test(v)) return 'Branch names cannot contain spaces'
  if (/\.\.|[~^:?*[\\]|@\{|\/$|^\/|\.lock$|^-/.test(v)) return 'Not a valid Git branch name'
  if (repo()?.local && findLocal(v)) return `Branch '${v}' already exists`
  return null
}

function findLocal(name) {
  const walk = (tree) => tree.items.find((b) => b.name === name) || tree.folders.map(walk).find(Boolean)
  return walk(repo().local)
}

async function doNewBranch(from) {
  const start = from || null
  const r = await dialog({
    title: start ? `New Branch from '${start}'` : 'New Branch',
    fields: [
      { id: 'name', label: 'New branch name', type: 'text', value: '', validate: branchNameError, autofocus: true },
      { id: 'checkout', label: 'Checkout branch', type: 'checkbox', value: true }
    ],
    buttons: [
      { label: 'Cancel', value: 'cancel' },
      { label: 'Create', value: 'ok', kind: 'primary', submit: true }
    ]
  })
  if (r.button !== 'ok') return
  const op = () => run('createBranch', { name: r.values.name.trim(), startPoint: start, checkout: r.values.checkout }, { title: 'New Branch' })
  await handleResult(`Created ${r.values.name.trim()}`, await op(), op)
}

async function doRename(name) {
  const r = await dialog({
    title: `Rename '${name}'`,
    fields: [{ id: 'name', label: 'New name', type: 'text', value: name, validate: (v) => (v === name ? 'Enter a different name' : branchNameError(v)), autofocus: true }],
    buttons: [
      { label: 'Cancel', value: 'cancel' },
      { label: 'Rename', value: 'ok', kind: 'primary', submit: true }
    ]
  })
  if (r.button !== 'ok') return
  const op = () => run('renameBranch', { from: name, to: r.values.name.trim() }, { title: 'Rename' })
  await handleResult(`Renamed to ${r.values.name.trim()}`, await op(), op)
}

async function doCheckoutRevision() {
  const r = await dialog({
    title: 'Checkout Tag or Revision',
    fields: [{ id: 'rev', label: 'Tag, commit hash or revision expression (HEAD~2, origin/main@{1}…)', type: 'text', value: '', autofocus: true, validate: (v) => (!v.trim() ? 'Enter a revision' : null) }],
    buttons: [
      { label: 'Cancel', value: 'cancel' },
      { label: 'Checkout', value: 'ok', kind: 'primary', submit: true }
    ]
  })
  if (r.button !== 'ok') return
  const rev = r.values.rev.trim()
  const sha = await run('resolveRevision', { rev })
  if (sha === undefined) return
  if (!sha) return errorDialog('Unknown revision', `fatal: '${rev}' does not name a commit`)
  await doCheckout(rev, { detach: !findLocal(rev) })
}

async function doNewTag() {
  const r = await dialog({
    title: 'New Tag',
    fields: [
      { id: 'name', label: 'Tag name', type: 'text', value: '', autofocus: true, validate: (v) => (!v.trim() || /\s/.test(v) ? 'Enter a tag name without spaces' : null) },
      { id: 'ref', label: 'Commit', type: 'text', value: 'HEAD' },
      { id: 'message', label: 'Message (makes an annotated tag)', type: 'textarea', value: '' }
    ],
    buttons: [
      { label: 'Cancel', value: 'cancel' },
      { label: 'Create Tag', value: 'ok', kind: 'primary', submit: true }
    ]
  })
  if (r.button !== 'ok') return
  const op = () => run('createTag', { name: r.values.name.trim(), ref: r.values.ref.trim() || 'HEAD', message: r.values.message.trim() || undefined }, { title: 'New Tag' })
  await handleResult(`Created tag ${r.values.name.trim()}`, await op(), op)
}

async function doReset() {
  const r = await dialog({
    title: `Reset HEAD (${currentLabel()})`,
    fields: [
      { id: 'ref', label: 'To commit', type: 'text', value: 'HEAD', autofocus: true },
      {
        id: 'mode',
        label: 'Mode',
        type: 'select',
        value: 'mixed',
        options: [
          ['soft', 'Soft: keep changes staged'],
          ['mixed', 'Mixed: keep changes unstaged'],
          ['hard', 'Hard: discard all changes'],
          ['keep', 'Keep: keep local changes, refuse if they conflict']
        ]
      }
    ],
    buttons: [
      { label: 'Cancel', value: 'cancel' },
      { label: 'Reset', value: 'ok', kind: 'primary', submit: true }
    ]
  })
  if (r.button !== 'ok') return
  const { mode } = r.values
  const ref = r.values.ref.trim() || 'HEAD'
  if (mode === 'hard') {
    const ok = await confirmDialog('Reset --hard?', `This discards every uncommitted change and moves '${currentLabel()}' to ${ref}. It cannot be undone.`, 'Reset Hard')
    if (!ok) return
  }
  const op = () => run('reset', { mode, ref }, { title: 'Reset' })
  await handleResult(`Reset (${mode}) to ${ref}`, await op(), op)
}

async function doUpdateProject() {
  const method = state.data?.settings?.updateMethod || 'rebase'
  toast(`Updating (${method})…`)
  const op = () => run('updateProject', {}, { title: 'Update Project' })
  await handleResult('Update Project', await op(), op)
}

async function doPull() {
  const method = state.data?.settings?.updateMethod || 'rebase'
  const r = await dialog({
    title: `Pull into '${currentLabel()}'`,
    fields: [{ id: 'method', label: 'Integrate with', type: 'select', value: method, options: [['rebase', 'Rebase'], ['merge', 'Merge']] }],
    buttons: [
      { label: 'Cancel', value: 'cancel' },
      { label: 'Pull', value: 'ok', kind: 'primary', submit: true }
    ]
  })
  if (r.button !== 'ok') return
  if (r.values.method !== method) await run('settings.set', { key: 'updateMethod', value: r.values.method })
  const op = () => run('pull', {}, { title: 'Pull' })
  await handleResult('Pull', await op(), op)
  await load()
}

async function doFetch() {
  const btn = $('fetch')
  btn.disabled = true
  btn.classList.add('spinning')
  try {
    const res = await run('fetch', {}, { title: 'Fetch' })
    if (res) {
      toast(firstLines(res.output) || 'Fetched all remotes')
      await afterChange()
    }
  } finally {
    btn.disabled = false
    btn.classList.remove('spinning')
  }
}

async function doPush(branch) {
  const name = branch || current()
  if (!name) return errorDialog('Push', 'HEAD is detached: check out a branch to push it.')
  const b = findLocal(name)
  let commits = []
  if (b?.upstream) {
    const cmp = await run('compare', { base: b.upstream, other: name }, { quiet: true })
    commits = cmp?.onlyInOther || []
  }
  const r = await dialog({
    title: `Push '${name}'`,
    body: [
      el('p', {}, b?.upstream ? `To ${b.upstream}` : 'No upstream yet: the branch is pushed to the default remote and tracked.'),
      b?.upstream ? el('p', { class: 'hint' }, `${commits.length} commit${commits.length === 1 ? '' : 's'} to push`) : null,
      commits.length ? commitList(commits.slice(0, 50)) : null
    ],
    fields: [{ id: 'force', label: 'Force push (--force-with-lease)', type: 'checkbox', value: false }],
    buttons: [
      { label: 'Cancel', value: 'cancel' },
      { label: 'Push', value: 'ok', kind: 'primary', submit: true }
    ]
  })
  if (r.button !== 'ok') return
  if (r.values.force) {
    const ok = await confirmDialog('Force push?', `Force pushing '${name}' rewrites the remote branch. --force-with-lease refuses if someone else pushed since your last fetch.`, 'Force Push')
    if (!ok) return
  }
  const op = (extra = {}) => run('push', { branch: name, force: r.values.force, ...extra }, { title: 'Push' })
  await handleResult(`Pushed ${name}`, await op(), op)
}

async function doCommit() {
  const r0 = repo()
  const r = await dialog({
    title: `Commit to '${currentLabel()}'`,
    body: [el('p', { class: 'hint' }, `${r0?.changes?.total ?? 0} changed file(s). Orca's own commit panel is also in the palette: “Git: Commit (Orca Source Control)”.`)],
    fields: [
      { id: 'message', label: 'Commit message', type: 'textarea', value: '', autofocus: true },
      { id: 'all', label: 'Stage all changes (including new files)', type: 'checkbox', value: true },
      { id: 'amend', label: 'Amend previous commit', type: 'checkbox', value: false }
    ],
    buttons: [
      { label: 'Cancel', value: 'cancel' },
      { label: 'Commit', value: 'ok', kind: 'primary', submit: true }
    ]
  })
  if (r.button !== 'ok') return
  if (!r.values.message.trim() && !r.values.amend) return errorDialog('Commit', 'Commit message is empty.')
  const op = () => run('commit', { message: r.values.message.trim(), all: r.values.all, amend: r.values.amend }, { title: 'Commit' })
  await handleResult('Committed', await op(), op)
}

function refPickerField(id, label) {
  const r = repo()
  const refs = []
  const walk = (tree, out) => {
    tree.items.forEach((i) => out.push(i.name))
    tree.folders.forEach((f) => walk(f, out))
  }
  if (r) {
    walk(r.local, refs)
    r.remote.forEach((g) => walk(g.tree, refs))
  }
  return { id, label, type: 'text', value: '', options: refs.filter((n) => n !== current()), autofocus: true, validate: (v) => (!v.trim() ? 'Pick a branch' : null) }
}

async function doMergePick() {
  const r = await dialog({
    title: `Merge into '${currentLabel()}'`,
    fields: [refPickerField('ref', 'Branch to merge')],
    buttons: [
      { label: 'Cancel', value: 'cancel' },
      { label: 'Merge', value: 'ok', kind: 'primary', submit: true }
    ]
  })
  if (r.button !== 'ok') return
  const op = () => run('merge', { ref: r.values.ref.trim() }, { title: 'Merge' })
  await handleResult('Merge', await op(), op)
}

async function doRebasePick() {
  const r = await dialog({
    title: `Rebase '${currentLabel()}' onto…`,
    fields: [refPickerField('onto', 'Onto branch')],
    buttons: [
      { label: 'Cancel', value: 'cancel' },
      { label: 'Rebase', value: 'ok', kind: 'primary', submit: true }
    ]
  })
  if (r.button !== 'ok') return
  const op = () => run('rebase', { onto: r.values.onto.trim() }, { title: 'Rebase' })
  await handleResult('Rebase', await op(), op)
}

async function doNewWorktree() {
  const r = await dialog({
    title: 'New Worktree (Orca workspace)',
    body: [el('p', { class: 'hint' }, 'Created by Orca, so it appears in the left sidebar.')],
    fields: [
      { id: 'name', label: 'Name (also the new branch)', type: 'text', value: '', autofocus: true, validate: branchNameError },
      { ...refPickerField('base', 'Base branch'), autofocus: false, value: current() || '', validate: null }
    ],
    buttons: [
      { label: 'Cancel', value: 'cancel' },
      { label: 'Create', value: 'ok', kind: 'primary', submit: true }
    ]
  })
  if (r.button !== 'ok') return
  const res = await run('newWorktree', { name: r.values.name.trim(), baseBranch: r.values.base.trim() || undefined }, { title: 'New Worktree' })
  if (res) {
    toast(`Created worktree ${r.values.name.trim()}`)
    await afterChange()
  }
}

async function doStash() {
  const r = await dialog({
    title: 'Stash Changes',
    fields: [
      { id: 'message', label: 'Message', type: 'text', value: '', autofocus: true },
      { id: 'untracked', label: 'Include untracked files', type: 'checkbox', value: true }
    ],
    buttons: [
      { label: 'Cancel', value: 'cancel' },
      { label: 'Stash', value: 'ok', kind: 'primary', submit: true }
    ]
  })
  if (r.button !== 'ok') return
  const op = () => run('stash', { message: r.values.message.trim() || undefined, includeUntracked: r.values.untracked }, { title: 'Stash' })
  await handleResult('Stashed', await op(), op)
}

async function doUnstash(ref, pop) {
  const op = () => run('unstash', { ref, pop }, { title: 'Unstash' })
  const done = await handleResult(pop ? `Popped ${ref}` : `Applied ${ref}`, await op(), op)
  if (done && state.view.kind === 'viewer') await showStashes()
}

async function doDropStash(ref) {
  const ok = await confirmDialog(`Drop ${ref}?`, 'The stashed changes are deleted.', 'Drop')
  if (!ok) return
  const res = await run('dropStash', { ref })
  if (res) await showStashes()
}

async function doRollback() {
  const st = await run('status')
  if (!st) return
  const changed = st.filter((e) => !e.untracked)
  if (!changed.length) return toast('No local changes to roll back')
  const r = await dialog({
    title: 'Rollback Changes',
    body: [el('p', {}, 'Revert these files to HEAD:'), el('ul', { class: 'files' }, ...changed.map((e) => el('li', {}, `${e.x}${e.y} ${e.path}`)))],
    fields: [{ id: 'deleteAdded', label: 'Delete files added since HEAD', type: 'checkbox', value: false }],
    buttons: [
      { label: 'Cancel', value: 'cancel' },
      { label: 'Rollback', value: 'ok', kind: 'danger' }
    ]
  })
  if (r.button !== 'ok') return
  const ok = await confirmDialog('Discard these changes?', `${changed.length} file(s) return to their committed state. This cannot be undone.`, 'Rollback')
  if (!ok) return
  const op = () => run('rollback', { deleteAdded: r.values.deleteAdded }, { title: 'Rollback' })
  await handleResult('Rolled back', await op(), op)
}

async function doCreatePatch() {
  const patch = await run('createPatch', {}, { title: 'Create Patch' })
  if (patch === undefined) return
  if (!patch.trim()) return toast('No local changes to put in a patch')
  const r = await dialog({
    title: 'Create Patch from Local Changes',
    body: [el('p', {}, `${patch.split('\n').length} lines.`), patchView(patch.slice(0, 20000))],
    buttons: [
      { label: 'Close', value: 'cancel' },
      {
        label: 'Save Patch…',
        value: 'save',
        kind: 'primary',
        // saveAs needs the click itself, so it runs inside the handler.
        onClick: async () => {
          if (!orca?.files?.saveAs) return errorDialog('Save Patch', 'Saving files needs the Orca desktop app.')
          const branch = (current() || 'changes').replace(/[^\w.-]+/g, '-')
          const res = await orca.files.saveAs({ suggestedName: `${branch}.patch`, mimeType: 'text/x-patch', data: patch })
          if (res?.status === 'saved') toast('Patch saved')
        }
      }
    ]
  })
  return r
}

async function doApplyPatch() {
  const input = el('input', { type: 'file', accept: '.patch,.diff,text/x-patch,text/plain' })
  let text = null
  input.addEventListener('change', async () => {
    const file = input.files?.[0]
    text = file ? await file.text() : null
    info.textContent = file ? `${file.name}: ${text.split('\n').length} lines` : ''
  })
  const info = el('p', { class: 'hint' }, '')
  const r = await dialog({
    title: 'Apply Patch',
    body: [el('p', {}, 'Applies with git apply --3way.'), input, info],
    buttons: [
      { label: 'Cancel', value: 'cancel' },
      { label: 'Apply', value: 'ok', kind: 'primary' }
    ]
  })
  if (r.button !== 'ok') return
  if (!text) return errorDialog('Apply Patch', 'Choose a patch file first.')
  const op = () => run('applyPatch', { patch: text }, { title: 'Apply Patch' })
  await handleResult('Patch applied', await op(), op)
}

async function pickFile(kind) {
  const files = await run('trackedFiles')
  if (!files) return
  const titles = { fileHistory: 'Show History', blame: 'Annotate with Git Blame', rollbackFile: 'Rollback File' }
  const r = await dialog({
    title: `${titles[kind]}: pick a file`,
    body: [el('p', { class: 'hint' }, 'Orca does not tell plugins which file is open, so pick it here.')],
    fields: [{ id: 'file', label: 'File', type: 'text', value: store.get('lastFile', ''), options: files, autofocus: true, validate: (v) => (files.includes(v) ? null : 'Pick a tracked file') }],
    buttons: [
      { label: 'Cancel', value: 'cancel' },
      { label: 'OK', value: 'ok', kind: 'primary', submit: true }
    ]
  })
  if (r.button !== 'ok') return
  const file = r.values.file
  store.set('lastFile', file)
  if (kind === 'fileHistory') {
    const res = await run('fileHistory', { file })
    if (!res) return
    setView({ kind: 'viewer', back: { kind: 'vcs' }, title: `History: ${file}`, sub: `${res.length} commits`, draw: (body) => body.append(commitList(res)) })
  } else if (kind === 'blame') {
    const res = await run('blame', { file })
    if (!res) return
    setView({
      kind: 'viewer',
      back: { kind: 'vcs' },
      title: `Blame: ${file}`,
      draw(body) {
        const box = el('div', { class: 'code', style: { overflow: 'auto' } })
        let prev = null
        for (const l of res) {
          const ann = l.sha === prev ? '' : `${l.short} ${l.author ?? ''} ${l.date ? new Date(l.date * 1000).toLocaleDateString() : ''}`
          prev = l.sha
          box.append(el('div', { class: 'blame-line', title: `${l.short} ${l.subject ?? ''}` }, el('span', { class: 'ann' }, ann), el('span', {}, l.text)))
        }
        body.append(box)
      }
    })
  } else {
    const ok = await confirmDialog(`Rollback ${file}?`, 'The file returns to its committed state. Your changes to it are lost.', 'Rollback')
    if (!ok) return
    const op = () => run('rollback', { paths: [file] }, { title: 'Rollback' })
    await handleResult(`Rolled back ${file}`, await op(), op)
  }
}

async function doAbort(opName) {
  const ok = await confirmDialog(`Abort ${opName}?`, 'Returns the branch to where it was before the operation started. Conflict resolutions made so far are lost.', 'Abort')
  if (!ok) return
  const res = await run('abort', {}, { title: 'Abort' })
  if (res) {
    toast('Aborted')
    await afterChange()
  }
}

async function doContinue() {
  const op = () => run('continue', {}, { title: 'Continue' })
  await handleResult('Continued', await op(), op)
}

async function pickWorkspace() {
  const ws = state.data?.workspace
  const options = [['', 'Follow the focused Orca workspace'], ...(ws?.worktrees || []).map((w) => [w.path, `${w.displayName} · ${w.branch} — ${w.path}`])]
  const r = await dialog({
    title: 'Workspace',
    body: [
      el('p', { class: 'hint' }, ws?.reason === 'ambiguous' ? 'Several Orca workspaces match the focused one by name and branch. The most recently active is used unless you pick one.' : 'This panel follows the workspace focused in Orca. You can pin another one.')
    ],
    fields: [{ id: 'path', label: 'Work on', type: 'select', value: ws?.override ? ws.path : '', options }],
    buttons: [
      { label: 'Cancel', value: 'cancel' },
      { label: 'Use', value: 'ok', kind: 'primary', submit: true }
    ]
  })
  if (r.button !== 'ok') return
  const data = await run('workspace.select', { path: r.values.path || null })
  if (data) {
    state.data = data
    setView({ kind: 'list' })
  }
}

async function openSettings() {
  const s = state.data?.settings || {}
  const r = await dialog({
    title: 'Git Controls Settings',
    fields: [
      { id: 'updateMethod', label: 'Update Project / Pull method', type: 'select', value: s.updateMethod || 'rebase', options: [['rebase', 'Rebase'], ['merge', 'Merge']] },
      { id: 'recentCount', label: 'Recent branches shown', type: 'number', value: s.recentCount ?? 5 },
      { id: 'showTags', label: 'Show tags', type: 'checkbox', value: s.showTags !== false },
      { id: 'fetchOnOpen', label: 'Fetch when the panel opens', type: 'checkbox', value: Boolean(s.fetchOnOpen) }
    ],
    buttons: [
      { label: 'Cancel', value: 'cancel' },
      { label: 'Save', value: 'ok', kind: 'primary', submit: true }
    ]
  })
  if (r.button !== 'ok') return
  const values = { ...r.values, recentCount: Math.max(0, Math.min(20, Number(r.values.recentCount) || 0)) }
  for (const [key, value] of Object.entries(values)) {
    if (s[key] !== value) await run('settings.set', { key, value })
  }
  await load()
}

// ---------------------------------------------------------------------------
// Palette commands hand dialogs to the panel

async function handleIntent(intent) {
  if (!intent) return
  if (intent.kind === 'result') {
    const retryOp = (extra = {}) => run(intent.op, { ...(intent.args || {}), ...extra }, { title: intent.title })
    return handleResult(intent.title, intent.value, retryOp)
  }
  const map = {
    branches: () => setView({ kind: 'list' }),
    vcs: () => setView({ kind: 'vcs' }),
    newBranch: () => doNewBranch(),
    newTag: () => doNewTag(),
    merge: doMergePick,
    rebase: doRebasePick,
    reset: doReset,
    checkoutRevision: doCheckoutRevision,
    newWorktree: doNewWorktree,
    worktrees: showWorktrees,
    log: showLog,
    patchCreate: doCreatePatch,
    patchApply: doApplyPatch,
    stashes: showStashes,
    rollback: doRollback,
    fileHistory: () => pickFile('fileHistory'),
    blame: () => pickFile('blame'),
    rollbackFile: () => pickFile('rollbackFile'),
    commit: doCommit
  }
  map[intent.dialog]?.()
}

// ---------------------------------------------------------------------------
// Keyboard

function selectableNodes() {
  return [...viewEl.querySelectorAll('[data-idx]')]
}

function moveSelection(delta) {
  const nodes = selectableNodes()
  if (!nodes.length) return
  state.keyboard = true
  state.selected = Math.max(0, Math.min(nodes.length - 1, state.selected + delta))
  nodes.forEach((n) => n.classList.toggle('selected', Number(n.dataset.idx) === state.selected))
  nodes[state.selected]?.scrollIntoView({ block: 'nearest' })
}

function activateSelected() {
  const node = selectableNodes()[state.selected]
  node?.click()
}

document.addEventListener('keydown', (e) => {
  if (document.querySelector('.overlay')) return // dialogs handle their own keys
  if (e.metaKey || e.ctrlKey) return
  if (e.key === 'ArrowDown') {
    e.preventDefault()
    moveSelection(1)
  } else if (e.key === 'ArrowUp') {
    e.preventDefault()
    moveSelection(-1)
  } else if (e.key === 'Enter' || (e.key === 'ArrowRight' && document.activeElement !== searchEl)) {
    if (state.rows.length) {
      e.preventDefault()
      activateSelected()
    }
  } else if (e.key === 'Escape' || (e.key === 'ArrowLeft' && document.activeElement !== searchEl)) {
    if (state.view.kind !== 'list') {
      e.preventDefault()
      setView(state.view.back || { kind: 'list' })
    } else if (state.query) {
      e.preventDefault()
      searchEl.value = ''
      state.query = ''
      render()
    }
  }
})

searchEl.addEventListener('input', () => {
  state.query = searchEl.value.trim()
  state.selected = 0
  render()
})

$('fetch').addEventListener('click', doFetch)
$('settings').addEventListener('click', openSettings)
$('workspace').addEventListener('click', pickWorkspace)

// ---------------------------------------------------------------------------
// Live updates

function subscribe() {
  const on = orca?.plugin?.on?.bind(orca.plugin)
  if (on) {
    on('git.changed', () => scheduleRefresh())
    on('workspace.changed', () => {
      setView({ kind: 'list' })
      load()
    })
    on('ui.intent', () => load())
  }
}

// Fallback for changes the worker's file watcher misses (network drives).
let lastFp = null
setInterval(async () => {
  if (document.hidden || !state.data?.repo) return
  try {
    const fp = await request('fingerprint', {}, 10_000)
    if (lastFp && fp !== lastFp && fp !== state.data.repo.fingerprint) scheduleRefresh(0)
    lastFp = fp
  } catch {}
}, 15_000)
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) scheduleRefresh(0)
})

subscribe()
render()
searchEl.focus()
load({ refreshWorkspace: true }).then(() => {
  if (state.data?.settings?.fetchOnOpen && state.data?.repo) doFetch()
})
