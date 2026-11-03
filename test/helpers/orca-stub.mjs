// A stand-in `orca` CLI: records its argv and prints canned answers. Never runs the real binary.

import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import path from 'node:path'
import { fresh } from './repo.mjs'

const SCRIPT = `
const fs = require('fs')
const path = require('path')
const dir = path.dirname(process.argv[1])
const args = process.argv.slice(2)
fs.appendFileSync(path.join(dir, 'calls.jsonl'), JSON.stringify(args) + '\\n')
const responses = JSON.parse(fs.readFileSync(path.join(dir, 'responses.json'), 'utf8'))
const key = args.filter((a) => !a.startsWith('--')).slice(0, 2).join(' ')
const r = responses[key] ?? { stdout: { ok: true, result: {} } }
if (r.stdout !== undefined) process.stdout.write(typeof r.stdout === 'string' ? r.stdout : JSON.stringify(r.stdout))
if (r.stderr) process.stderr.write(r.stderr)
process.exit(r.exit ?? 0)
`

/**
 * Writes the stub and points ORCA_GIT_CONTROLS_ORCA at it.
 * Responses are keyed by the first two positional args ("worktree list", "terminal switch").
 */
export function installOrcaStub() {
  const dir = fresh('orca-stub')
  mkdirSync(dir, { recursive: true })
  const bin = path.join(dir, 'orca')
  writeFileSync(path.join(dir, 'stub.cjs'), SCRIPT)
  // A shell wrapper, so a node path with spaces cannot break a shebang line.
  writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${path.join(dir, 'stub.cjs')}" "$@"\n`, { mode: 0o755 })
  const responsesFile = path.join(dir, 'responses.json')
  const callsFile = path.join(dir, 'calls.jsonl')
  let responses = {}
  const save = () => writeFileSync(responsesFile, JSON.stringify(responses))
  save()
  process.env.ORCA_GIT_CONTROLS_ORCA = bin
  return {
    bin,
    respond(key, r) {
      responses[key] = r
      save()
    },
    ok(key, result) {
      this.respond(key, { stdout: { ok: true, result } })
    },
    reset() {
      responses = {}
      save()
      if (existsSync(callsFile)) rmSync(callsFile)
    },
    calls() {
      if (!existsSync(callsFile)) return []
      return readFileSync(callsFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
    }
  }
}
