"""Authenticated Oops → Raft outbox routes, shared by the backend and local bridge host."""
import hmac
import json
import os
import re
import threading
import time
from urllib.parse import urlsplit, parse_qs

from raft_outbox import Outbox, OutboxError
from raft_collaboration import Collaboration
from raft_task_binding import RaftTaskBindings


class RaftApi:
    def __init__(self, state_dir, api_token="", worker_token="", targets=(), enabled=False, collaboration_group=None, backend=None):
        self.state_dir = state_dir
        self.api_token = api_token
        self.worker_token = worker_token
        self.group_binding = collaboration_group or {}
        group_id = self.group_binding.get("channelId")
        self.targets = tuple(dict.fromkeys([*targets, *(["channel:" + group_id] if group_id else [])]))
        self.enabled = bool(enabled and api_token and worker_token and self.targets)
        self._queue = None
        self._lock = threading.Lock()
        self._last_worker_poll = 0
        self._collaboration = None
        self._task_bindings = None
        self.backend_context = backend

    @classmethod
    def from_env(cls, state_dir, backend=None):
        targets = [s.strip() for s in os.environ.get("OOPS_RAFT_TARGETS", "").split(",") if s.strip()]
        return cls(os.path.join(state_dir, "raft"), os.environ.get("OOPS_API_TOKEN", "").strip(),
                   os.environ.get("OOPS_RAFT_WORKER_TOKEN", "").strip(), targets,
                   os.environ.get("OOPS_RAFT_ENABLED") == "1", {
                       "serverId": os.environ.get("OOPS_RAFT_GROUP_SERVER_ID", ""),
                       "channelId": os.environ.get("OOPS_RAFT_GROUP_CHANNEL_ID", ""),
                   }, backend=backend)

    def task_bindings(self):
        with self._lock:
            if self._task_bindings is None:
                self._task_bindings = RaftTaskBindings(self.state_dir, backend=self.backend_context)
            return self._task_bindings

    def collaboration(self):
        if not self.group_binding.get("serverId") or not self.group_binding.get("channelId"):
            raise OutboxError(503, "GROUP_NOT_CONFIGURED", "Oops 协作群尚未连接")
        bindings = self.task_bindings()
        with self._lock:
            if self._collaboration is None:
                self._collaboration = Collaboration(self.state_dir,
                    self.group_binding["serverId"], self.group_binding["channelId"],
                    outbox_target="channel:" + self.group_binding["channelId"], task_bindings=bindings)
            return self._collaboration

    def bridge_online(self):
        return bool(self._last_worker_poll and time.monotonic() - self._last_worker_poll < 40)

    def validate_dispatch(self, job):
        if str(job.get("target", "")).startswith(("channel:", "thread:")):
            return self.collaboration().validate_dispatch(job)
        return True

    def collaboration_call(self, method, route, query, body, personal="", read_context=None):
        if method == "GET" and route == "/v1/raft/collaboration" and not self.group_binding.get("channelId"):
            return {"group": None, "group_status": "not_configured", "group_version": None,
                    "items": [], "bridge_online": self.bridge_online()}
        service, queue = self.collaboration(), self.queue()
        if method == "POST" and route == "/v1/raft/worker/group":
            if not isinstance(body, dict):
                raise OutboxError(400, "BAD_REQUEST", "请求必须是 JSON 对象")
            if body.get("group") is not None:
                return service.update_group(body["group"])
            return service.group_failed(str(body.get("error_code") or "GROUP_READ_FAILED")[:100])
        if method == "GET" and route == "/v1/raft/collaboration":
            return dict(service.overview(queue, personal=personal, read_context=read_context), bridge_online=self.bridge_online())
        if route == "/v1/raft/collaboration/handoffs":
            if method == "POST":
                return service.submit_handoff(body, queue, personal=personal)
            if method == "GET":
                return service.find_request(query["request_id"][0], queue, personal=personal, read_context=read_context) if "request_id" in query else service.overview(queue, personal=personal, read_context=read_context)
        if method == "POST" and route == "/v1/raft/collaboration/continue":
            return service.continue_handoff(body, queue, personal=personal)
        if method == "POST" and route == "/v1/raft/collaboration/reviews":
            return service.review(body, queue, personal=personal)
        match = re.fullmatch(r"/v1/raft/collaboration/handoffs/([a-f0-9]{32})(/cancel)?", route)
        if match and method == "GET" and not match.group(2):
            return service.get(match.group(1), queue, personal=personal, read_context=read_context)
        if match and method == "POST" and match.group(2):
            if not isinstance(body, dict) or body.get("confirm") is not True:
                raise OutboxError(400, "CONFIRM_REQUIRED", "请明确确认取消尚未发送的任务简报")
            return service.cancel(match.group(1), queue, personal=personal)
        raise OutboxError(404, "NOT_FOUND", "没有这个群协作接口")

    def queue(self):
        if not self.enabled:
            raise OutboxError(503, "RAFT_NOT_CONFIGURED", "Raft 尚未配置独立身份、收件人与桥接凭据")
        with self._lock:
            if self._queue is None:
                self._queue = Outbox(self.state_dir, self.targets)
            return self._queue

    @staticmethod
    def source_reference(query):
        kind = query.get("kind", [None])[0]
        field = "session_id" if kind == "meeting_item" else "source_meeting_id" if kind == "label_review" else None
        fields = {"kind", "item_id", "fingerprint", field} if field else set()
        if not fields or set(query) - {"mode"} != fields or any(len(values) != 1 for values in query.values()):
            raise OutboxError(400, "BAD_REQUEST", "请选择明确的原任务来源，不接收身份声明或任意来源地址")
        if query.get("mode", ["confirmed"])[0] not in ("confirmed", "delegate"):
            raise OutboxError(400, "BAD_REQUEST", "来源读取模式无效")
        return {key: query[key][0] for key in fields}

    @staticmethod
    def redact_source_links(result, error):
        for task in result["items"]:
            task.update(title=None, text=None, body_unavailable=True, reply_reviews=[],
                        source_status="temporarily_unavailable" if error.http_status >= 500 else "unavailable", source_error=error.code)
            records = []
            for record in task.get("collaborations", []):
                safe = {key: record[key] for key in ("id", "task_id", "request_id", "outbox_id", "outbox_request_id", "status", "transport_status",
                                                    "raft_message_id", "created_at", "updated_at") if key in record}
                safe["communications"] = [{key: item[key] for key in ("id", "request_id", "outbox_id", "status", "transport_status", "raft_message_id") if key in item}
                                          for item in record.get("communications", [])]
                safe.update(body_unavailable=True, replies=[], reviews=[], source_error=error.code)
                records.append(safe)
            task["collaborations"] = records
        return result

    def task_collaborations(self, task, personal, read_context=None):
        if not self.group_binding.get("serverId") or not self.group_binding.get("channelId"):
            task["collaborations"] = []
            return task
        collaboration, queue = self.collaboration(), self.queue()
        records = {record["id"]: record for record in collaboration.for_task(task["id"], queue, personal=personal, read_context=read_context)["items"]}
        for link in task.get("handoffs", []):
            if link["handoff_id"] not in records:
                records[link["handoff_id"]] = collaboration.get(link["handoff_id"], queue, personal=personal, read_context=read_context)
        # A collaboration read can invalidate the source after the caller's
        # initial task read. Refresh the task before returning its body.
        task.update(self.task_bindings().get(task["id"], read_context=read_context))
        task["collaborations"] = list(records.values())
        if task.get("body_unavailable"):
            self.redact_source_links({"items": [task]}, OutboxError(
                503 if task["source_status"] == "temporarily_unavailable" else 409,
                task.get("source_error") or "TASK_SOURCE_UNAVAILABLE", "任务来源当前不可用"))
        return task

    def call(self, method, path, authorization, body=None, personal=""):
        parsed = urlsplit(path)
        route = parsed.path
        worker = route.startswith("/v1/raft/worker/")
        token = self.worker_token if worker else self.api_token
        if not token or not hmac.compare_digest(authorization.encode(), ("Bearer " + token).encode()):
            raise OutboxError(401, "UNAUTHORIZED", "Raft 桥接凭据无效" if worker else "服务访问凭据无效")
        # Explicit, call-local display context. POST and worker paths never
        # receive it, including SDK pre-send validation and reply writes.
        display_route = route.startswith(("/v1/raft/source", "/v1/raft/tasks", "/v1/raft/collaboration"))
        read_context = self.task_bindings().sources.read_context(personal) if method == "GET" and not worker and display_route else None
        if method == "GET" and route in ("/v1/raft/source", "/v1/raft/source/links"):
            self.queue()
            service = self.task_bindings()
            query = parse_qs(parsed.query, keep_blank_values=True)
            ref = self.source_reference(query)
            mode = query.get("mode", ["confirmed"])[0]
            if not personal:
                raise OutboxError(401, "TASK_ACCOUNT_REQUIRED", "请先连接本人的飞书账号")
            if route == "/v1/raft/source":
                current = service.sources.read(ref, personal, mode=mode, read_context=read_context)
                dispatch = self.collaboration().source_dispatch_status(ref, personal, self.queue())
                return dict(current, dispatch_allowed=current["dispatch_allowed"] and not dispatch["blocking_dispatch"], **dispatch)
            result = service.find_source(ref, personal, read_context=read_context)
            for task in result["items"]:
                self.task_collaborations(task, personal, read_context=read_context)
            history_dispatch = self.collaboration().task_dispatch_status([task["id"] for task in result["items"]], self.queue(), personal=personal)
            try:
                current = service.sources.read(ref, personal, mode=mode, read_context=read_context)
                dispatch = self.collaboration().source_dispatch_status(ref, personal, self.queue())
            except OutboxError as error:
                return dict(self.redact_source_links(result, error), source_ref=ref, source_status="temporarily_unavailable" if error.http_status >= 500 else "unavailable",
                            dispatch_allowed=False, source_error=error.code, **history_dispatch)
            return dict(result, source_ref=ref, source_status=current["source_status"], dispatch_allowed=current["dispatch_allowed"] and not dispatch["blocking_dispatch"], source_version=current["source_version"],
                        source_policy=current["source_policy"], review_status=current["review_status"], source_mode=current["source_mode"], read_only=True, **dispatch)
        if route == "/v1/raft/tasks":
            self.queue()  # Require explicitly enabled authenticated integration.
            service = self.task_bindings()
            if method == "POST":
                # Exact original request recovery must remain readable after
                # delivery becomes unknown. Only a new task registration is
                # blocked by unresolved transport across source versions.
                if isinstance(body, dict) and "task_ref" in body and not service.find_request(body.get("request_id"), personal=personal, external=True)["items"]:
                    dispatch = self.collaboration().source_dispatch_status(body["task_ref"], personal, self.queue())
                    if dispatch["blocking_dispatch"]:
                        raise OutboxError(409, "SOURCE_DISPATCH_UNRESOLVED", "原事项仍有未知或正在发送的派工，请查询原线程，不能另派")
                return self.task_collaborations(service.create(body, personal=personal), personal)
            if method == "GET":
                query = parse_qs(parsed.query)
                result = service.find_request(query["request_id"][0], personal=personal, external=True, read_context=read_context) if "request_id" in query else service.list(personal=personal, external=True, read_context=read_context)
                for task in result["items"]:
                    self.task_collaborations(task, personal, read_context=read_context)
                return result
        task_match = re.fullmatch(r"/v1/raft/tasks/(raft-task:[a-f0-9]{32})", route)
        if task_match and method == "GET":
            self.queue()
            return self.task_collaborations(self.task_bindings().read_task(task_match.group(1), personal, read_context=read_context), personal, read_context=read_context)
        if route.startswith("/v1/raft/collaboration") or route == "/v1/raft/worker/group":
            return self.collaboration_call(method, route, parse_qs(parsed.query), body, personal=personal, read_context=read_context)
        if method == "GET" and route in ("/v1/raft/status", "/v1/raft/worker/status"):
            return {"enabled": self.enabled, "allowed_targets": list(self.targets),
                    "bridge_online": self.bridge_online(),
                    "mode": "explicit_text_only", "transport": "raft-sdk",
                    **(self.queue().status() if self.enabled else {"counts": {}}),
                    "allowed_targets": [target for target in self.targets if not target.startswith(("channel:", "thread:"))]}
        queue = self.queue()
        if method == "GET" and route in ("/v1/raft/messages", "/v1/raft/worker/messages"):
            query = parse_qs(parsed.query)
            if "request_id" in query:
                result = queue.find_request(query["request_id"][0])
                if not worker:
                    result["items"] = [item for item in result["items"] if not item["target"].startswith(("channel:", "thread:"))]
                return result
            try:
                limit = int(query.get("limit", ["30"])[0])
            except ValueError:
                raise OutboxError(400, "BAD_REQUEST", "limit 必须是整数") from None
            result = queue.list(limit=limit, status=query.get("status", [None])[0])
            if not worker:
                result["items"] = [item for item in result["items"] if not item["target"].startswith(("channel:", "thread:"))]
            return result
        match = re.fullmatch(r"/v1/raft/messages/([a-f0-9]{32})(/cancel)?", route)
        if match:
            if method == "GET" and not match.group(2):
                item = queue.get(match.group(1))
                if item["target"].startswith(("channel:", "thread:")):
                    raise OutboxError(400, "GROUP_ENTRY_REQUIRED", "群任务与回复请从协作群入口读取")
                return item
            if method == "POST" and match.group(2):
                if not isinstance(body, dict) or body.get("confirm") is not True:
                    raise OutboxError(400, "CONFIRM_REQUIRED", "请明确确认取消这条尚未发出的消息")
                if queue.get(match.group(1))["target"].startswith(("channel:", "thread:")):
                    raise OutboxError(400, "GROUP_ENTRY_REQUIRED", "群任务请从协作群入口取消")
                return queue.cancel(match.group(1))
        if method == "POST" and route == "/v1/raft/messages":
            if isinstance(body, dict) and str(body.get("target", "")).strip().startswith(("channel:", "thread:")):
                raise OutboxError(400, "GROUP_CONFIRM_REQUIRED", "群内任务与续发请从协作群入口逐次核对")
            return queue.submit(body)
        if method == "POST" and route == "/v1/raft/worker/poll":
            if not isinstance(body, dict) or not isinstance(body.get("worker"), str) or not body["worker"].strip():
                raise OutboxError(400, "BAD_REQUEST", "缺少桥接进程标识")
            self._last_worker_poll = time.monotonic()
            result = queue.claim(body["worker"])
            if result.get("job"):
                job = result["job"]
                try:
                    self.validate_dispatch(job)
                except OutboxError as error:
                    queue.settle(job["id"], job["lease"], {"status": "failed", "error": error.code})
                    return {"job": None, "blocked_job_id": job["id"]}
            return result
        match = re.fullmatch(r"/v1/raft/worker/jobs/([a-f0-9]{32})/validate", route)
        if method == "POST" and match:
            if not isinstance(body, dict):
                raise OutboxError(400, "BAD_REQUEST", "请求必须是 JSON 对象")
            job = queue.lease_view(match.group(1), body.get("lease"))
            self.validate_dispatch(job)
            return {"valid": True, "id": job["id"]}
        match = re.fullmatch(r"/v1/raft/worker/jobs/([a-f0-9]{32})/settle", route)
        if method == "POST" and match:
            if not isinstance(body, dict):
                raise OutboxError(400, "BAD_REQUEST", "请求必须是 JSON 对象")
            receipt = dict(body)
            lease = receipt.pop("lease", None)
            return queue.settle(match.group(1), lease, receipt)
        if method == "POST" and route == "/v1/raft/worker/replies":
            if not isinstance(body, dict):
                raise OutboxError(400, "BAD_REQUEST", "请求必须是 JSON 对象")
            reply = dict(body)
            job = queue.by_raft_message(reply.pop("source_message_id", None))
            return queue.record_reply(job["id"], reply)
        raise OutboxError(404, "NOT_FOUND", "没有这个 Raft 接口")

    def handle(self, handler, method):
        body = None
        if method == "POST":
            try:
                size = int(handler.headers.get("Content-Length") or 0)
                if not 0 < size <= 64_000:
                    raise ValueError()
                body = json.loads(handler.rfile.read(size))
            except (ValueError, UnicodeError):
                raise OutboxError(400, "BAD_REQUEST", "请求必须是合法 JSON，且不超过 64 KB") from None
        return self.call(method, handler.path, handler.headers.get("Authorization", ""), body,
                         personal=handler.headers.get("X-Oops-User-Token", ""))
