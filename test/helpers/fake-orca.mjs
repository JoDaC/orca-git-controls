// A stand-in for the `orca` object Orca hands the worker (same shape as scripts/dev-server.mjs).

export function fakeOrca({ context = null, settings = {}, storage = {}, failing = [], panels = true } = {}) {
  const handlers = new Map()
  const listeners = new Map()
  const commands = new Map()
  const posts = []
  const notes = []
  const logs = []
  const fail = new Set(failing)
  const state = { context }

  const orca = {
    api: { major: 1, minor: 2 },
    log: (m) => logs.push(m),
    host: {
      has: () => true,
      async call(method, params = {}) {
        if (fail.has(method)) throw new Error(`${method} unavailable`)
        switch (method) {
          case 'workspace.readContext':
            return state.context
          case 'notifications.show':
            notes.push(params)
            return { delivered: true }
          case 'settings.get':
            return { settings: { ...settings } }
          case 'settings.set':
            settings[params.key] = params.value
            return { ok: true }
          case 'storage.get':
            return { value: storage[params.key] ?? null }
          case 'storage.set':
            storage[params.key] = params.value
            return { ok: true }
          default:
            throw new Error(`unknown host method ${method}`)
        }
      }
    },
    panels: panels
      ? {
          handle: (name, fn) => handlers.set(name, fn),
          post: (event, payload) => {
            if (fail.has('panels.post')) throw new Error('panel gone')
            posts.push({ event, payload, at: Date.now() })
          }
        }
      : {},
    events: {
      on: (event, fn) => {
        listeners.set(event, fn)
        return { dispose() {} }
      }
    },
    commands: {
      register: (id, fn) => {
        commands.set(id, fn)
        return { dispose() {} }
      }
    }
  }

  return {
    orca,
    state,
    settings,
    storage,
    handlers,
    commands,
    posts,
    notes,
    logs,
    fail,
    git: (op, args) => handlers.get('git')({ op, args }),
    emit: (event, payload) => listeners.get(event)(payload),
    run: (id) => commands.get(id)(),
    postsOf: (event) => posts.filter((p) => p.event === event),
    clear() {
      posts.length = 0
      notes.length = 0
      logs.length = 0
    }
  }
}
