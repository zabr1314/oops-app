"""Personal, current-source permission for meeting-to-Raft handoffs.

Phone display names are not identities. Read contracts authorize no send by
themselves; an explicit task-create confirmation records a separate personal
receipt. Receipts contain account identifiers and hashes, never session tokens,
OAuth credentials, or a duplicate meeting transcript.
"""

import contextlib
import datetime as dt
import hashlib
import hmac
import json
import re
import time

from raft_outbox import OutboxError


CONTRACT_SECONDS = 300
DOMAIN = "oops-raft-source.v1"
CANDIDATE_DOMAIN = "oops-raft-candidate.v1"
CANDIDATE_STATE = dict(review_status="unreviewed", responsibility="unverified")


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode()).hexdigest()


def reference(value):
    if not isinstance(value, dict):
        raise OutboxError(400, "TASK_SOURCE_REQUIRED", "请选择真实任务来源")
    kind = value.get("kind")
    fields = ({"kind", "session_id", "item_id", "fingerprint"} if kind == "meeting_item"
              else {"kind", "source_meeting_id", "item_id", "fingerprint"} if kind == "label_review" else set())
    if not fields or set(value) != fields:
        raise OutboxError(400, "TASK_SOURCE_UNSUPPORTED", "来源引用字段或类型不支持")
    result = dict(value)
    field = "session_id" if kind == "meeting_item" else "source_meeting_id"
    if not isinstance(result[field], str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,100}", result[field]):
        raise OutboxError(400, "BAD_REQUEST", "来源会议编号无效")
    pattern = r"mi-[a-f0-9]{12}" if kind == "meeting_item" else r"ai-[a-f0-9]{12}"
    if not isinstance(result["item_id"], str) or not re.fullmatch(pattern, result["item_id"]):
        raise OutboxError(400, "BAD_REQUEST", "来源事项编号无效")
    if not isinstance(result["fingerprint"], str) or not re.fullmatch(r"[a-f0-9]{64}", result["fingerprint"]):
        raise OutboxError(400, "BAD_REQUEST", "来源指纹须来自真实当前回包")
    return result


def locator(ref):
    return {key: value for key, value in ref.items() if key != "fingerprint"}


def source_version(receipt):
    """Stable version of one person's checked source, without read expiry.

    Reconnecting the same account does not create a new source version. Only
    the actual source/review version may authorize an explicit new task.
    """
    binding = receipt["actor_binding"]
    return digest(dict(
        source_ref=receipt["source_ref"],
        principal_id=binding["principal_id"], account_open_id=binding["account_open_id"], tenant_key=binding["tenant_key"],
        snapshot_hash=receipt["snapshot_hash"], review_hash=receipt["review_hash"], review_revision=receipt["review_revision"]))


class SourceReadContext:
    """One GET's display snapshot. Never an authority for an external write."""

    def __init__(self, access, personal):
        self.access, self.personal = access, personal
        self.snapshots, self.label_values, self.label_errors = {}, {}, {}

    def ensure_binding(self, binding):
        if self.access.identity(self.personal) != binding:
            raise OutboxError(409, "TASK_BINDING_CHANGED", "读取期间本人账号或授权已变化")

    def label_current(self, reviews, mid, uid, actor):
        key = (mid, actor)
        if key in self.label_errors:
            raise self.label_errors[key]
        if key not in self.label_values:
            config = reviews._config(self.access.backend)
            try:
                value, _ = reviews._current(config, mid, uid, actor)
            except Exception as error:
                if getattr(error, "status", None) == 503:
                    self.label_errors[key] = error
                raise
            self.label_values[key] = config, value
        config, value = self.label_values[key]
        fp = reviews._approved(config, mid, uid)
        item = next((row for row in value["items"] if row.get("id") == uid), None)
        if value.get("status") != "ready" or not item or item.get("fingerprint") != fp:
            raise reviews.ReviewError(409, "TASK_SOURCE_CHANGED", "这件事或原话已变化，请重新核对来源")
        return value, item

    def snapshot(self, ref, binding, mode):
        self.ensure_binding(binding)
        key = digest(dict(source_ref=ref, actor_binding=binding, mode=mode))
        if key not in self.snapshots:
            try:
                value = self.access._snapshot(ref, binding, False, mode=mode, read_context=self)
            except OutboxError as error:
                self.snapshots[key] = None, error
            else:
                self.snapshots[key] = value, None
                # Delegate reads of an already-confirmed item use the exact
                # old contract, so both display modes share this snapshot.
                if value["source_policy"] == "confirmed_source":
                    for alias in ("confirmed", "delegate"):
                        self.snapshots[digest(dict(source_ref=ref, actor_binding=binding, mode=alias))] = value, None
        value, error = self.snapshots[key]
        self.ensure_binding(binding)
        if error is not None:
            raise error
        return value

    def validate(self, receipt):
        ref, binding, candidate = self.access._receipt_parts(receipt)
        snapshot = self.snapshot(ref, binding, "delegate" if candidate else "confirmed")
        return self.access._compare_receipt(receipt, snapshot, candidate)


