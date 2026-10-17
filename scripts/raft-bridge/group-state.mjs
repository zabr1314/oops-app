const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class GroupError extends Error {
  constructor(code) { super(code); this.code = code; }
}
function reject(code) { throw new GroupError(code); }
function requireOk(result, code) { if (!result?.ok) reject(code); return result.data; }
export function groupUrl(serverSlug, channelId) {
  if (!serverSlug || !UUID.test(channelId)) reject('GROUP_URL_IDENTITY_INVALID');
  return `https://app.raft.build/s/${encodeURIComponent(serverSlug)}/channel/${channelId}`;
}
export function parseGroupDestination(target) {
  if (typeof target !== 'string') return null;
  const root = /^channel:([0-9a-f-]{36})$/i.exec(target);
  if (root && UUID.test(root[1])) return { kind: 'channel', channelId: root[1] };
  const thread = /^thread:([0-9a-f-]{36}):([0-9a-f-]{36})$/i.exec(target);
  if (thread && UUID.test(thread[1]) && UUID.test(thread[2])) return { kind: 'thread', channelId: thread[1], rootMessageId: thread[2] };
  return null;
}
export function messageChannelId(message) { return message?.raw?.channelId ?? message?.raw?.channel_id ?? null; }
export function messageSenderId(message) { return message?.raw?.senderId ?? message?.raw?.sender_id ?? null; }

export async function resolveStoredMessage(raft, messageId) {
  const summary = requireOk(await raft.messages.resolve({ messageId }), 'MESSAGE_RESOLVE_UNAVAILABLE');
  if (summary.id !== messageId || typeof summary.target !== 'string' || !summary.target) reject('MESSAGE_RESOLVE_IDENTITY_MISMATCH');
  // /messages/:id/resolve returns a compact envelope on the deployed server:
  // sender/channel/thread UUIDs are omitted. A consume:false history read
  // anchored by the complete message UUID exposes the actual stored row.
  const page = requireOk(await raft.messages.read({ target: summary.target, around: messageId, limit: 1, consume: false }), 'MESSAGE_STORED_ROW_UNAVAILABLE');
  if (page.target !== summary.target) reject('MESSAGE_STORED_TARGET_MISMATCH');
  const matches = page.messages.filter(message => message.id === messageId && message.target === page.target);
  if (matches.length !== 1 || !UUID.test(messageChannelId(matches[0]) ?? '') || !UUID.test(messageSenderId(matches[0]) ?? '')) reject('MESSAGE_STORED_UUIDS_MISSING');
  return matches[0];
}

