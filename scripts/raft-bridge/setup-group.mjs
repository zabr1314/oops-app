#!/usr/bin/env node
import { createRaft } from '@botiverse/raft-sdk';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { UUID, BridgeError, fail, readConfig, verifyIdentity, prepareState, atomicJson } from './bridge.mjs';
import { GroupError, visibleChannels, channelById, groupUrl } from './group-state.mjs';

const NAME = 'oops-collaboration';
const DESCRIPTION = 'Oops协作群';
function emit(value) { process.stdout.write(`${JSON.stringify(value)}\n`); }
function code(error) { return error instanceof BridgeError || error instanceof GroupError ? error.code : 'GROUP_SETUP_FAILED'; }
function setupFetch(config, createAllowed, membersAllowed) {
  const attempted = new Set();
  return async (input, options = {}) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    if (url.origin !== new URL(config.serverUrl).origin) fail('RAFT_REQUEST_ORIGIN_REJECTED');
    const method = (options.method ?? 'GET').toUpperCase();
    if (!['GET', 'HEAD'].includes(method)) {
      const create = method === 'POST' && url.pathname.endsWith('/internal/agent-api/channels');
      const member = method === 'POST' && /\/internal\/agent-api\/channels\/[0-9a-f-]{36}\/members$/i.test(url.pathname);
      if (!(create && createAllowed) && !(member && membersAllowed)) fail('GROUP_SETUP_WRITE_NOT_ALLOWED');
      const fingerprint = `${url.pathname}:${options.body}`;
      if (attempted.has(fingerprint)) fail('GROUP_SETUP_AUTOMATIC_RETRY_BLOCKED');
      attempted.add(fingerprint);
    }
    return fetch(input, { ...options, redirect: 'error', signal: AbortSignal.timeout(30000) });
  };
}
async function loadJournal(filename) {
  try {
    const journal = JSON.parse(await fs.readFile(filename, 'utf8'));
    if (journal.schema !== 'oops-raft-group-setup.v1' || journal.name !== NAME || !journal.members) fail('GROUP_SETUP_JOURNAL_INVALID');
    return journal;
  } catch (error) {
    if (error.code === 'ENOENT') return { schema: 'oops-raft-group-setup.v1', name: NAME, create: null, members: {} };
    throw error;
  }
}
async function noBusinessMessages(raft, row, knownMembers) {
  const history = await raft.messages.read({ target: `#${row.name}`, limit: 100, consume: false });
  if (!history.ok || history.data.target !== `#${row.name}`) fail('GROUP_EMPTY_CHECK_UNAVAILABLE');
  if (history.data.hasOlder || history.data.hasNewer) fail('GROUP_EMPTY_CHECK_INCOMPLETE');
  const permitted = new Set(knownMembers.map(member => `@${member.handle} was added to this channel.`));
  // Raft itself persists membership notices. These are the only content
  // allowed during bootstrap; normal messages stop all further member writes.
  if (history.data.messages.some(message => message.sender.type !== 'system' || !permitted.has(message.content))) fail('GROUP_ALREADY_HAS_MESSAGES');
}
async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help')) { emit({ usage: 'node setup-group.mjs --config /private/config.json [--check | --create] [--add-agent UUID] [--add-human UUID]', group_name: NAME, visibility: 'private', adds_human_automatically: false }); return; }
  let filename = process.env.OOPS_RAFT_CONFIG ?? path.join(os.homedir(), '.config/oops/raft-bridge.json');
  const requested = [];
  let check = false, create = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--config' && args[i + 1]) filename = args[++i];
    else if (args[i] === '--check') check = true;
    else if (args[i] === '--create') create = true;
    else if (['--add-agent', '--add-human'].includes(args[i]) && args[i + 1]) {
      const type = args[i] === '--add-agent' ? 'agent' : 'human';
      const id = args[++i]; if (!UUID.test(id)) fail('GROUP_MEMBER_UUID_INVALID');
      if (!requested.some(member => member.id === id && member.type === type)) requested.push({ id, type });
    } else fail('GROUP_SETUP_ARGUMENT_INVALID');
  }
  if (check && (create || requested.length)) fail('GROUP_SETUP_CHECK_WRITE_CONFLICT');
  check ||= !create && !requested.length;
  filename = path.resolve(filename);
  const config = await readConfig(filename);
  const raft = createRaft({ serverUrl: config.serverUrl, credential: config.raftCredential, fetch: setupFetch(config, create, requested.length > 0), retry: { attempts: 1 } });
  const identity = await verifyIdentity(raft, config);
  if (identity.agent_handle !== 'Oops') fail('GROUP_REQUIRES_DEDICATED_OOPS_IDENTITY');
  if (!identity.capabilities.includes('channels')) fail('GROUP_CHANNELS_SCOPE_MISSING');
  const journalFile = path.join(config.stateDir, 'group-setup.json');
  const journal = await loadJournal(journalFile);
  if (journal.server_id && journal.server_id !== config.raftServerId) fail('GROUP_SETUP_JOURNAL_SERVER_MISMATCH');
  const channels = await visibleChannels(raft, config);
  const recordedId = config.collaborationGroup?.channelId ?? journal.create?.channel_id;
  let matches = recordedId ? channels.filter(row => row.id === recordedId) : channels.filter(row => row.name === NAME);
  if (matches.length > 1) fail('GROUP_NAME_AMBIGUOUS');
  let row = matches[0] ?? null;
  if (check) {
    if (row) row = await channelById(raft, config, row.id);
    emit({ ok: true, readonly: true, exists: Boolean(row), group: row ? { serverId: config.raftServerId, channelId: row.id, name: row.name, url: groupUrl(identity.server_slug, row.id) } : null, previous_create: journal.create?.status ?? null }); return;
  }
  await prepareState(config.stateDir);
  const lockPath = path.join(config.stateDir, 'group-setup.lock');
  let lock;
  try { lock = await fs.open(lockPath, 'wx', 0o600); } catch { fail('GROUP_SETUP_ALREADY_RUNNING_OR_STALE_LOCK'); }
  try {
    await lock.writeFile(JSON.stringify({ pid: process.pid })); await lock.sync();
    journal.server_id = config.raftServerId;
    const save = () => atomicJson(journalFile, journal);
    if (!row) {
      if (recordedId) fail('GROUP_RECORDED_ID_NOT_VISIBLE');
      if (journal.create) fail('GROUP_PREVIOUS_CREATE_ONLY_RECONCILE_NO_RECREATE');
      if (!create) fail('GROUP_NOT_CREATED_EXPLICIT_CREATE_REQUIRED');
      journal.create = { status: 'attempting', started_at: new Date().toISOString() };
      await save();
      let outcome;
      try { outcome = await raft.routes.channels.create({ body: { name: NAME, description: DESCRIPTION, visibility: 'private' } }); }
      catch { journal.create.status = 'unknown'; await save(); fail('GROUP_CREATE_UNKNOWN_ONLY_RECONCILE'); }
      if (!outcome.ok) {
        journal.create.status = outcome.error.kind === 'http' && outcome.status >= 400 && outcome.status < 500 ? 'rejected' : 'unknown';
        await save(); fail(journal.create.status === 'rejected' ? 'GROUP_CREATE_REJECTED' : 'GROUP_CREATE_UNKNOWN_ONLY_RECONCILE');
      }
      if (!UUID.test(outcome.data?.id ?? '') || outcome.data.name !== NAME || outcome.data.type !== 'private' || outcome.data.createdByAgentId !== config.raftAgentId) {
        journal.create.status = 'unknown'; await save(); fail('GROUP_CREATE_RECEIPT_INVALID');
      }
      journal.create = { ...journal.create, status: 'created', channel_id: outcome.data.id };
      await save();
      row = await channelById(raft, config, outcome.data.id);
    } else {
      row = await channelById(raft, config, row.id);
      if (!recordedId && (row.name !== NAME || row.description !== DESCRIPTION)) fail('GROUP_EXISTING_NAME_NOT_OURS');
      journal.create = { ...journal.create, status: 'reconciled', channel_id: row.id };
      await save();
    }
    const own = { id: identity.agent_id, handle: identity.agent_handle, name: identity.agent_name, type: 'agent' };
    const bindings = [own, ...(Array.isArray(config.collaborationGroup?.members) ? config.collaborationGroup.members : []), ...Object.values(journal.members).flatMap(entry => entry.member ? [entry.member] : [])];
    await noBusinessMessages(raft, row, bindings);
    async function saveConfig() {
      const raw = JSON.parse(await fs.readFile(filename, 'utf8'));
      if (raw.raftAgentId !== config.raftAgentId || raw.raftServerId !== config.raftServerId) fail('GROUP_CONFIG_IDENTITY_CHANGED');
      const unique = [...new Map(bindings.map(member => [`${member.type}:${member.id}`, member])).values()];
      raw.collaborationGroup = { serverId: config.raftServerId, channelId: row.id, name: row.name, url: groupUrl(identity.server_slug, row.id), members: unique };
      await atomicJson(filename, raw);
    }
    await saveConfig();
    for (const member of requested) {
      if (member.type === 'agent' && member.id === config.raftAgentId) continue;
      row = await channelById(raft, config, row.id);
      await noBusinessMessages(raft, row, bindings);
      const key = `${member.type}:${member.id}`;
      const previous = journal.members[key];
      if (previous?.status === 'added') continue;
      if (previous) fail('GROUP_MEMBER_PRIOR_ATTEMPT_ONLY_RECONCILE');
      journal.members[key] = { status: 'attempting', channel_id: row.id, started_at: new Date().toISOString() };
      await save();
      let outcome;
      try { outcome = await raft.routes.channels.addMember({ params: { channelId: row.id }, body: member.type === 'agent' ? { agentId: member.id } : { userId: member.id } }); }
      catch { journal.members[key].status = 'unknown'; await save(); fail('GROUP_MEMBER_ADD_UNKNOWN_NO_RETRY'); }
      if (!outcome.ok || outcome.data.channelId !== row.id || outcome.data.member?.id !== member.id || outcome.data.member.type !== member.type) {
        journal.members[key].status = !outcome.ok && outcome.error.kind === 'http' && outcome.status >= 400 && outcome.status < 500 ? 'rejected' : 'unknown';
        await save(); fail('GROUP_MEMBER_ADD_NOT_CONFIRMED');
      }
      const profile = await raft.profile.show({ target: `@${outcome.data.member.name}` });
      const displayName = profile.ok && profile.data.id === member.id && profile.data.kind === member.type ? profile.data.displayName ?? profile.data.name : outcome.data.member.name;
      const confirmed = { ...member, handle: outcome.data.member.name, name: displayName };
      journal.members[key] = { ...journal.members[key], status: 'added', member: confirmed };
      bindings.push(confirmed); await save(); await saveConfig();
    }
    emit({ ok: true, group: { serverId: config.raftServerId, channelId: row.id, name: row.name, url: groupUrl(identity.server_slug, row.id) }, member_ids: bindings.map(member => ({ id: member.id, type: member.type })), business_messages_sent: 0 });
  } finally { await lock.close(); await fs.unlink(lockPath); }
}
main().catch(error => { process.stderr.write(`${JSON.stringify({ ok: false, code: code(error) })}\n`); process.exitCode = 1; });