class SourceAccess:
    def __init__(self, backend):
        self.backend = backend

    def _mobile(self):
        mobile = getattr(self.backend, "mobile_feishu", None)
        if mobile is None:
            raise OutboxError(503, "TASK_SOURCE_SERVICE_UNAVAILABLE", "个人身份与真实来源服务尚未接入")
        return mobile

    def _actor(self, status):
        if status.get("status") != "bound":
            if status.get("status") == "unavailable":
                raise OutboxError(503, "TASK_IDENTITY_UNAVAILABLE", "本人账号状态暂不可核对")
            raise OutboxError(401, "TASK_ACCOUNT_REQUIRED", "请先连接本人的飞书账号")
        account = status.get("account") or {}
        people = getattr(getattr(self.backend, "people", None), "data", None) or {}
        mapping = dict(people.get("people") or {})
        own = people.get("self") or {}
        if own.get("name") and own.get("open_id"):
            mapping.setdefault(own["name"], own["open_id"])
        names = [name for name, uid in mapping.items() if uid and uid == account.get("open_id")]
        if len(names) != 1:
            raise OutboxError(409, "TASK_REVIEWER_UNVERIFIED", "本人飞书身份与核对姓名尚未核实")
        result = dict(principal_id=status.get("principal_id"), binding_revision=status.get("binding_revision"),
                      account_open_id=account.get("open_id"), tenant_key=account.get("tenant_key"), actor=names[0])
        if (not isinstance(result["principal_id"], str) or not re.fullmatch(r"[a-f0-9]{32}", result["principal_id"])
                or type(result["binding_revision"]) is not int or not result["account_open_id"] or not result["tenant_key"]):
            raise OutboxError(409, "TASK_BINDING_CHANGED", "个人账号绑定尚不可核对")
        return result

    def identity(self, personal):
        if not isinstance(personal, str) or not personal:
            raise OutboxError(401, "TASK_ACCOUNT_REQUIRED", "请先连接本人的飞书账号")
        try:
            mobile = self._mobile()
            return self._actor(mobile.accounts.status_readonly_snapshot(personal))
        except OutboxError:
            raise
        except Exception as error:
            if getattr(error, "status", None) == 503:
                raise OutboxError(503, "TASK_IDENTITY_UNAVAILABLE", "本人身份存储暂不可读取") from None
            raise OutboxError(401, "TASK_ACCOUNT_REQUIRED", "本人账号会话已失效，请重新连接") from None

    @contextlib.contextmanager
    def identity_guard(self, binding):
        """Authoritative worker check under the existing account write lock."""
        deferred = None
        try:
            mobile = self._mobile()
            with mobile.accounts._transaction() as data:
                try:
                    entry = mobile.accounts._entry_for_principal(data, binding["principal_id"])
                    current = self._actor(mobile.accounts._status(entry))
                    if current != binding:
                        raise OutboxError(409, "TASK_BINDING_CHANGED", "原派工人的账号或授权已变化")
                except OutboxError as error:
                    deferred = error
                if deferred is None:
                    try:
                        yield mobile
                    except Exception as error:
                        # OutboxError inherits ValueError. Do not let the
                        # accounts context relabel a domain rejection as 503.
                        deferred = error
        except OutboxError:
            raise
        except Exception as error:
            if getattr(error, "status", None) == 503:
                raise OutboxError(503, "TASK_IDENTITY_UNAVAILABLE", "原派工身份暂不可核对") from None
            raise OutboxError(409, "TASK_BINDING_CHANGED", "原派工身份已不可核对，停止派工") from None
        if deferred is not None:
            raise deferred

    def same_reader(self, receipt, personal):
        # A disconnected/changed creator may still read IDs and delivery facts
        # through its unchanged opaque principal, but cannot receive old text.
        if not personal:
            return False
        try:
            principal = self._mobile().accounts.principal_readonly_snapshot(personal)
        except Exception:
            return False
        return principal == receipt.get("actor_binding", {}).get("principal_id")

    def history_principal(self, personal):
        if not isinstance(personal, str) or not personal:
            raise OutboxError(401, "TASK_ACCOUNT_REQUIRED", "请使用原手机的本人会话读取派工历史")
        try:
            return self._mobile().accounts.principal_readonly_snapshot(personal)
        except OutboxError:
            raise
        except Exception as error:
            if getattr(error, "status", None) == 503:
                raise OutboxError(503, "TASK_IDENTITY_UNAVAILABLE", "本人历史身份暂不可核对") from None
            raise OutboxError(401, "TASK_ACCOUNT_REQUIRED", "本人手机会话已失效") from None

    def _native_owner(self, ref, binding):
        mobile = self._mobile()
        sid = ref["session_id"]
        account_key = binding["tenant_key"] + ":" + binding["account_open_id"]
        # Pure permission read: never claim an old meeting or mutate its owner.
        try:
            with mobile.owners.connect() as db:
                row = db.execute("SELECT principal,account FROM owners WHERE sid=?", (sid,)).fetchone()
            if row is None or row[0] != binding["principal_id"] or row[1] not in (None, account_key):
                raise OutboxError(403, "TASK_SOURCE_FORBIDDEN", "当前账号没有这场会议的派工权限")
        except OutboxError:
            raise
        except Exception:
            raise OutboxError(503, "TASK_SOURCE_PERMISSION_UNAVAILABLE", "会议所属身份暂不可核对") from None

    def _snapshot(self, ref, binding, require_personal_confirmation, mode="confirmed", read_context=None):
        backend = self.backend
        if ref["kind"] == "label_review":
            import app_task_reviews as reviews
            import label_app_tasks as label
            try:
                mid = ref["source_meeting_id"]
                mobile = self._mobile()
                if hasattr(mobile.owners, "readable_ids"):
                    allowed = mobile.owners.readable_ids("label_meeting", binding["principal_id"])
                else:
                    allowed = frozenset(label.MEETINGS)
                if mid not in allowed:
                    raise OutboxError(403, "TASK_SOURCE_FORBIDDEN", "当前账号没有该核对来源的权限")
                value, raw = (read_context.label_current(reviews, mid, ref["item_id"], binding["actor"]) if read_context is not None
                              else reviews._current(reviews._config(backend), mid, ref["item_id"], binding["actor"]))
                if raw["fingerprint"] != ref["fingerprint"]:
                    raise OutboxError(409, "TASK_SOURCE_CHANGED", "原话或事项已变化，请重新核对")
                saved = raw.get("review") or {}
                checked = label._review(raw, binding["actor"], value["revision"])
                if checked.get("verdict") != "confirmed" or saved.get("kind", raw.get("kind")) != "task" or raw.get("stale_review"):
                    if (mode == "delegate" and checked.get("verdict") == "unreviewed" and raw.get("review") is None
                            and raw.get("kind") == "task" and raw.get("source") == "ai" and not raw.get("stale_review") and not raw.get("stale")):
                        rendered = reviews._result(value, raw, binding["actor"], mid)
                        item = dict(kind="task", title=raw["title"], detail=raw.get("detail") or "", due=raw.get("due") or "",
                                    owner=None, owner_hint=raw.get("owner_hint") or "")
                        shape = dict(source_ref=ref, item=item, candidate_state=CANDIDATE_STATE,
                                     personal_review=None, evidence=rendered["evidence"])
                        return dict(item=item, evidence=rendered["evidence"], snapshot_hash=digest(shape),
                                    review_hash=digest(dict(personal_review=None, candidate_state=CANDIDATE_STATE)),
                                    review_revision=rendered["revision"], source_status="current", source_policy="candidate_dispatch",
                                    self_review=dict(status="unreviewed", reviewer=binding["actor"]))
                    if mode == "delegate":
                        raise OutboxError(409, "TASK_CANDIDATE_UNAVAILABLE", "当前事项已舍弃、合并、变化或不再是任务，不能直接派工")
                    raise OutboxError(409, "TASK_PERSONAL_CONFIRM_REQUIRED", "请先在任务中保存本人的确认，不能借用同伴的答案")
                if not saved.get("owner") or saved["owner"] not in value.get("owners", []):
                    raise OutboxError(409, "TASK_OWNER_REQUIRED", "请先在本人核对中明确选择任务负责人")
                rendered = reviews._result(value, raw, binding["actor"], mid)
                item = dict(kind="task", title=saved.get("title") or raw["title"], detail=saved.get("detail") or raw.get("detail") or "",
                            due=saved.get("due") or "", owner=saved.get("owner"))
                own_review = dict(saved)
                proof_shape = dict(source_ref=ref, item=item, review=own_review, evidence=rendered["evidence"])
                return dict(item=item, evidence=rendered["evidence"], snapshot_hash=digest(proof_shape),
                            review_hash=digest(own_review), review_revision=rendered["revision"], source_status="current",
                            self_review=dict(status="confirmed", reviewer=binding["actor"]), source_policy="confirmed_source")
            except OutboxError:
                raise
            except Exception as error:
                raise OutboxError(getattr(error, "status", 503), getattr(error, "code", "TASK_SOURCE_UNAVAILABLE"),
                                  "本人核对来源当前不可用，请重新读取") from None
        if ref["kind"] == "meeting_item":
            import minutes_items
            from action_sources import binding_for, last_raw_revision
            self._native_owner(ref, binding)
            try:
                with backend.meetings.lock:
                    if backend.meeting_deleted(ref["session_id"]):
                        raise OutboxError(409, "TASK_SOURCE_UNAVAILABLE", "会议来源已删除")
                    row = backend.meetings.load(ref["session_id"])
                    current = next((item for item in minutes_items.confirmed(row, "task") if item["id"] == ref["item_id"]), None)
                    if current is None and mode == "delegate":
                        candidate = next((item for item in row.get("items", []) if item.get("id") == ref["item_id"]), None)
                        saved = (row.get("item_reviews") or {}).get(ref["item_id"])
                        if (candidate is None or candidate.get("fingerprint") != ref["fingerprint"] or candidate.get("kind") != "task"
                                or candidate.get("stale") or candidate.get("stale_review") or candidate.get("review") is not None or saved is not None):
                            raise OutboxError(409, "TASK_CANDIDATE_UNAVAILABLE", "当前会议候选已舍弃、合并、变化或不再是任务，不能直接派工")
                        if not minutes_items.reusable(row):
                            raise OutboxError(409, "TASK_SOURCE_UNAVAILABLE", "这场会议当前不允许对外使用")
                        ids = list(candidate["ids"])
                        original = backend.sign_action_binding(binding_for(row, ids))
                        # This proves the selected source only. A candidate
                        # must never use the human-confirmed item contract.
                        backend.validate_action_source(dict(session_id=ref["session_id"], evidence=dict(
                            utterance_ids=ids, quote=" ".join(source["quote"] for source in original["sources"]), source_binding=original)))
                        item = dict(kind="task", title=candidate["title"], detail=candidate.get("detail") or "",
                                    due=candidate.get("due") or "", owner=None, owner_hint=candidate.get("owner_hint") or "")
                        review_version = minutes_items.review_fingerprint(row, ref["item_id"], {})
                        shape = dict(source_ref=ref, item=item, candidate_state=CANDIDATE_STATE, item_review_version=review_version,
                                     source_revisions={uid: last_raw_revision(row, uid) for uid in ids},
                                     source_binding={key: value for key, value in original.items() if key != "proof"})
                        return dict(item=item, evidence=candidate["evidence"], snapshot_hash=digest(shape), review_hash=review_version,
                                    review_revision=review_version, source_status="current", source_policy="candidate_dispatch",
                                    self_review=dict(status="unreviewed", reason="candidate_dispatch_is_not_a_review"))
                    if current is None or current["fingerprint"] != ref["fingerprint"]:
                        raise OutboxError(409, "TASK_SOURCE_CHANGED", "会议事项或核对版本已变化")
                    if current.get("owner") not in (*backend.meetings.team, minutes_items.COLLECTIVE):
                        raise OutboxError(409, "TASK_OWNER_REQUIRED", "会议事项尚未明确核对负责人")
                    ids = list(current["ids"])
                    item_contract = backend.item_action_binding(row, current)
                    original = backend.sign_action_binding(dict(binding_for(row, ids), **item_contract))
                    backend.validate_action_source(dict(session_id=ref["session_id"], evidence=dict(
                        utterance_ids=ids, quote=" ".join(source["quote"] for source in original["sources"]), source_binding=original)))
                    item = dict(kind="task", title=current["title"], detail=current.get("detail") or "", due=current.get("due") or "", owner=current.get("owner"))
                    shape = dict(source_ref=ref, item=item, item_contract=item_contract,
                                 source_revisions={uid: last_raw_revision(row, uid) for uid in ids})
                    return dict(item=item, evidence=current["evidence"], snapshot_hash=digest(shape), review_hash=digest(item_contract),
                                review_revision=item_contract["item_review_fingerprint"], source_status=current["source_status"],
                                self_review=dict(status="confirmation_required", reason="global_review_is_not_personal"), source_policy="confirmed_source")
            except OutboxError:
                raise
            except Exception as error:
                if getattr(error, "status", None) == 503:
                    raise OutboxError(503, "TASK_SOURCE_UNAVAILABLE", "会议来源暂不可读取，请稍后重新核对") from None
                raise OutboxError(409, "TASK_SOURCE_UNAVAILABLE", "会议事项、原话或核对合同已不可用") from None
        raise OutboxError(400, "TASK_SOURCE_UNSUPPORTED", "该来源类型尚未接入")

    def _sign(self, contract):
        return self.backend.action_binding_signature(contract)

    def read_context(self, personal):
        return SourceReadContext(self, personal)

    def read(self, supplied, personal, mode="confirmed", read_context=None):
        if mode not in ("confirmed", "delegate"):
            raise OutboxError(400, "BAD_REQUEST", "来源读取模式无效")
        ref, binding = reference(supplied), self.identity(personal)
        if read_context is not None and (read_context.access is not self or read_context.personal != personal):
            raise OutboxError(403, "TASK_SOURCE_FORBIDDEN", "来源读取上下文不属于当前本人")
        snapshot = (read_context.snapshot(ref, binding, mode) if read_context is not None
                    else self._snapshot(ref, binding, False, mode=mode))
        if self.identity(personal) != binding:
            raise OutboxError(409, "TASK_BINDING_CHANGED", "读取期间本人账号已变化")
        expires = dt.datetime.fromtimestamp(time.time() + CONTRACT_SECONDS, dt.timezone.utc).isoformat()
        candidate = snapshot["source_policy"] == "candidate_dispatch"
        contract = dict(domain=CANDIDATE_DOMAIN if candidate else DOMAIN, version=1, source_ref=ref, actor_binding=binding,
                        snapshot_hash=snapshot["snapshot_hash"], review_hash=snapshot["review_hash"],
                        review_revision=snapshot["review_revision"], expires_at=expires)
        if candidate:
            contract["candidate_state"] = dict(CANDIDATE_STATE)
        contract["proof"] = self._sign(contract)
        return dict(source_ref=ref, source_contract=contract, dispatch_allowed=True, source_confirm_required=True,
                    item=snapshot["item"], evidence=snapshot["evidence"], self_review=snapshot["self_review"],
                    source_status=snapshot["source_status"], review_revision=snapshot["review_revision"], source_version=source_version(contract),
                    source_policy=snapshot["source_policy"], review_status="unreviewed" if candidate else "confirmed",
                    source_mode="delegate" if candidate else "confirmed", read_only=True)

    @contextlib.contextmanager
    def prepare(self, supplied, contract, personal, confirmed):
        if confirmed is not True:
            raise OutboxError(400, "SOURCE_CONFIRM_REQUIRED", "请本人核对来源与本次派工内容后确认")
        ref, binding = reference(supplied), self.identity(personal)
        candidate = isinstance(contract, dict) and contract.get("domain") == CANDIDATE_DOMAIN
        fields = {"domain", "version", "source_ref", "actor_binding", "snapshot_hash", "review_hash", "review_revision", "expires_at", "proof"}
        if candidate:
            fields.add("candidate_state")
        if (not isinstance(contract, dict) or set(contract) != fields or contract.get("domain") != (CANDIDATE_DOMAIN if candidate else DOMAIN)
                or type(contract.get("version")) is not int or contract["version"] != 1
                or contract["source_ref"] != ref or contract["actor_binding"] != binding
                or candidate and contract.get("candidate_state") != CANDIDATE_STATE):
            raise OutboxError(409, "TASK_SOURCE_CONTRACT_INVALID", "来源与本人核对合同不一致，不能降为手工派工")
        try:
            valid = isinstance(contract["proof"], str) and hmac.compare_digest(contract["proof"], self._sign(contract))
            expiration = dt.datetime.fromisoformat(contract["expires_at"].replace("Z", "+00:00"))
            if expiration.tzinfo is None or expiration.timestamp() <= time.time() or not valid:
                raise ValueError()
        except (ValueError, TypeError, AttributeError):
            raise OutboxError(409, "TASK_SOURCE_CONTRACT_EXPIRED", "来源读取合同已失效，请重新核对") from None
        with self.identity_guard(binding):
            pass
        # Keep meeting and account locks separate. Existing Feishu writes use
        # meeting -> accounts; holding accounts while reading a meeting would
        # invert that established order.
        snapshot = self._snapshot(ref, binding, True, mode="delegate" if candidate else "confirmed")
        if (snapshot["source_policy"] == "candidate_dispatch") != candidate:
            raise OutboxError(409, "TASK_SOURCE_CHANGED", "候选核对状态已变化，请重新读取后明确派工")
        if any(contract[key] != snapshot[key] for key in ("snapshot_hash", "review_hash", "review_revision")):
            raise OutboxError(409, "TASK_SOURCE_CHANGED", "本人核对版本或原话已变化，请重新读取")
        with self.identity_guard(binding):
            receipt = dict(version=1, source_ref=ref, actor_binding=binding, snapshot_hash=snapshot["snapshot_hash"],
                           review_hash=snapshot["review_hash"], confirmed_at=dt.datetime.now(dt.timezone.utc).isoformat(),
                           source_status=snapshot["source_status"], review_revision=snapshot["review_revision"])
            if candidate:
                receipt.update(domain=CANDIDATE_DOMAIN, candidate_state=dict(CANDIDATE_STATE))
            yield receipt

    @staticmethod
    def _receipt_parts(receipt):
        if not isinstance(receipt, dict) or receipt.get("version") != 1:
            raise OutboxError(409, "TASK_PERSONAL_CONFIRM_REQUIRED", "旧来源任务缺少本人派工核对，不能继续发送")
        ref = reference(receipt.get("source_ref"))
        binding = receipt.get("actor_binding")
        if not isinstance(binding, dict):
            raise OutboxError(409, "TASK_BINDING_CHANGED", "原派工身份缺失")
        candidate = receipt.get("domain") == CANDIDATE_DOMAIN
        if receipt.get("domain", DOMAIN) not in (DOMAIN, CANDIDATE_DOMAIN) or candidate and receipt.get("candidate_state") != CANDIDATE_STATE:
            raise OutboxError(409, "TASK_SOURCE_CONTRACT_INVALID", "原派工的候选授权合同无效")
        return ref, binding, candidate

    @staticmethod
    def _compare_receipt(receipt, snapshot, candidate):
        if (snapshot["source_policy"] == "candidate_dispatch") != candidate:
            raise OutboxError(409, "TASK_SOURCE_CHANGED", "原候选的核对状态已变化，已停止旧派工授权")
        if receipt["source_ref"]["kind"] == "label_review" and snapshot["review_revision"] != receipt.get("review_revision"):
            raise OutboxError(409, "TASK_PERSONAL_REVIEW_REVISION_CHANGED", "本人的会议核对版本已更新，请重新核对本次派工")
        if snapshot["snapshot_hash"] != receipt.get("snapshot_hash") or snapshot["review_hash"] != receipt.get("review_hash"):
            raise OutboxError(409, "TASK_SOURCE_CHANGED", "原任务、原话或本人的核对已变化")
        return snapshot["source_status"]

    def validate(self, receipt):
        # POST and worker validation always performs fresh source reads and
        # authoritative account guards. No display context is accepted here.
        ref, binding, candidate = self._receipt_parts(receipt)
        with self.identity_guard(binding):
            pass
        snapshot = self._snapshot(ref, binding, True, mode="delegate" if candidate else "confirmed")
        with self.identity_guard(binding):
            return self._compare_receipt(receipt, snapshot, candidate)