export async function visibleChannels(raft, config) {
  const data = requireOk(await raft.routes.server.info(), 'GROUP_DIRECTORY_UNAVAILABLE');
  if (data.runtimeContext?.agentId !== config.raftAgentId || data.runtimeContext?.serverId !== config.raftServerId || !Array.isArray(data.channels)) reject('GROUP_DIRECTORY_IDENTITY_MISMATCH');
  return data.channels;
}
export async function channelById(raft, config, channelId) {
  const matches = (await visibleChannels(raft, config)).filter(row => row.id === channelId);
  if (matches.length !== 1) reject('GROUP_NOT_VISIBLE');
  const row = matches[0];
  if (row.type !== 'private') reject('GROUP_NOT_PRIVATE');
  if (row.joined !== true) reject('GROUP_NOT_JOINED');
  if (row.archived === true || row.archivedAt) reject('GROUP_ARCHIVED');
  if (typeof row.name !== 'string' || !row.name || /[\s:#]/.test(row.name)) reject('GROUP_NAME_INVALID');
  return row;
}

export async function inspectGroup(raft, config, identity) {
  const recorded = config.collaborationGroup;
  if (!recorded || !UUID.test(recorded.channelId ?? '') || recorded.serverId !== config.raftServerId) reject('GROUP_NOT_CONFIGURED');
  const row = await channelById(raft, config, recorded.channelId);
  // The deployed member endpoint accepts a canonical #name, not a UUID.
  // Pin that spelling to the recorded ID before and after the roster read.
  const rosterTarget = `#${row.name}`;
  const roster = requireOk(await raft.channels.members({ target: rosterTarget }), 'GROUP_ROSTER_UNAVAILABLE');
  const after = await channelById(raft, config, recorded.channelId);
  if (after.name !== row.name) reject('GROUP_ROSTER_NAME_CHANGED');
  if (roster.channel?.ref !== rosterTarget || roster.channel?.type !== 'private' || !Array.isArray(roster.agents) || !Array.isArray(roster.humans)) reject('GROUP_ROSTER_INVALID');
  const known = [{ id: identity.agent_id, handle: identity.agent_handle, type: 'agent' }, ...(Array.isArray(recorded.members) ? recorded.members : [])];
  const members = [];
  for (const [type, rows] of [['agent', roster.agents], ['human', roster.humans]]) {
    for (const entry of rows) {
      if (typeof entry.name !== 'string' || !entry.name) reject('GROUP_MEMBER_HANDLE_MISSING');
      const profile = requireOk(await raft.profile.show({ target: `@${entry.name}` }), 'GROUP_MEMBER_ID_UNAVAILABLE');
      if (profile.kind !== type || !UUID.test(profile.id ?? '') || profile.name !== entry.name) reject('GROUP_MEMBER_ID_MISMATCH');
      if (!known.some(binding => binding.type === type && binding.id === profile.id)) reject('GROUP_MEMBER_NOT_CONFIRMED');
      if ((type === 'human' && profile.membershipStatus !== 'active') || (type === 'agent' && profile.deletedAt)) reject('GROUP_MEMBER_INACTIVE');
      members.push({ id: profile.id, handle: `@${profile.name}`, name: profile.displayName?.trim() || profile.name, type });
    }
  }
  if (!members.some(member => member.type === 'agent' && member.id === identity.agent_id)) reject('GROUP_BRIDGE_MEMBERSHIP_MISSING');
  return { id: row.id, name: row.name, server_id: config.raftServerId, url: groupUrl(identity.server_slug, row.id), visibility: 'private', joined: true, archived: false, bridge_agent_id: identity.agent_id, members };
}

export async function groupSendTarget(raft, destination, group) {
  if (!destination || destination.channelId !== group.id) reject('GROUP_DESTINATION_NOT_ALLOWED');
  if (destination.kind === 'channel') return { target: `#${group.name}`, channelId: group.id };
  const root = await resolveStoredMessage(raft, destination.rootMessageId);
  if (root.id !== destination.rootMessageId || messageChannelId(root) !== group.id || root.target !== `#${group.name}`) reject('GROUP_THREAD_ROOT_MISMATCH');
  return { target: `#${group.name}:${root.id.slice(0, 8)}`, channelId: group.id, rootMessageId: root.id, threadId: UUID.test(root.thread?.id ?? '') ? root.thread.id : null };
}

export async function verifyGroupSend(raft, receipt, expected, group, bridgeAgentId) {
  const message = await resolveStoredMessage(raft, receipt.raft_message_id);
  if (message.id !== receipt.raft_message_id || messageSenderId(message) !== bridgeAgentId) reject('GROUP_SENT_IDENTITY_MISMATCH');
  let expectedChannel = group.id;
  if (expected.rootMessageId) {
    const root = await resolveStoredMessage(raft, expected.rootMessageId);
    if (root.id !== expected.rootMessageId || messageChannelId(root) !== group.id || !UUID.test(root.thread?.id ?? '')) reject('GROUP_SENT_THREAD_ROOT_MISMATCH');
    expectedChannel = root.thread.id;
  }
  if (messageChannelId(message) !== expectedChannel || message.target !== expected.target) reject('GROUP_SENT_CHANNEL_MISMATCH');
  return { ...receipt, response: { ...receipt.response, target: expected.target, channel_id: expectedChannel, root_channel_id: group.id, ...(expected.rootMessageId ? { root_message_id: expected.rootMessageId, thread_id: expectedChannel } : {}) } };
}
