# Oops → Raft bridge

This trusted Node process connects the existing Oops backend outbox to one
independent Raft External Agent. It does not read meetings, execute inbound
Raft instructions, or use an existing managed Agent's identity.

Official dependencies are pinned exactly: `@botiverse/raft-sdk` 0.18.0 and
`@botiverse/raft` CLI 0.0.26. Node 20 or newer is required. In this workspace,
Node is available at `/Users/gpfs/.nvm/versions/node/v24.17.0/bin/node`.

## Authentication and private configuration

Create an **External Agent** in the intended Raft server. An existing
`raft-computer` machine login does not supply this independent Agent's
credential. Obtain its `sk_agent_*` credential through the External setup
card or the official device authorization flow. The bridge checks that it is
external, has `send` and `read`, and matches both expected IDs before claiming
anything. Do not put its credential in command arguments, Git, the APK,
public pages, or logs.

The shared collaboration group also needs the `channels` scope. Its setup
uses the already provisioned dedicated External Agent with handle `Oops`.
The server still checks that Agent's current `createChannels` and
`addChannelMembers` permissions; having a credential scope does not grant a
server role.

The installed official CLI is available at `node_modules/.bin/raft`. The
documented device flow is:

```sh
raft agent login start --server https://api.raft.build --agent AGENT_ID --profile-slug oops-bridge
# A human approves the link printed by the CLI.
raft agent login wait --server https://api.raft.build --agent AGENT_ID --device-code DEVICE_CODE --profile-slug oops-bridge
```

The bridge reads its own private JSON configuration, not the CLI profile or
`~/.slock` proxy credentials. If using the profile flow, deliberately provision
that same independent credential into the bridge's secret file on this
machine; never copy a managed Agent's per-launch token. Generating a token on
the setup card and placing it directly in the private configuration is the
shorter setup route.

Use `config.example.json` as a schema reference. The file must be a regular
file with owner-only permissions, for example mode `0600`. The default path is
`~/.config/oops/raft-bridge.json`; `OOPS_RAFT_CONFIG` or `--config` can select a
different private file. The repository's ignored
`.local-backend/raft-local.json` is supported.

| Field | Purpose |
| --- | --- |
| `server` or `backendUrl` | Existing Oops backend URL; HTTPS, or HTTP on loopback |
| `workerToken` | Dedicated backend Raft-worker credential |
| `raftCredential` | This bridge External Agent's `sk_agent_*` credential |
| `raftAgentId` | Expected External Agent UUID, checked against Raft |
| `raftServerId` | Expected Raft server UUID, checked against Raft |
| `serverUrl` | Raft API origin; defaults to `https://api.raft.build` |
| `worker` | Stable backend worker name; optional |
| `stateDir` | Private state base; bridge uses its `bridge/` subdirectory |
| `pollIntervalMs` | 1000–60000 ms; defaults to 10000 |
| `collaborationGroup` | Verified server/channel IDs, link, and known member identities; written by setup |

`backendToken`, if present in shared local configuration, is not used. This
process needs only the separate `workerToken`. First use `--check`; it only
verifies identity, calls `GET /v1/raft/worker/status`, and inspects an already
configured group without publishing metadata. It never claims a job or sends
a message. `--once` claims at most one queued job and then reads
replies. Without either flag it runs continuously.

```sh
node bridge.mjs --config /private/path/config.json --check
node bridge.mjs --config /private/path/config.json --once
node bridge.mjs --config /private/path/config.json
```

## Explicit empty-group setup

`setup-group.mjs --check` is read-only. It finds the previously recorded
channel UUID or the exact `oops-collaboration` name in the verified server.
`--create` explicitly creates one empty private group, with description
`Oops协作群`, only when no recorded or same-name visible group exists.
Creation automatically joins only the dedicated External Agent. A human
must be explicitly named with `--add-human HUMAN_UUID` to see the private
group; the script does not borrow the machine login or infer a human ID.

```sh
node setup-group.mjs --config /private/path/config.json --check
node setup-group.mjs --config /private/path/config.json --create \
  --add-human VERIFIED_HUMAN_UUID \
  --add-agent VERIFIED_AGENT_UUID
```

Setup records a durable private creation journal before its single create
POST. Unknown creation is reconciled by reading, never by creating again.
Member-add attempts likewise have their own journal and are not retried
after uncertain delivery. Adding a member uses the explicit UUID, and its
actual member receipt supplies the binding stored in private configuration.
The setup permits only the membership system notices it has confirmed;
business messages stop further membership writes. No meeting, task source,
private material, or ordinary message is posted during setup. `group-setup.lock`
prevents simultaneous setup processes. Restart the bridge and backend after
setup so they load the new binding.

## Delivery and database contract

The backend owns its existing storage and an independent SQLite outbox. The
bridge accesses that database only through these authenticated endpoints:

- `POST /v1/raft/worker/poll` with `{ "worker": "..." }` claims one job.
- `POST /v1/raft/worker/group` publishes freshly read group metadata, or an
  `error_code` that clears the group's current validity.
- `POST /v1/raft/worker/jobs/:id/validate` checks the current lease, frozen
  message, group version, selected members, and authorization before sending.
