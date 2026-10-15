"""Per-install Oops principals and server-side Feishu OAuth; never falls back to lark-cli.

Deployment config (or equivalent lower-case keys passed as ``config``)::

    OOPS_FEISHU_CLIENT_ID, OOPS_FEISHU_CLIENT_SECRET
    OOPS_FEISHU_REDIRECT_URI  # fixed, registered HTTPS callback; no client override
    OOPS_FEISHU_TOKEN_KEY     # cryptography.fernet.Fernet.generate_key(), kept outside state
    OOPS_FEISHU_OAUTH_SCOPES  # space-separated approved scopes; default: offline_access

``cryptography`` is an optional deployment dependency, required for OAuth. Missing
configuration, a missing library, or an invalid key closes OAuth without blocking
creation of an anonymous phone principal. No token is written without encryption.
The injected transport is ``(method, url, headers, body_dict_or_none, timeout)``
and returns ``(http_status, json_dict)`` (a dict alone means HTTP 200).

Protocol sources: https://open.feishu.cn/document/authentication-management/access-token/obtain-oauth-code
https://open.feishu.cn/document/authentication-management/access-token/get-user-access-token
https://open.feishu.cn/document/authentication-management/access-token/refresh-user-access-token
https://open.feishu.cn/document/server-docs/authentication-management/login-state-management/get
Official PKCE implementation: https://github.com/larksuite/lark-openapi-mcp/blob/main/src/auth/provider/oauth.ts
"""

import base64
import contextlib
import copy
import fcntl
import hashlib
import json
import os
import re
import secrets
import stat
import tempfile
import threading
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
import uuid

try:
    from cryptography.fernet import Fernet
except ImportError:
    Fernet = None


AUTHORIZE_URL = "https://accounts.feishu.cn/open-apis/authen/v1/authorize"
API_ORIGIN = "https://open.feishu.cn"
TOKEN_PATH = "/open-apis/authen/v2/oauth/token"
USERINFO_PATH = "/open-apis/authen/v1/user_info"
STATE_TTL = 10 * 60
TOKEN_MARGIN = 60
MAX_RESPONSE = 2 * 1024 * 1024
RECIPIENT_SEARCH_PATH = "/open-apis/search/v1/user"
RECIPIENT_SEARCH_TTL = 30 * 60
RECIPIENT_SEARCH_LIMIT = 100
AUTH_CODES = {99991661, 99991663, 99991668, 99991669, 99991677, 99991679}
_LOCKS = {}
_LOCKS_LOCK = threading.Lock()


class AccountError(Exception):
    """Safe to present to the client; never contains provider bodies or credentials.

    ``uncertain`` means an external write may already have happened. Callers must
    retain the operation receipt and must not replay such writes automatically.
    """

    def __init__(self, status, code, message, uncertain=False, provider_code=None):
        super().__init__(message)
        self.status, self.code, self.message = status, code, message
        self.uncertain = bool(uncertain)
        # Numeric diagnostics only; provider messages/bodies may contain private
        # text, URLs, or credentials and must never enter delivery journals.
        self.provider_code = (provider_code if isinstance(provider_code, int) and not isinstance(provider_code, bool)
                              and 0 <= provider_code <= 2147483647 else None)


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None  # never forward a user bearer to a redirect target


def _transport(method, url, headers, body, timeout):
    request = urllib.request.Request(url, data=(json.dumps(body, ensure_ascii=False).encode("utf-8")
                                               if body is not None else None), headers=headers, method=method)
    opener = urllib.request.build_opener(_NoRedirect)
    try:
        response = opener.open(request, timeout=timeout)
    except urllib.error.HTTPError as error:
        response = error
    with response:
        raw = response.read(MAX_RESPONSE + 1)
        if len(raw) > MAX_RESPONSE:
            raise ValueError("response too large")
        try:
            payload = json.loads(raw.decode("utf-8"))
        except (ValueError, UnicodeError):
            payload = None
        return response.code, payload


def _file_transport(method, url, headers, body, timeout):
    """Multipart bytes only; the JSON/OAuth transport remains unchanged."""
    request = urllib.request.Request(url, data=body, headers=headers, method=method)
    opener = urllib.request.build_opener(_NoRedirect)
    try:
        response = opener.open(request, timeout=timeout)
    except urllib.error.HTTPError as error:
        response = error
    with response:
        raw = response.read(MAX_RESPONSE + 1)
        if len(raw) > MAX_RESPONSE:
            raise ValueError('response too large')
        return response.code, json.loads(raw.decode('utf-8'))


def _digest(value):
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _one(query, key):
    value = query.get(key)
    if isinstance(value, (list, tuple)):
        if len(value) != 1:
            raise AccountError(400, "OAUTH_CALLBACK_INVALID", "授权回调参数无效")
        value = value[0]
    return value if isinstance(value, str) else ""


