#!/usr/bin/env node
import { createRaft } from '@botiverse/raft-sdk';
import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { GroupError, inspectGroup, parseGroupDestination, groupSendTarget, verifyGroupSend, resolveStoredMessage, messageChannelId, messageSenderId } from './group-state.mjs';

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OOPS_ID = /^[a-f0-9]{32}$/;
const ROOT_TARGET = /^(?:#[^\s:]+|dm:@[^\s:]+)$/;
const SAFE_REJECTIONS = new Set(['INVALID_REQUEST', 'CAPABILITY_NOT_AUTHORIZED', 'SCOPE_DENIED', 'NOT_FOUND', 'CONFLICT', 'IDEMPOTENCY_KEY_REUSED', 'UNSUPPORTED_FOR_EXTERNAL_AGENTS', 'MODEL_ONLY']);

export class BridgeError extends Error {
  constructor(code, status) { super(code); this.code = code; this.status = status; }
}
export function fail(code) { throw new BridgeError(code); }
function log(event, details = {}) { process.stdout.write(`${JSON.stringify({ event, ...details })}\n`); }
function errorCode(error) { return error instanceof BridgeError || error instanceof GroupError ? error.code : 'BRIDGE_OPERATION_FAILED'; }
function endpoint(value, field) {
  let url;
  try { url = new URL(value); } catch { fail(`${field}_URL_INVALID`); }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash || (url.protocol !== 'https:' && !(local && url.protocol === 'http:'))) fail(`${field}_URL_UNSAFE`);
  return url.toString().replace(/\/$/, '');
}
export async function readConfig(filename) {
  let stat, value;
  try { stat = await fs.lstat(filename); } catch { fail('CONFIG_NOT_FOUND'); }
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) fail('CONFIG_REQUIRES_PRIVATE_REGULAR_FILE');
  try { value = JSON.parse(await fs.readFile(filename, 'utf8')); } catch { fail('CONFIG_INVALID_JSON'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('CONFIG_INVALID');
  if (typeof value.workerToken !== 'string' || !value.workerToken.trim()) fail('BACKEND_WORKER_TOKEN_MISSING');
  if (typeof value.raftCredential !== 'string' || !value.raftCredential.startsWith('sk_agent_')) fail('RAFT_EXTERNAL_AGENT_CREDENTIAL_MISSING');
  if (!UUID.test(value.raftAgentId ?? '') || !UUID.test(value.raftServerId ?? '')) fail('RAFT_EXPECTED_IDENTITY_MISSING');
  const pollIntervalMs = value.pollIntervalMs ?? 10000;
  if (!Number.isInteger(pollIntervalMs) || pollIntervalMs < 1000 || pollIntervalMs > 60000) fail('POLL_INTERVAL_INVALID');
  const worker = value.worker ?? `oops-raft-${os.hostname()}`;
  if (typeof worker !== 'string' || !worker.trim() || worker.length > 100) fail('WORKER_NAME_INVALID');
  return {
    ...value, server: endpoint(value.server ?? value.backendUrl, 'BACKEND'),
    serverUrl: endpoint(value.serverUrl ?? 'https://api.raft.build', 'RAFT'), worker, pollIntervalMs,
    stateDir: path.resolve(value.stateDir ?? path.join(os.homedir(), '.local/share/oops-raft-bridge'), 'bridge'),
  };
}

export function createBackend(config) {
  return async (route, body) => {
    let response;
    try {
      response = await fetch(`${config.server}${route}`, {
        method: body === undefined ? 'GET' : 'POST', redirect: 'error',
        headers: { Authorization: `Bearer ${config.workerToken}`, Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(30000),
      });
    } catch { fail('BACKEND_REQUEST_UNKNOWN'); }
    if (!response.ok) throw new BridgeError(`BACKEND_HTTP_${response.status}`, response.status);
    let result;
    try {
      const raw = await response.text();
      if (raw.length > 1024 * 1024) fail('BACKEND_RESPONSE_TOO_LARGE');
      result = JSON.parse(raw);
    } catch (error) { if (error instanceof BridgeError) throw error; fail('BACKEND_RESPONSE_INVALID'); }
    if (!result || typeof result !== 'object') fail('BACKEND_RESPONSE_INVALID');
    return result;
  };
}

function createRaftFetch(config) {
  const attemptedKeys = new Set();
  const expectedOrigin = new URL(config.serverUrl).origin;
  return async (input, options = {}) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    if (url.origin !== expectedOrigin) fail('RAFT_REQUEST_ORIGIN_REJECTED');
    const method = (options.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
    if (!['GET', 'HEAD'].includes(method)) {
      if (method !== 'POST' || !url.pathname.endsWith('/internal/agent-api/v2/send')) fail('RAFT_WRITE_NOT_ALLOWED');
      let key;
      try { key = JSON.parse(options.body).idempotencyKey; } catch { fail('RAFT_SEND_KEY_MISSING'); }
      if (typeof key !== 'string' || !key.startsWith('oopsy-')) fail('RAFT_SEND_KEY_MISSING');
      // messages.send in SDK 0.18.0 retries transport errors internally. A
      // second request is blocked locally: unknown delivery is never re-sent.
      if (attemptedKeys.has(key)) fail('RAFT_AUTOMATIC_RETRY_BLOCKED');
      attemptedKeys.add(key);
    }
    return fetch(input, { ...options, redirect: 'error', signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000) });
  };
}

export async function verifyIdentity(raft, config) {
  const identity = await raft.identity.whoami();
  if (!identity.ok) fail(`RAFT_IDENTITY_${identity.error.code}`);
  const { agent, server, capabilities } = identity.data;
  if (!agent.external || agent.id !== config.raftAgentId || server.id !== config.raftServerId) fail('RAFT_IDENTITY_MISMATCH');
  if (!['send', 'read'].every(scope => capabilities.includes(scope))) fail('RAFT_CREDENTIAL_SCOPES_MISSING');
  return { agent_id: agent.id, agent_handle: agent.name, agent_name: agent.displayName ?? agent.name, server_id: server.id, server_slug: server.slug, capabilities };
}

export async function prepareState(directory) {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail('STATE_DIRECTORY_INVALID');
  await fs.chmod(directory, 0o700);
}
export async function atomicJson(filename, value) {
  const tmp = `${filename}.${process.pid}.${randomUUID()}.tmp`;
  const file = await fs.open(tmp, 'wx', 0o600);
  try { await file.writeFile(JSON.stringify(value)); await file.sync(); } finally { await file.close(); }
  await fs.rename(tmp, filename);
  const directory = await fs.open(path.dirname(filename), 'r');
  try { await directory.sync(); } finally { await directory.close(); }
}
export async function acquireLock(directory) {
  const filename = path.join(directory, 'worker.lock');
  try {
    const old = JSON.parse(await fs.readFile(filename, 'utf8'));
    if (!Number.isInteger(old.pid) || old.pid < 1) fail('WORKER_LOCK_INVALID');
    let running = true;
    try { process.kill(old.pid, 0); } catch (error) { if (error.code === 'ESRCH') running = false; }
    if (running) fail('WORKER_ALREADY_RUNNING');
    // Do not race another process while automatically deleting a stale lock.
    // A stopped PID can be checked and its stale lock removed by the operator.
    fail('WORKER_LOCK_STALE_REMOVE_AFTER_PID_CHECK');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  let handle;
  try { handle = await fs.open(filename, 'wx', 0o600); } catch { fail('WORKER_ALREADY_RUNNING'); }
  await handle.writeFile(JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() }));
  await handle.sync();
  return async () => { await handle.close(); await fs.unlink(filename); };
}
async function loadJournal(filename) {
  let value;
  try { value = JSON.parse(await fs.readFile(filename, 'utf8')); } catch (error) {
    if (error.code === 'ENOENT') return { schema: 'oops-raft-journal.v1', jobs: {} };
    fail('JOURNAL_UNREADABLE');
  }
  if (value?.schema !== 'oops-raft-journal.v1' || !value.jobs || typeof value.jobs !== 'object' || Array.isArray(value.jobs)) fail('JOURNAL_INVALID');
  return value;
}
export function digest(job) { return createHash('sha256').update(JSON.stringify([job.target, job.text, job.kind, job.request_id])).digest('hex'); }
function validJob(job) {
  return job && OOPS_ID.test(job.id ?? '') && OOPS_ID.test(job.lease ?? '') && typeof job.request_id === 'string'
    && ['message', 'instruction'].includes(job.kind) && (Boolean(parseGroupDestination(job.target)) || (ROOT_TARGET.test(job.target ?? '') && job.target.startsWith('dm:@')))
    && typeof job.text === 'string' && job.text.trim() && job.text.length <= 12000;
}
function resultFromOutcome(outcome, target, agentId) {
  if (outcome?.ok && outcome.state === 'interrupted') return { status: 'failed', error: 'RAFT_SEND_INTERRUPTED_REVIEW_REQUIRED' };
  if (outcome?.ok && outcome.state === 'sent' && UUID.test(outcome.data?.messageId ?? '')) {
    return {
      status: 'sent', raft_message_id: outcome.data.messageId,
      response: { provider: 'raft', target, sender_id: agentId, ...(Number.isInteger(outcome.data.messageSeq) ? { message_seq: outcome.data.messageSeq } : {}) },
    };
  }
  const code = outcome?.error?.code;
  const definite = SAFE_REJECTIONS.has(code) || (code === 'HTTP_ERROR' && outcome.error.status >= 400 && outcome.error.status < 500 && ![408, 425, 429].includes(outcome.error.status));
  return { status: definite ? 'failed' : 'unknown', error: code ? `RAFT_${code}` : 'RAFT_RECEIPT_MISSING' };
}

