// End-to-end harness: a demo repo per test, the real worker behind scripts/dev-server.mjs, and
// headless Chrome driven over the DevTools protocol (no dependencies: Node's global WebSocket).

import { spawn, execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, realpathSync, rmSync, cpSync, chmodSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const FAKE_ORCA = path.join(ROOT, 'test/e2e/fake-orca.mjs')

export const CHROME =
  process.env.CHROME_PATH ||
  [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser'
  ].find((p) => existsSync(p))

// The same lookup as lib/git.mjs, so the tests read the repo with the git the worker uses.
export const GIT = process.env.ORCA_GIT_CONTROLS_GIT || ['/opt/homebrew/bin/git', '/usr/local/bin/git', '/usr/bin/git'].find((p) => existsSync(p)) || 'git'

// Keeps the person's ~/.gitconfig (signing, hooks, pull.rebase) out of the demo repos.
const GIT_ENV = {
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Demo',
  GIT_AUTHOR_EMAIL: 'demo@example.com',
  GIT_COMMITTER_NAME: 'Demo',
  GIT_COMMITTER_EMAIL: 'demo@example.com'
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const tmpRoot = () => realpathSync(tmpdir())

function safeRemove(dir) {
  if (dir && dir.startsWith(tmpRoot() + path.sep)) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
}

// ---------------------------------------------------------------------------
// Demo repository

/** Builds the demo repo once; each test gets a copy, which is much faster than rebuilding it. */
export function buildTemplate() {
  const dir = mkdtempSync(path.join(tmpRoot(), 'gc-e2e-template-'))
  execFileSync('bash', [path.join(ROOT, 'scripts/make-demo-repo.sh'), path.join(dir, 'demo')], { env: { ...process.env, ...GIT_ENV }, stdio: 'pipe' })
  return { dir, demo: path.join(dir, 'demo'), dispose: () => safeRemove(dir) }
}

function copyDemo(template) {
  const dir = mkdtempSync(path.join(tmpRoot(), 'gc-e2e-'))
  cpSync(template.demo, dir, { recursive: true, verbatimSymlinks: true })
  const repo = path.join(dir, 'work')
  // Worktree links are absolute paths, so the copy still points at the template. `git worktree
  // repair` leaves them alone while the template's admin dir is still valid, so rewrite them.
  writeFileSync(path.join(dir, 'work-hotfix/.git'), `gitdir: ${path.join(repo, '.git/worktrees/work-hotfix')}\n`)
  writeFileSync(path.join(repo, '.git/worktrees/work-hotfix/gitdir'), `${path.join(dir, 'work-hotfix/.git')}\n`)
  // `git clone` stored the template's absolute origin path.
  gitIn(path.join(dir, 'other'))('remote', 'set-url', 'origin', path.join(dir, 'origin.git'))
  return { dir, repo }
}

export function gitIn(cwd) {
  return (...args) => execFileSync(GIT, args, { cwd, env: { ...process.env, ...GIT_ENV }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).replace(/\n+$/, '')
}

// ---------------------------------------------------------------------------
// Dev server

async function startServer(repo, dir, { orcaWorktrees = [] } = {}) {
  chmodSync(FAKE_ORCA, 0o755)
  const orcaLog = path.join(dir, 'orca-calls.jsonl')
  const child = spawn(process.execPath, [path.join(ROOT, 'scripts/dev-server.mjs'), repo, '0'], {
    env: { ...process.env, ...GIT_ENV, ORCA_GIT_CONTROLS_ORCA: FAKE_ORCA, ORCA_GIT_CONTROLS_GIT: GIT, FAKE_ORCA_GIT: GIT, FAKE_ORCA_LOG: orcaLog, FAKE_ORCA_WORKTREES: JSON.stringify(orcaWorktrees) },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  let output = ''
  const url = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`dev-server did not start:\n${output}`)), 20_000)
    const onData = (d) => {
      output += d
      const m = /(http:\/\/localhost:\d+\/)/.exec(output)
      if (m) {
        clearTimeout(timer)
        resolve(m[1])
      }
    }
    child.stdout.on('data', onData)
    child.stderr.on('data', (d) => (output += d))
    child.on('exit', (code) => reject(new Error(`dev-server exited ${code}:\n${output}`)))
  })
  return {
    url,
    log: () => output,
    orcaCalls: () => (existsSync(orcaLog) ? readFileSync(orcaLog, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []),
    async command(id) {
      const r = await fetch(new URL('/__command', url), { method: 'POST', body: JSON.stringify({ id }) })
      return r.json()
    },
    async notifications() {
      return (await fetch(new URL('/__notifications', url))).json()
    },
    async stop() {
      if (child.exitCode !== null) return
      const exited = new Promise((r) => child.once('exit', r))
      child.kill('SIGKILL')
      await exited
    }
  }
}

// ---------------------------------------------------------------------------
// Chrome over CDP

export class Browser {
  static async launch() {
    const profile = mkdtempSync(path.join(tmpRoot(), 'gc-e2e-chrome-'))
    const proc = spawn(
      CHROME,
      [
        '--headless=new',
        '--remote-debugging-port=0',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-background-timer-throttling',
        '--disable-renderer-backgrounding',
        '--disable-backgrounding-occluded-windows',
        '--disable-extensions',
        `--user-data-dir=${profile}`,
        'about:blank'
      ],
      { stdio: ['ignore', 'ignore', 'pipe'] }
    )
    let err = ''
    const wsUrl = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Chrome did not start:\n${err}`)), 30_000)
      proc.stderr.on('data', (d) => {
        err += d
        const m = /DevTools listening on (ws:\/\/\S+)/.exec(err)
        if (m) {
          clearTimeout(timer)
          resolve(m[1])
        }
      })
      proc.on('exit', (code) => reject(new Error(`Chrome exited ${code}:\n${err}`)))
    })
    const b = new Browser(proc, profile)
    await b.connect(wsUrl)
    return b
  }

  constructor(proc, profile) {
    this.proc = proc
    this.profile = profile
    this.nextId = 0
    this.pending = new Map()
    this.sessions = new Map()
  }

  connect(wsUrl) {
    this.ws = new WebSocket(wsUrl)
    this.ws.addEventListener('message', (e) => {
      const m = JSON.parse(e.data)
      if (m.id && this.pending.has(m.id)) {
        const { resolve, reject, method } = this.pending.get(m.id)
        this.pending.delete(m.id)
        if (m.error) reject(new Error(`${method}: ${m.error.message}`))
        else resolve(m.result)
      } else if (m.method && m.sessionId) {
        this.sessions.get(m.sessionId)?.onEvent(m.method, m.params)
      }
    })
    return new Promise((resolve, reject) => {
      this.ws.addEventListener('open', resolve)
      this.ws.addEventListener('error', reject)
    })
  }

  send(method, params = {}, sessionId) {
    const id = ++this.nextId
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method })
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
    })
  }

  async newPage() {
    const { browserContextId } = await this.send('Target.createBrowserContext', { disposeOnDetach: true })
    const { targetId } = await this.send('Target.createTarget', { url: 'about:blank', browserContextId })
    const { sessionId } = await this.send('Target.attachToTarget', { targetId, flatten: true })
    const page = new Page(this, sessionId, targetId, browserContextId)
    this.sessions.set(sessionId, page)
    await page.init()
    return page
  }

  async close() {
    try {
      this.ws?.close()
    } catch {}
    this.proc.kill('SIGKILL')
    await new Promise((r) => (this.proc.exitCode !== null ? r() : this.proc.once('exit', r)))
    safeRemove(this.profile)
  }
}

const KEYS = {
  ArrowDown: 40,
  ArrowUp: 38,
  ArrowLeft: 37,
  ArrowRight: 39,
  Enter: 13,
  Escape: 27
}

export class Page {
  constructor(browser, sessionId, targetId, contextId) {
    Object.assign(this, { browser, sessionId, targetId, contextId })
    this.nativeDialogs = []
    this.errors = []
  }

  send(method, params) {
    return this.browser.send(method, params, this.sessionId)
  }

  onEvent(method, params) {
    if (method === 'Page.javascriptDialogOpening') {
      this.nativeDialogs.push(params)
      this.send('Page.handleJavaScriptDialog', { accept: false }).catch(() => {})
    } else if (method === 'Runtime.exceptionThrown') {
      this.errors.push(params.exceptionDetails?.exception?.description || params.exceptionDetails?.text)
    }
  }

  async init() {
    await this.send('Page.enable')
    await this.send('Runtime.enable')
    await this.send('DOM.enable')
    await this.send('Emulation.setFocusEmulationEnabled', { enabled: true })
    await this.send('Emulation.setDeviceMetricsOverride', { width: 460, height: 1400, deviceScaleFactor: 1, mobile: false })
    await this.send('Page.addScriptToEvaluateOnNewDocument', { source: PAGE_HELPERS })
  }

  async goto(url) {
    await this.send('Page.navigate', { url })
    await this.waitFor('__t.loaded()', 20_000, 'panel load')
  }

  async reload() {
    await this.send('Page.reload', {})
    await sleep(100)
    await this.waitFor('__t.loaded()', 20_000, 'panel reload')
  }

  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text)
    return r.result.value
  }

  /** Calls a helper from PAGE_HELPERS: page.t('clickRow', 'Local', 'main'). */
  t(name, ...args) {
    return this.eval(`__t.${name}(...${JSON.stringify(args)})`)
  }

  waitFor(expr, ms = 15_000, what = expr) {
    return this.eval(`__t.until(() => (${expr}), ${ms}, ${JSON.stringify(what)})`)
  }

  async key(key) {
    const code = KEYS[key]
    const base = { key, code: key, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code }
    await this.send('Input.dispatchKeyEvent', { type: 'keyDown', ...base, ...(key === 'Enter' ? { text: '\r' } : {}) })
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base })
  }

  /** A real mouse click, which (unlike element.click()) counts as a user gesture. */
  async clickReal(expression) {
    const box = await this.eval(`(() => { const r = (${expression}).getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 } })()`)
    for (const type of ['mousePressed', 'mouseReleased']) await this.send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 })
  }

  type(text) {
    return this.send('Input.insertText', { text })
  }

  async setFiles(selector, files) {
    const r = await this.send('Runtime.evaluate', { expression: `document.querySelector(${JSON.stringify(selector)})` })
    await this.send('DOM.setFileInputFiles', { files, objectId: r.result.objectId })
  }

  /** Lets the page use navigator.clipboard; headless Chrome keeps its own clipboard, not the system's. */
  grantClipboard(origin) {
    return this.browser.send('Browser.grantPermissions', { origin, browserContextId: this.contextId, permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'] })
  }

  async close() {
    this.browser.sessions.delete(this.sessionId)
    await this.browser.send('Target.closeTarget', { targetId: this.targetId }).catch(() => {})
    await this.browser.send('Target.disposeBrowserContext', { browserContextId: this.contextId }).catch(() => {})
  }
}

// Runs inside the panel page. Everything the tests read or click goes through here.
const PAGE_HELPERS = String.raw`
window.__t = (() => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const txt = (n) => (n?.textContent || '').replace(/\s+/g, ' ').trim()
  const view = () => document.getElementById('view')
  const top = () => [...document.querySelectorAll('#dialog-root .overlay')].pop()?.querySelector('.dialog')
  const describe = (n) => ({
    kind: n.classList.contains('section') ? 'section' : n.classList.contains('sep') ? 'sep' : n.querySelector('.twisty') ? 'folder' : 'row',
    text: txt(n),
    label: txt(n.querySelector('.label')) || txt(n),
    indent: parseInt(n.style.paddingLeft) || 0,
    current: n.classList.contains('current-branch'),
    selected: n.classList.contains('selected'),
    disabled: n.classList.contains('disabled'),
    star: n.querySelector('.star') ? n.querySelector('.star').classList.contains('on') : null,
    badge: txt(n.querySelector('.badge')) || null,
    upstream: txt(n.querySelector('.upstream')) || null,
    upstreamGone: Boolean(n.querySelector('.upstream.gone')),
    upstreamStruck: n.querySelector('.upstream') ? getComputedStyle(n.querySelector('.upstream')).textDecorationLine.includes('line-through') : false,
    incoming: txt(n.querySelector('.counts .in')) || null,
    outgoing: txt(n.querySelector('.counts .out')) || null,
    title: n.title || ''
  })
  const t = {
    sleep,
    async until(fn, ms, what) {
      const end = Date.now() + ms
      let err
      while (Date.now() < end) {
        try {
          const v = fn()
          if (v) return v
        } catch (e) {
          err = e
        }
        await sleep(40)
      }
      throw new Error('Timed out waiting for ' + what + (err ? ' (' + err.message + ')' : '') + '\nDialog: ' + JSON.stringify(t.dialog()) + '\nToast: ' + t.toast())
    },
    loaded: () => !view().querySelector('.empty') && view().querySelectorAll('.row').length > 5 && t.idle(),
    listShown: () => !view().querySelector('.subhead') && Boolean(view().querySelector('.section, .empty')) && t.idle(),
    idle: () => !document.querySelector('.busy-bar'),
    /** The main view as a flat list, each entry tagged with its section. */
    listing() {
      let section = null
      const out = []
      for (const n of view().children) {
        const d = describe(n)
        if (d.kind === 'section') section = d.text
        out.push({ ...d, section })
      }
      return out
    },
    sections: () => [...view().querySelectorAll(':scope > .section')].map(txt),
    find(section, label, kind) {
      return t.listing().find((r) => r.section === section && r.label === label && (!kind || r.kind === kind)) || null
    },
    node(section, label) {
      let cur = null
      for (const n of view().children) {
        if (n.classList.contains('section')) cur = txt(n)
        else if (cur === section && txt(n.querySelector('.label')) === label) return n
      }
      return null
    },
    clickRow(section, label) {
      const n = t.node(section, label)
      if (!n) throw new Error('No row ' + label + ' in ' + section + ': ' + JSON.stringify(t.listing().map((r) => r.section + '/' + r.label)))
      n.click()
      return true
    },
    clickStar(section, label) {
      t.node(section, label).querySelector('.star').click()
      return true
    },
    clickSection(label) {
      ;[...view().querySelectorAll(':scope > .section')].find((n) => txt(n) === label).click()
      return true
    },
    subhead: () => ({ title: txt(view().querySelector('.subhead .title')), sub: txt(view().querySelector('.subhead .sub')) }),
    menu: () => [...view().querySelectorAll('.menu-row')].map((n) => ({ label: txt(n), disabled: n.classList.contains('disabled'), danger: n.classList.contains('danger'), selected: n.classList.contains('selected') })),
    clickMenu(label) {
      const n = [...view().querySelectorAll('.menu-row')].find((m) => txt(m) === label)
      if (!n) throw new Error('No menu item ' + label + ': ' + JSON.stringify(t.menu().map((m) => m.label)))
      n.click()
      return true
    },
    back() {
      view().querySelector('.subhead .icon-btn').click()
      return true
    },
    viewerText: () => txt(view().querySelector('.viewer')),
    viewer: () => view().querySelector('.viewer'),
    dialog() {
      const d = top()
      if (!d) return null
      return {
        title: txt(d.querySelector('.d-title')),
        body: txt(d.querySelector('.d-body')),
        pre: [...d.querySelectorAll('pre')].map((p) => p.textContent),
        hints: [...d.querySelectorAll('.hint')].map(txt),
        files: [...d.querySelectorAll('ul.files li')].map(txt),
        buttons: [...d.querySelectorAll('.d-buttons button')].map(txt),
        fields: [...d.querySelectorAll('input, textarea, select')].map((i) => ({ id: i.id.replace(/^f-/, ''), type: i.type, value: i.type === 'checkbox' ? i.checked : i.value })),
        picks: [...d.querySelectorAll('.pick-list:not([hidden]) .label')].map(txt),
        errors: [...d.querySelectorAll('.error')].map(txt).filter(Boolean)
      }
    },
    dialogCount: () => document.querySelectorAll('#dialog-root .overlay').length,
    fill(id, value) {
      const i = top().querySelector('#f-' + id)
      if (i.type === 'checkbox') i.checked = Boolean(value)
      else i.value = String(value)
      i.dispatchEvent(new Event('input', { bubbles: true }))
      i.dispatchEvent(new Event('change', { bubbles: true }))
      return true
    },
    pick(text) {
      const n = [...top().querySelectorAll('.pick-list .row')].find((r) => txt(r) === text)
      n.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))
      return true
    },
    press(label) {
      const b = [...top().querySelectorAll('.d-buttons button')].find((x) => txt(x) === label)
      if (!b) throw new Error('No button ' + label + ' in ' + JSON.stringify(t.dialog()))
      b.click()
      return true
    },
    toast() {
      const n = document.getElementById('toast')
      return n.classList.contains('show') ? n.textContent : ''
    },
    clearToast() {
      const n = document.getElementById('toast')
      n.classList.remove('show')
      n.textContent = ''
      return true
    },
    banner() {
      const b = document.getElementById('banner')
      return b.hidden ? null : { text: txt(b.querySelector('.grow')), buttons: [...b.querySelectorAll('button')].map(txt) }
    },
    clickBanner(label) {
      ;[...document.querySelectorAll('#banner button')].find((b) => txt(b) === label).click()
      return true
    },
    header: () => ({ name: txt(document.querySelector('#workspace .ws-name')), branch: txt(document.querySelector('#workspace .ws-branch')) }),
    search(q) {
      const s = document.getElementById('search')
      s.focus()
      s.value = q
      s.dispatchEvent(new Event('input', { bubbles: true }))
      return true
    }
  }
  return t
})()
`

// ---------------------------------------------------------------------------
// One panel per test

let browserPromise = null
let template = null

export function setupSuite({ before, after }) {
  before(async () => {
    template = buildTemplate()
    browserPromise = Browser.launch()
    await browserPromise
  })
  after(async () => {
    if (browserPromise) await (await browserPromise.catch(() => null))?.close()
    template?.dispose()
  })
}

/**
 * Copies the demo repo, starts a dev-server on it and opens the panel in a fresh browser context.
 * `setup(git, { repo, dir })` runs before the server starts. `orcaWorktrees({ repo, dir })` gives
 * the workspaces the fake `orca worktree list` reports.
 */
export async function openPanel(t, { theme = 'light', setup, orcaWorktrees } = {}) {
  const { dir, repo } = copyDemo(template)
  const git = gitIn(repo)
  let server
  let page
  t.after(async () => {
    await page?.close().catch(() => {})
    await server?.stop()
    safeRemove(dir)
  })
  if (setup) await setup(git, { repo, dir })
  server = await startServer(repo, dir, { orcaWorktrees: orcaWorktrees ? orcaWorktrees({ repo, dir }) : [] })
  const browser = await browserPromise
  page = await browser.newPage()
  await page.goto(server.url + (theme === 'dark' ? '?theme=dark' : ''))
  return { repo, dir, git, page, server, other: gitIn(path.join(dir, 'other')) }
}
