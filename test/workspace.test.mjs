import { test } from 'node:test'
import assert from 'node:assert/strict'
import { matchWorkspace } from '../lib/workspace.mjs'

const wts = [
  { path: '/a/app', displayName: 'main', branch: 'refs/heads/main', lastActivityAt: 10 },
  { path: '/b/tool', displayName: 'main', branch: 'refs/heads/main', lastActivityAt: 20 },
  { path: '/a/app-feature', displayName: 'feature-x', branch: 'refs/heads/feature/x', lastActivityAt: 5 },
  { path: '/old', displayName: 'feature-x', branch: 'refs/heads/feature/x', isArchived: true }
]

test('no focused workspace', () => {
  assert.equal(matchWorkspace(null, wts).path, null)
})

test('terminal ids identify the workspace exactly, even when names collide', () => {
  const ctx = { branch: 'main', displayName: 'main', terminals: [{ id: 'term_1' }] }
  const terms = [
    { handle: 'term_1', worktreePath: '/a/app' },
    { handle: 'term_2', worktreePath: '/b/tool' }
  ]
  assert.deepEqual(matchWorkspace(ctx, wts, terms).path, '/a/app')
  // Orca may report the pty id instead of the handle.
  assert.equal(matchWorkspace({ ...ctx, terminals: [{ id: 'pty-9' }] }, wts, [{ handle: 'x', ptyId: 'pty-9', worktreePath: '/b/tool' }]).path, '/b/tool')
})

test('unique display name and branch', () => {
  const r = matchWorkspace({ branch: 'feature/x', displayName: 'feature-x', terminals: [] }, wts)
  assert.equal(r.path, '/a/app-feature')
  assert.equal(r.reason, 'name')
})

test('ambiguous names fall back to the most recently active, and say so', () => {
  const r = matchWorkspace({ branch: 'main', displayName: 'main', terminals: [] }, wts)
  assert.equal(r.path, '/b/tool')
  assert.equal(r.reason, 'ambiguous')
  assert.deepEqual(r.candidates, ['/b/tool', '/a/app'])
})

test('no match', () => {
  assert.equal(matchWorkspace({ branch: 'zzz', displayName: 'nope', terminals: [] }, wts).path, null)
})