async function runWorker(config, raft, backend, identity, once) {
  await prepareState(config.stateDir);
  const release = await acquireLock(config.stateDir);
  const journalFile = path.join(config.stateDir, 'journal.json');
  let stopped = false;
  const stop = () => { stopped = true; };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  try {
    const journal = await loadJournal(journalFile);
    const save = () => atomicJson(journalFile, journal);
    let currentGroup = null;
    async function refreshGroup() {
      currentGroup = null;
      try {
        const group = await inspectGroup(raft, config, identity);
        const confirmation = await backend('/v1/raft/worker/group', { group });
        if (confirmation.group_status !== 'available' || confirmation.group?.id !== group.id || confirmation.group?.server_id !== group.server_id) fail('GROUP_BACKEND_CONFIRMATION_MISSING');
        currentGroup = group;
        return group;
      } catch (error) {
        // Publish invalidity immediately. Cached group membership never
        // authorizes a new message or follow-up after this check fails.
        await backend('/v1/raft/worker/group', { error_code: errorCode(error) });
        throw error;
      }
    }
    async function settle(entry) {
      await backend(`/v1/raft/worker/jobs/${encodeURIComponent(entry.id)}/settle`, { lease: entry.lease, ...entry.result });
      entry.reported = true; await save();
      log('settled', { job_id: entry.id, status: entry.result.status });
    }
    async function recover() {
      for (const entry of Object.values(journal.jobs)) {
        if (entry.reported) continue;
        if (!entry.result) {
          entry.result = { status: 'unknown', error: 'BRIDGE_RESTARTED_DURING_SEND' };
          await save();
        }
        await settle(entry);
      }
    }
    async function sendOne() {
      const { job } = await backend('/v1/raft/worker/poll', { worker: config.worker });
      if (!job) return;
      if (!OOPS_ID.test(job.id ?? '') || !OOPS_ID.test(job.lease ?? '')) fail('BACKEND_JOB_IDENTITY_INVALID');
      const previous = journal.jobs[job.id];
      if (previous) {
        const result = previous.digest === digest(job) && previous.result ? previous.result : { status: 'unknown', error: 'JOB_ALREADY_ATTEMPTED_OR_CHANGED' };
        await backend(`/v1/raft/worker/jobs/${encodeURIComponent(job.id)}/settle`, { lease: job.lease, ...result });
        log('duplicate_job_not_sent', { job_id: job.id }); return;
      }
      const entry = { id: job.id, lease: job.lease, idempotency_key: `oopsy-${job.id}`, digest: digest(job), started_at: new Date().toISOString(), reported: false };
      journal.jobs[job.id] = entry;
      if (!validJob(job)) {
        entry.result = { status: 'failed', error: 'BACKEND_JOB_PAYLOAD_INVALID' };
        await save(); await settle(entry); return;
      }
      let expected, group;
      const destination = parseGroupDestination(job.target);
      try {
        if (destination) {
          group = await refreshGroup();
          expected = await groupSendTarget(raft, destination, group);
        } else {
          // Legacy explicitly approved DM jobs stay on their own route. A
          // null group destination never reaches groupSendTarget.
          expected = { target: job.target, legacyDm: true };
        }
        // The backend checks the frozen job, lease, live group mapping,
        // selected members, and source authorization before any Raft write.
        const validation = await backend(`/v1/raft/worker/jobs/${encodeURIComponent(job.id)}/validate`, { lease: job.lease });
        if (validation.valid !== true || validation.id !== job.id) fail('BACKEND_JOB_VALIDATION_RECEIPT_INVALID');
      } catch (error) {
        entry.result = { status: 'failed', error: `BEFORE_SEND_${errorCode(error)}` };
        await save(); await settle(entry); return;
      }
      // Persist the attempt before the only network send. The journal stores
      // a digest and receipt, never message text or credentials.
      await save();
      try {
        const outcome = await raft.messages.send({ target: expected.target, content: job.text, idempotencyKey: entry.idempotency_key });
        const receipt = resultFromOutcome(outcome, expected.target, config.raftAgentId);
        if (receipt.status === 'sent') {
          // A known message ID is still provisional until the actual group
          // or thread channel ID is resolved and compared to the bound ID.
          entry.result = { ...receipt, status: 'unknown', error: 'RAFT_CHANNEL_RECEIPT_NOT_CHECKED' };
          await save();
          try {
            if (destination) entry.result = await verifyGroupSend(raft, receipt, expected, group, config.raftAgentId);
            else {
              const resolved = await resolveStoredMessage(raft, receipt.raft_message_id);
              const canonicalDm = job.target.replace(/~(?:agent|human)$/, '');
              if (resolved.id !== receipt.raft_message_id || resolved.target !== canonicalDm
                  || messageSenderId(resolved) !== config.raftAgentId || !UUID.test(messageChannelId(resolved) ?? '')) fail('DM_SENT_RECEIPT_MISMATCH');
              entry.result = { ...receipt, response: { ...receipt.response, target: canonicalDm, channel_id: messageChannelId(resolved) } };
            }
          }
          catch (error) {
            entry.result = { ...receipt, status: 'unknown', error: errorCode(error) };
            if (destination) {
              currentGroup = null;
              await backend('/v1/raft/worker/group', { error_code: errorCode(error) });
            }
          }
        } else entry.result = receipt;
      } catch { entry.result = { ...entry.result, status: 'unknown', error: 'RAFT_SEND_RECEIPT_UNKNOWN' }; }
      await save(); await settle(entry);
    }
    async function collectReplies() {
      const listing = await backend('/v1/raft/worker/messages?status=sent&limit=30');
      if (!Array.isArray(listing.items)) fail('BACKEND_SENT_LIST_INVALID');
      const readRoots = new Set();
      for (const job of listing.items) {
        if (stopped || !UUID.test(job.raft_message_id ?? '')) continue;
        const destination = parseGroupDestination(job.target);
        const sourceId = destination?.kind === 'thread' ? destination.rootMessageId : job.raft_message_id;
        if (readRoots.has(sourceId)) continue;
        readRoots.add(sourceId);
        if (destination && (!currentGroup || destination.channelId !== currentGroup.id)) continue;
        let root;
        try { root = await resolveStoredMessage(raft, sourceId); }
        catch { log('reply_source_unavailable', { job_id: job.id }); continue; }
        // Full source UUID plus its explicit thread UUID bind this narrow
        // read. No inbox, DM root history, or arbitrary thread is imported.
        if (root.id !== sourceId || !UUID.test(root.thread?.id ?? '') || !ROOT_TARGET.test(root.target)) continue;
        if (destination && (messageChannelId(root) !== currentGroup.id || root.target !== `#${currentGroup.name}`)) continue;
        if (!destination && (root.target !== job.target.replace(/~(?:agent|human)$/, '') || messageSenderId(root) !== config.raftAgentId)) continue;
        const threadId = root.thread.id;
        const expectedTarget = `${root.target}:${root.id.slice(0, 8)}`;
        const history = await raft.messages.read({ target: expectedTarget, limit: 50, consume: false });
        if (!history.ok || history.data.target !== expectedTarget) { log('reply_thread_unavailable', { job_id: job.id }); continue; }
        const existing = new Set((job.replies ?? []).map(reply => reply.reply_id));
        for (const message of history.data.messages) {
          const rawChannelId = messageChannelId(message);
          let senderId = messageSenderId(message);
          if (!UUID.test(message.id ?? '') || existing.has(message.id) || message.id === root.id || rawChannelId !== threadId || message.target !== expectedTarget
              || !['human', 'agent'].includes(message.sender.type) || typeof message.content !== 'string' || !message.content.trim()) continue;
          if (!UUID.test(senderId ?? '')) {
            if (!message.sender.name) continue;
            const profile = await raft.profile.show({ target: `@${message.sender.name}` });
            if (!profile.ok || profile.data.kind !== message.sender.type || profile.data.name !== message.sender.name || !UUID.test(profile.data.id ?? '')) continue;
            senderId = profile.data.id;
          }
          if (message.sender.type === 'agent' && senderId === config.raftAgentId) continue;
          if (destination && !currentGroup.members.some(member => member.type === message.sender.type && member.id === senderId)) continue;
          if (message.content.length > 12000) { log('reply_too_large', { job_id: job.id }); continue; }
          await backend('/v1/raft/worker/replies', {
            source_message_id: root.id, reply_id: message.id, text: message.content,
            sender_id: senderId, sender_type: message.sender.type,
            ...(message.sender.name ? { sender: message.sender.name } : {}),
            ...(typeof message.timestamp === 'string' ? { created_at: message.timestamp } : {}),
          });
          log('reply_collected', { job_id: job.id, reply_id: message.id });
        }
        if (history.data.hasOlder || history.data.hasNewer) log('reply_window_bounded', { job_id: job.id, limit: 50 });
      }
    }
    do {
      try { if (config.collaborationGroup) await refreshGroup(); await recover(); if (!stopped) await sendOne(); if (!stopped) await collectReplies(); }
      catch (error) { log('cycle_failed', { code: errorCode(error) }); if (once) throw error; }
      if (once || stopped) break;
      await delay(config.pollIntervalMs);
    } while (!stopped);
  } finally {
    process.off('SIGINT', stop); process.off('SIGTERM', stop);
    await release();
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help')) {
    process.stdout.write('Usage: node bridge.mjs [--config /private/path/config.json] [--check | --once]\n--check verifies configured identities and backend availability without claiming or sending.\n--once claims at most one queued message, then reads only replies to sent messages.\n'); return;
  }
  let filename = process.env.OOPS_RAFT_CONFIG ?? path.join(os.homedir(), '.config/oops/raft-bridge.json');
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--config' && args[i + 1]) filename = args[++i];
    else if (!['--check', '--once'].includes(args[i])) fail('ARGUMENT_INVALID');
  }
  if (args.includes('--check') && args.includes('--once')) fail('ARGUMENT_MODE_CONFLICT');
  const config = await readConfig(path.resolve(filename));
  const backend = createBackend(config);
  const raft = createRaft({ serverUrl: config.serverUrl, credential: config.raftCredential, fetch: createRaftFetch(config), retry: { attempts: 1 }, conversationCards: false });
  const identity = await verifyIdentity(raft, config);
  const backendStatus = await backend('/v1/raft/worker/status');
  if (backendStatus.enabled !== true) fail('BACKEND_RAFT_DISABLED');
  if (args.includes('--check')) {
    const group = config.collaborationGroup ? await inspectGroup(raft, config, identity) : null;
    log('check', { ok: true, ...identity, backend_available: true, group }); return;
  }
  log('connected', { ...identity, worker: config.worker });
  await runWorker(config, raft, backend, identity, args.includes('--once'));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { process.stderr.write(`${JSON.stringify({ ok: false, code: errorCode(error) })}\n`); process.exitCode = 1; });
}
