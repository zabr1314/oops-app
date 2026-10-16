import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';

const source = readFileSync(new URL('../src/Prototype.tsx', import.meta.url), 'utf8');
const logic = source.slice(source.indexOf('type NativeScopeState ='), source.indexOf('export default function Prototype'));
const { nativeScopeTransition } = await import('data:text/javascript;base64,' + Buffer.from(stripTypeScriptTypes(logic, { mode: 'strip' })).toString('base64'));

test('the first verified scope preserves a return deep link despite earlier unknown versions', () => {
  let state = { established: false };
  for (const version of [0, 1]) {
    const transition = nativeScopeTransition(state, undefined, version);
    assert.equal(transition.clear, false);
    assert.equal(transition.resetRoute, false);
    state = transition.next;
  }
  const established = nativeScopeTransition(state, 'account-a@service', 1);
  assert.equal(established.restore, true);
  assert.equal(established.clear, true);
  assert.equal(established.resetRoute, false);
});

test('revocation to an unavailable scope clears account drafts immediately and cannot restore them', () => {
  const established = nativeScopeTransition({ established: false }, 'account-a@service', 2);
  const revoked = nativeScopeTransition(established.next, undefined, 3);
  assert.equal(revoked.clear, true);
  assert.equal(revoked.resetRoute, true);
  assert.equal(revoked.restore, false);
  const waiting = nativeScopeTransition(revoked.next, undefined, 3);
  assert.equal(waiting.restore, false);
  assert.equal(waiting.clear, false);
  const other = nativeScopeTransition(waiting.next, 'account-b@service', 3);
  assert.equal(other.clear, true);
  assert.equal(other.resetRoute, true);
});

test('credential and service generations invalidate forms even if the persistent account key stays stable', () => {
  const state = nativeScopeTransition({ established: false }, 'account-a@service', 5).next;
  const unchanged = nativeScopeTransition(state, 'account-a@service', 5);
  assert.equal(unchanged.clear, false);
  const reauthorized = nativeScopeTransition(state, 'account-a@service', 6);
  assert.equal(reauthorized.clear, true);
  assert.equal(reauthorized.resetRoute, true);
  assert.equal(reauthorized.restore, true);
  const switched = nativeScopeTransition(reauthorized.next, 'account-a@other-service', 7);
  assert.equal(switched.clear, true);
  assert.equal(switched.resetRoute, true);
});
