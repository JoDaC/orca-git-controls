// End-to-end tests for the panel: the real worker and git behind scripts/dev-server.mjs, the panel
// in headless Chrome. Each test works on its own copy of scripts/make-demo-repo.sh's repository.
//   npm run test:e2e

import { describe, test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync, readFileSync, existsSync, appendFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { CHROME, GIT, setupSuite, openPanel } from './harness.mjs'

const skip = CHROME ? false : 'Chrome not found (set CHROME_PATH)'
if (CHROME) setupSuite({ before, after })

const opts = { concurrency: Number(process.env.E2E_CONCURRENCY || 4), skip, timeout: 90_000 }
const q = JSON.stringify
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function eventually(fn, ms = 10_000, what = 'condition') {
  const end = Date.now() + ms
  let last
  while (Date.now() < end) {
    try {
      last = await fn()
      if (last) return last
    } catch (e) {
      last = e
    }
    await sleep(50)
  }
  throw new Error(`Timed out waiting for ${what}: ${last?.message ?? last}`)
}

const dialog = (page, title) => page.waitFor(`__t.dialog()?.title === ${q(title)} && __t.dialog()`, 15_000, `dialog "${title}"`)
const noDialog = (page) => page.waitFor('__t.dialogCount() === 0 && __t.idle()', 30_000, 'dialogs to close')
/** Waits for an action to finish: dialogs closed, busy bar gone, a toast shown. */
const finished = (page) => page.waitFor('__t.dialogCount() === 0 && __t.idle() && __t.toast()', 30_000, 'the action to finish')
const subhead = (page, title) => page.waitFor(`__t.subhead().title === ${q(title)} && __t.subhead()`, 15_000, `view "${title}"`)
const listView = (page) => page.waitFor(`__t.listShown()`, 15_000, 'branch list')
const row = (page, section, label) => page.waitFor(`__t.find(${q(section)}, ${q(label)})`, 15_000, `row ${section}/${label}`)
const noRow = (page, section, label) => page.waitFor(`__t.loaded() && !__t.find(${q(section)}, ${q(label)})`, 15_000, `no row ${section}/${label}`)

/** Leaves any submenu or viewer and waits for the reloaded branch list. */
async function toList(page) {
  for (let i = 0; i < 4 && (await page.eval(`Boolean(document.querySelector('#view .subhead'))`)); i++) {
    await page.t('back')
    await sleep(50)
  }
  await listView(page)
}

async function openMenu(page, section, label, title) {
  await toList(page)
  await page.t('clearToast')
  await page.t('clickRow', section, label)
  return subhead(page, title)
}

async function gitMenu(page, item) {
  await page.t('clearToast')
  if ((await page.t('subhead')).title !== 'Git') {
    await toList(page)
    await page.t('clickRow', 'Actions', 'Git Menu')
    await subhead(page, 'Git')
  }
  await page.t('clickMenu', item)
}

const ok = (fn) => {
  try {
    fn()
    return true
  } catch {
    return false
  }
}

const currentBranch = (git) => git('branch', '--show-current')
const branches = (git) => git('for-each-ref', '--format=%(refname:short)', 'refs/heads').split('\n')
const stashes = (git) => git('stash', 'list').split('\n').filter(Boolean)
const isAncestor = (git, a, b) => ok(() => git('merge-base', '--is-ancestor', a, b))

function commitFile(git, file, text, message, repo) {
  writeFileSync(path.join(repo, file), text)
  git('add', file)
  git('commit', '-qm', message)
}

// ---------------------------------------------------------------------------

describe('initial render', opts, () => {
  test('sections, folders, favorites, counts, upstreams and badges', async (t) => {
    const { page } = await openPanel(t, {
      setup: (git) => {
        git('push', '-q', 'codex', '--delete', 'release/1.2')
        git('fetch', '-q', '--prune', 'codex')
      }
    })
    assert.deepEqual(await page.t('sections'), ['Actions', 'Recent', 'Local', 'Remote', 'Tags'])
    const list = await page.t('listing')
    const labels = (section) => list.filter((r) => r.section === section && r.kind !== 'section').map((r) => `${r.kind === 'folder' ? '+' : ''}${r.label}`)

    assert.deepEqual(labels('Actions'), ['Update Project…', 'Commit…', 'Push…', 'New Branch…', 'Checkout Tag or Revision…', 'Git Menu'])
    assert.deepEqual(labels('Recent'), ['main', 'feature/login', 'feature/onboarding', 'experiment', 'release/1.2'])
    // Favorites first, then folders by "/", then the rest.
    assert.deepEqual(labels('Local'), ['main', '+bugfix', 'crash-on-start', '+feature', '+settings', 'theme', 'login', 'onboarding', '+hotfix', 'urgent', '+release', '1.2', 'experiment'])
    assert.deepEqual(labels('Remote'), ['+origin', '+bugfix', 'crash-on-start', '+feature', 'login', 'remote-only', 'main', '+codex', '+codex', 'onboarding-v2'])
    // Tags start collapsed.
    assert.deepEqual(labels('Tags'), [])

    const local = (label) => list.find((r) => r.section === 'Local' && r.label === label)
    const main = local('main')
    assert.equal(main.star, true)
    assert.equal(main.current, true)
    assert.equal(main.incoming, '1')
    assert.equal(main.upstream, 'origin/main')
    assert.equal(list.filter((r) => r.current && r.section === 'Local').length, 1)
    assert.equal(local('experiment').star, false)
    assert.equal(local('login').outgoing, '2')
    assert.equal(local('login').upstream, 'origin/feature/login')
    assert.equal(local('crash-on-start').incoming, '1')
    assert.ok(local('theme').indent > local('settings').indent && local('settings').indent > local('feature').indent)
    assert.equal(local('urgent').badge, 'worktree')
    assert.match(local('urgent').title, /Checked out in worktree .*work-hotfix/)
    // release/1.2's upstream was deleted on codex: still named, struck through.
    assert.equal(local('1.2').upstream, 'codex/release/1.2')
    assert.equal(local('1.2').upstreamGone, true)
    assert.equal(local('1.2').upstreamStruck, true)
    assert.equal(local('login').upstreamStruck, false)
    assert.deepEqual(await page.t('header'), { name: 'work', branch: 'main' })

    await page.t('clickSection', 'Tags')
    await row(page, 'Tags', 'v1.0')
    assert.ok(await page.t('find', 'Tags', 'v1.1'))
    // Collapsing a folder hides its branches.
    await page.t('clickRow', 'Local', 'feature')
    await noRow(page, 'Local', 'login')
    assert.deepEqual(page.nativeDialogs, [])
  })
})

describe('search and keyboard', opts, () => {
  test('search filters branches and actions, including Git menu items', async (t) => {
    const { page } = await openPanel(t)
    await page.t('search', 'log')
    await page.waitFor(`!__t.find('Local', 'experiment')`)
    const list = await page.t('listing')
    const labels = (section) => list.filter((r) => r.section === section && r.kind !== 'section').map((r) => r.label)
    assert.deepEqual(await page.t('sections'), ['Actions', 'Recent', 'Local', 'Remote'])
    assert.deepEqual(labels('Actions'), ['Show Git Log'])
    assert.deepEqual(labels('Recent'), ['feature/login'])
    assert.deepEqual(labels('Local'), ['feature', 'login'])
    assert.deepEqual(labels('Remote'), ['origin', 'feature', 'login'])
    assert.equal(await page.eval(`[...document.querySelectorAll('#view .row mark')].map((m) => m.textContent.toLowerCase()).every((t) => t === 'log')`), true)

    await page.t('search', 'stash')
    await page.waitFor(`__t.find('Actions', 'Uncommitted Changes › Stash Changes…')`)
    assert.deepEqual(await page.t('sections'), ['Actions'])

    await page.t('search', 'zzzz-nothing')
    await page.waitFor(`document.querySelector('#view .empty')?.textContent.includes('Nothing matches')`)

    // A Git menu item found by search runs from the list.
    await page.t('search', 'git log')
    await page.t('clickRow', 'Actions', 'Show Git Log')
    await subhead(page, 'Git Log')

    // The submenu filters too.
    await page.t('back')
    await subhead(page, 'Git')
    await page.t('search', 'stash')
    await page.waitFor(`__t.menu().length === 2`)
    assert.deepEqual((await page.t('menu')).map((m) => m.label), ['Uncommitted Changes › Stash Changes…', 'Uncommitted Changes › Unstash Changes…'])
  })

  test('arrows move the selection, Enter and → open, Esc and ← go back', async (t) => {
    const { page } = await openPanel(t)
    await page.t('search', 'onboarding')
    await page.waitFor(`__t.listing().find((r) => r.selected)?.label === 'feature/onboarding'`)
    await page.key('ArrowDown')
    await page.waitFor(`__t.listing().find((r) => r.selected)?.label === 'feature'`)
    await page.key('ArrowDown')
    await page.waitFor(`__t.listing().find((r) => r.selected)?.label === 'onboarding'`)
    await page.key('ArrowUp')
    await page.key('ArrowUp')
    await page.waitFor(`__t.listing().find((r) => r.selected)?.label === 'feature/onboarding'`)

    await page.key('Enter')
    await subhead(page, 'feature/onboarding')
    assert.equal((await page.t('menu'))[0].selected, true)
    await page.key('ArrowDown')
    await page.waitFor(`__t.menu()[1].selected`)

    // Esc goes back and brings the list's query back; a second Esc clears it.
    await page.key('Escape')
    await listView(page)
    assert.equal(await page.eval(`document.getElementById('search').value`), 'onboarding')
    await page.key('Escape')
    await page.waitFor(`document.getElementById('search').value === '' && __t.find('Local', 'experiment')`)

    // → and ← work when focus is not in the search box (there they move the caret).
    await page.eval(`document.activeElement.blur()`)
    await page.key('ArrowDown')
    await page.waitFor(`__t.listing().find((r) => r.selected)?.label === 'Commit…'`)
    await page.key('ArrowRight')
    await dialog(page, "Commit to 'main'")
    await page.key('Escape')
    await noDialog(page)

    await page.t('search', 'experiment')
    await page.waitFor(`__t.listing().find((r) => r.selected)?.label === 'experiment'`)
    await page.eval(`document.activeElement.blur()`)
    await page.key('ArrowRight')
    await subhead(page, 'experiment')
    await page.eval(`document.activeElement.blur()`)
    await page.key('ArrowLeft')
    await listView(page)
  })
})

describe('header buttons', opts, () => {
  test('Fetch fetches all remotes and shows the new branch', async (t) => {
    const { page, git, other } = await openPanel(t)
    other('checkout', '-q', '-b', 'feature/fetched')
    other('commit', '-q', '--allow-empty', '-m', 'Fetched commit')
    other('push', '-q', 'origin', 'feature/fetched')
    assert.equal(await page.t('find', 'Remote', 'fetched'), null)
    await page.t('clearToast')
    await page.eval(`document.getElementById('fetch').click()`)
    await finished(page)
    await row(page, 'Remote', 'fetched')
    assert.equal(git('rev-parse', 'origin/feature/fetched'), other('rev-parse', 'HEAD'))
  })

  test('fetchOnOpen fetches when the panel opens, and only then', async (t) => {
    const { page, git, other } = await openPanel(t)
    const pushToMain = (msg) => {
      other('checkout', '-q', 'main')
      other('pull', '-q')
      other('commit', '-q', '--allow-empty', '-m', msg)
      other('push', '-q', 'origin', 'main')
    }
    assert.equal((await page.t('find', 'Local', 'main')).incoming, '1')

    pushToMain('Remote commit before the setting')
    await page.reload()
    await sleep(1500)
    assert.equal((await page.t('find', 'Local', 'main')).incoming, '1')
    assert.notEqual(git('rev-parse', 'origin/main'), other('rev-parse', 'HEAD'))

    await page.eval(`document.getElementById('settings').click()`)
    await dialog(page, 'Git Controls Settings')
    await page.t('fill', 'fetchOnOpen', true)
    await page.t('press', 'Save')
    await noDialog(page)
    // Saving the setting does not fetch by itself.
    await sleep(500)
    assert.equal((await page.t('find', 'Local', 'main')).incoming, '1')

    await page.reload()
    await page.waitFor(`__t.find('Local', 'main')?.incoming === '2'`, 15_000, 'the fetch on open')
    assert.equal(git('rev-parse', 'origin/main'), other('rev-parse', 'HEAD'))
  })

  test('settings reach the worker: update method, recent count, show tags', async (t) => {
    const { page, git, repo } = await openPanel(t, {
      setup: (git, { repo }) => commitFile(git, 'local.txt', 'local\n', 'Local commit on main', repo)
    })
    await page.eval(`document.getElementById('settings').click()`)
    const d = await dialog(page, 'Git Controls Settings')
    assert.deepEqual(
      d.fields.map((f) => [f.id, f.value]),
      [
        ['updateMethod', 'rebase'],
        ['recentCount', '5'],
        ['showTags', true],
        ['fetchOnOpen', false]
      ]
    )
    await page.t('fill', 'updateMethod', 'merge')
    await page.t('fill', 'recentCount', '2')
    await page.t('fill', 'showTags', false)
    await page.t('press', 'Save')
    await noDialog(page)
    await page.waitFor(`!__t.sections().includes('Tags')`)
    await page.waitFor(`__t.listing().filter((r) => r.section === 'Recent' && r.kind === 'row').length === 2`)
    const snap = await page.eval(`orca.plugin.request('git', { op: 'snapshot' }).then((r) => r.value.settings)`)
    assert.deepEqual(snap, { updateMethod: 'merge', recentCount: 2, showTags: false, fetchOnOpen: false })

    // The worker uses the method: Update Project merges instead of rebasing.
    const before = git('rev-parse', 'HEAD')
    await page.t('clickRow', 'Actions', 'Update Project…')
    await finished(page)
    assert.equal(git('rev-parse', 'HEAD^1'), before)
    assert.equal(git('rev-parse', 'HEAD^2'), git('rev-parse', 'origin/main'))
    assert.ok(existsSync(path.join(repo, 'local.txt')))

    await page.eval(`document.getElementById('settings').click()`)
    const again = await dialog(page, 'Git Controls Settings')
    assert.deepEqual(again.fields.map((f) => f.value), ['merge', '2', false, false])
  })

  test('the workspace button pins another workspace, and the pin survives a reload', async (t) => {
    const { page, repo, dir } = await openPanel(t, {
      orcaWorktrees: ({ repo, dir }) => [
        { path: repo, branch: 'refs/heads/main', displayName: 'work', lastActivityAt: 2 },
        { path: path.join(dir, 'work-hotfix'), branch: 'refs/heads/hotfix/urgent', displayName: 'work-hotfix', lastActivityAt: 1 }
      ]
    })
    const hotfix = path.join(dir, 'work-hotfix')
    const pick = async (value) => {
      await page.eval(`document.getElementById('workspace').click()`)
      const d = await dialog(page, 'Workspace')
      await page.t('fill', 'path', value)
      await page.t('press', 'Use')
      await noDialog(page)
      return d
    }

    await page.eval(`document.getElementById('workspace').click()`)
    const d = await dialog(page, 'Workspace')
    assert.deepEqual(d.buttons, ['Cancel', 'Use'])
    // The dev server pins the demo repo at start, so it is the preselected entry.
    assert.deepEqual(d.fields, [{ id: 'path', type: 'select-one', value: repo }])
    assert.deepEqual(await page.eval(`[...document.querySelectorAll('#f-path option')].map((o) => [o.value, o.textContent])`), [
      ['', 'Follow the focused Orca workspace'],
      [repo, `work · main — ${repo}`],
      [hotfix, `work-hotfix · hotfix/urgent — ${hotfix}`]
    ])
    await page.t('press', 'Cancel')
    await noDialog(page)

    await pick(hotfix)
    await page.waitFor(`__t.header().name === 'work-hotfix' && __t.header().branch === 'hotfix/urgent'`)
    await page.waitFor(`__t.find('Local', 'urgent')?.current && __t.find('Local', 'main')?.badge === 'worktree'`)
    assert.equal((await page.t('find', 'Local', 'urgent')).badge, null)
    assert.match(await page.eval(`document.getElementById('workspace').title`), /work-hotfix \(picked by you\)/)

    await page.reload()
    assert.deepEqual(await page.t('header'), { name: 'work-hotfix', branch: 'hotfix/urgent' })
    assert.equal((await page.t('find', 'Local', 'urgent')).current, true)

    await pick(repo)
    await page.waitFor(`__t.header().name === 'work' && __t.find('Local', 'main')?.current`)
  })
})

describe('favorites', opts, () => {
  test('the star toggles a favorite and survives a reload', async (t) => {
    const { page } = await openPanel(t)
    await page.t('clickStar', 'Local', 'experiment')
    await page.waitFor(`__t.find('Local', 'experiment')?.star === true`)
    // Favorites float to the top of their folder, by name.
    await page.waitFor(`(() => { const l = __t.listing().filter((r) => r.section === 'Local' && r.kind !== 'section'); return l[0].label === 'experiment' && l[1].label === 'main' && l[2].label === 'bugfix' })()`)
    await page.t('clickStar', 'Local', 'main')
    await page.waitFor(`__t.find('Local', 'main')?.star === false`)

    await page.reload()
    assert.equal((await page.t('find', 'Local', 'experiment')).star, true)
    assert.equal((await page.t('find', 'Local', 'main')).star, false)
    const favs = await page.eval(`orca.plugin.request('git', { op: 'snapshot' }).then((r) => r.value.repo.favorites)`)
    assert.deepEqual(favs, ['experiment'])
  })
})

// ---------------------------------------------------------------------------

describe('local branch submenu', opts, () => {
  test('lists the actions for a branch, the current branch, and a branch with an upstream', async (t) => {
    const { page } = await openPanel(t)
    await openMenu(page, 'Local', 'experiment', 'experiment')
    assert.deepEqual(await page.t('menu'), [
      { label: 'Checkout', disabled: false, danger: false, selected: true },
      { label: "New Branch from 'experiment'…", disabled: false, danger: false, selected: false },
      { label: "Checkout and Rebase onto 'main'", disabled: false, danger: false, selected: false },
      { label: "Compare with 'main'", disabled: false, danger: false, selected: false },
      { label: 'Show Diff with Working Tree', disabled: false, danger: false, selected: false },
      { label: "Rebase 'main' onto 'experiment'", disabled: false, danger: false, selected: false },
      { label: "Merge 'experiment' into 'main'", disabled: false, danger: false, selected: false },
      { label: 'Update', disabled: true, danger: false, selected: false },
      { label: 'Push…', disabled: false, danger: false, selected: false },
      { label: 'Rename…', disabled: false, danger: false, selected: false },
      { label: 'Delete', disabled: false, danger: true, selected: false }
    ])
    await page.t('back')
    await openMenu(page, 'Local', 'login', 'feature/login')
    assert.deepEqual(await page.t('subhead'), { title: 'feature/login', sub: '→ origin/feature/login ↑2' })
    await page.t('back')
    await openMenu(page, 'Local', 'main', 'main')
    assert.deepEqual((await page.t('menu')).map((m) => m.label), ["New Branch from 'main'…", 'Show Diff with Working Tree', 'Update', 'Push…', 'Rename…'])
  })

  test('Checkout', async (t) => {
    const { page, git } = await openPanel(t)
    await openMenu(page, 'Local', 'experiment', 'experiment')
    await page.t('clickMenu', 'Checkout')
    await finished(page)
    assert.equal(currentBranch(git), 'experiment')
    await page.waitFor(`__t.find('Local', 'experiment')?.current && __t.header().branch === 'experiment'`)
    assert.equal((await page.t('find', 'Local', 'main')).current, false)
  })

  test('New Branch from…, with validation', async (t) => {
    const { page, git } = await openPanel(t)
    await openMenu(page, 'Local', 'login', 'feature/login')
    await page.t('clickMenu', "New Branch from 'feature/login'…")
    const d = await dialog(page, "New Branch from 'feature/login'")
    assert.deepEqual(d.fields, [
      { id: 'name', type: 'text', value: '' },
      { id: 'checkout', type: 'checkbox', value: true }
    ])
    await page.t('fill', 'name', 'has space')
    await page.t('press', 'Create')
    await page.waitFor(`__t.dialog()?.errors[0] === 'Branch names cannot contain spaces'`)
    await page.t('fill', 'name', 'experiment')
    await page.waitFor(`__t.dialog()?.errors[0] === "Branch 'experiment' already exists"`)
    await page.t('fill', 'name', 'feature/from-login')
    await page.t('press', 'Create')
    await finished(page)
    assert.equal(currentBranch(git), 'feature/from-login')
    assert.equal(git('rev-parse', 'feature/from-login'), git('rev-parse', 'feature/login'))
    await page.waitFor(`__t.find('Local', 'from-login')?.current`)
  })

  test('Checkout and Rebase onto current', async (t) => {
    const { page, git } = await openPanel(t, { setup: (git, { repo }) => commitFile(git, 'm.txt', 'm\n', 'Main moves on', repo) })
    const before = git('rev-parse', 'experiment')
    await openMenu(page, 'Local', 'experiment', 'experiment')
    await page.t('clickMenu', "Checkout and Rebase onto 'main'")
    await finished(page)
    assert.equal(currentBranch(git), 'experiment')
    assert.notEqual(git('rev-parse', 'experiment'), before)
    assert.ok(isAncestor(git, 'main', 'experiment'))
  })

  test('Compare and Show Diff with Working Tree', async (t) => {
    const { page } = await openPanel(t)
    await openMenu(page, 'Local', 'experiment', 'experiment')
    await page.t('clickMenu', "Compare with 'main'")
    await subhead(page, 'experiment ⇄ main')
    const text = await page.t('viewerText')
    assert.match(text, /In 'experiment' but not in 'main' \(1\)/)
    assert.match(text, /Work on experiment/)
    assert.match(text, /In 'main' but not in 'experiment' \(0\)/)
    // Back returns to the submenu it came from.
    await page.t('back')
    await subhead(page, 'experiment')
    await page.t('clickMenu', 'Show Diff with Working Tree')
    const sh = await subhead(page, 'Diff: experiment ↔ working tree')
    assert.equal(sh.sub, '1 file')
    assert.match(await page.t('viewerText'), /experiment\.txt/)
    assert.equal(await page.eval(`[...document.querySelectorAll('.viewer pre .del')].some((n) => n.textContent === '-experiment')`), true)
  })

  test('Rebase current onto', async (t) => {
    const { page, git } = await openPanel(t)
    await openMenu(page, 'Local', 'experiment', 'experiment')
    await page.t('clickMenu', "Rebase 'main' onto 'experiment'")
    await dialog(page, "Rebase 'main' onto 'experiment'?")
    await page.t('press', 'Rebase')
    await finished(page)
    assert.equal(currentBranch(git), 'main')
    assert.ok(isAncestor(git, 'experiment', 'main'))
  })

  test('Merge into current', async (t) => {
    const { page, git } = await openPanel(t)
    await openMenu(page, 'Local', 'experiment', 'experiment')
    await page.t('clickMenu', "Merge 'experiment' into 'main'")
    await dialog(page, "Merge 'experiment' into 'main'?")
    await page.t('press', 'Merge')
    await finished(page)
    assert.ok(isAncestor(git, 'experiment', 'main'))
  })

  test('Update fast-forwards a branch that is not checked out', async (t) => {
    const { page, git } = await openPanel(t)
    await openMenu(page, 'Local', 'crash-on-start', 'bugfix/crash-on-start')
    await page.t('clickMenu', 'Update')
    await finished(page)
    assert.equal(git('rev-parse', 'bugfix/crash-on-start'), git('rev-parse', 'origin/bugfix/crash-on-start'))
    assert.equal(currentBranch(git), 'main')
    await page.waitFor(`__t.find('Local', 'crash-on-start')?.incoming === null`)
  })

  test('Push… a branch with an upstream, and one without', async (t) => {
    const { page, git, dir } = await openPanel(t)
    const origin = (...a) => execFileSync(GIT, ['--git-dir', path.join(dir, 'origin.git'), ...a], { encoding: 'utf8' }).trim()
    await openMenu(page, 'Local', 'login', 'feature/login')
    await page.t('clickMenu', 'Push…')
    const d = await dialog(page, "Push 'feature/login'")
    assert.match(d.body, /To origin\/feature\/login/)
    assert.deepEqual(d.hints, ['2 commits to push'])
    assert.match(d.body, /More unpushed login work/)
    await page.t('press', 'Push')
    await finished(page)
    assert.equal(origin('rev-parse', 'feature/login'), git('rev-parse', 'feature/login'))
    await page.waitFor(`__t.find('Local', 'login')?.outgoing === null`)

    await openMenu(page, 'Local', 'experiment', 'experiment')
    await page.t('clickMenu', 'Push…')
    const d2 = await dialog(page, "Push 'experiment'")
    assert.match(d2.body, /No upstream yet/)
    await page.t('press', 'Push')
    await finished(page)
    assert.equal(git('rev-parse', '--abbrev-ref', 'experiment@{u}'), 'origin/experiment')
    await page.waitFor(`__t.find('Local', 'experiment')?.upstream === 'origin/experiment'`)
  })

  test('Rename…', async (t) => {
    const { page, git } = await openPanel(t)
    await openMenu(page, 'Local', 'experiment', 'experiment')
    await page.t('clickMenu', 'Rename…')
    const d = await dialog(page, "Rename 'experiment'")
    assert.equal(d.fields[0].value, 'experiment')
    await page.t('press', 'Rename')
    await page.waitFor(`__t.dialog()?.errors[0] === 'Enter a different name'`)
    await page.t('fill', 'name', 'experiment-2')
    await page.t('press', 'Rename')
    await finished(page)
    assert.ok(branches(git).includes('experiment-2'))
    assert.ok(!branches(git).includes('experiment'))
    await row(page, 'Local', 'experiment-2')
  })

  test('Delete: a merged branch goes at once, an unmerged one asks first', async (t) => {
    const { page, git } = await openPanel(t, { setup: (git) => git('branch', 'merged-topic') })
    await openMenu(page, 'Local', 'merged-topic', 'merged-topic')
    await page.t('clickMenu', 'Delete')
    await finished(page)
    assert.ok(!branches(git).includes('merged-topic'))
    await noRow(page, 'Local', 'merged-topic')

    await openMenu(page, 'Local', 'experiment', 'experiment')
    await page.t('clickMenu', 'Delete')
    let d = await dialog(page, 'Branch is not fully merged')
    assert.match(d.pre[0], /error: The branch 'experiment' is not fully merged/)
    await page.t('press', 'Cancel')
    await noDialog(page)
    assert.ok(branches(git).includes('experiment'))

    await page.t('clickMenu', 'Delete')
    d = await dialog(page, 'Branch is not fully merged')
    await page.t('press', 'Delete Anyway')
    await finished(page)
    assert.ok(!branches(git).includes('experiment'))
    await noRow(page, 'Local', 'experiment')
  })
})

describe('remote branch submenu', opts, () => {
  test('lists its actions; Checkout creates a tracking branch', async (t) => {
    const { page, git } = await openPanel(t)
    await openMenu(page, 'Remote', 'remote-only', 'origin/feature/remote-only')
    assert.deepEqual((await page.t('menu')).map((m) => m.label + (m.danger ? ' (danger)' : '')), [
      'Checkout',
      "New Branch from 'origin/feature/remote-only'…",
      "Compare with 'main'",
      'Show Diff with Working Tree',
      "Rebase 'main' onto 'origin/feature/remote-only'",
      "Merge 'origin/feature/remote-only' into 'main'",
      'Delete (danger)'
    ])
    await page.t('clickMenu', 'Checkout')
    await finished(page)
    assert.equal(currentBranch(git), 'feature/remote-only')
    assert.equal(git('rev-parse', '--abbrev-ref', 'feature/remote-only@{u}'), 'origin/feature/remote-only')
    await page.waitFor(`__t.find('Local', 'remote-only')?.current`)
  })

  test('New Branch from, without checking it out', async (t) => {
    const { page, git } = await openPanel(t)
    await openMenu(page, 'Remote', 'remote-only', 'origin/feature/remote-only')
    await page.t('clickMenu', "New Branch from 'origin/feature/remote-only'…")
    await dialog(page, "New Branch from 'origin/feature/remote-only'")
    await page.t('fill', 'name', 'from-remote')
    await page.t('fill', 'checkout', false)
    await page.t('press', 'Create')
    await finished(page)
    assert.equal(git('rev-parse', 'from-remote'), git('rev-parse', 'origin/feature/remote-only'))
    assert.equal(currentBranch(git), 'main')
  })

  test('Compare and Show Diff', async (t) => {
    const { page, git } = await openPanel(t)
    const count = git('rev-list', '--count', 'main..origin/feature/remote-only')
    await openMenu(page, 'Remote', 'remote-only', 'origin/feature/remote-only')
    await page.t('clickMenu', "Compare with 'main'")
    await subhead(page, 'origin/feature/remote-only ⇄ main')
    assert.ok((await page.t('viewerText')).startsWith(`In 'origin/feature/remote-only' but not in 'main' (${count})`))
    assert.match(await page.t('viewerText'), /Remote only/)
    await page.t('back')
    await subhead(page, 'origin/feature/remote-only')
    await page.t('clickMenu', 'Show Diff with Working Tree')
    await subhead(page, 'Diff: origin/feature/remote-only ↔ working tree')
    assert.match(await page.t('viewerText'), /r\.txt/)
  })

  test('Rebase onto and Merge', async (t) => {
    const { page, git } = await openPanel(t)
    await openMenu(page, 'Remote', 'main', 'origin/main')
    await page.t('clickMenu', "Rebase 'main' onto 'origin/main'")
    await dialog(page, "Rebase 'main' onto 'origin/main'?")
    await page.t('press', 'Rebase')
    await finished(page)
    assert.equal(git('rev-parse', 'main'), git('rev-parse', 'origin/main'))

    await openMenu(page, 'Remote', 'remote-only', 'origin/feature/remote-only')
    await page.t('clickMenu', "Merge 'origin/feature/remote-only' into 'main'")
    await dialog(page, "Merge 'origin/feature/remote-only' into 'main'?")
    await page.t('press', 'Merge')
    await finished(page)
    assert.ok(isAncestor(git, 'origin/feature/remote-only', 'main'))
  })

  test('Delete asks, then deletes the branch on the remote', async (t) => {
    const { page, git, dir } = await openPanel(t)
    const originHas = () => ok(() => execFileSync(GIT, ['--git-dir', path.join(dir, 'origin.git'), 'rev-parse', '--verify', '-q', 'refs/heads/feature/remote-only'], { stdio: 'pipe' }))
    await openMenu(page, 'Remote', 'remote-only', 'origin/feature/remote-only')
    await page.t('clickMenu', 'Delete')
    const d = await dialog(page, "Delete remote branch 'origin/feature/remote-only'?")
    assert.deepEqual(d.buttons, ['Cancel', 'Delete Remote Branch'])
    await page.t('press', 'Cancel')
    await noDialog(page)
    assert.ok(originHas())
    await page.t('clickMenu', 'Delete')
    await dialog(page, "Delete remote branch 'origin/feature/remote-only'?")
    await page.t('press', 'Delete Remote Branch')
    await finished(page)
    assert.ok(!originHas())
    assert.ok(!ok(() => git('rev-parse', '--verify', '-q', 'origin/feature/remote-only')))
    await noRow(page, 'Remote', 'remote-only')
  })
})

describe('tag submenu', opts, () => {
  const openTag = async (page, tag) => {
    await page.t('clickSection', 'Tags')
    await row(page, 'Tags', tag)
    return openMenu(page, 'Tags', tag, tag)
  }

  test('lists its actions; Checkout detaches HEAD', async (t) => {
    const { page, git } = await openPanel(t, { setup: (git) => git('reset', '-q', '--hard', 'HEAD~1') })
    // main was moved back so v1.0 is a different commit from HEAD.
    await openTag(page, 'v1.0')
    assert.deepEqual((await page.t('menu')).map((m) => m.label + (m.danger ? ' (danger)' : '')), [
      'Checkout',
      "New Branch from 'v1.0'…",
      "Compare with 'main'",
      'Show Diff with Working Tree',
      "Merge 'v1.0' into 'main'",
      'Delete Tag (danger)'
    ])
    await page.t('clickMenu', 'Checkout')
    await finished(page)
    assert.equal(currentBranch(git), '')
    assert.equal(git('rev-parse', 'HEAD'), git('rev-parse', 'v1.0^{commit}'))
    const sha = git('rev-parse', 'HEAD').slice(0, 8)
    await page.waitFor(`__t.header().branch === ${q(`detached at ${sha}`)}`)
  })

  test('New Branch from, Compare, Show Diff', async (t) => {
    const { page, git } = await openPanel(t)
    await openTag(page, 'v1.0')
    await page.t('clickMenu', "Compare with 'main'")
    await subhead(page, 'v1.0 ⇄ main')
    assert.match(await page.t('viewerText'), /In 'v1\.0' but not in 'main' \(0\)/)
    await page.t('back')
    await subhead(page, 'v1.0')
    await page.t('clickMenu', 'Show Diff with Working Tree')
    await subhead(page, 'Diff: v1.0 ↔ working tree')
    assert.match(await page.t('viewerText'), /No differences/)
    await page.t('back')
    await subhead(page, 'v1.0')
    await page.t('clickMenu', "New Branch from 'v1.0'…")
    await dialog(page, "New Branch from 'v1.0'")
    await page.t('fill', 'name', 'from-tag')
    await page.t('press', 'Create')
    await finished(page)
    assert.equal(currentBranch(git), 'from-tag')
    assert.equal(git('rev-parse', 'from-tag'), git('rev-parse', 'v1.0^{commit}'))
  })

  test('Merge', async (t) => {
    const { page, git } = await openPanel(t, { setup: (git) => git('tag', 'exp-tag', 'experiment') })
    await openTag(page, 'exp-tag')
    await page.t('clickMenu', "Merge 'exp-tag' into 'main'")
    await dialog(page, "Merge 'exp-tag' into 'main'?")
    await page.t('press', 'Merge')
    await finished(page)
    assert.ok(isAncestor(git, 'exp-tag', 'main'))
  })

  test('Delete Tag asks first', async (t) => {
    const { page, git } = await openPanel(t)
    await openTag(page, 'v1.0')
    await page.t('clickMenu', 'Delete Tag')
    await dialog(page, "Delete tag 'v1.0'?")
    await page.t('press', 'Delete Tag')
    await finished(page)
    assert.ok(!git('tag').split('\n').includes('v1.0'))
    await noRow(page, 'Tags', 'v1.0')
  })
})

// ---------------------------------------------------------------------------

describe('smart checkout', opts, () => {
  // experiment changes app.txt at the end; main's uncommitted change is at the start, so the two
  // merge cleanly when Smart Checkout restores it.
  const diverge = (git, { repo }) => {
    git('checkout', '-q', 'experiment')
    appendFileSync(path.join(repo, 'app.txt'), 'experiment line\n')
    git('commit', '-qam', 'Experiment changes app.txt')
    git('checkout', '-q', 'main')
    writeFileSync(path.join(repo, 'app.txt'), 'dirty first line\n' + readFileSync(path.join(repo, 'app.txt'), 'utf8'))
  }

  const blockedCheckout = async (page) => {
    await openMenu(page, 'Local', 'experiment', 'experiment')
    await page.t('clickMenu', 'Checkout')
    return dialog(page, 'Checkout would overwrite local changes')
  }

  test('Smart Checkout carries the changes over', async (t) => {
    const { page, git, repo } = await openPanel(t, { setup: diverge })
    const d = await blockedCheckout(page)
    assert.deepEqual(d.files, ['app.txt'])
    assert.match(d.body, /Your local changes to these files would be overwritten/)
    assert.deepEqual(d.buttons, ['Cancel', 'Force Checkout', 'Smart Checkout'])
    await page.t('press', 'Smart Checkout')
    await finished(page)
    assert.equal(currentBranch(git), 'experiment')
    const text = readFileSync(path.join(repo, 'app.txt'), 'utf8')
    assert.match(text, /^dirty first line\n/)
    assert.match(text, /experiment line\n$/)
    assert.deepEqual(stashes(git), [])
  })

  test('Force Checkout asks again, then discards the changes', async (t) => {
    const { page, git, repo } = await openPanel(t, { setup: diverge })
    await blockedCheckout(page)
    await page.t('press', 'Force Checkout')
    const d = await dialog(page, 'Discard local changes?')
    assert.match(d.body, /permanently discards your changes to 1 file/)
    await page.t('press', 'Cancel')
    await noDialog(page)
    assert.equal(currentBranch(git), 'main')
    assert.match(readFileSync(path.join(repo, 'app.txt'), 'utf8'), /dirty first line/)

    await page.t('clickMenu', 'Checkout')
    await dialog(page, 'Checkout would overwrite local changes')
    await page.t('press', 'Force Checkout')
    await dialog(page, 'Discard local changes?')
    await page.t('press', 'Discard and Checkout')
    await finished(page)
    assert.equal(currentBranch(git), 'experiment')
    assert.doesNotMatch(readFileSync(path.join(repo, 'app.txt'), 'utf8'), /dirty first line/)
  })

  test('Cancel leaves everything as it was', async (t) => {
    const { page, git, repo } = await openPanel(t, { setup: diverge })
    await blockedCheckout(page)
    await page.t('press', 'Cancel')
    await noDialog(page)
    assert.equal(currentBranch(git), 'main')
    assert.match(readFileSync(path.join(repo, 'app.txt'), 'utf8'), /dirty first line/)
    assert.deepEqual(stashes(git), [])
  })

  test('an untracked file that exists on the target: Smart Checkout keeps the stash and names the file', async (t) => {
    const { page, git, repo } = await openPanel(t, { setup: (git, { repo }) => writeFileSync(path.join(repo, 'experiment.txt'), 'mine\n') })
    const d = await blockedCheckout(page)
    assert.match(d.body, /These untracked files would be overwritten/)
    assert.deepEqual(d.files, ['experiment.txt'])
    await page.t('press', 'Smart Checkout')
    const c = await dialog(page, 'Checked out, but your changes conflict')
    assert.deepEqual(c.files, ['experiment.txt'])
    assert.match(c.pre[0], /experiment\.txt already exists, no checkout/)
    await page.t('press', 'OK')
    await noDialog(page)
    assert.equal(currentBranch(git), 'experiment')
    assert.equal(stashes(git).length, 1)
    assert.equal(readFileSync(path.join(repo, 'experiment.txt'), 'utf8'), 'experiment\n')
  })
})

describe('worktrees', opts, () => {
  test('a branch held by another worktree: submenu opens its worktree, checkout shows the path', async (t) => {
    const { page, server, dir } = await openPanel(t)
    const wt = path.join(dir, 'work-hotfix')
    await openMenu(page, 'Local', 'urgent', 'hotfix/urgent')
    const menu = await page.t('menu')
    assert.equal(menu[0].label, 'Open Its Worktree in Orca')
    assert.ok(!menu.some((m) => m.label === 'Checkout'))
    assert.equal(menu.find((m) => m.label === "Checkout and Rebase onto 'main'").disabled, true)
    await page.t('clickMenu', 'Open Its Worktree in Orca')
    await page.waitFor(`__t.toast() === ${q(`Opened ${wt}`)}`)
    assert.deepEqual(server.orcaCalls().filter((c) => c[1] === 'create'), [['terminal', 'create', '--worktree', `path:${wt}`, '--focus']])

    // Checkout Tag or Revision by branch name reaches git's worktree refusal.
    await page.t('back')
    await listView(page)
    await page.t('clickRow', 'Actions', 'Checkout Tag or Revision…')
    await dialog(page, 'Checkout Tag or Revision')
    await page.t('fill', 'rev', 'hotfix/urgent')
    await page.t('press', 'Checkout')
    const d = await dialog(page, "'hotfix/urgent' is checked out in another worktree")
    assert.deepEqual(d.pre, [wt])
    assert.deepEqual(d.buttons, ['Cancel', 'Open That Worktree in Orca'])
    await page.t('press', 'Open That Worktree in Orca')
    await noDialog(page)
    await eventually(() => server.orcaCalls().filter((c) => c[1] === 'create').length === 2, 5000, 'second open')
  })
})

// ---------------------------------------------------------------------------

describe('Git menu', opts, () => {
  test('lists every entry', async (t) => {
    const { page } = await openPanel(t)
    await page.t('clickRow', 'Actions', 'Git Menu')
    assert.deepEqual(await subhead(page, 'Git'), { title: 'Git', sub: 'main' })
    assert.deepEqual((await page.t('menu')).map((m) => m.label), [
      'Commit…',
      'Push…',
      'Update Project…',
      'Pull…',
      'Fetch',
      'Merge…',
      'Rebase…',
      'Branches…',
      'New Branch…',
      'New Tag…',
      'Reset HEAD…',
      'New Worktree…',
      'Worktrees…',
      'Show Git Log',
      'Patch › Create Patch from Local Changes…',
      'Patch › Apply Patch…',
      'Uncommitted Changes › Stash Changes…',
      'Uncommitted Changes › Unstash Changes…',
      'Uncommitted Changes › Rollback…',
      'Current File › Show History…',
      'Current File › Annotate with Git Blame…',
      'Current File › Rollback…'
    ])
    await page.t('clickMenu', 'Branches…')
    await listView(page)
  })

  test('Commit…', async (t) => {
    const { page, git, repo } = await openPanel(t, { setup: (git, { repo }) => writeFileSync(path.join(repo, 'new.txt'), 'new\n') })
    await gitMenu(page, 'Commit…')
    let d = await dialog(page, "Commit to 'main'")
    assert.match(d.hints[0], /^1 changed file\(s\)/)
    await page.t('press', 'Commit')
    d = await dialog(page, 'Commit')
    assert.deepEqual(d.pre, ['Commit message is empty.'])
    await page.t('press', 'Close')
    await noDialog(page)

    await gitMenu(page, 'Commit…')
    await dialog(page, "Commit to 'main'")
    await page.t('fill', 'message', 'Add new.txt')
    await page.t('press', 'Commit')
    await finished(page)
    assert.equal(git('log', '-1', '--format=%s'), 'Add new.txt')
    assert.equal(git('status', '--porcelain'), '')
    assert.equal(git('show', '--format=', '--name-only', 'HEAD'), 'new.txt')

    // Amend without a message keeps the message.
    writeFileSync(path.join(repo, 'new.txt'), 'newer\n')
    await gitMenu(page, 'Commit…')
    await dialog(page, "Commit to 'main'")
    await page.t('fill', 'amend', true)
    await page.t('press', 'Commit')
    await finished(page)
    assert.equal(git('log', '-1', '--format=%s'), 'Add new.txt')
    assert.equal(git('show', 'HEAD:new.txt'), 'newer')
    assert.equal(git('rev-list', '--count', 'origin/main..HEAD'), '1')
  })

  test('Push…: a rejected push offers --force-with-lease', async (t) => {
    const { page, git, dir } = await openPanel(t, { setup: (git, { repo }) => commitFile(git, 'local.txt', 'l\n', 'Local commit', repo) })
    const remoteMain = () => execFileSync(GIT, ['--git-dir', path.join(dir, 'origin.git'), 'rev-parse', 'main'], { encoding: 'utf8' }).trim()
    const before = remoteMain()
    await gitMenu(page, 'Push…')
    const d = await dialog(page, "Push 'main'")
    assert.deepEqual(d.hints, ['1 commit to push'])
    await page.t('press', 'Push')
    const r = await dialog(page, 'Push rejected')
    assert.match(r.pre[0], /\[rejected\]/)
    assert.deepEqual(r.buttons, ['Cancel', 'Force Push (with lease)'])
    await page.t('press', 'Cancel')
    await noDialog(page)
    assert.equal(remoteMain(), before)

    await gitMenu(page, 'Push…')
    await dialog(page, "Push 'main'")
    await page.t('press', 'Push')
    await dialog(page, 'Push rejected')
    await page.t('press', 'Force Push (with lease)')
    await finished(page)
    assert.equal(remoteMain(), git('rev-parse', 'main'))
  })

  test('Push… with the force box asks first', async (t) => {
    const { page, git, dir } = await openPanel(t, { setup: (git, { repo }) => commitFile(git, 'local.txt', 'l\n', 'Local commit', repo) })
    await gitMenu(page, 'Push…')
    await dialog(page, "Push 'main'")
    await page.t('fill', 'force', true)
    await page.t('press', 'Push')
    await dialog(page, 'Force push?')
    await page.t('press', 'Force Push')
    await finished(page)
    assert.equal(execFileSync(GIT, ['--git-dir', path.join(dir, 'origin.git'), 'rev-parse', 'main'], { encoding: 'utf8' }).trim(), git('rev-parse', 'main'))
  })

  test('Update Project…, Pull… and Fetch', async (t) => {
    const { page, git, other } = await openPanel(t)
    await gitMenu(page, 'Update Project…')
    await page.waitFor(`__t.toast().startsWith('Updating (rebase)')`)
    await page.waitFor(`__t.idle() && !__t.toast().startsWith('Updating')`)
    assert.equal(git('rev-parse', 'main'), git('rev-parse', 'origin/main'))
    await page.waitFor(`__t.find('Local', 'main')?.incoming === null`)

    other('checkout', '-q', 'main')
    other('pull', '-q')
    other('commit', '-q', '--allow-empty', '-m', 'Another remote commit')
    other('push', '-q', 'origin', 'main')
    await gitMenu(page, 'Pull…')
    const d = await dialog(page, "Pull into 'main'")
    assert.deepEqual(d.fields, [{ id: 'method', type: 'select-one', value: 'rebase' }])
    await page.t('press', 'Pull')
    await finished(page)
    assert.equal(git('log', '-1', '--format=%s'), 'Another remote commit')

    other('checkout', '-q', '-b', 'feature/menu-fetch')
    other('push', '-q', 'origin', 'feature/menu-fetch')
    await gitMenu(page, 'Fetch')
    await finished(page)
    assert.ok(ok(() => git('rev-parse', '--verify', '-q', 'origin/feature/menu-fetch')))
    await page.t('back')
    await row(page, 'Remote', 'menu-fetch')
  })

  test('Merge… and Rebase… pick a branch', async (t) => {
    const { page, git } = await openPanel(t)
    await gitMenu(page, 'Merge…')
    await dialog(page, "Merge into 'main'")
    await page.t('press', 'Merge')
    await page.waitFor(`__t.dialog()?.errors[0] === 'Pick a branch'`)
    await page.t('fill', 'ref', 'exper')
    const d = await page.waitFor(`__t.dialog()?.picks.length === 1 && __t.dialog()`)
    assert.deepEqual(d.picks, ['experiment'])
    await page.t('pick', 'experiment')
    await page.waitFor(`__t.dialog()?.fields[0].value === 'experiment'`)
    await page.t('press', 'Merge')
    await finished(page)
    assert.ok(isAncestor(git, 'experiment', 'main'))
    assert.equal(git('rev-list', '--count', 'main..origin/main'), '1')

    await gitMenu(page, 'Rebase…')
    await dialog(page, "Rebase 'main' onto…")
    await page.t('fill', 'onto', 'origin/main')
    await page.t('press', 'Rebase')
    await finished(page)
    assert.ok(isAncestor(git, 'origin/main', 'main'))
    // The rebase replays experiment's commit on top of origin/main.
    assert.equal(git('log', '-1', '--format=%s'), 'Work on experiment')
  })

  test('New Branch… and New Tag…', async (t) => {
    const { page, git } = await openPanel(t)
    await gitMenu(page, 'New Branch…')
    await dialog(page, 'New Branch')
    await page.t('fill', 'name', 'topic')
    await page.t('press', 'Create')
    await finished(page)
    assert.equal(currentBranch(git), 'topic')

    await gitMenu(page, 'New Tag…')
    await dialog(page, 'New Tag')
    await page.t('fill', 'name', 'v9')
    await page.t('fill', 'message', 'Nine')
    await page.t('press', 'Create Tag')
    await finished(page)
    assert.equal(git('cat-file', '-t', 'v9'), 'tag')
    assert.equal(git('tag', '-l', '--format=%(contents:subject)', 'v9'), 'Nine')

    await gitMenu(page, 'New Tag…')
    await dialog(page, 'New Tag')
    await page.t('fill', 'name', 'v9-light')
    await page.t('fill', 'ref', 'experiment')
    await page.t('press', 'Create Tag')
    await finished(page)
    assert.equal(git('cat-file', '-t', 'v9-light'), 'commit')
    assert.equal(git('rev-parse', 'v9-light'), git('rev-parse', 'experiment'))
  })

  test('Checkout Tag or Revision…', async (t) => {
    const { page, git } = await openPanel(t)
    await page.t('clickRow', 'Actions', 'Checkout Tag or Revision…')
    await dialog(page, 'Checkout Tag or Revision')
    await page.t('fill', 'rev', 'nope-not-a-rev')
    await page.t('press', 'Checkout')
    const e = await dialog(page, 'Unknown revision')
    assert.deepEqual(e.pre, ["fatal: 'nope-not-a-rev' does not name a commit"])
    await page.t('press', 'Close')
    await noDialog(page)

    const target = git('rev-parse', 'HEAD~1')
    await page.t('clickRow', 'Actions', 'Checkout Tag or Revision…')
    await dialog(page, 'Checkout Tag or Revision')
    await page.t('fill', 'rev', 'HEAD~1')
    await page.t('press', 'Checkout')
    await finished(page)
    assert.equal(git('rev-parse', 'HEAD'), target)
    assert.equal(currentBranch(git), '')

    // A local branch name checks the branch out instead of detaching.
    await page.t('clickRow', 'Actions', 'Checkout Tag or Revision…')
    await dialog(page, 'Checkout Tag or Revision')
    await page.t('fill', 'rev', 'experiment')
    await page.t('press', 'Checkout')
    await finished(page)
    assert.equal(currentBranch(git), 'experiment')
  })

  for (const mode of ['soft', 'mixed', 'hard', 'keep']) {
    test(`Reset HEAD… ${mode}`, async (t) => {
      const { page, git, repo } = await openPanel(t, {
        setup: (git, { repo }) => {
          commitFile(git, 'reset.txt', 'reset\n', 'Commit to reset', repo)
          writeFileSync(path.join(repo, 'README.md'), '# Dirty\n')
        }
      })
      const target = git('rev-parse', 'HEAD~1')
      await gitMenu(page, 'Reset HEAD…')
      const d = await dialog(page, 'Reset HEAD (main)')
      assert.deepEqual(d.fields.map((f) => [f.id, f.value]), [
        ['ref', 'HEAD'],
        ['mode', 'mixed']
      ])
      await page.t('fill', 'ref', 'HEAD~1')
      await page.t('fill', 'mode', mode)
      await page.t('press', 'Reset')
      if (mode === 'hard') {
        await dialog(page, 'Reset --hard?')
        await page.t('press', 'Cancel')
        await noDialog(page)
        assert.notEqual(git('rev-parse', 'HEAD'), target)
        await gitMenu(page, 'Reset HEAD…')
        await dialog(page, 'Reset HEAD (main)')
        await page.t('fill', 'ref', 'HEAD~1')
        await page.t('fill', 'mode', 'hard')
        await page.t('press', 'Reset')
        await dialog(page, 'Reset --hard?')
        await page.t('press', 'Reset Hard')
      }
      await finished(page)
      assert.equal(git('rev-parse', 'HEAD'), target)
      const status = git('status', '--porcelain', '--untracked-files=all').split('\n').filter(Boolean).sort()
      const expected = {
        soft: ['A  reset.txt', ' M README.md'].sort(),
        mixed: [' M README.md', '?? reset.txt'].sort(),
        hard: [],
        keep: [' M README.md']
      }[mode]
      assert.deepEqual(status, expected)
      assert.equal(existsSync(path.join(repo, 'reset.txt')), mode === 'soft' || mode === 'mixed')
    })
  }

  test('New Worktree… goes through Orca and Worktrees… lists them', async (t) => {
    const { page, git, server, repo, dir } = await openPanel(t)
    await gitMenu(page, 'New Worktree…')
    const d = await dialog(page, 'New Worktree (Orca workspace)')
    assert.deepEqual(d.fields.map((f) => [f.id, f.value]), [
      ['name', ''],
      ['base', 'main']
    ])
    await page.t('fill', 'name', 'wt-new')
    await page.t('press', 'Create')
    await page.waitFor(`__t.toast() === 'Created worktree wt-new'`)
    assert.deepEqual(server.orcaCalls().find((c) => c[0] === 'worktree' && c[1] === 'create'), ['worktree', 'create', '--repo', `path:${repo}`, '--name', 'wt-new', '--activate', '--base-branch', 'main'])
    assert.match(git('worktree', 'list'), /wt-new/)
    await toList(page)
    await page.waitFor(`__t.find('Local', 'wt-new')?.badge === 'worktree'`)

    await gitMenu(page, 'Worktrees…')
    await subhead(page, 'Worktrees')
    const rows = await page.eval(`[...document.querySelectorAll('.viewer .file-row')].map((r) => [r.querySelector('strong').textContent, r.querySelector('button, .badge').textContent])`)
    assert.deepEqual(rows, [
      ['main', 'this'],
      ['hotfix/urgent', 'Open in Orca'],
      ['wt-new', 'Open in Orca']
    ])
    await page.eval(`[...document.querySelectorAll('.viewer .file-row')][1].querySelector('button').click()`)
    await page.waitFor(`__t.toast().startsWith('Opened')`)
    assert.deepEqual(server.orcaCalls().filter((c) => c[0] === 'terminal' && c[1] === 'create').pop(), ['terminal', 'create', '--worktree', `path:${path.join(dir, 'work-hotfix')}`, '--focus'])
    await page.eval(`[...document.querySelectorAll('.viewer button')].find((b) => b.textContent === 'New Worktree…').click()`)
    await dialog(page, 'New Worktree (Orca workspace)')
  })

  test('Show Git Log', async (t) => {
    const { page } = await openPanel(t)
    await gitMenu(page, 'Show Git Log')
    assert.deepEqual(await subhead(page, 'Git Log'), { title: 'Git Log', sub: 'all branches, newest 400' })
    const text = await page.t('viewerText')
    for (const s of ['Initial commit', 'Main change 3', 'Remote only', 'Work on experiment', 'tag: v1.0']) assert.ok(text.includes(s), s)
    await page.key('Escape')
    await subhead(page, 'Git')
  })

  test('Patch: create saves the local changes, apply applies a file', async (t) => {
    const { page, git, repo, dir } = await openPanel(t, {
      setup: (git, { repo, dir }) => {
        appendFileSync(path.join(repo, 'app.txt'), 'patched line\n')
        writeFileSync(path.join(dir, 'change.patch'), git('diff') + '\n')
        git('checkout', '--', 'app.txt')
      }
    })
    await gitMenu(page, 'Patch › Create Patch from Local Changes…')
    await page.waitFor(`__t.toast() === 'No local changes to put in a patch'`)

    await gitMenu(page, 'Patch › Apply Patch…')
    await dialog(page, 'Apply Patch')
    await page.t('press', 'Apply')
    const e = await dialog(page, 'Apply Patch')
    assert.deepEqual(e.pre, ['Choose a patch file first.'])
    await page.t('press', 'Close')
    await noDialog(page)

    await gitMenu(page, 'Patch › Apply Patch…')
    await dialog(page, 'Apply Patch')
    await page.setFiles('.dialog input[type=file]', [path.join(dir, 'change.patch')])
    await page.waitFor(`__t.dialog().hints.some((h) => h.startsWith('change.patch:'))`)
    await page.t('press', 'Apply')
    await finished(page)
    assert.match(readFileSync(path.join(repo, 'app.txt'), 'utf8'), /patched line\n$/)

    writeFileSync(path.join(repo, 'new.txt'), 'brand new\n')
    await gitMenu(page, 'Patch › Create Patch from Local Changes…')
    const d = await dialog(page, 'Create Patch from Local Changes')
    assert.match(d.body, /\+patched line/)
    await page.t('press', 'Save Patch…')
    const saved = await page.waitFor(`window.__savedFiles?.[0]`)
    assert.equal(saved.suggestedName, 'main.patch')
    assert.match(saved.data, /diff --git a\/app\.txt b\/app\.txt/)
    assert.match(saved.data, /diff --git a\/new\.txt b\/new\.txt[\s\S]*\+brand new/)
    await page.waitFor(`__t.toast() === 'Patch saved'`)
    assert.equal((await page.t('dialog')).title, 'Create Patch from Local Changes')
    await page.t('press', 'Close')
    await noDialog(page)
    // The intent-to-add used for the patch is undone.
    assert.deepEqual(git('status', '--porcelain').split('\n').sort(), ['?? new.txt', 'M  app.txt'])
  })

  test('Stash Changes…', async (t) => {
    const { page, git } = await openPanel(t, {
      setup: (git, { repo }) => {
        appendFileSync(path.join(repo, 'app.txt'), 'wip\n')
        writeFileSync(path.join(repo, 'untracked.txt'), 'u\n')
      }
    })
    await gitMenu(page, 'Uncommitted Changes › Stash Changes…')
    await dialog(page, 'Stash Changes')
    await page.t('fill', 'message', 'my wip')
    await page.t('press', 'Stash')
    await finished(page)
    assert.deepEqual(stashes(git), ['stash@{0}: On main: my wip'])
    assert.equal(git('status', '--porcelain'), '')
  })

  const twoStashes = (git, { repo }) => {
    appendFileSync(path.join(repo, 'app.txt'), 'first\n')
    git('stash', 'push', '-q', '-m', 'first stash')
    writeFileSync(path.join(repo, 'README.md'), '# second\n')
    git('stash', 'push', '-q', '-m', 'second stash')
  }
  const stashButton = (page, ref, which) =>
    page.eval(`(() => { const r = [...document.querySelectorAll('.viewer .file-row')].find((r) => r.querySelector('.sha')?.textContent === ${q(ref)}); [...r.querySelectorAll('button')].find((b) => b.textContent === ${q(which)} || b.title === ${q(which)}).click(); return true })()`)

  test('Unstash Changes…: Apply keeps the stash', async (t) => {
    const { page, git, repo } = await openPanel(t, { setup: twoStashes })
    await gitMenu(page, 'Uncommitted Changes › Unstash Changes…')
    const sh = await subhead(page, 'Stashes')
    assert.equal(sh.sub, '2')
    assert.match(await page.t('viewerText'), /stash@\{0\} On main: second stash.*stash@\{1\} On main: first stash/)
    await stashButton(page, 'stash@{1}', 'Apply')
    await finished(page)
    assert.equal(stashes(git).length, 2)
    assert.match(readFileSync(path.join(repo, 'app.txt'), 'utf8'), /first\n$/)
    await subhead(page, 'Stashes')
  })

  test('Unstash Changes…: Drop asks, Pop applies and drops', async (t) => {
    const { page, git, repo } = await openPanel(t, { setup: twoStashes })
    await gitMenu(page, 'Uncommitted Changes › Unstash Changes…')
    await subhead(page, 'Stashes')
    await stashButton(page, 'stash@{1}', 'Drop')
    await dialog(page, 'Drop stash@{1}?')
    await page.t('press', 'Drop')
    await page.waitFor(`__t.subhead().sub === '1'`)
    assert.deepEqual(stashes(git), ['stash@{0}: On main: second stash'])

    await page.t('clearToast')
    await stashButton(page, 'stash@{0}', 'Pop')
    await finished(page)
    assert.deepEqual(stashes(git), [])
    assert.equal(readFileSync(path.join(repo, 'README.md'), 'utf8'), '# second\n')
    await page.waitFor(`__t.subhead().sub === '0' && __t.viewerText().includes('No stashes.')`)
  })

  test('Rollback… asks twice, then restores the files', async (t) => {
    const { page, git, repo } = await openPanel(t, {
      setup: (git, { repo }) => {
        appendFileSync(path.join(repo, 'app.txt'), 'oops\n')
        writeFileSync(path.join(repo, 'added.txt'), 'added\n')
        git('add', 'added.txt')
        writeFileSync(path.join(repo, 'untracked.txt'), 'keep me\n')
      }
    })
    await gitMenu(page, 'Uncommitted Changes › Rollback…')
    let d = await dialog(page, 'Rollback Changes')
    assert.deepEqual(d.files.sort(), ['A added.txt', 'M app.txt'])
    await page.t('press', 'Rollback')
    await dialog(page, 'Discard these changes?')
    await page.t('press', 'Cancel')
    await noDialog(page)
    assert.match(readFileSync(path.join(repo, 'app.txt'), 'utf8'), /oops/)

    await gitMenu(page, 'Uncommitted Changes › Rollback…')
    await dialog(page, 'Rollback Changes')
    await page.t('fill', 'deleteAdded', true)
    await page.t('press', 'Rollback')
    d = await dialog(page, 'Discard these changes?')
    assert.match(d.body, /2 file\(s\) return to their committed state/)
    await page.t('press', 'Rollback')
    await finished(page)
    assert.doesNotMatch(readFileSync(path.join(repo, 'app.txt'), 'utf8'), /oops/)
    assert.ok(!existsSync(path.join(repo, 'added.txt')))
    assert.equal(git('status', '--porcelain'), '?? untracked.txt')

    await gitMenu(page, 'Uncommitted Changes › Rollback…')
    await page.waitFor(`__t.toast() === 'No local changes to roll back'`)
  })

  test('Current File: History and Blame', async (t) => {
    const { page } = await openPanel(t)
    await gitMenu(page, 'Current File › Show History…')
    const d = await dialog(page, 'Show History: pick a file')
    assert.ok(d.picks.includes('app.txt') && d.picks.includes('README.md'))
    await page.t('fill', 'file', 'nope.txt')
    await page.t('press', 'OK')
    await page.waitFor(`__t.dialog()?.errors[0] === 'Pick a tracked file'`)
    await page.t('fill', 'file', 'app')
    await page.waitFor(`__t.dialog()?.picks.join() === 'app.txt'`)
    await page.t('pick', 'app.txt')
    await page.t('press', 'OK')
    assert.deepEqual(await subhead(page, 'History: app.txt'), { title: 'History: app.txt', sub: '3 commits' })
    assert.match(await page.t('viewerText'), /Main change 3.*Main change 2.*Main change 1/)

    await page.t('back')
    await subhead(page, 'Git')
    await page.t('clickMenu', 'Current File › Annotate with Git Blame…')
    // The last file is remembered.
    const b = await dialog(page, 'Annotate with Git Blame: pick a file')
    assert.equal(b.fields[0].value, 'app.txt')
    await page.t('press', 'OK')
    await subhead(page, 'Blame: app.txt')
    const lines = await page.eval(`[...document.querySelectorAll('.viewer .blame-line')].map((l) => [l.querySelector('.ann').textContent.split(' ')[1], l.lastChild.textContent])`)
    assert.deepEqual(lines, [
      ['Demo', 'line 1'],
      ['Demo', 'line 2'],
      ['Demo', 'line 3']
    ])
  })

  test('Current File: Rollback', async (t) => {
    const { page, git, repo } = await openPanel(t, {
      setup: (git, { repo }) => {
        appendFileSync(path.join(repo, 'app.txt'), 'oops\n')
        writeFileSync(path.join(repo, 'README.md'), '# also changed\n')
      }
    })
    await gitMenu(page, 'Current File › Rollback…')
    await dialog(page, 'Rollback File: pick a file')
    await page.t('fill', 'file', 'app.txt')
    await page.t('press', 'OK')
    await dialog(page, 'Rollback app.txt?')
    await page.t('press', 'Rollback')
    await finished(page)
    assert.equal(git('status', '--porcelain'), ' M README.md')
    assert.doesNotMatch(readFileSync(path.join(repo, 'app.txt'), 'utf8'), /oops/)
  })
})

// ---------------------------------------------------------------------------

describe('conflicts', opts, () => {
  const conflicting = (git, { repo }) => {
    git('checkout', '-q', '-b', 'conflict-a')
    commitFile(git, 'app.txt', 'theirs\n', 'Theirs', repo)
    git('checkout', '-q', 'main')
    commitFile(git, 'app.txt', 'ours\n', 'Ours', repo)
  }
  const startMerge = async (page) => {
    await openMenu(page, 'Local', 'conflict-a', 'conflict-a')
    await page.t('clickMenu', "Merge 'conflict-a' into 'main'")
    await dialog(page, "Merge 'conflict-a' into 'main'?")
    await page.t('press', 'Merge')
    const d = await dialog(page, 'Merge: conflicts')
    assert.deepEqual(d.files, ['app.txt'])
    assert.match(d.pre[0], /CONFLICT/)
    assert.deepEqual(d.buttons, ['Abort', 'Resolve Later'])
  }

  test('merge conflict: banner with Abort', async (t) => {
    const { page, git, repo } = await openPanel(t, { setup: conflicting })
    const ours = git('rev-parse', 'HEAD')
    await startMerge(page)
    await page.t('press', 'Resolve Later')
    const banner = await page.waitFor(`__t.banner()`)
    assert.deepEqual(banner, { text: 'Merge in progress. Resolve conflicts, then continue.', buttons: ['Continue', 'Abort'] })
    assert.ok(existsSync(path.join(repo, '.git/MERGE_HEAD')))
    await page.t('clickBanner', 'Abort')
    await dialog(page, 'Abort Merge?')
    await page.t('press', 'Abort')
    await page.waitFor(`__t.banner() === null && __t.idle()`)
    assert.ok(!existsSync(path.join(repo, '.git/MERGE_HEAD')))
    assert.equal(git('rev-parse', 'HEAD'), ours)
    assert.equal(git('status', '--porcelain'), '')
  })

  test('merge conflict: banner with Continue', async (t) => {
    const { page, git, repo } = await openPanel(t, { setup: conflicting })
    await startMerge(page)
    await page.t('press', 'Resolve Later')
    await page.waitFor(`__t.banner()`)
    writeFileSync(path.join(repo, 'app.txt'), 'resolved\n')
    git('add', 'app.txt')
    await page.t('clearToast')
    await page.t('clickBanner', 'Continue')
    await finished(page)
    await page.waitFor(`__t.banner() === null`)
    assert.equal(git('rev-parse', 'HEAD^2'), git('rev-parse', 'conflict-a'))
    assert.equal(git('show', 'HEAD:app.txt'), 'resolved')
  })

  test('rebase conflict: Abort from the conflict dialog, then Continue after resolving', async (t) => {
    const { page, git, repo } = await openPanel(t, { setup: conflicting })
    const ours = git('rev-parse', 'HEAD')
    const rebase = async () => {
      await openMenu(page, 'Local', 'conflict-a', 'conflict-a')
      await page.t('clickMenu', "Rebase 'main' onto 'conflict-a'")
      await dialog(page, "Rebase 'main' onto 'conflict-a'?")
      await page.t('press', 'Rebase')
      await dialog(page, 'Rebase: conflicts')
    }
    await rebase()
    await page.t('press', 'Abort')
    await dialog(page, 'Abort Rebase?')
    await page.t('press', 'Abort')
    await page.waitFor(`__t.toast() === 'Aborted' && __t.banner() === null`)
    assert.equal(git('rev-parse', 'HEAD'), ours)
    assert.equal(currentBranch(git), 'main')

    await rebase()
    await page.t('press', 'Resolve Later')
    const banner = await page.waitFor(`__t.banner()`)
    assert.equal(banner.text, 'Rebase in progress. Resolve conflicts, then continue.')
    writeFileSync(path.join(repo, 'app.txt'), 'resolved\n')
    git('add', 'app.txt')
    await page.t('clearToast')
    await page.t('clickBanner', 'Continue')
    await finished(page)
    await page.waitFor(`__t.banner() === null`)
    assert.equal(currentBranch(git), 'main')
    assert.equal(git('rev-parse', 'HEAD~1'), git('rev-parse', 'conflict-a'))
  })
})

describe('errors and live updates', opts, () => {
  test("the error dialog shows git's text verbatim, the command, and Copy", async (t) => {
    const { page, git, server } = await openPanel(t)
    await page.grantClipboard(new URL(server.url).origin)
    await page.eval(`navigator.clipboard.writeText('before')`)
    let expected
    try {
      git('tag', 'v1.0', 'HEAD')
    } catch (e) {
      expected = String(e.stderr).trim()
    }
    assert.ok(expected)
    await gitMenu(page, 'New Tag…')
    await dialog(page, 'New Tag')
    await page.t('fill', 'name', 'v1.0')
    await page.t('press', 'Create Tag')
    const d = await dialog(page, 'New Tag')
    assert.deepEqual(d.pre, [expected])
    assert.deepEqual(d.hints, ['git tag v1.0 HEAD'])
    assert.deepEqual(d.buttons, ['Copy', 'Close'])
    await page.clickReal(`[...document.querySelectorAll('.d-buttons button')].find((b) => b.textContent === 'Copy')`)
    await page.waitFor(`__t.toast() === 'Copied'`)
    assert.equal(await page.eval(`navigator.clipboard.readText()`), expected)
    assert.equal((await page.t('dialog')).title, 'New Tag')
    await page.t('press', 'Close')
    await noDialog(page)
  })

  test('a branch made outside the panel shows up without a reload', async (t) => {
    const { page, git } = await openPanel(t)
    await page.eval(`window.__sameDocument = true`)
    git('branch', 'zzz')
    await page.waitFor(`__t.find('Local', 'zzz')`, 10_000, 'zzz to appear')
    git('branch', '-D', 'zzz')
    await noRow(page, 'Local', 'zzz')
    assert.equal(await page.eval(`window.__sameDocument`), true)
  })
})

describe('palette commands', opts, () => {
  test('each dialog command opens its dialog in the panel', async (t) => {
    const { page, server } = await openPanel(t, { setup: (git, { repo }) => appendFileSync(path.join(repo, 'app.txt'), 'dirty\n') })
    const cases = [
      ['git.commitDialog', 'dialog', "Commit to 'main'"],
      ['git.newBranch', 'dialog', 'New Branch'],
      ['git.newTag', 'dialog', 'New Tag'],
      ['git.merge', 'dialog', "Merge into 'main'"],
      ['git.rebase', 'dialog', "Rebase 'main' onto…"],
      ['git.reset', 'dialog', 'Reset HEAD (main)'],
      ['git.checkoutRevision', 'dialog', 'Checkout Tag or Revision'],
      ['git.newWorktree', 'dialog', 'New Worktree (Orca workspace)'],
      ['git.patchCreate', 'dialog', 'Create Patch from Local Changes'],
      ['git.patchApply', 'dialog', 'Apply Patch'],
      ['git.rollback', 'dialog', 'Rollback Changes'],
      ['git.fileHistory', 'dialog', 'Show History: pick a file'],
      ['git.blame', 'dialog', 'Annotate with Git Blame: pick a file'],
      ['git.rollbackFile', 'dialog', 'Rollback File: pick a file'],
      ['git.worktrees', 'view', 'Worktrees'],
      ['git.log', 'view', 'Git Log'],
      ['git.stashes', 'view', 'Stashes'],
      ['git.vcsPopup', 'view', 'Git'],
      ['git.branches', 'list']
    ]
    for (const [id, kind, title] of cases) {
      const r = await server.command(id)
      assert.equal(r.result, 'Continue in the Git Controls panel', id)
      if (kind === 'dialog') {
        await dialog(page, title)
        await page.key('Escape')
        await noDialog(page)
      } else if (kind === 'view') {
        await subhead(page, title)
      } else {
        await listView(page)
      }
    }
    const notes = await server.notifications()
    assert.equal(notes.length, cases.length)
    assert.ok(notes.every((n) => n.body === 'Open Git Controls in the right sidebar to continue.'))
  })

  test('an intent survives a refresh that overtakes the load carrying it', async (t) => {
    const { page, server, git } = await openPanel(t)
    // Holds back the snapshot that carries the intent, so a refresh started after it returns first.
    await page.eval(`(() => {
      const real = orca.plugin.request.bind(orca.plugin)
      orca.plugin.request = async (name, input, o) => {
        const res = await real(name, input, o)
        if (input.op === 'snapshot' && res.value?.intent) await new Promise((r) => setTimeout(r, 1500))
        return res
      }
      return true
    })()`)
    await server.command('git.newTag')
    await sleep(200)
    git('branch', 'overtaking')
    await row(page, 'Local', 'overtaking')
    await dialog(page, 'New Tag')
  })

  test('commands that run directly notify, and hand decisions to the panel', async (t) => {
    const { page, git, server, dir, repo } = await openPanel(t, { setup: (git, { repo }) => commitFile(git, 'local.txt', 'l\n', 'Local commit', repo) })
    assert.equal((await server.command('git.fetch')).result, (await server.notifications()).at(-1).body)
    assert.equal((await server.notifications()).at(-1).title, 'Fetch')

    // A rejected push needs a decision: the panel shows it.
    assert.equal((await server.command('git.push')).result, 'rejected')
    assert.equal((await server.notifications()).at(-1).title, 'Push: action needed')
    await dialog(page, 'Push rejected')
    await page.t('press', 'Force Push (with lease)')
    await finished(page)
    assert.equal(execFileSync(GIT, ['--git-dir', path.join(dir, 'origin.git'), 'rev-parse', 'main'], { encoding: 'utf8' }).trim(), git('rev-parse', 'main'))

    appendFileSync(path.join(repo, 'app.txt'), 'dirty\n')
    await server.command('git.stash')
    assert.equal((await server.notifications()).at(-1).title, 'Stash Changes')
    assert.equal(stashes(git).length, 1)
    await server.command('git.unstash')
    assert.equal(stashes(git).length, 0)
    assert.equal((await server.notifications()).at(-1).title, 'Unstash Changes')
  })
})

describe('themes', opts, () => {
  for (const theme of ['light', 'dark']) {
    test(`${theme} theme applies Orca's variables`, async (t) => {
      const { page } = await openPanel(t, { theme })
      const s = await page.eval(`(() => ({
        cls: document.documentElement.className,
        orcaBg: document.documentElement.style.getPropertyValue('--orca-background'),
        bodyBg: getComputedStyle(document.body).backgroundColor,
        fg: getComputedStyle(document.body).color,
        scheme: getComputedStyle(document.documentElement).colorScheme
      }))()`)
      assert.equal(s.cls, theme)
      assert.equal(s.scheme, theme)
      if (theme === 'dark') {
        assert.equal(s.orcaBg, '#1e1f22')
        assert.equal(s.bodyBg, 'rgb(30, 31, 34)')
        assert.equal(s.fg, 'rgb(223, 225, 229)')
      } else {
        assert.equal(s.orcaBg, '#ffffff')
        assert.equal(s.bodyBg, 'rgb(255, 255, 255)')
        assert.equal(s.fg, 'rgb(31, 35, 40)')
      }
    })
  }
})
