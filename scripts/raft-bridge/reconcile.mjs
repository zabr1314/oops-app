#!/usr/bin/env node
import { createRaft } from '@botiverse/raft-sdk';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { UUID, BridgeError, fail, readConfig, verifyIdentity, createBackend, acquireLock, atomicJson, digest } from './bridge.mjs';
import { GroupError, inspectGroup, parseGroupDestination, groupSendTarget, verifyGroupSend, resolveStoredMessage } from './group-state.mjs';

const JOB_ID = /^[a-f0-9]{32}$/;
function output(value) { process.stdout.write(`${JSON.stringify(value)}\n`); }
function readonlyFetch(config) {
  return async (input, options = {}) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    const method = (options.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
    if (url.origin !== new URL(config.serverUrl).origin || !['GET', 'HEAD'].includes(method)) fail('RECONCILE_RAFT_WRITE_REJECTED');
    return fetch(input, { ...options, redirect: 'error', signal: AbortSignal.timeout(30000) });
  };
}
async function journalAt(filename) {
  const stat = await fs.lstat(filename);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) fail('RECONCILE_JOURNAL_NOT_PRIVATE');
  const journal = JSON.parse(await fs.readFile(filename, 'utf8'));
  if (journal.schema !== 'oops-raft-journal.v1' || !journal.jobs || typeof journal.jobs !== 'object') fail('RECONCILE_JOURNAL_INVALID');
  return journal;
}
function entryFor(journal, jobId) {
  const entry = journal.jobs[jobId];
  if (!entry || entry.id !== jobId || !JOB_ID.test(entry.lease ?? '') || entry.idempotency_key !== `oopsy-${jobId}` || !UUID.test(entry.result?.raft_message_id ?? '')) fail('RECONCILE_KNOWN_RECEIPT_REQUIRED');
  if (!['unknown', 'sent'].includes(entry.result.status)) fail('RECONCILE_ENTRY_NOT_UNKNOWN_OR_SENT');
  return entry;
}
async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help')) { output({ usage: 'node reconcile.mjs --config /private/config.json --job OOPS_JOB_ID --check|--apply', raft_network_writes: 0, apply: 'Verified known Raft ID → original lease settlement only; stop the worker before --apply.' }); return; }
  let filename = process.env.OOPS_RAFT_CONFIG ?? path.join(os.homedir(), '.config/oops/raft-bridge.json');
  let jobId, apply = false, check = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--config' && args[i + 1]) filename = args[++i];
    else if (args[i] === '--job' && args[i + 1]) jobId = args[++i];
    else if (args[i] === '--apply') apply = true;
    else if (args[i] === '--check') check = true;
    else fail('RECONCILE_ARGUMENT_INVALID');
  }
  if (!JOB_ID.test(jobId ?? '') || apply === check) fail('RECONCILE_EXPLICIT_JOB_AND_MODE_REQUIRED');
  const config = await readConfig(path.resolve(filename));
  const journalFile = path.join(config.stateDir, 'journal.json');
  const journal = await journalAt(journalFile);
  const entry = entryFor(journal, jobId);
  const backend = createBackend(config);
  const listing = await backend('/v1/raft/worker/messages?limit=100');
  if (!Array.isArray(listing.items)) fail('RECONCILE_BACKEND_LIST_INVALID');
  const jobs = listing.items.filter(job => job.id === jobId);
  if (jobs.length !== 1) fail('RECONCILE_JOB_NOT_IN_BOUNDED_LIST');
  const job = jobs[0];
  if (digest(job) !== entry.digest || job.raft_message_id !== entry.result.raft_message_id || !['unknown', 'sent'].includes(job.status)) fail('RECONCILE_BACKEND_MAPPING_MISMATCH');
  const destination = parseGroupDestination(job.target);
  if (!destination) fail('RECONCILE_GROUP_RECEIPT_REQUIRED');
  const raft = createRaft({ serverUrl: config.serverUrl, credential: config.raftCredential, fetch: readonlyFetch(config), retry: { attempts: 1 } });
  const identity = await verifyIdentity(raft, config);
  const group = await inspectGroup(raft, config, identity);
  const expected = await groupSendTarget(raft, destination, group);
  const stored = await resolveStoredMessage(raft, job.raft_message_id);
  // The same stored message must contain the original immutable job text.
  // This data is compared in memory and never printed or copied to the journal.
  if (stored.content !== job.text) fail('RECONCILE_STORED_TEXT_MISMATCH');
  const candidate = { status: 'sent', raft_message_id: job.raft_message_id, response: { provider: 'raft', target: expected.target, sender_id: identity.agent_id, ...(Number.isInteger(stored.seq) ? { message_seq: stored.seq } : {}) } };
  const verified = await verifyGroupSend(raft, candidate, expected, group, identity.agent_id);
  const summary = { ok: true, job_id: jobId, raft_message_id: verified.raft_message_id, channel_id: verified.response.channel_id, sender_id: verified.response.sender_id, actual_thread_id: stored.thread?.id ?? null, already_sent: job.status === 'sent', raft_network_writes: 0 };
  if (check) { output({ ...summary, readonly: true, can_settle_original_lease: job.status === 'unknown' }); return; }
  if (job.status === 'sent') { output({ ...summary, applied: false }); return; }
  const release = await acquireLock(config.stateDir);
  try {
    const current = await journalAt(journalFile);
    const currentEntry = entryFor(current, jobId);
    if (currentEntry.digest !== entry.digest || currentEntry.lease !== entry.lease || currentEntry.result.raft_message_id !== verified.raft_message_id) fail('RECONCILE_JOURNAL_CHANGED');
    // Persist the definite receipt first. If DB settlement loses its response,
    // the normal worker recovers this receipt without another Raft send.
    currentEntry.result = verified;
    currentEntry.reported = false;
    currentEntry.reconciled_at = new Date().toISOString();
    await atomicJson(journalFile, current);
    const settled = await backend(`/v1/raft/worker/jobs/${jobId}/settle`, { lease: currentEntry.lease, ...verified });
    if (settled.id !== jobId || settled.status !== 'sent' || settled.raft_message_id !== verified.raft_message_id) fail('RECONCILE_DB_RECEIPT_NOT_CONFIRMED');
    currentEntry.reported = true;
    await atomicJson(journalFile, current);
    output({ ...summary, applied: true, status: 'sent', original_lease_used: true });
  } finally { await release(); }
}
main().catch(error => { process.stderr.write(`${JSON.stringify({ ok: false, code: error instanceof BridgeError || error instanceof GroupError ? error.code : 'RECONCILE_FAILED' })}\n`); process.exitCode = 1; });
