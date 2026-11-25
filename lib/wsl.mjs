// Windows + WSL support.
//
// On Windows, Orca can run workspaces inside WSL through a separate runtime (`--environment wsl`).
// Those workspaces have Linux paths such as /home/me/repo, which the plugin's Windows node and
// Windows git cannot use. Inside the plugin they are carried as UNC paths
// (\\wsl.localhost\<distro>\home\me\repo), which node's fs can read, and git for them runs inside
// the distro through wsl.exe.

import { execFile } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'

const UNC = /^[\\/]{2}wsl(?:\.localhost|\$)[\\/]([^\\/]+)(?:[\\/](.*))?$/i

/** { distro, linuxPath } for a \\wsl.localhost\<distro>\... or \\wsl$\<distro>\... path, else null. */
export function parseWslPath(p) {
  if (typeof p !== 'string') return null
  const m = UNC.exec(p)
  if (!m) return null
  const rest = (m[2] || '').replace(/\\/g, '/').replace(/\/+$/, '')
  return { distro: m[1], linuxPath: path.posix.normalize('/' + rest) }
}

/** The UNC path Windows uses for `linuxPath` inside `distro`. */
export function toWslPath(distro, linuxPath) {
  const p = path.posix.normalize(linuxPath).replace(/\/+$/, '')
  return `\\\\wsl.localhost\\${distro}${p.replace(/\//g, '\\')}`
}

/**
 * A path git printed (Linux style) turned into one the Windows side can use, given the
 * repository path `cwd` it ran in. Paths outside WSL come back unchanged.
 */
export function fromWslGitPath(cwd, p) {
  const wsl = parseWslPath(cwd)
  if (!wsl || typeof p !== 'string' || !p.startsWith('/')) return p
  return toWslPath(wsl.distro, p)
}

/** wsl.exe arguments that run `command args` in `linuxCwd` inside `distro`, with `env` set. */
export function wslCommandArgs(distro, linuxCwd, command, args, env = {}) {
  const vars = Object.entries(env)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${k}=${v}`)
  return ['-d', distro, '--cd', linuxCwd, '--exec', 'env', ...vars, command, ...args]
}

/**
 * `env` with the per-user Windows variables filled in when missing. Orca starts plugin workers
 * with a trimmed environment; without APPDATA the orca CLI cannot find its runtime, and git and
 * wsl.exe expect USERPROFILE and SystemRoot. Off Windows `env` is returned unchanged.
 */
export function windowsEnv(env = process.env, platform = process.platform) {
  if (platform !== 'win32') return env
  // Windows variable names are case-insensitive.
  const get = (name) => {
    const key = Object.keys(env).find((k) => k.toUpperCase() === name.toUpperCase())
    return key ? env[key] : undefined
  }
  const home = get('USERPROFILE') || os.homedir()
  const fill = {
    USERPROFILE: home,
    APPDATA: path.win32.join(home, 'AppData', 'Roaming'),
    LOCALAPPDATA: path.win32.join(home, 'AppData', 'Local'),
    SystemRoot: get('windir') || 'C:\\Windows'
  }
  const out = { ...env }
  for (const [k, v] of Object.entries(fill)) if (!get(k)) out[k] = v
  return out
}

export function wslBinary() {
  return process.env.ORCA_GIT_CONTROLS_WSL || 'wsl.exe'
}

/**
 * True for wsl.exe's own UTF-16LE text: a BOM, or lines ending in UTF-16 "\n" whose first
 * characters are ASCII. NUL-separated git output (-z) does not end that way.
 */
export function looksUtf16(buf) {
  if (!buf || buf.length < 2 || buf.length % 2) return false
  if (buf[0] === 0xff && buf[1] === 0xfe) return true
  if (buf[buf.length - 2] !== 0x0a || buf[buf.length - 1] !== 0) return false
  const n = Math.min(buf.length, 32)
  for (let i = 0; i < n; i += 2) if (buf[i] === 0 || buf[i + 1] !== 0) return false
  return true
}

/** wsl.exe prints its own messages in UTF-16LE; what runs inside the distro prints UTF-8. */
export function decodeWslOutput(buf) {
  if (!buf || !buf.length) return ''
  if (looksUtf16(buf)) return buf.toString('utf16le').replace(/^\uFEFF/, '')
  return buf.toString('utf8')
}

function runWsl(args, timeoutMs = 15_000) {
  return new Promise((resolve) => {
    execFile(wslBinary(), args, { timeout: timeoutMs, encoding: 'buffer', windowsHide: true, env: windowsEnv() }, (error, stdout, stderr) => {
      resolve({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, stdout: decodeWslOutput(stdout), stderr: decodeWslOutput(stderr) })
    })
  })
}

/** Parses `wsl.exe -l -q`: one distro name per line. */
export function parseDistroList(text) {
  return text
    .split(/\r?\n/)
    .map((l) => l.replace(/\0/g, '').trim())
    .filter((l) => l && !/^docker-desktop/i.test(l))
}

// One probe per distro: does it run an Orca server, and do the sample paths exist there?
// "[o]rca" so the pattern does not match this probe's own command line.
export const PROBE = 'n=0; (pgrep -f "[o]rca.* serve" >/dev/null 2>&1 || ps -eo args 2>/dev/null | grep -q "[o]rca.* serve") && echo ORCA; for p in "$@"; do [ -e "$p" ] && n=$((n+1)); done; echo "paths $n"'

/** Scores a probe answer: an Orca server counts more than paths that exist. */
export function scoreProbe(text) {
  const paths = Number(/paths (\d+)/.exec(text)?.[1] || 0)
  return (/^ORCA$/m.test(text) ? 100 : 0) + paths
}

const distroCache = new Map()

/**
 * The WSL distro an Orca environment runs in. Orca does not say, so this checks the running
 * distros for an Orca server and for the workspace paths it reported.
 * ORCA_GIT_CONTROLS_WSL_DISTRO overrides it. Returns null when no distro fits.
 */
export async function resolveDistro(key, samplePaths = [], { run = runWsl } = {}) {
  if (process.env.ORCA_GIT_CONTROLS_WSL_DISTRO) return process.env.ORCA_GIT_CONTROLS_WSL_DISTRO
  if (distroCache.has(key)) return distroCache.get(key)
  const list = await run(['-l', '-q', '--running'])
  if (list.code !== 0) return null
  const distros = parseDistroList(list.stdout)
  const sample = samplePaths.filter((p) => typeof p === 'string' && p.startsWith('/')).slice(0, 5)
  const answers = await Promise.all(distros.map((distro) => run(['-d', distro, '--exec', 'sh', '-c', PROBE, 'probe', ...sample])))
  let best = null
  let bestScore = 0
  // Ties go to the earlier distro in wsl.exe's list.
  answers.forEach((res, i) => {
    const score = res.code === 0 ? scoreProbe(res.stdout) : 0
    if (score > bestScore) {
      best = distros[i]
      bestScore = score
    }
  })
  if (best) distroCache.set(key, best)
  return best
}

export function clearDistroCache() {
  distroCache.clear()
}
