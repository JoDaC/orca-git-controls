// Small DOM helpers: element builder, in-panel dialogs (plugin frames disable alert/confirm), toast.

export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue
    if (k === 'class') node.className = v
    else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v)
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v)
    else if (k === 'value') node.value = v
    else if (k === 'checked') node.checked = Boolean(v)
    else node.setAttribute(k, v === true ? '' : String(v))
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue
    node.append(c instanceof Node ? c : document.createTextNode(String(c)))
  }
  return node
}

let busyCount = 0
export function setBusy(on) {
  busyCount = Math.max(0, busyCount + (on ? 1 : -1))
  const app = document.getElementById('app')
  let bar = app.querySelector('.busy-bar')
  if (busyCount && !bar) app.append(el('div', { class: 'busy-bar' }))
  if (!busyCount && bar) bar.remove()
}

let toastTimer = null
export function toast(text, { error = false, ms = 3500 } = {}) {
  const t = document.getElementById('toast')
  t.textContent = text
  t.classList.toggle('error', error)
  t.classList.add('show')
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => t.classList.remove('show'), ms)
}

/**
 * Opens a modal dialog inside the panel.
 * fields: [{ id, label, type: text|textarea|number|checkbox|select, value, options, validate, autofocus }]
 *   A text field with `options` gets a filterable pick list (branches, files).
 * buttons: [{ label, value, kind: primary|danger, submit, onClick }]
 *   `onClick` runs inside the click (for gesture-gated calls) and keeps the dialog open.
 * Resolves { button, values }; Escape resolves button 'cancel'.
 */
export function dialog({ title, body = [], fields = [], buttons = [{ label: 'OK', value: 'ok', kind: 'primary' }] }) {
  return new Promise((resolve) => {
    const root = document.getElementById('dialog-root')
    const prevFocus = document.activeElement
    const inputs = new Map()
    const errors = new Map()
    const formFields = fields.map((f) => {
      const id = `f-${f.id}`
      let input
      if (f.type === 'checkbox') {
        input = el('input', { type: 'checkbox', id, checked: f.value })
        inputs.set(f.id, input)
        return el('div', { class: 'field check' }, input, el('label', { for: id }, f.label))
      }
      if (f.type === 'select') {
        input = el('select', { id }, ...f.options.map(([v, l]) => el('option', { value: v }, l)))
        input.value = f.value ?? ''
      } else if (f.type === 'textarea') {
        input = el('textarea', { id, value: f.value ?? '' })
      } else {
        input = el('input', { type: f.type === 'number' ? 'number' : 'text', id, value: f.value ?? '', autocomplete: 'off', spellcheck: 'false' })
      }
      inputs.set(f.id, input)
      const err = el('div', { class: 'error' })
      errors.set(f.id, err)
      const parts = [el('label', { for: id }, f.label), input]
      if (f.options && f.type !== 'select') {
        const list = el('div', { class: 'pick-list' })
        const draw = () => {
          const q = input.value.toLowerCase()
          const hits = f.options.filter((o) => o.toLowerCase().includes(q)).slice(0, 60)
          list.replaceChildren(
            ...hits.map((o) =>
              el(
                'div',
                {
                  class: 'row',
                  onmousedown: (e) => {
                    e.preventDefault()
                    input.value = o
                    draw()
                    validate()
                  }
                },
                el('span', { class: 'label' }, o)
              )
            )
          )
          list.hidden = hits.length === 0 || (hits.length === 1 && hits[0] === input.value)
        }
        input.addEventListener('input', draw)
        draw()
        parts.push(list)
      }
      parts.push(err)
      return el('div', { class: 'field' }, ...parts)
    })

    const values = () => {
      const out = {}
      for (const f of fields) {
        const input = inputs.get(f.id)
        out[f.id] = f.type === 'checkbox' ? input.checked : f.type === 'number' ? Number(input.value) : input.value
      }
      return out
    }
    const validate = () => {
      let ok = true
      for (const f of fields) {
        if (!f.validate) continue
        const msg = f.validate(inputs.get(f.id).value)
        errors.get(f.id).textContent = msg || ''
        if (msg) ok = false
      }
      return ok
    }
    for (const f of fields) if (f.validate) inputs.get(f.id).addEventListener('input', () => errors.get(f.id).textContent && validate())

    const close = (button) => {
      overlay.remove()
      document.removeEventListener('keydown', onKey, true)
      prevFocus?.focus?.()
      resolve({ button, values: values() })
    }
    const press = async (b) => {
      if (b.onClick) return b.onClick()
      if (b.value !== 'cancel' && (b.submit || b.kind === 'primary') && !validate()) return
      close(b.value)
    }
    const btnNodes = buttons.map((b) => el('button', { class: `btn${b.kind ? ' ' + b.kind : ''}`, onclick: () => press(b) }, b.label))
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        close('cancel')
      } else if (e.key === 'Enter' && !(e.target instanceof HTMLTextAreaElement) && !(e.target instanceof HTMLButtonElement)) {
        const submit = buttons.find((b) => b.submit)
        if (submit) {
          e.preventDefault()
          press(submit)
        }
      } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        const submit = buttons.find((b) => b.submit)
        if (submit) {
          e.preventDefault()
          press(submit)
        }
      }
    }
    const overlay = el(
      'div',
      {
        class: 'overlay',
        onmousedown: (e) => {
          if (e.target === overlay) close('cancel')
        }
      },
      el('div', { class: 'dialog', role: 'dialog', 'aria-label': title }, el('div', { class: 'd-title' }, title), el('div', { class: 'd-body' }, ...[body].flat(), ...formFields), el('div', { class: 'd-buttons' }, ...btnNodes))
    )
    root.append(overlay)
    document.addEventListener('keydown', onKey, true)
    const auto = fields.find((f) => f.autofocus)
    const focusTarget = auto ? inputs.get(auto.id) : btnNodes[btnNodes.length - 1]
    setTimeout(() => {
      focusTarget?.focus()
      if (focusTarget?.select && auto?.type !== 'select') focusTarget.select()
    }, 0)
  })
}

export async function confirmDialog(title, text, confirmLabel = 'OK', { danger = true } = {}) {
  const r = await dialog({
    title,
    body: text ? [el('pre', {}, text)] : [],
    buttons: [
      { label: 'Cancel', value: 'cancel' },
      { label: confirmLabel, value: 'ok', kind: danger ? 'danger' : 'primary' }
    ]
  })
  return r.button === 'ok'
}

/** Shows git's error text verbatim. */
export async function errorDialog(title, message, command) {
  await dialog({
    title,
    body: [command ? el('p', { class: 'hint' }, command) : null, el('pre', {}, message || '(no output)')],
    buttons: [
      {
        label: 'Copy',
        value: 'copy',
        onClick: () => {
          const ta = el('textarea', { value: message })
          document.body.append(ta)
          ta.select()
          try {
            document.execCommand('copy')
            toast('Copied')
          } catch {}
          ta.remove()
        }
      },
      { label: 'Close', value: 'ok', kind: 'primary' }
    ]
  })
}
