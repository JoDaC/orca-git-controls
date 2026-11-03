// Preview the panel in a normal browser, outside Orca.
// Runs the real worker (worker/main.mjs) with a stand-in `orca` object against one repository,
// and serves panel/ with a mock `window.orca` that forwards plugin.request over HTTP.
//
//   node scripts/dev-server.mjs /path/to/repo [port]     (port 0 picks a free one)
//   open http://localhost:4519/?theme=dark
//
// For the end-to-end tests it also serves:
//   POST /__command  {"id": "git.newBranch"}  runs a registered palette command, as Orca would
//   GET  /__notifications                     notifications the worker has shown so far

import http from 'node:http'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const repo = path.resolve(process.argv[2] || process.cwd())
const port = Number(process.argv[3] || 4519)

const handlers = new Map()
const commands = new Map()
const notifications = []
const listeners = new Set()
const settings = {}
const storage = {}
const fakeOrca = {
  api: { major: 1, minor: 2 },
  log: (m) => console.log('[worker]', m),
  host: {
    has: () => true,
    async call(method, params = {}) {
      switch (method) {
        case 'workspace.readContext':
          return null
        case 'notifications.show':
          console.log('[notify]', params.title, params.body ?? '')
          notifications.push(params)
          return { delivered: true }
        case 'settings.get':
          return { settings }
        case 'settings.set':
          settings[params.key] = params.value
          return { ok: true }
        case 'storage.get':
          return { value: storage[params.key] ?? null }
        case 'storage.set':
          storage[params.key] = params.value
          return { ok: true }
        default:
          throw Object.assign(new Error(`not in dev host: ${method}`), { code: 'unknown_method' })
      }
    }
  },
  panels: {
    handle: (name, fn) => handlers.set(name, fn),
    post: (event, payload) => {
      for (const res of listeners) res.write(`data: ${JSON.stringify({ event, payload })}\n\n`)
    }
  },
  events: { on: () => ({ dispose() {} }) },
  commands: {
    register: (id, fn) => {
      commands.set(id, fn)
      return { dispose: () => commands.delete(id) }
    }
  }
}

const { default: activate } = await import(path.join(root, 'worker/main.mjs'))
await activate(fakeOrca)
await handlers.get('git')({ op: 'workspace.select', args: { path: repo } })

const MOCK = `
const listeners = new Map()
const es = new EventSource('/__events')
es.onmessage = (m) => { const { event, payload } = JSON.parse(m.data); (listeners.get(event) || []).forEach((f) => f(payload)) }
const dark = new URLSearchParams(location.search).get('theme') === 'dark'
document.documentElement.classList.add(dark ? 'dark' : 'light')
const vars = dark
  ? { background: '#1e1f22', foreground: '#dfe1e5', muted: '#2b2d30', 'muted-foreground': '#8c8f94', accent: '#2e436e', border: '#393b40', input: '#43454a', ring: '#3574f0', primary: '#3574f0', 'primary-foreground': '#fff', popover: '#2b2d30', 'popover-foreground': '#dfe1e5', destructive: '#e5534b' }
  : { background: '#ffffff', foreground: '#1f2328', muted: '#f2f3f5', 'muted-foreground': '#6c707e', accent: '#dbe6fd', border: '#ebecf0', input: '#c9ccd6', ring: '#3574f0', primary: '#3574f0', 'primary-foreground': '#fff', popover: '#ffffff', 'popover-foreground': '#1f2328', destructive: '#db3b4b' }
for (const [k, v] of Object.entries(vars)) document.documentElement.style.setProperty('--orca-' + k, v)
window.orca = Object.freeze({
  api: { major: 1, minor: 2 },
  host: { has: () => false, call: async () => { throw new Error('dev') } },
  on: () => ({ dispose() {} }),
  files: { saveAs: async ({ suggestedName, data }) => { (window.__savedFiles ||= []).push({ suggestedName, data }); const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([data])); a.download = suggestedName; a.click(); return { status: 'saved' } } },
  plugin: {
    async request(name, input) {
      const r = await fetch('/__req', { method: 'POST', body: JSON.stringify({ name, input }) })
      return r.json()
    },
    on(event, fn) { if (!listeners.has(event)) listeners.set(event, []); listeners.get(event).push(fn); return { dispose() {} } }
  }
})
`

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }

const server = http
  .createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://x')
      if (url.pathname === '/__events') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
        listeners.add(res)
        req.on('close', () => listeners.delete(res))
        return
      }
      if (url.pathname === '/__req') {
        let body = ''
        for await (const chunk of req) body += chunk
        const { name, input } = JSON.parse(body)
        const out = await handlers.get(name)(input, {})
        res.writeHead(200, { 'content-type': 'application/json' })
        return res.end(JSON.stringify(out))
      }
      if (url.pathname === '/__command' && req.method === 'POST') {
        let body = ''
        for await (const chunk of req) body += chunk
        const { id } = JSON.parse(body)
        const fn = commands.get(id)
        if (!fn) throw new Error(`no command ${id}`)
        const out = await fn()
        res.writeHead(200, { 'content-type': 'application/json' })
        return res.end(JSON.stringify({ result: out ?? null }))
      }
      if (url.pathname === '/__notifications') {
        res.writeHead(200, { 'content-type': 'application/json' })
        return res.end(JSON.stringify(notifications))
      }
      if (url.pathname === '/__mock.js') {
        res.writeHead(200, { 'content-type': 'text/javascript' })
        return res.end(MOCK)
      }
      const file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1)
      const full = path.join(root, 'panel', path.normalize(file))
      if (!full.startsWith(path.join(root, 'panel'))) throw new Error('outside')
      let data = await readFile(full)
      if (file === 'index.html') data = Buffer.from(String(data).replace('<script type="module"', '<script src="/__mock.js"></script>\n    <script type="module"'))
      res.writeHead(200, { 'content-type': TYPES[path.extname(full)] || 'application/octet-stream' })
      res.end(data)
    } catch (e) {
      res.writeHead(404)
      res.end(String(e.message))
    }
  })
  .listen(port, () => console.log(`Git Controls dev preview for ${repo}: http://localhost:${server.address().port}/`))