- `POST /v1/raft/worker/jobs/:id/settle` submits the lease and a `status`
  (`sent`, `unknown`, or `failed`), with the real `raft_message_id` for `sent`.
- `GET /v1/raft/worker/messages?status=sent&limit=30` selects sent messages.
- `POST /v1/raft/worker/replies` records a reply bound to an explicit
  root `source_message_id`, unique `reply_id`, `text`, stable `sender_id`,
  `sender_type`, and optional display text/time.

Each job's idempotency key is `oopsy-<Oops job ID>`. Before making the one
network send, the bridge atomically persists and fsyncs its journal. The
journal holds a payload hash and receipt metadata, not message text or
credentials. A crash, timeout, invalid provider receipt, or uncertain send
becomes `unknown`; the bridge never sends that job again. A known receipt
can be re-submitted to the backend with the same lease. `interrupted` is
recorded as `failed` with a review-required reason: its SDK `ok: true` does
not mean the message was sent, and the bridge does not auto-resume it.

SDK 0.18.0 internally retries transport failures from `messages.send` even
with `retry.attempts: 1`. A narrow fetch guard blocks a second network POST
for the same key. This is independent of Raft's own idempotency guarantee.
Only the SDK's message-send POST is permitted; other Raft writes are denied.

Targets are explicitly bound by the backend. New shared-group jobs use
`channel:GROUP_UUID` for a root message or
`thread:GROUP_UUID:ACTUAL_RAFT_ROOT_MESSAGE_UUID` for follow-ups. The bridge
resolves the currently visible group by UUID, verifies its current name,
private visibility, membership and archive state, and only then translates
that binding to the SDK's `#name` or `#name:rootprefix` spelling. Group members
are checked through actual roster/profile reads against the explicit setup
bindings. A rename keeps its identity; an unknown member or unavailable
group stops new writes and clears current group validity.

After sending, the bridge resolves the actual message UUID and verifies the
provider's real channel UUID and sender UUID. A thread send also resolves
its full root UUID and actual thread UUID. Only then is it recorded as
`sent`. `channel_id`, `root_channel_id`, and, for a follow-up, `thread_id` and
`root_message_id` are provider-verified metadata. A wrong or unreadable
receipt stays `unknown` and is never resent. Both `message` and `instruction`
send the exact authorized text as an ordinary Raft message. No Raft task is
created and nobody is automatically marked responsible or complete.

The deployed `messages.resolve` response is a compact envelope without
sender, channel, or thread UUIDs. `resolveStoredMessage` uses that canonical
target to read history around the **full** message UUID, with `limit: 1` and
`consume: false`. Its one exact stored row must expose real sender/channel
UUIDs. This same path hydrates roots before following their exact thread;
missing UUIDs are never accepted as verified identity.

## Reconcile a known receipt without resending

`reconcile.mjs --check` is read-only. It accepts one explicit Oops job ID and
compares the original backend payload, journal digest and known Raft message
UUID, exact stored text, dedicated sender UUID, actual group/channel UUID,
and, if relevant, the thread root. It prints metadata only. This bounded
lookup covers the backend's newest 100 outbox rows; an older missing job is
not recreated or resent.

```sh
node reconcile.mjs --config /private/production-config.json --job OOPS_JOB_ID --check
# Stop only this configured backend's bridge before applying the known receipt.
node reconcile.mjs --config /private/production-config.json --job OOPS_JOB_ID --apply
```

`--apply` makes **zero Raft writes**. It uses the original journal lease to
settle a verified `unknown` result as `sent` in the same backend, and updates
that journal atomically. It takes the existing worker lock; a concurrently
running worker prevents application. The definite receipt is journaled
before the DB call, so a lost settlement response can be recovered without
another Raft send. Configuration and state directories remain separate for
different backends.

Reply collection resolves each actual sent message UUID, requires its exact
thread UUID, reads only its canonical target with `consume: false`, checks
the returned parent target and each row's actual channel UUID, and imports
human and Agent replies with proven stable sender IDs. Missing sender IDs
can be resolved through an exact typed profile; display names never replace
identity. Follow-ups share the original root's replies and each root is read
once per cycle. It never reads the general inbox or an entire private conversation.
The current bound is the newest 30 sent jobs and newest 50 replies per thread;
long conversations and older jobs are not promised to be fully synchronized.
The bridge reports truncated windows and does not treat replies as commands
or business completion.

The private `worker.lock` prevents simultaneous bridge instances. A stale
lock intentionally stops startup; verify its PID has stopped before removing
only that lock. Never remove `journal.json` to retry an unknown delivery.

## Official references

- [Create and connect an external Agent](https://docs.raft.build/developers/sdk/external-agents/)
- [SDK API usage and idempotent sends](https://docs.raft.build/developers/sdk/api-client/)
- [Wake-ups and cursor acknowledgment](https://docs.raft.build/developers/sdk/external-agents/wake-and-status/)
- [Official server target resolver](https://github.com/botiverse/raft-source/blob/main/packages/server/src/routes/agentWritableTarget.ts)
- [Official channel creation boundary](https://github.com/botiverse/raft-source/blob/main/packages/server/src/routes/agentChannelCreate.ts)
- [Official channel member addition boundary](https://github.com/botiverse/raft-source/blob/main/packages/server/src/routes/agentChannelMembers.ts)
