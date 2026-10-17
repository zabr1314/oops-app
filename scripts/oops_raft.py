#!/usr/bin/env python3
"""Local Oops Raft host and authenticated client. Credentials stay in an ignored private file."""
import argparse
import json
import os
import secrets
import sys
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit

from raft_api import RaftApi
from raft_outbox import OutboxError

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_CONFIG = os.path.join(ROOT, ".local-backend", "raft-local.json")
LOCAL_UI_ORIGINS = {"http://127.0.0.1:5173", "http://localhost:5173"}


def load_config(path):
    if os.stat(path).st_mode & 0o077:
        raise ValueError("连接配置含凭据，请先将文件权限设为 0600")
    with open(path, encoding="utf-8") as handle:
        return json.load(handle)


def initialize(path, targets):
    if os.path.exists(path):
        return load_config(path)
    if not targets:
        raise ValueError("先指定本次允许接收 Oops 消息的 Raft 收件人")
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    value = {"backendUrl": "http://127.0.0.1:8798", "backendToken": secrets.token_urlsafe(32),
             "workerToken": secrets.token_urlsafe(32), "serverUrl": "https://api.raft.build",
             "raftCredential": "", "worker": "oops-raft-local", "allowedTargets": targets,
             "stateDir": os.path.expanduser("~/.local/share/oops-raft/local")}
    fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        json.dump(value, handle, ensure_ascii=False, indent=2)
        handle.write("\n")
    return value


def client(config, path, body=None):
    url = config["backendUrl"].rstrip("/")
    parsed = urlsplit(url)
    if parsed.scheme != "https" and not (parsed.scheme == "http" and parsed.hostname in ("localhost", "127.0.0.1", "::1")):
        raise ValueError("凭据只能发往 HTTPS 或本机回环服务")
    request = urllib.request.Request(url + path, data=None if body is None else json.dumps(body).encode(),
        headers={"Authorization": "Bearer " + config["backendToken"], "Content-Type": "application/json"})
    # Do not follow credential-bearing redirects to another endpoint.
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *args, **kwargs):
            return None
    with urllib.request.build_opener(NoRedirect).open(request, timeout=10) as response:
        return json.load(response)


def serve(config):
    url = urlsplit(config["backendUrl"])
    if url.scheme != "http" or url.hostname != "127.0.0.1" or url.path not in ("", "/"):
        raise ValueError("本机桥接主机只允许 http://127.0.0.1:<端口>")
    api = RaftApi(config["stateDir"], config["backendToken"], config["workerToken"],
                  config["allowedTargets"], enabled=True, collaboration_group=config.get("collaborationGroup"))

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def setup(self):
            super().setup()
            self.connection.settimeout(10)

        def origin_ok(self):
            return not self.headers.get("Origin") or self.headers["Origin"] in LOCAL_UI_ORIGINS

        def reply(self, status, value):
            payload = json.dumps(value, ensure_ascii=False).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(payload)))
            self.send_header("Cache-Control", "no-store")
            if self.headers.get("Origin") in LOCAL_UI_ORIGINS:
                self.send_header("Access-Control-Allow-Origin", self.headers["Origin"])
                self.send_header("Vary", "Origin")
                self.send_header("Access-Control-Allow-Headers", "Authorization, Content-Type")
                self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
            self.end_headers()
            self.wfile.write(payload)

        def handle_request(self, method):
            try:
                if not self.origin_ok():
                    raise OutboxError(403, "ORIGIN_BLOCKED", "本机连接只允许已配置的 Oops 预览页面")
                if not urlsplit(self.path).path.startswith("/v1/raft/"):
                    raise OutboxError(404, "NOT_FOUND", "没有这个接口")
                if method == "GET" and self.path == "/v1/raft/local-session":
                    if self.headers.get("Origin") not in LOCAL_UI_ORIGINS:
                        raise OutboxError(403, "ORIGIN_BLOCKED", "本机连接必须从 Oops 的本机私人页面发起")
                    self.reply(200, {"token": config["backendToken"], "scope": "local_raft_outbox"})
                    return
                value = api.handle(self, method)
                self.reply(200, value)
            except OutboxError as error:
                self.reply(error.http_status, {"error": {"code": error.code, "message": str(error)}})
            except Exception:
                self.reply(500, {"error": {"code": "INTERNAL", "message": "消息存储暂时不可用"}})

        def do_GET(self):
            self.handle_request("GET")

        def do_POST(self):
            self.handle_request("POST")

        def do_OPTIONS(self):
            self.reply(200 if self.origin_ok() else 403, {})

    server = ThreadingHTTPServer(("127.0.0.1", url.port or 8798), Handler)
    identity_state = "已配置专用身份，送达以桥接回执为准" if config.get("raftCredential") else "等待独立 Raft 身份授权"
    print(f"Oops Raft 本机消息服务已启动：{config['backendUrl']}；{identity_state}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", default=DEFAULT_CONFIG)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--init-local", action="store_true")
    mode.add_argument("--serve", action="store_true")
    mode.add_argument("--status", action="store_true")
    mode.add_argument("--list", action="store_true")
    mode.add_argument("--send-file", help="显式确认的消息 JSON 文件，不在命令参数中输入凭据或会议正文")
    parser.add_argument("--target", action="append", default=[])
    args = parser.parse_args()
    try:
        if args.init_local:
            initialize(args.config, args.target)
            print("本机消息数据库配置已准备；凭据只保存在私有配置文件，Raft 授权尚未完成")
            return
        config = load_config(args.config)
        if args.serve:
            return serve(config)
        if args.status:
            result = client(config, "/v1/raft/status")
        elif args.list:
            result = client(config, "/v1/raft/messages?limit=30")
        else:
            with open(args.send_file, encoding="utf-8") as handle:
                body = json.load(handle)
            result = client(config, "/v1/raft/messages", body)
        print(json.dumps(result, ensure_ascii=False, indent=2))
    except urllib.error.HTTPError as error:
        try:
            message = json.load(error).get("error", {}).get("message", "请求失败")
        except (ValueError, AttributeError):
            message = "请求失败"
        print(f"HTTP {error.code}：{message}", file=sys.stderr)
        return 1
    except (OSError, ValueError, KeyError) as error:
        # No credential-bearing URL or exception dump.
        print(f"连接未完成：{type(error).__name__}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