class Accounts:
    def __init__(self, state_dir, config=None, transport=None, clock=None):
        supplied = config or {}
        names = {"client_id": "OOPS_FEISHU_CLIENT_ID", "client_secret": "OOPS_FEISHU_CLIENT_SECRET",
                 "redirect_uri": "OOPS_FEISHU_REDIRECT_URI", "token_key": "OOPS_FEISHU_TOKEN_KEY",
                 "scopes": "OOPS_FEISHU_OAUTH_SCOPES"}
        self.config = {key: supplied.get(key, os.environ.get(env, "")) for key, env in names.items()}
        scopes = self.config["scopes"] or "offline_access"
        try:
            self.scopes = list(dict.fromkeys(scopes.split() if isinstance(scopes, str) else scopes))
        except TypeError:
            self.scopes = [None]  # invalid config closes OAuth, anonymous sessions remain available
        self.clock = clock or time.time
        self.transport = transport or _transport
        self.dir = os.path.join(os.fspath(state_dir), "feishu-accounts")
        if os.path.islink(self.dir):
            raise AccountError(503, "ACCOUNTS_STORAGE_UNAVAILABLE", "个人授权存储不可用")
        os.makedirs(self.dir, mode=0o700, exist_ok=True)
        os.chmod(self.dir, 0o700)
        self.path = os.path.join(self.dir, "accounts.json")
        self.lock_path = os.path.join(self.dir, "accounts.lock")
        with _LOCKS_LOCK:
            self.lock = _LOCKS.setdefault(os.path.realpath(self.dir), threading.RLock())
        self.fernet = None
        if Fernet is not None and self.config["token_key"]:
            try:
                key = self.config["token_key"]
                self.fernet = Fernet(key.encode("ascii") if isinstance(key, str) else key)
            except (ValueError, TypeError, UnicodeError):
                pass

    @property
    def available(self):
        try:
            uri = urllib.parse.urlsplit(str(self.config["redirect_uri"]))
        except ValueError:
            return False
        return bool(self.fernet and self.config["client_id"] and self.config["client_secret"]
                    and uri.scheme == "https" and uri.hostname and not uri.username and not uri.password
                    and not uri.fragment and not uri.query
                    and all(isinstance(s, str) and re.fullmatch(r"[A-Za-z0-9_.:-]{1,150}", s) for s in self.scopes))

    def _ready(self):
        if not self.available:
            raise AccountError(503, "FEISHU_OAUTH_UNAVAILABLE", "飞书个人授权尚未配置完成")

    @contextlib.contextmanager
    def _transaction(self):
        with self.lock:
            fd = None
            try:
                fd = os.open(self.lock_path, os.O_CREAT | os.O_RDWR | getattr(os, "O_NOFOLLOW", 0), 0o600)
                os.fchmod(fd, 0o600)
                fcntl.flock(fd, fcntl.LOCK_EX)
                data = self._load()
                yield data
            except AccountError:
                raise
            except (OSError, ValueError, TypeError):
                raise AccountError(503, "ACCOUNTS_STORAGE_UNAVAILABLE", "个人授权存储不可用") from None
            finally:
                if fd is not None:
                    fcntl.flock(fd, fcntl.LOCK_UN)
                    os.close(fd)

    def _load(self):
        try:
            fd = os.open(self.path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
        except FileNotFoundError:
            return {"version": 1, "sessions": {}, "states": {}}
        with os.fdopen(fd, "r", encoding="utf-8") as stream:
            if not stat.S_ISREG(os.fstat(stream.fileno()).st_mode):
                raise ValueError("not regular")
            os.fchmod(stream.fileno(), 0o600)
            data = json.load(stream)
        if not isinstance(data, dict) or data.get("version") != 1 or not isinstance(data.get("sessions"), dict) or not isinstance(data.get("states"), dict):
            raise ValueError("invalid store")
        return data

    def _save(self, data):
        fd, temp = tempfile.mkstemp(dir=self.dir, prefix=".accounts-", suffix=".tmp")
        try:
            os.fchmod(fd, 0o600)
            with os.fdopen(fd, "w", encoding="utf-8") as stream:
                json.dump(data, stream, ensure_ascii=False, separators=(",", ":"))
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temp, self.path)
            directory = os.open(self.dir, os.O_RDONLY)
            try:
                os.fsync(directory)
            finally:
                os.close(directory)
        finally:
            if os.path.exists(temp):
                os.unlink(temp)

    def _session(self, data, token):
        if not isinstance(token, str) or not re.fullmatch(r"[A-Za-z0-9_-]{43,200}", token):
            raise AccountError(401, "OOPS_USER_UNAUTHORIZED", "个人会话无效，请重新连接此手机")
        entry = data["sessions"].get(_digest(token))
        if not entry:
            raise AccountError(401, "OOPS_USER_UNAUTHORIZED", "个人会话无效，请重新连接此手机")
        return entry

    def _seal(self, value):
        self._ready()
        return self.fernet.encrypt(json.dumps(value, separators=(",", ":")).encode("utf-8")).decode("ascii")

    def _unseal(self, value):
        self._ready()
        try:
            result = json.loads(self.fernet.decrypt(value.encode("ascii")).decode("utf-8"))
            if not isinstance(result, dict):
                raise ValueError("invalid credentials")
            return result
        except Exception:
            raise AccountError(503, "FEISHU_CREDENTIAL_LOCKED", "个人授权无法解密，请检查服务配置或重新授权") from None

    def create_session(self):
        token = secrets.token_urlsafe(48)
        with self._transaction() as data:
            entry = {"principal_id": uuid.uuid4().hex, "binding_revision": 0, "created_at": self.clock()}
            data["sessions"][_digest(token)] = entry
            self._save(data)
        return {"session_token": token, "principal_id": entry["principal_id"]}

    def principal(self, session_token):
        with self._transaction() as data:
            return self._session(data, session_token)["principal_id"]

    def _readonly_snapshot(self):
        """Atomic-file snapshot only. Never use it as permission for an external write."""
        try:
            return self._load()
        except (OSError, ValueError, TypeError):
            raise AccountError(503, "ACCOUNTS_STORAGE_UNAVAILABLE", "个人授权存储不可用") from None

    def principal_readonly_snapshot(self, session_token):
        """Nonblocking UI/queue identity read; workers must recheck under the write lock."""
        return self._session(self._readonly_snapshot(), session_token)["principal_id"]

    def status_readonly_snapshot(self, session_token):
        """Nonblocking UI snapshot; possibly one atomic commit behind a concurrent change."""
        return self._status(self._session(self._readonly_snapshot(), session_token))

    def _binding_status(self, entry):
        if not self.available:
            return "unavailable"
        if not entry.get("account"):
            return "unbound"
        if entry.get("binding_state") != "bound" or entry.get("client_id") != self.config["client_id"]:
            return "expired"
        try:
            tokens = self._unseal(entry.get("credentials", ""))
        except AccountError:
            return "unavailable"
        now = self.clock()
        if tokens.get("expires_at", 0) > now or (tokens.get("refresh_token") and tokens.get("refresh_expires_at", 0) > now):
            return "bound"
        return "expired"

    def _status(self, entry):
        status = self._binding_status(entry)
        scope = set()
        if status == "bound":
            scope = set(self._unseal(entry["credentials"]).get("scopes", []))
        def has(*options):
            return status == "bound" and bool(scope.intersection(options))
        create_document = has("docx:document", "docx:document:create")
        write_document = has("docx:document", "docx:document:write_only", "docs:document.content:write")
        # Permission scopes use the docs: namespace, even on /drive/v1 APIs.
        # Metadata is a separate permission; creating a document does not imply it.
        settings_read = has("docs:permission.setting:read", "drive:drive", "drive:drive:readonly", "drive:file", "docs:doc")
        settings_write = has("docs:permission.setting:write_only", "drive:drive", "drive:file", "docs:doc")
        members_create = has("docs:permission.member:create", "drive:drive", "drive:file", "docs:doc")
        metadata_read = has("drive:drive", "drive:drive.metadata:readonly")
        messages_send = status == "bound" and {"im:message", "im:message.send_as_user"}.issubset(scope)
        calendar_create = has("calendar:calendar", "calendar:calendar.event:create")
        # Primary-calendar lookup and event read-back are required before we
        # report a personally confirmed calendar operation as successful.
        calendar_read = has("calendar:calendar", "calendar:calendar:readonly")
        calendar_invite = has("calendar:calendar", "calendar:calendar.event:update")
        files_upload = has("im:resource", "im:resource:upload")
        return {"principal_id": entry["principal_id"], "binding_revision": entry["binding_revision"],
                "status": status, "account": copy.deepcopy(entry.get("account")),
                "capabilities": {"oauth": self.available, "recipients": status == "bound",
                    "recipients_search": has("contact:user:search"),
                    "task_write": has("task:task:write") or (has("task:task:writeonly") and has("task:task:read")),
                    "documents_read": has("docx:document", "docx:document:readonly", "docs:document.content:read"),
                    "documents_create": create_document, "documents_write": write_document,
                    "documents_content_write": write_document,
                    "sharing": members_create, "sharing_members_create": members_create,
                    "sharing_settings_read": settings_read, "sharing_settings_write": settings_write,
                    "metadata_read": metadata_read, "messages_send": messages_send,
                    "files_upload": files_upload, "agent_file_delivery": files_upload and messages_send,
                    "minutes_delivery": all((create_document, write_document, settings_read, settings_write,
                                              members_create, metadata_read, messages_send)),
                    "calendar_write": calendar_create, "calendar_create": calendar_create,
                    "calendar_read": calendar_read, "calendar_invite": calendar_invite,
                    "calendar_delivery": calendar_create and calendar_read}}

    def status(self, session_token):
        with self._transaction() as data:
            return self._status(self._session(data, session_token))

    @staticmethod
    def _entry_for_principal(data, principal_id):
        if not isinstance(principal_id, str) or not re.fullmatch(r"[a-f0-9]{32}", principal_id):
            raise AccountError(401, "OOPS_USER_UNAUTHORIZED", "个人会话身份无效")
        entry = next((item for item in data["sessions"].values() if item["principal_id"] == principal_id), None)
        if not entry:
            raise AccountError(401, "OOPS_USER_UNAUTHORIZED", "个人会话身份无效")
        return entry

    def status_for_principal(self, principal_id):
        """Server-only background lookup; never expose principal as HTTP credentials."""
        with self._transaction() as data:
            return self._status(self._entry_for_principal(data, principal_id))

    def _check_binding(self, entry, expected_binding):
        if expected_binding is None:
            return
        account = entry.get("account") or {}
        if (not isinstance(expected_binding, dict)
                or expected_binding.get("binding_revision") != entry["binding_revision"]
                or expected_binding.get("account_open_id") != account.get("open_id")
                or expected_binding.get("tenant_key") != account.get("tenant_key")):
            raise AccountError(409, "FEISHU_BINDING_CHANGED", "个人飞书绑定已变化，请重新核对此操作")

    def begin(self, session_token):
        self._ready()
        state, verifier, attempt = secrets.token_urlsafe(32), secrets.token_urlsafe(64), uuid.uuid4().hex
        expires = self.clock() + STATE_TTL
        with self._transaction() as data:
            entry = self._session(data, session_token)
            data["states"] = {key: value for key, value in data["states"].items()
                              if value["expires_at"] > self.clock() and value["principal_id"] != entry["principal_id"]}
            entry["oauth_attempt"] = attempt
            data["states"][_digest(state)] = {"principal_id": entry["principal_id"], "revision": entry["binding_revision"],
                "attempt": attempt, "expires_at": expires, "verifier": self._seal({"value": verifier})}
            self._save(data)
        challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode("ascii")).digest()).rstrip(b"=").decode("ascii")
        params = {"client_id": self.config["client_id"], "response_type": "code", "redirect_uri": self.config["redirect_uri"],
                  "scope": " ".join(self.scopes), "state": state, "code_challenge": challenge,
                  "code_challenge_method": "S256", "prompt": "consent"}
        return {"authorization_url": AUTHORIZE_URL + "?" + urllib.parse.urlencode(params), "expires_at": expires}

    def _request(self, method, path, body=None, access_token=None, params=None):
        method = str(method).upper()
        if method not in {"GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"}:
            raise AccountError(400, "FEISHU_REQUEST_INVALID", "飞书请求方法无效")
        parsed = urllib.parse.urlsplit(str(path))
        decoded = urllib.parse.unquote(parsed.path)
        if (parsed.scheme or parsed.netloc or parsed.fragment or not parsed.path.startswith("/open-apis/")
                or "\\" in decoded or any(segment in (".", "..") for segment in decoded.split("/"))
                or any(ord(char) < 32 for char in str(path))):
            raise AccountError(400, "FEISHU_REQUEST_INVALID", "飞书请求地址无效")
        query = urllib.parse.parse_qsl(parsed.query, keep_blank_values=True)
        if params:
            if not isinstance(params, dict):
                raise AccountError(400, "FEISHU_REQUEST_INVALID", "飞书请求参数无效")
            query.extend(params.items())
        if any(str(key).lower() in {"access_token", "user_access_token", "refresh_token", "tenant_access_token"} for key, _ in query):
            raise AccountError(400, "FEISHU_REQUEST_INVALID", "飞书请求参数无效")
        url = API_ORIGIN + parsed.path + (("?" + urllib.parse.urlencode(query, doseq=True)) if query else "")
        headers = {"Content-Type": "application/json; charset=utf-8", "Accept": "application/json"}
        if access_token:
            headers["Authorization"] = "Bearer " + access_token
        try:
            result = self.transport(method, url, headers, body, 20)
        except AccountError:
            raise
        except Exception:
            raise AccountError(502, "FEISHU_NETWORK_UNAVAILABLE", "飞书响应未确认，请查询原操作结果", uncertain=method not in {"GET", "HEAD"}) from None
        try:
            http_status, payload = (200, result) if isinstance(result, dict) else result
        except (TypeError, ValueError):
            raise AccountError(502, "FEISHU_RESPONSE_INVALID", "飞书回包无法核对，请查询原操作结果", uncertain=method not in {"GET", "HEAD"}) from None
        if not isinstance(http_status, int) or not isinstance(payload, dict):
            raise AccountError(502, "FEISHU_RESPONSE_INVALID", "飞书回包无法核对，请查询原操作结果", uncertain=method not in {"GET", "HEAD"})
        return http_status, payload

    @staticmethod
    def _accepted(http_status, payload):
        return 200 <= http_status < 300 and payload.get("code", 0) in (0, "0", None) and not payload.get("error")

    def _tokens(self, payload):
        if not isinstance(payload.get("access_token"), str) or not payload["access_token"]:
            raise AccountError(502, "FEISHU_TOKEN_INVALID", "飞书授权回包不完整，请重新授权")
        if str(payload.get("token_type", "Bearer")).lower() != "bearer":
            raise AccountError(502, "FEISHU_TOKEN_INVALID", "飞书授权凭据类型无法核对，请重新授权")
        try:
            expires = int(payload["expires_in"])
            refresh_expires = int(payload.get("refresh_token_expires_in") or 0)
            if expires <= 0 or isinstance(payload["expires_in"], bool) or refresh_expires < 0:
                raise ValueError("invalid expiry")
        except (KeyError, TypeError, ValueError, OverflowError):
            raise AccountError(502, "FEISHU_TOKEN_INVALID", "飞书授权有效期无法核对，请重新授权") from None
        refresh = payload.get("refresh_token")
        if refresh is not None and not isinstance(refresh, str):
            raise AccountError(502, "FEISHU_TOKEN_INVALID", "飞书授权回包不完整，请重新授权")
        scope = payload.get("scope") or ""
        if not isinstance(scope, str):
            raise AccountError(502, "FEISHU_TOKEN_INVALID", "飞书授权范围无法核对，请重新授权")
        return {"access_token": payload["access_token"], "expires_at": self.clock() + expires,
                "refresh_token": refresh or "", "refresh_expires_at": self.clock() + refresh_expires,
                "scopes": scope.split()}

    def callback(self, query):
        self._ready()
        if isinstance(query, str):
            query = urllib.parse.parse_qs(query.lstrip("?"), keep_blank_values=True)
        if not isinstance(query, dict):
            raise AccountError(400, "OAUTH_CALLBACK_INVALID", "授权回调参数无效")
        state = _one(query, "state")
        if not re.fullmatch(r"[A-Za-z0-9_-]{43,200}", state):
            raise AccountError(400, "OAUTH_STATE_INVALID", "授权状态已失效，请从手机重新开始")
        with self._transaction() as data:
            pending = data["states"].pop(_digest(state), None)
            self._save(data)  # consume before exchange, including cancellation and failures
            if not pending or pending["expires_at"] <= self.clock():
                raise AccountError(400, "OAUTH_STATE_INVALID", "授权状态已失效，请从手机重新开始")
            entry = next((item for item in data["sessions"].values() if item["principal_id"] == pending["principal_id"]), None)
            if not entry or entry.get("oauth_attempt") != pending["attempt"] or entry["binding_revision"] != pending["revision"]:
                raise AccountError(400, "OAUTH_STATE_INVALID", "授权状态已失效，请从手机重新开始")
        if _one(query, "error"):
            raise AccountError(400, "FEISHU_AUTH_CANCELLED", "本次飞书授权已取消，原绑定保持不变")
        code = _one(query, "code")
        if not code or len(code) > 2000:
            raise AccountError(400, "OAUTH_CALLBACK_INVALID", "授权回调缺少有效授权码")
        body = {"grant_type": "authorization_code", "client_id": self.config["client_id"],
                "client_secret": self.config["client_secret"], "code": code,
                "redirect_uri": self.config["redirect_uri"], "code_verifier": self._unseal(pending["verifier"])["value"]}
        http, response = self._request("POST", TOKEN_PATH, body)
        if not self._accepted(http, response):
            raise AccountError(400, "FEISHU_AUTH_REJECTED", "飞书未完成授权，原绑定保持不变")
        tokens = self._tokens(response)
        http, info = self._request("GET", USERINFO_PATH, access_token=tokens["access_token"])
        account = info.get("data") or {}
        if not self._accepted(http, info) or not isinstance(account, dict) or not all(isinstance(account.get(key), str) and account[key] for key in ("open_id", "tenant_key", "name")):
            raise AccountError(502, "FEISHU_IDENTITY_UNVERIFIED", "飞书身份无法核对，原绑定保持不变")
        if not re.fullmatch(r"ou_[A-Za-z0-9_-]{1,150}", account["open_id"]):
            raise AccountError(502, "FEISHU_IDENTITY_UNVERIFIED", "飞书身份无法核对，原绑定保持不变")
        account = {"open_id": account["open_id"], "tenant_key": account["tenant_key"][:150],
                   "name": "".join(char for char in account["name"][:120] if ord(char) >= 32)}
        with self._transaction() as data:
            entry = next((item for item in data["sessions"].values() if item["principal_id"] == pending["principal_id"]), None)
            if not entry or entry.get("oauth_attempt") != pending["attempt"] or entry["binding_revision"] != pending["revision"]:
                raise AccountError(409, "OAUTH_STATE_INVALID", "授权期间绑定已变化，请从手机重新开始")
            entry.update(account=account, credentials=self._seal(tokens), binding_state="bound",
                         client_id=self.config["client_id"], binding_revision=entry["binding_revision"] + 1)
            entry.pop("oauth_attempt", None)
            entry.pop("recipient_search", None)
            self._save(data)
            return self._status(entry)

    def disconnect(self, session_token):
        with self._transaction() as data:
            entry = self._session(data, session_token)
            for key in ("account", "credentials", "binding_state", "client_id", "oauth_attempt", "recipient_search"):
                entry.pop(key, None)
            entry["binding_revision"] += 1
            data["states"] = {key: value for key, value in data["states"].items() if value["principal_id"] != entry["principal_id"]}
            self._save(data)
            return self._status(entry)

    def _bound(self, entry):
        self._ready()
        if self._binding_status(entry) != "bound":
            raise AccountError(401, "FEISHU_AUTH_REQUIRED", "请先在此手机完成个人飞书授权")

    def _expire(self, data, entry):
        entry.pop("credentials", None)
        entry.pop("recipient_search", None)
        entry["binding_state"] = "expired"
        self._save(data)

    def _refresh(self, data, entry, tokens):
        if not tokens.get("refresh_token") or tokens.get("refresh_expires_at", 0) <= self.clock():
            self._expire(data, entry)
            raise AccountError(401, "FEISHU_AUTH_EXPIRED", "个人飞书授权已失效，请重新授权")
        try:
            http, response = self._request("POST", TOKEN_PATH, {"grant_type": "refresh_token", "client_id": self.config["client_id"],
                "client_secret": self.config["client_secret"], "refresh_token": tokens["refresh_token"]})
            if not self._accepted(http, response):
                raise ValueError("refresh rejected")
            refreshed = self._tokens(response)
            # Rotating refresh tokens must be saved before any business request.
            entry["credentials"] = self._seal(refreshed)
            self._save(data)
            return refreshed
        except Exception:
            self._expire(data, entry)
            raise AccountError(401, "FEISHU_AUTH_EXPIRED", "个人飞书授权刷新失败，请重新授权") from None

    @staticmethod
    def _operation_guard(before_request):
        if before_request is None:
            return
        try:
            before_request()
        except Exception as error:
            # DeliveryError is a ValueError: translate the server-only source
            # guard before the storage transaction can misclassify it as bad JSON.
            if getattr(error, "code", None) in {"MINUTES_SOURCE_CHANGED", "MINUTES_SOURCE_UNAVAILABLE",
                    "MINUTES_NOT_READY", "MEETING_OWNER_REQUIRED", "MEETING_IN_PROGRESS"}:
                raise AccountError(error.status, error.code, error.message) from None
            raise AccountError(409, "FEISHU_OPERATION_WITHDRAWN", "操作依据未能核实，未提交飞书请求") from None

    def _user_request(self, data, entry, method, path, body=None, params=None, before_request=None):
        self._bound(entry)
        tokens = self._unseal(entry["credentials"])
        if tokens["expires_at"] <= self.clock() or (tokens.get("refresh_token") and tokens.get("refresh_expires_at", 0) > self.clock()
                and tokens["expires_at"] <= self.clock() + TOKEN_MARGIN):
            tokens = self._refresh(data, entry, tokens)
        method = str(method).upper()
        self._operation_guard(before_request)
        http, payload = self._request(method, path, body, tokens["access_token"], params)
        if http == 401 or payload.get("code") in AUTH_CODES:
            if method in {"GET", "HEAD"}:
                tokens = self._refresh(data, entry, tokens)
                self._operation_guard(before_request)
                http, payload = self._request(method, path, body, tokens["access_token"], params)
            if http == 401 or payload.get("code") in AUTH_CODES:
                self._expire(data, entry)
                raise AccountError(401, "FEISHU_AUTH_EXPIRED", "个人飞书授权已失效，请重新授权")
        if not self._accepted(http, payload):
            if http == 403 or payload.get("code") in {99991672, 99991676}:
                raise AccountError(403, "FEISHU_PERMISSION_DENIED", "当前飞书授权缺少此操作所需权限", provider_code=payload.get("code"))
            raise AccountError(502, "FEISHU_API_REJECTED", "飞书未接受此操作，请核对权限和参数",
                               uncertain=http >= 500 and method not in {"GET", "HEAD"}, provider_code=payload.get("code"))
        return payload

    def user_request(self, session_token, method, path, body=None, params=None):
        self._ready()
        with self._transaction() as data:
            return self._user_request(data, self._session(data, session_token), method, path, body, params)

    def user_request_for_principal(self, principal_id, method, path, body=None, params=None, expected_binding=None, expected_recipients=None, expected_recipient_names=None, before_request=None):
        """Server-only worker route; use token-authenticated routes for HTTP callers."""
        self._ready()
        with self._transaction() as data:
            entry = self._entry_for_principal(data, principal_id)
            self._check_binding(entry, expected_binding)
            if expected_recipients is not None:
                self._validate_recipients(data, entry, expected_recipients, expected_recipient_names)
            return self._user_request(data, entry, method, path, body, params, before_request)

    def user_file_request_for_principal(self, principal_id, name, content, expected_binding=None,
                                        expected_recipients=None, transport=None, expected_recipient_names=None,
                                        before_request=None):
        """Upload a frozen original through IM File.Create with this user's token.

        Official SDK: service/im/v1/resource.go file.Create supports User/Tenant;
        this method uses User only. Upload is a write: no automatic auth replay.
        """
        self._ready()
        if (not isinstance(name, str) or not name or len(name) > 120 or os.path.basename(name) != name or
                any(c in name for c in ('"', '\r', '\n', '\\')) or
                not isinstance(content, bytes) or not 0 < len(content) <= 20 * 1024 * 1024):
            raise AccountError(400, 'BAD_RESULT_FILE', '成果文件名称或大小无效')
        boundary = 'oops-' + secrets.token_hex(24)
        # stream preserves arbitrary original bytes, including PPTX, without conversion.
        parts = []
        for key, value in (('file_type', 'stream'), ('file_name', name)):
            parts.append(('--' + boundary + '\r\nContent-Disposition: form-data; name="' + key + '"\r\n\r\n' + value + '\r\n').encode())
        parts += [('--' + boundary + '\r\nContent-Disposition: form-data; name="file"; filename="' + name + '"\r\nContent-Type: application/octet-stream\r\n\r\n').encode(),
                  content, ('\r\n--' + boundary + '--\r\n').encode()]
        with self._transaction() as data:
            entry = self._entry_for_principal(data, principal_id)
            self._bound(entry)
            self._check_binding(entry, expected_binding)
            if expected_recipients is not None:
                self._validate_recipients(data, entry, expected_recipients, expected_recipient_names)
            tokens = self._unseal(entry['credentials'])
            if not set(tokens.get('scopes', [])).intersection({'im:resource', 'im:resource:upload'}):
                raise AccountError(403, 'FEISHU_PERMISSION_DENIED', '本人授权缺少im:resource或im:resource:upload文件上传权限')
            if tokens['expires_at'] <= self.clock() + TOKEN_MARGIN:
                tokens = self._refresh(data, entry, tokens)
            headers = {'Content-Type': 'multipart/form-data; boundary=' + boundary,
                       'Accept': 'application/json', 'Authorization': 'Bearer ' + tokens['access_token']}
            self._operation_guard(before_request)
            try:
                response = (transport or _file_transport)('POST', API_ORIGIN + '/open-apis/im/v1/files',
                                                          headers, b''.join(parts), 60)
                http, payload = (200, response) if isinstance(response, dict) else response
            except AccountError:
                raise
            except Exception as error:
                raise AccountError(502, 'FEISHU_FILE_OUTCOME_UNKNOWN', '文件上传结果未知，请核对原操作', uncertain=True) from error
            if not isinstance(http, int) or not isinstance(payload, dict):
                raise AccountError(502, 'FEISHU_FILE_OUTCOME_UNKNOWN', '文件上传回执无效', uncertain=True)
            if http == 401 or payload.get('code') in AUTH_CODES:
                self._expire(data, entry)
                raise AccountError(401, 'FEISHU_AUTH_EXPIRED', '本人飞书授权已失效，请重新授权')
            if not self._accepted(http, payload):
                raise AccountError(502, 'FEISHU_FILE_REJECTED', '飞书未接受文件上传', uncertain=http >= 500,
                                   provider_code=payload.get('code'))
            if not isinstance((payload.get('data') or {}).get('file_key'), str) or not payload['data']['file_key']:
                raise AccountError(502, 'FEISHU_FILE_OUTCOME_UNKNOWN', '文件上传缺少真实回执', uncertain=True)
            return payload

    def _directory(self, data, entry):
        self._bound(entry)
        tenant = entry["account"]["tenant_key"]
        accounts = {}
        for item in data["sessions"].values():
            if self._binding_status(item) == "bound" and item["account"]["tenant_key"] == tenant:
                account = item["account"]
                accounts[account["open_id"]] = copy.deepcopy(account)
        return accounts

    @staticmethod
    def _recipient_query(query):
        if (not isinstance(query, str) or len(query) > 100
                or any(ord(char) < 32 or ord(char) == 127 for char in query)):
            raise AccountError(400, "RECIPIENT_QUERY_INVALID", "收件人搜索内容无效")
        query = unicodedata.normalize("NFC", query.strip())
        if query and not any(char.isalnum() for char in query):
            raise AccountError(400, "RECIPIENT_QUERY_INVALID", "请输入收件人姓名")
        return query

    def _search_users(self, data, entry, query):
        """One explicit name query only; never enumerate or follow pagination.

        The official user-token endpoint excludes other tenants and resigned
        users. Do not replace it with users/basic_batch, which ignores visibility.
        https://open.feishu.cn/document/server-docs/contact-v3/user/search-users
        """
        self._bound(entry)
        if "contact:user:search" not in self._unseal(entry["credentials"]).get("scopes", []):
            raise AccountError(403, "FEISHU_RECIPIENT_SEARCH_UNAVAILABLE", "当前个人授权未开通飞书联系人搜索")
        response = self._user_request(data, entry, "GET", RECIPIENT_SEARCH_PATH,
                                      params={"query": query, "page_size": 20})
        payload = response.get("data")
        if not isinstance(payload, dict) or not isinstance(payload.get("users"), list) or len(payload["users"]) > 20:
            raise AccountError(502, "FEISHU_RECIPIENTS_INVALID", "飞书收件人回包无法核对，请重新搜索")
        accounts = {}
        tenant = entry["account"]["tenant_key"]
        for user in payload["users"]:
            if (not isinstance(user, dict) or not isinstance(user.get("open_id"), str)
                    or not re.fullmatch(r"ou_[A-Za-z0-9_-]{1,128}", user["open_id"])
                    or not isinstance(user.get("name"), str) or not user["name"].strip()
                    or len(user["name"]) > 120 or any(ord(char) < 32 or ord(char) == 127 for char in user["name"])
                    or user.get("tenant_key", tenant) != tenant):
                raise AccountError(502, "FEISHU_RECIPIENTS_INVALID", "飞书收件人身份无法核对，请重新搜索")
            account = {"open_id": user["open_id"], "name": unicodedata.normalize("NFC", user["name"].strip()), "tenant_key": tenant}
            if account["open_id"] in accounts and accounts[account["open_id"]] != account:
                raise AccountError(502, "FEISHU_RECIPIENTS_INVALID", "飞书收件人身份无法核对，请重新搜索")
            accounts[account["open_id"]] = account
        return accounts, payload.get("has_more") is True

    def _search_proofs(self, entry):
        account, now = entry["account"], self.clock()
        proofs = entry.get("recipient_search") or {}
        if not isinstance(proofs, dict):
            return {}
        return {open_id: proof for open_id, proof in proofs.items() if isinstance(proof, dict)
                and proof.get("principal_id") == entry["principal_id"]
                and proof.get("binding_revision") == entry["binding_revision"]
                and proof.get("account_open_id") == account["open_id"]
                and proof.get("tenant_key") == account["tenant_key"]
                and isinstance(proof.get("expires_at"), (int, float)) and proof["expires_at"] > now
                and isinstance(proof.get("query"), str) and proof["query"]
                and isinstance(proof.get("name"), str) and proof["name"]}

    def _recipients(self, data, entry, query):
        query = self._recipient_query(query)
        accounts = {key: account for key, account in self._directory(data, entry).items()
                    if query.casefold() in account["name"].casefold()}
        source, has_more = "bound_accounts", False
        if query and self._status(entry)["capabilities"]["recipients_search"]:
            found, has_more = self._search_users(data, entry, query)
            proofs = {key: proof for key, proof in self._search_proofs(entry).items() if proof["query"] != query}
            now = self.clock()
            for open_id, account in found.items():
                proofs[open_id] = dict(account, principal_id=entry["principal_id"], binding_revision=entry["binding_revision"],
                    account_open_id=entry["account"]["open_id"], query=query, verified_at=now, expires_at=now + RECIPIENT_SEARCH_TTL)
            entry["recipient_search"] = dict(sorted(reversed(list(proofs.items())), key=lambda item: item[1].get("verified_at", 0), reverse=True)[:RECIPIENT_SEARCH_LIMIT])
            self._save(data)
            # A bound account remains authoritative if the search ranks it too.
            accounts = {**found, **accounts}
            source = "feishu_user_search"
        return {"items": sorted(accounts.values(), key=lambda account: (account["name"], account["open_id"])),
                "source": source, "has_more": has_more}

    def recipients(self, session_token, query=""):
        with self._transaction() as data:
            return self._recipients(data, self._session(data, session_token), query)

    def _validate_recipients(self, data, entry, open_ids, expected_names=None):
        if not isinstance(open_ids, list) or len(open_ids) > 100 or any(not isinstance(value, str) for value in open_ids):
            raise AccountError(400, "RECIPIENTS_INVALID", "请选择已核对的飞书收件人")
        allowed = self._directory(data, entry)
        proofs = self._search_proofs(entry)
        selected = list(dict.fromkeys(open_ids))
        searched = [value for value in selected if value not in allowed]
        # Reject injected IDs before issuing even a read request for them.
        if any(value not in proofs for value in searched):
            raise AccountError(403, "RECIPIENTS_UNVERIFIED", "收件人未经本人搜索核对或搜索已过期，请重新选择")
        fresh = {}
        for value in searched:
            proof = proofs[value]
            query = self._recipient_query(proof["query"])
            if query not in fresh:
                fresh[query], _ = self._search_users(data, entry, query)
            account = fresh[query].get(value)
            if not account or account["name"] != proof["name"]:
                # Never silently replace the name reviewed by the user.
                raise AccountError(409, "RECIPIENTS_CHANGED", "收件人身份或可见范围已变化，请重新搜索并核对")
            allowed[value] = account
        if expected_names is not None and (not isinstance(expected_names, dict) or set(expected_names) != set(selected)
                or any(expected_names[value] != allowed[value]["name"] for value in selected)):
            raise AccountError(409, "RECIPIENTS_CHANGED", "收件人姓名已变化，请重新核对当前收件人")
        return list(dict.fromkeys(open_ids))

    def validate_recipients(self, session_token, open_ids, expected_names=None):
        with self._transaction() as data:
            return self._validate_recipients(data, self._session(data, session_token), open_ids, expected_names)

    def recipient_identities(self, session_token, open_ids):
        """Server-derived review snapshot, never accept client-provided names."""
        with self._transaction() as data:
            entry = self._session(data, session_token)
            selected = self._validate_recipients(data, entry, open_ids)
            accounts = self._directory(data, entry)
            proofs = self._search_proofs(entry)
            return {value: (accounts.get(value) or proofs[value])["name"] for value in selected}

    def validate_recipients_for_principal(self, principal_id, open_ids, expected_binding=None):
        """Server-only validation; use expected_recipients on a subsequent write too."""
        with self._transaction() as data:
            entry = self._entry_for_principal(data, principal_id)
            self._check_binding(entry, expected_binding)
            return self._validate_recipients(data, entry, open_ids)

    def recipients_for_principal(self, principal_id, query="", expected_binding=None):
        """Server-only lookup for already-authenticated task confirmation workers."""
        with self._transaction() as data:
            entry = self._entry_for_principal(data, principal_id)
            self._check_binding(entry, expected_binding)
            return self._recipients(data, entry, query)

    @staticmethod
    def _validate_task(body):
        """Explicit-confirm helper; caller journals client_token/op_id before invoking.

        No automatic retry on create/read-back failure. ``uncertain`` keeps an
        already-created task from becoming a duplicate creation on a retry.
        """
        if not isinstance(body, dict) or not isinstance(body.get("summary"), str) or not body["summary"].strip():
            raise AccountError(400, "FEISHU_TASK_INVALID", "飞书任务事项不能为空")
        if not isinstance(body.get("client_token"), str) or not re.fullmatch(r"[A-Za-z0-9_-]{8,100}", body["client_token"]):
            raise AccountError(400, "FEISHU_TASK_INVALID", "飞书任务缺少有效的防重编号")
        members = body.get("members")
        if not isinstance(members, list) or not members or any(not isinstance(member, dict) or member.get("type") != "user"
                or member.get("role") not in {"assignee", "follower"} for member in members):
            raise AccountError(400, "FEISHU_TASK_INVALID", "请选择已核对的任务负责人")
        return [member.get("id") for member in members]

    def _create_task(self, data, entry, body):
        self._validate_recipients(data, entry, self._validate_task(body))
        result = self._user_request(data, entry, "POST", "/open-apis/task/v2/tasks", copy.deepcopy(body), {"user_id_type": "open_id"})
        task = (result.get("data") or {}).get("task") or {}
        guid = task.get("guid")
        if not guid or not re.fullmatch(r"[A-Za-z0-9_-]{1,150}", str(guid)):
            raise AccountError(502, "FEISHU_TASK_RECEIPT_UNKNOWN", "飞书任务创建结果待核对，请勿重复创建", uncertain=True)
        try:
            result = self._user_request(data, entry, "GET", "/open-apis/task/v2/tasks/" + guid,
                                        params={"user_id_type": "open_id"})
            verified = (result.get("data") or {}).get("task") or {}
            if verified.get("guid") != guid:
                raise ValueError("receipt mismatch")
        except Exception:
            raise AccountError(502, "FEISHU_TASK_RECEIPT_UNKNOWN", "飞书任务已返回编号但回读未确认，请核实原任务", uncertain=True) from None
        return verified

    def create_task(self, session_token, body):
        """Explicit user confirmation only; caller journals client_token before invoking."""
        with self._transaction() as data:
            return self._create_task(data, self._session(data, session_token), body)

    def create_task_for_principal(self, principal_id, body, expected_binding=None):
        """Server-only variant for an already-journaled, personal confirmation."""
        with self._transaction() as data:
            entry = self._entry_for_principal(data, principal_id)
            self._check_binding(entry, expected_binding)
            return self._create_task(data, entry, body)
