"""Personal Feishu OAuth contracts against fake HTTP; no Feishu/model requests."""

import base64
import concurrent.futures
import copy
import hashlib
import json
import os
import stat
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from unittest import mock
from urllib.parse import parse_qs, urlsplit

sys.path.insert(0, str(Path(__file__).resolve().parent))
import feishu_accounts as fa


class FakeHTTP:
    def __init__(self):
        self.calls = []
        self.responses = []
        self.lock = threading.Lock()

    def add(self, response):
        self.responses.append(response)

    def __call__(self, method, url, headers, body, timeout):
        with self.lock:
            self.calls.append((method, url, copy.deepcopy(headers), copy.deepcopy(body)))
            if not self.responses:
                raise AssertionError("unexpected HTTP call")
            response = self.responses.pop(0)
        if callable(response):
            return response(method, url, headers, body, timeout)
        if isinstance(response, Exception):
            raise response
        return copy.deepcopy(response)


class SessionTests(unittest.TestCase):
    def setUp(self):
        environment = mock.patch.dict(os.environ, {name: "" for name in (
            "OOPS_FEISHU_CLIENT_ID", "OOPS_FEISHU_CLIENT_SECRET", "OOPS_FEISHU_REDIRECT_URI",
            "OOPS_FEISHU_TOKEN_KEY", "OOPS_FEISHU_OAUTH_SCOPES")})
        environment.start()
        self.addCleanup(environment.stop)
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.http = FakeHTTP()

    def test_unconfigured_session_still_has_private_principal(self):
        accounts = fa.Accounts(self.tmp.name, config={}, transport=self.http)
        session = accounts.create_session()
        self.assertEqual(session["principal_id"], accounts.principal(session["session_token"]))
        self.assertGreaterEqual(len(session["session_token"]), 43)
        status = accounts.status(session["session_token"])
        self.assertEqual("unavailable", status["status"])
        self.assertEqual(0, status["binding_revision"])
        self.assertIsNone(status["account"])
        self.assertFalse(status["capabilities"]["oauth"])
        self.assertNotIn(session["session_token"], Path(accounts.path).read_text())
        with self.assertRaises(fa.AccountError) as raised:
            accounts.begin(session["session_token"])
        self.assertEqual("FEISHU_OAUTH_UNAVAILABLE", raised.exception.code)
        self.assertEqual([], self.http.calls)

    def test_provider_diagnostic_is_only_a_safe_integer(self):
        for value in (True, False, '1770006', -1, 2147483648, {'code': 1770006}, ['private'], None):
            with self.subTest(value=value):
                error = fa.AccountError(502, 'FEISHU_API_REJECTED', '固定提示', provider_code=value)
                self.assertIsNone(error.provider_code)
        self.assertEqual(1770006, fa.AccountError(502, 'FEISHU_API_REJECTED', '固定提示', provider_code=1770006).provider_code)

    def test_other_phone_cannot_use_principal_id_as_credentials(self):
        accounts = fa.Accounts(self.tmp.name, config={}, transport=self.http)
        first, second = accounts.create_session(), accounts.create_session()
        self.assertNotEqual(accounts.principal(first["session_token"]), accounts.principal(second["session_token"]))
        for token in (first["principal_id"], "self", "", "x" * 64):
            with self.subTest(token=token[:8]), self.assertRaises(fa.AccountError) as raised:
                accounts.principal(token)
            self.assertEqual(401, raised.exception.status)

    def test_disk_permissions_and_reload(self):
        accounts = fa.Accounts(self.tmp.name, config={})
        session = accounts.create_session()
        self.assertEqual(0o700, stat.S_IMODE(os.stat(accounts.dir).st_mode))
        self.assertEqual(0o600, stat.S_IMODE(os.stat(accounts.path).st_mode))
        self.assertEqual(0o600, stat.S_IMODE(os.stat(accounts.lock_path).st_mode))
        reloaded = fa.Accounts(self.tmp.name, config={})
        self.assertEqual(session["principal_id"], reloaded.principal(session["session_token"]))

    def test_corrupt_store_fails_closed(self):
        accounts = fa.Accounts(self.tmp.name, config={})
        Path(accounts.path).write_text("broken")
        with self.assertRaises(fa.AccountError) as raised:
            accounts.create_session()
        self.assertEqual("ACCOUNTS_STORAGE_UNAVAILABLE", raised.exception.code)
        self.assertEqual("broken", Path(accounts.path).read_text())

    def test_symlink_directory_and_file_refused(self):
        outside = Path(self.tmp.name) / "outside"
        outside.mkdir()
        directory = Path(self.tmp.name) / "feishu-accounts"
        directory.symlink_to(outside, target_is_directory=True)
        with self.assertRaises(fa.AccountError):
            fa.Accounts(self.tmp.name, config={})
        directory.unlink()
        accounts = fa.Accounts(self.tmp.name, config={})
        secret = outside / "secret"
        secret.write_text("unchanged")
        Path(accounts.path).symlink_to(secret)
        with self.assertRaises(fa.AccountError):
            accounts.create_session()
        self.assertEqual("unchanged", secret.read_text())


@unittest.skipUnless(fa.Fernet is not None, "cryptography is required for encrypted OAuth tests")
class OAuthTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.http = FakeHTTP()
        self.now = 1_700_000_000
        self.config = {"client_id": "test-client", "client_secret": "test-client-secret",
                       "redirect_uri": "https://oops.example.test/v1/feishu/callback",
                       "token_key": fa.Fernet.generate_key().decode("ascii"),
                       "scopes": "offline_access task:task:write docx:document:create im:message im:message.send_as_user"}
        self.accounts = fa.Accounts(self.tmp.name, self.config, self.http, lambda: self.now)
        self.session = self.accounts.create_session()["session_token"]

    @staticmethod
    def token(access="access-alice", refresh="refresh-alice", expires=7200, scope=None):
        return {"code": 0, "access_token": access, "refresh_token": refresh, "expires_in": expires,
                "refresh_token_expires_in": 86400, "token_type": "Bearer",
                "scope": scope if scope is not None else "offline_access task:task:write docx:document:create im:message im:message.send_as_user"}

    def begin(self, session=None):
        value = self.accounts.begin(session or self.session)
        return parse_qs(urlsplit(value["authorization_url"]).query), value

    def bind(self, session=None, open_id="ou_alice", name="Alice", tenant="tenant-one", token=None):
        session = session or self.session
        query, _ = self.begin(session)
        self.http.add(token or self.token())
        self.http.add({"code": 0, "data": {"open_id": open_id, "name": name, "tenant_key": tenant,
                                              "email": "not-stored@example.test", "mobile": "not-stored"}})
        return self.accounts.callback({"state": query["state"][0], "code": "test-code"})

    def snapshot(self, session=None):
        status = self.accounts.status(session or self.session)
        return {"binding_revision": status["binding_revision"], "account_open_id": status["account"]["open_id"],
                "tenant_key": status["account"]["tenant_key"]}

    def test_pkce_and_fixed_callback(self):
        query, value = self.begin()
        self.assertEqual("https://accounts.feishu.cn", urlsplit(value["authorization_url"]).scheme + "://" + urlsplit(value["authorization_url"]).netloc)
        self.assertEqual(["S256"], query["code_challenge_method"])
        self.assertEqual([self.config["redirect_uri"]], query["redirect_uri"])
        self.assertEqual(["consent"], query["prompt"])
        self.assertEqual(self.now + fa.STATE_TTL, value["expires_at"])
        self.http.add(self.token())
        self.http.add({"code": 0, "data": {"open_id": "ou_alice", "name": "Alice", "tenant_key": "tenant-one"}})
        result = self.accounts.callback({"state": query["state"][0], "code": "test-code", "redirect_uri": "https://attacker.invalid"})
        request = self.http.calls[0]
        verifier = request[3]["code_verifier"]
        challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
        self.assertEqual(query["code_challenge"][0], challenge)
        self.assertEqual(self.config["redirect_uri"], request[3]["redirect_uri"])
        self.assertEqual("https://open.feishu.cn/open-apis/authen/v2/oauth/token", request[1])
        self.assertEqual("authorization_code", request[3]["grant_type"])
        self.assertEqual("bound", result["status"])

    def test_tokens_encrypted_identity_minimized_and_status_redacted(self):
        result = self.bind()
        self.assertEqual({"open_id": "ou_alice", "name": "Alice", "tenant_key": "tenant-one"}, result["account"])
        raw = Path(self.accounts.path).read_text()
        for secret in ("access-alice", "refresh-alice", "test-client-secret", self.session, "not-stored@example.test", "not-stored"):
            self.assertNotIn(secret, raw)
        for forbidden in ("access_token", "refresh_token", "credentials", "client_secret"):
            self.assertNotIn(forbidden, json.dumps(result))
        self.assertTrue(result["capabilities"]["task_write"])
        self.assertTrue(result["capabilities"]["messages_send"])
        self.assertFalse(result["capabilities"]["calendar_write"])
        self.assertEqual(1, result["binding_revision"])

    def test_state_is_single_use_even_after_failed_exchange(self):
        query, _ = self.begin()
        self.http.add({"code": 20003, "error_description": "secret-upstream-value"})
        with self.assertRaises(fa.AccountError) as raised:
            self.accounts.callback({"state": query["state"][0], "code": "test-code"})
        self.assertNotIn("secret-upstream-value", str(raised.exception))
        with self.assertRaises(fa.AccountError) as replay:
            self.accounts.callback({"state": query["state"][0], "code": "test-code"})
        self.assertEqual("OAUTH_STATE_INVALID", replay.exception.code)
        self.assertEqual(1, len(self.http.calls))

    def test_expiry_and_parallel_begin_cancel_old_state(self):
        first, _ = self.begin()
        second, _ = self.begin()
        with self.assertRaises(fa.AccountError):
            self.accounts.callback({"state": first["state"][0], "code": "old-code"})
        self.now += fa.STATE_TTL + 1
        with self.assertRaises(fa.AccountError):
            self.accounts.callback({"state": second["state"][0], "code": "late-code"})
        self.assertEqual([], self.http.calls)

    def test_cancel_rebind_preserves_original(self):
        first = self.bind()
        pending, _ = self.begin()
        with self.assertRaises(fa.AccountError) as error:
            self.accounts.callback({"state": pending["state"][0], "error": "access_denied"})
        self.assertEqual("FEISHU_AUTH_CANCELLED", error.exception.code)
        self.assertEqual(first, self.accounts.status(self.session))

    def test_failed_userinfo_cannot_replace_old_account(self):
        old = self.bind()
        pending, _ = self.begin()
        self.http.add(self.token(access="untrusted-rebind-token"))
        self.http.add({"code": 0, "data": {"open_id": "ou_attacker", "name": "Other"}})
        with self.assertRaises(fa.AccountError):
            self.accounts.callback({"state": pending["state"][0], "code": "other-code"})
        self.assertEqual(old, self.accounts.status(self.session))

    def test_disconnect_invalidates_pending_state_and_old_binding(self):
        self.bind()
        pending, _ = self.begin()
        result = self.accounts.disconnect(self.session)
        self.assertEqual("unbound", result["status"])
        self.assertIsNone(result["account"])
        self.assertEqual(2, result["binding_revision"])
        with self.assertRaises(fa.AccountError):
            self.accounts.callback({"state": pending["state"][0], "code": "old-code"})
        raw = json.loads(Path(self.accounts.path).read_text())
        entry = next(iter(raw["sessions"].values()))
        self.assertNotIn("credentials", entry)

    def test_disconnect_during_exchange_cannot_resurrect_binding(self):
        pending, _ = self.begin()
        def during_exchange(*args):
            self.accounts.disconnect(self.session)
            return self.token()
        self.http.add(during_exchange)
        self.http.add({"code": 0, "data": {"open_id": "ou_alice", "name": "Alice", "tenant_key": "tenant-one"}})
        with self.assertRaises(fa.AccountError) as error:
            self.accounts.callback({"state": pending["state"][0], "code": "test-code"})
        self.assertEqual(409, error.exception.status)
        self.assertEqual("unbound", self.accounts.status(self.session)["status"])

    def test_independent_session_uses_its_own_token(self):
        self.bind()
        other = self.accounts.create_session()["session_token"]
        self.bind(other, "ou_bob", "Bob", token=self.token("access-bob", "refresh-bob"))
        self.http.add({"code": 0, "data": {"ok": True}})
        self.accounts.user_request(other, "GET", "/open-apis/task/v2/tasks")
        self.assertEqual("Bearer access-bob", self.http.calls[-1][2]["Authorization"])
        self.assertEqual("ou_alice", self.accounts.status(self.session)["account"]["open_id"])

    def test_refresh_saves_rotated_tokens_before_request(self):
        self.bind(token=self.token(expires=61))
        self.now += 2
        self.http.add(self.token("new-access", "rotated-refresh"))
        self.http.add({"code": 0, "data": {"ok": True}})
        self.accounts.user_request(self.session, "POST", "/open-apis/task/v2/tasks", {"summary": "test"})
        self.assertEqual("refresh_token", self.http.calls[-2][3]["grant_type"])
        self.assertEqual("refresh-alice", self.http.calls[-2][3]["refresh_token"])
        self.assertEqual("Bearer new-access", self.http.calls[-1][2]["Authorization"])
        self.now += 7200
        self.http.add(self.token("third-access", "third-refresh"))
        self.http.add({"code": 0})
        self.accounts.user_request(self.session, "GET", "/open-apis/task/v2/tasks")
        self.assertEqual("rotated-refresh", self.http.calls[-2][3]["refresh_token"])

    def test_refresh_failure_disables_only_that_binding(self):
        self.bind(token=self.token(expires=61))
        self.now += 2
        self.http.add(TimeoutError("provider-secret"))
        with self.assertRaises(fa.AccountError) as error:
            self.accounts.user_request(self.session, "POST", "/open-apis/task/v2/tasks", {})
        self.assertFalse(error.exception.uncertain)  # business write never began
        self.assertEqual("expired", self.accounts.status(self.session)["status"])
        self.assertNotIn("provider-secret", str(error.exception))
        self.assertEqual(3, len(self.http.calls))

    def test_unknown_write_is_not_replayed_or_fallback(self):
        self.bind()
        self.http.add(TimeoutError("token-in-error-message"))
        with self.assertRaises(fa.AccountError) as error:
            self.accounts.user_request(self.session, "POST", "/open-apis/docx/v1/documents", {})
        self.assertTrue(error.exception.uncertain)
        self.assertNotIn("token-in-error-message", str(error.exception))
        self.assertEqual(3, len(self.http.calls))
        self.assertEqual("bound", self.accounts.status(self.session)["status"])

    def test_write_auth_rejection_not_replayed(self):
        self.bind()
        self.http.add({"code": 99991677, "msg": "secret-token"})
        with self.assertRaises(fa.AccountError) as error:
            self.accounts.user_request(self.session, "POST", "/open-apis/docx/v1/documents", {})
        self.assertFalse(error.exception.uncertain)
        self.assertEqual(3, len(self.http.calls))
        self.assertEqual("expired", self.accounts.status(self.session)["status"])

    def test_safe_read_can_refresh_after_token_rejection(self):
        self.bind()
        self.http.add({"code": 99991677})
        self.http.add(self.token("new-access", "new-refresh"))
        self.http.add({"code": 0, "data": {"ok": True}})
        result = self.accounts.user_request(self.session, "GET", "/open-apis/task/v2/tasks")
        self.assertTrue(result["data"]["ok"])
        self.assertEqual("Bearer new-access", self.http.calls[-1][2]["Authorization"])

    def test_bound_same_tenant_directory_rejects_forged_or_cross_tenant(self):
        self.bind()
        bob, outsider = (self.accounts.create_session()["session_token"] for _ in range(2))
        self.bind(bob, "ou_bob", "Bob")
        self.bind(outsider, "ou_outsider", "Other", "tenant-two")
        items = self.accounts.recipients(self.session)["items"]
        self.assertEqual({"ou_alice", "ou_bob"}, {item["open_id"] for item in items})
        self.assertEqual(["ou_bob"], self.accounts.validate_recipients(self.session, ["ou_bob", "ou_bob"]))
        self.assertEqual(["ou_bob"], [item["open_id"] for item in self.accounts.recipients(self.session, "bo")["items"]])
        for forged in ("ou_fake", "ou_outsider"):
            with self.subTest(forged=forged), self.assertRaises(fa.AccountError):
                self.accounts.validate_recipients(self.session, [forged])
        self.accounts.disconnect(bob)
        with self.assertRaises(fa.AccountError):
            self.accounts.validate_recipients(self.session, ["ou_bob"])

    def test_background_principal_expected_binding_rejects_rebind(self):
        self.bind()
        principal, snapshot = self.accounts.principal(self.session), self.snapshot()
        self.assertEqual(self.accounts.status(self.session), self.accounts.status_for_principal(principal))
        self.http.add({"code": 0})
        self.accounts.user_request_for_principal(principal, "GET", "/open-apis/task/v2/tasks", expected_binding=snapshot)
        self.bind(open_id="ou_other", name="Other")
        before = len(self.http.calls)
        with self.assertRaises(fa.AccountError) as error:
            self.accounts.user_request_for_principal(principal, "POST", "/open-apis/task/v2/tasks", {}, expected_binding=snapshot)
        self.assertEqual("FEISHU_BINDING_CHANGED", error.exception.code)
        self.assertEqual(before, len(self.http.calls))

    def test_expected_recipients_checked_atomically_at_write_boundary(self):
        self.bind()
        bob = self.accounts.create_session()["session_token"]
        self.bind(bob, "ou_bob", "Bob")
        principal, snapshot = self.accounts.principal(self.session), self.snapshot()
        self.assertEqual(["ou_bob"], self.accounts.validate_recipients_for_principal(principal, ["ou_bob"], snapshot))
        self.assertEqual("ou_bob", self.accounts.recipients_for_principal(principal, "Bob", snapshot)["items"][0]["open_id"])
        self.accounts.disconnect(bob)
        before = len(self.http.calls)
        with self.assertRaises(fa.AccountError) as error:
            self.accounts.user_request_for_principal(principal, "POST", "/open-apis/im/v1/messages", {},
                expected_binding=snapshot, expected_recipients=["ou_bob"])
        self.assertEqual("RECIPIENTS_UNVERIFIED", error.exception.code)
        self.assertEqual(before, len(self.http.calls))

    @staticmethod
    def searched(*users, has_more=False):
        return {"code": 0, "data": {"users": list(users), "has_more": has_more, "page_token": "not-followed"}}

    def bind_search(self):
        # Actual granted scope can exceed the app's requested scopes config.
        return self.bind(token=self.token(scope="offline_access contact:user:search"))

    def test_name_search_uses_personal_user_token_and_only_official_open_id(self):
        status = self.bind_search()
        self.assertTrue(status["capabilities"]["recipients_search"])
        user = {"open_id": "ou_bob", "user_id": "different-user-id", "name": "Bob",
                "email": "not-persisted@example.test", "avatar": {"avatar_origin": "https://not-persisted.invalid"}}
        self.http.add(self.searched(user, has_more=True))
        before = len(self.http.calls)
        out = self.accounts.recipients(self.session, "  Bob  ")
        self.assertEqual("feishu_user_search", out["source"])
        self.assertTrue(out["has_more"])
        self.assertEqual([{"open_id": "ou_bob", "name": "Bob", "tenant_key": "tenant-one"}], out["items"])
        self.assertEqual(before + 1, len(self.http.calls))
        call = self.http.calls[-1]
        self.assertEqual("GET", call[0])
        self.assertEqual("/open-apis/search/v1/user", urlsplit(call[1]).path)
        self.assertEqual({"query": ["Bob"], "page_size": ["20"]}, parse_qs(urlsplit(call[1]).query))
        self.assertEqual("Bearer access-alice", call[2]["Authorization"])
        self.assertIsNone(call[3])
        raw = Path(self.accounts.path).read_text()
        self.assertNotIn("different-user-id", raw)
        self.assertNotIn("not-persisted", raw)
        self.http.add(self.searched(user))
        self.assertEqual({"ou_bob": "Bob"}, self.accounts.recipient_identities(self.session, ["ou_bob"]))
        before = len(self.http.calls)
        self.assertEqual(["ou_alice"], [item["open_id"] for item in self.accounts.recipients(self.session)["items"]])
        self.assertEqual(before, len(self.http.calls))  # empty q never lists cached/search users

    def test_search_proof_is_not_shared_with_other_phone_or_rebound_account(self):
        self.bind_search()
        self.http.add(self.searched({"open_id": "ou_bob", "name": "Bob"}))
        self.accounts.recipients(self.session, "Bob")
        other = self.accounts.create_session()["session_token"]
        self.bind(other, "ou_other", "Other", token=self.token(scope="contact:user:search"))
        before = len(self.http.calls)
        with self.assertRaises(fa.AccountError) as error:
            self.accounts.validate_recipients(other, ["ou_bob"])
        self.assertEqual("RECIPIENTS_UNVERIFIED", error.exception.code)
        self.assertEqual(before, len(self.http.calls))
        self.bind_search()  # even the same Feishu account creates a new binding revision
        self.assertNotIn("recipient_search", next(entry for entry in json.loads(Path(self.accounts.path).read_text())["sessions"].values()
                                                   if entry["principal_id"] == self.accounts.principal(self.session)))
        before = len(self.http.calls)
        with self.assertRaises(fa.AccountError):
            self.accounts.validate_recipients(self.session, ["ou_bob"])
        self.assertEqual(before, len(self.http.calls))

    def test_search_queries_and_cache_are_bounded_without_directory_scan(self):
        self.bind_search()
        before = len(self.http.calls)
        for query in ("*", "?", "Bob\n", "x" * 101, None):
            with self.subTest(query=query), self.assertRaises(fa.AccountError):
                self.accounts.recipients(self.session, query)
        self.assertEqual(before, len(self.http.calls))
        for page in range(6):
            users = [{"open_id": f"ou_page{page}_{i}", "name": f"Name {page} {i}"} for i in range(20)]
            self.http.add(self.searched(*users, has_more=True))
            out = self.accounts.recipients(self.session, f"Name {page}")
            self.assertTrue(out["has_more"])
        self.assertEqual(before + 6, len(self.http.calls))
        entry = next(iter(json.loads(Path(self.accounts.path).read_text())["sessions"].values()))
        self.assertEqual(fa.RECIPIENT_SEARCH_LIMIT, len(entry["recipient_search"]))
        self.assertIn("ou_page5_0", entry["recipient_search"])
        self.now += fa.RECIPIENT_SEARCH_TTL + 1
        before = len(self.http.calls)
        with self.assertRaises(fa.AccountError):
            self.accounts.validate_recipients(self.session, ["ou_page5_0"])
        self.assertEqual(before, len(self.http.calls))

    def test_search_rejects_user_id_only_malformed_or_other_tenant_results(self):
        self.bind_search()
        cases = [self.searched({"user_id": "ou_not_an_open_id", "name": "Bob"}),
                 self.searched({"open_id": "ou_bob", "name": "Bob", "tenant_key": "tenant-two"}),
                 self.searched({"open_id": "ou_bob", "name": "Bob\nInjected"}),
                 self.searched({"open_id": "ou_bob", "name": "Bob"}, {"open_id": "ou_bob", "name": "Different"}),
                 {"code": 0, "data": {"users": {"open_id": "ou_bob"}}}]
        for response in cases:
            with self.subTest(response=response):
                self.http.add(response)
                with self.assertRaises(fa.AccountError) as error:
                    self.accounts.recipients(self.session, "Bob")
                self.assertEqual("FEISHU_RECIPIENTS_INVALID", error.exception.code)
        before = len(self.http.calls)
        for value in ("different-user-id", "ou_bob", "ou_forged"):
            with self.subTest(value=value), self.assertRaises(fa.AccountError):
                self.accounts.validate_recipients(self.session, [value])
        self.assertEqual(before, len(self.http.calls))

    def test_every_search_recipient_write_rechecks_original_query_and_reviewed_name(self):
        self.bind_search()
        self.http.add(self.searched({"open_id": "ou_bob", "name": "Bob"}))
        self.accounts.recipients(self.session, "Bob")
        principal, binding = self.accounts.principal(self.session), self.snapshot()
        self.http.add(self.searched({"open_id": "ou_bob", "name": "Bob"}))
        self.http.add({"code": 0, "data": {"message_id": "om_confirmed"}})
        self.accounts.user_request_for_principal(principal, "POST", "/open-apis/im/v1/messages", {},
            expected_binding=binding, expected_recipients=["ou_bob"], expected_recipient_names={"ou_bob": "Bob"})
        self.assertEqual(["GET", "POST"], [call[0] for call in self.http.calls[-2:]])
        self.http.add(self.searched({"open_id": "ou_bob", "name": "New Bob"}))
        before = len(self.http.calls)
        with self.assertRaises(fa.AccountError) as error:
            self.accounts.user_request_for_principal(principal, "POST", "/open-apis/im/v1/messages", {},
                expected_binding=binding, expected_recipients=["ou_bob"], expected_recipient_names={"ou_bob": "Bob"})
        self.assertEqual("RECIPIENTS_CHANGED", error.exception.code)
        self.assertEqual(before + 1, len(self.http.calls))  # only a read, no message submission
        entry = next(iter(json.loads(Path(self.accounts.path).read_text())["sessions"].values()))
        self.assertEqual("Bob", entry["recipient_search"]["ou_bob"]["name"])
        # An explicit new search can show the new name, but cannot revise an old review.
        self.http.add(self.searched({"open_id": "ou_bob", "name": "New Bob"}))
        self.accounts.recipients(self.session, "New Bob")
        self.http.add(self.searched({"open_id": "ou_bob", "name": "New Bob"}))
        with self.assertRaises(fa.AccountError) as error:
            self.accounts.user_request_for_principal(principal, "POST", "/open-apis/im/v1/messages", {},
                expected_binding=binding, expected_recipients=["ou_bob"], expected_recipient_names={"ou_bob": "Bob"})
        self.assertEqual("RECIPIENTS_CHANGED", error.exception.code)
        self.assertEqual("GET", self.http.calls[-1][0])

    def test_recipient_removed_or_search_read_fails_stops_before_business_write(self):
        self.bind_search()
        self.http.add(self.searched({"open_id": "ou_bob", "name": "Bob"}))
        self.accounts.recipients(self.session, "Bob")
        for response in (self.searched(), TimeoutError(), (403, {"code": 99991672})):
            with self.subTest(response=type(response).__name__):
                self.http.add(response)
                before = len(self.http.calls)
                with self.assertRaises(fa.AccountError) as error:
                    self.accounts.user_request_for_principal(self.accounts.principal(self.session), "POST", "/open-apis/im/v1/messages", {},
                        expected_binding=self.snapshot(), expected_recipients=["ou_bob"], expected_recipient_names={"ou_bob": "Bob"})
                self.assertFalse(error.exception.uncertain)  # preflight read did not submit message
                self.assertEqual(before + 1, len(self.http.calls))
                self.assertEqual("GET", self.http.calls[-1][0])

    def test_real_accounts_and_delivery_send_to_searched_colleague_without_oops_binding(self):
        from minutes_delivery import MinutesDelivery
        self.bind_search()
        calls = []
        def provider(method, url, headers, body, timeout):
            path = urlsplit(url).path
            self.assertEqual("Bearer access-alice", headers["Authorization"])
            calls.append((method, path, copy.deepcopy(body)))
            data = {}
            if path == fa.RECIPIENT_SEARCH_PATH:
                self.assertEqual(["同事"], parse_qs(urlsplit(url).query)["query"])
                return self.searched({"open_id": "ou_colleague", "name": "同事", "user_id": "must-not-use"})
            if path == "/open-apis/docx/v1/documents":
                data = {"document": {"document_id": "doc123"}}
            elif path.endswith("/public") and method == "GET":
                data = {"permission_public": {"external_access": False, "link_share_entity": "closed", "share_entity": "only_full_access"}}
            elif path.endswith("/metas/batch_query"):
                data = {"metas": [{"doc_token": "doc123", "doc_type": "docx", "url": "https://example.feishu.cn/docx/doc123"}]}
            elif path.endswith("/members"):
                self.assertEqual("ou_colleague", body["member_id"])  # owner must never be granted
            elif path == "/open-apis/im/v1/messages":
                data = {"message_id": "om_" + body["receive_id"]}
            return {"code": 0, "data": data}
        self.accounts.transport = provider
        found = self.accounts.recipients(self.session, "同事")
        self.assertEqual(["ou_colleague"], [item["open_id"] for item in found["items"]])
        principal = self.accounts.principal(self.session)
        row = {"session_id": "m1", "ended_at": "2026-10-14T12:00:00Z"}
        delivery = MinutesDelivery(self.tmp.name, self.accounts, lambda sid: row, lambda value: "fingerprint-1",
                                  lambda value: "已核对的真实链路结构", owner_fn=lambda sid, owner: owner == principal)
        draft = delivery.prepare(self.session, "m1")["draft"]
        draft = delivery.save_review(self.session, "m1", {"revision": draft["revision"], "title": "已核对纪要",
            "content": draft["content"], "recipients": ["ou_alice", "ou_colleague"], "permission": "view"})["draft"]
        self.assertEqual({"ou_alice": "Alice", "ou_colleague": "同事"}, draft["recipient_names"])
        sent = delivery.confirm(self.session, "m1", {"revision": draft["revision"], "op_id": "integrated-send-1"})
        self.assertEqual("sent", sent["status"])
        self.assertEqual(["ou_colleague"], [body["member_id"] for method, path, body in calls if path.endswith("/members")])
        self.assertEqual(["ou_alice", "ou_colleague"], [body["receive_id"] for method, path, body in calls if path == "/open-apis/im/v1/messages"])
        before = len(calls)
        self.assertEqual(sent, delivery.confirm(self.session, "m1", {"revision": draft["revision"], "op_id": "repeat-tap-1"}))
        self.assertEqual(before, len(calls))

    def test_delivery_source_withdrawn_during_search_or_refresh_prevents_business_http(self):
        from minutes_delivery import MinutesDelivery
        for cause in ("search", "refresh"):
            with self.subTest(cause=cause):
                self.accounts.transport = self.http
                self.bind(token=self.token(expires=61, scope="offline_access contact:user:search"))
                source, searches, business = {"fingerprint": "current"}, [], []
                def provider(method, url, headers, body, timeout):
                    path = urlsplit(url).path
                    if path == fa.TOKEN_PATH:
                        self.assertEqual("refresh", cause)
                        source["fingerprint"] = "changed-during-refresh"
                        return self.token("rotated-access", "rotated-refresh", scope="offline_access contact:user:search")
                    if path == fa.RECIPIENT_SEARCH_PATH:
                        searches.append(url)
                        if len(searches) == 3 and cause == "refresh":
                            self.now += 2  # the next locked lookup must refresh (61 -> 59s)
                        if len(searches) == 4 and cause == "search":
                            source["fingerprint"] = "changed-during-search"
                        return self.searched({"open_id": "ou_colleague", "name": "Colleague"})
                    business.append(path)
                    raise AssertionError("source withdrawal must stop business HTTP")
                self.accounts.transport = provider
                self.accounts.recipients(self.session, "Colleague")
                principal = self.accounts.principal(self.session)
                row = {"session_id": cause, "ended_at": "2026-10-14T12:00:00Z"}
                delivery = MinutesDelivery(self.tmp.name, self.accounts, lambda sid: row,
                    lambda value: source["fingerprint"], lambda value: "Reviewed minutes",
                    owner_fn=lambda sid, owner: owner == principal)
                draft = delivery.prepare(self.session, cause)["draft"]
                draft = delivery.save_review(self.session, cause, {"revision": draft["revision"], "title": "Reviewed",
                    "content": draft["content"], "recipients": ["ou_colleague"], "permission": "view"})["draft"]
                out = delivery.confirm(self.session, cause, {"revision": draft["revision"], "op_id": "withdrawn-" + cause})
                self.assertEqual("invalidated", out["status"])
                self.assertEqual("MINUTES_SOURCE_CHANGED", out["reason"])
                self.assertEqual([], business)
                self.assertEqual(4, len(searches))

    def test_user_message_capability_requires_both_official_scopes(self):
        for scope in ("im:message", "im:message.send_as_user", "im:message:send_as_user"):
            with self.subTest(scope=scope):
                status = self.bind(token=self.token(scope=scope))
                self.assertFalse(status["capabilities"]["messages_send"])
        status = self.bind(token=self.token(scope="im:message im:message.send_as_user"))
        self.assertTrue(status["capabilities"]["messages_send"])

    def test_minimal_granular_minutes_scopes_cover_every_required_step(self):
        scopes = ["offline_access", "docx:document:create", "docx:document:write_only",
                  "docs:permission.setting:read", "docs:permission.setting:write_only",
                  "docs:permission.member:create", "drive:drive.metadata:readonly",
                  "im:message", "im:message.send_as_user"]
        result = self.bind(token=self.token(scope=" ".join(scopes)))
        capabilities = result["capabilities"]
        self.assertTrue(capabilities["minutes_delivery"])
        for key in ("documents_create", "documents_content_write", "sharing_settings_read",
                    "sharing_settings_write", "sharing_members_create", "metadata_read", "messages_send"):
            self.assertTrue(capabilities[key], key)
        self.assertFalse(capabilities["documents_read"])  # content read is not used by delivery
        self.assertFalse(capabilities["task_write"])
        for missing in scopes[1:]:
            with self.subTest(missing=missing):
                result = self.bind(token=self.token(scope=" ".join(scope for scope in scopes if scope != missing)))
                self.assertFalse(result["capabilities"]["minutes_delivery"])

    def test_granular_creation_sharing_settings_and_metadata_are_independent(self):
        for scope, enabled in (("docx:document:create", "documents_create"),
                               ("docx:document:write_only", "documents_content_write"),
                               ("docs:permission.member:create", "sharing_members_create"),
                               ("docs:permission.setting:read", "sharing_settings_read"),
                               ("docs:permission.setting:write_only", "sharing_settings_write"),
                               ("drive:drive.metadata:readonly", "metadata_read")):
            with self.subTest(scope=scope):
                capabilities = self.bind(token=self.token(scope=scope))["capabilities"]
                self.assertTrue(capabilities[enabled])
                self.assertFalse(capabilities["minutes_delivery"])
                for other in ("documents_create", "documents_content_write", "sharing_members_create",
                              "sharing_settings_read", "sharing_settings_write", "metadata_read"):
                    if other != enabled:
                        self.assertFalse(capabilities[other], other)
        capabilities = self.bind(token=self.token(scope="drive:permission.member:create drive:drive:permission"))["capabilities"]
        self.assertFalse(capabilities["sharing"])

    def test_broad_scopes_remain_compatible_and_task_requires_readback_scope(self):
        scopes = "offline_access docx:document drive:drive im:message im:message.send_as_user task:task:write"
        capabilities = self.bind(token=self.token(scope=scopes))["capabilities"]
        self.assertTrue(capabilities["minutes_delivery"])
        self.assertTrue(capabilities["task_write"])
        self.assertFalse(self.bind(token=self.token(scope="task:task:writeonly"))["capabilities"]["task_write"])
        self.assertTrue(self.bind(token=self.token(scope="task:task:writeonly task:task:read"))["capabilities"]["task_write"])

    def test_server_error_write_is_uncertain_and_read_is_safe(self):
        self.bind()
        for method, uncertain in (("POST", True), ("GET", False)):
            with self.subTest(method=method):
                self.http.add((503, {"code": 99999, "msg": "private-provider-detail"}))
                with self.assertRaises(fa.AccountError) as error:
                    self.accounts.user_request(self.session, method, "/open-apis/task/v2/tasks", {})
                self.assertEqual(uncertain, error.exception.uncertain)
                self.assertEqual(99999, error.exception.provider_code)
                self.assertNotIn("private-provider-detail", str(error.exception))

    def test_api_rejection_preserves_numeric_code_without_provider_message(self):
        self.bind()
        self.http.add((400, {'code': 1770006, 'msg': 'private-message-with-secret-and-access-url', 'error': {'details': 'private-body'}}))
        with self.assertRaises(fa.AccountError) as error:
            self.accounts.user_request(self.session, 'POST', '/open-apis/docx/v1/documents/doc123/blocks/doc123/children', {})
        self.assertEqual('FEISHU_API_REJECTED', error.exception.code)
        self.assertEqual(1770006, error.exception.provider_code)
        self.assertFalse(error.exception.uncertain)
        self.assertNotIn('private-', str(error.exception))

    def test_original_file_upload_rechecks_reviewed_names_before_submission(self):
        self.bind(token=self.token(scope='offline_access im:resource'))
        uploads = []
        def transport(*args):
            uploads.append(args)
            return {'code': 0, 'data': {'file_key': 'file-verified'}}
        with self.assertRaises(fa.AccountError) as caught:
            self.accounts.user_file_request_for_principal(self.accounts.principal(self.session), 'result.pptx', b'original',
                expected_binding=self.snapshot(), expected_recipients=['ou_alice'],
                expected_recipient_names={'ou_alice': 'Old Alice'}, transport=transport)
        self.assertEqual('RECIPIENTS_CHANGED', caught.exception.code)
        self.assertEqual([], uploads)
        result = self.accounts.user_file_request_for_principal(self.accounts.principal(self.session), 'result.pptx', b'original',
            expected_binding=self.snapshot(), expected_recipients=['ou_alice'],
            expected_recipient_names={'ou_alice': 'Alice'}, transport=transport)
        self.assertEqual('file-verified', result['data']['file_key'])
        self.assertEqual(1, len(uploads))

    def test_original_file_upload_rechecks_source_after_token_refresh(self):
        from minutes_delivery import DeliveryError
        self.bind(token=self.token(expires=60, scope='offline_access im:resource'))
        principal, binding = self.accounts.principal(self.session), self.snapshot()
        self.http.add(self.token(access='refreshed-file-token', scope='offline_access im:resource'))
        uploads, guarded = [], []
        def guard():
            guarded.append(urlsplit(self.http.calls[-1][1]).path)
            raise DeliveryError(409, 'MINUTES_SOURCE_CHANGED', 'source withdrawn while refreshing')
        def transport(*args):
            uploads.append(args)
            return {'code': 0, 'data': {'file_key': 'must-not-upload'}}
        with self.assertRaises(fa.AccountError) as caught:
            self.accounts.user_file_request_for_principal(principal, 'result.pptx', b'original', expected_binding=binding,
                expected_recipients=['ou_alice'], expected_recipient_names={'ou_alice': 'Alice'},
                before_request=guard, transport=transport)
        self.assertEqual('MINUTES_SOURCE_CHANGED', caught.exception.code)
        self.assertFalse(caught.exception.uncertain)
        self.assertEqual([fa.TOKEN_PATH], guarded)
        self.assertEqual([], uploads)

    def test_fixed_origin_rejects_external_and_token_query_paths(self):
        self.bind()
        before = len(self.http.calls)
        for path in ("https://evil.invalid/open-apis/x", "//evil.invalid/open-apis/x", "/private", "/open-apis/../x", "/open-apis/%2e%2e/x", "/open-apis/x?access_token=bad"):
            with self.subTest(path=path), self.assertRaises(fa.AccountError):
                self.accounts.user_request(self.session, "POST", path, {})
        with self.assertRaises(fa.AccountError):
            self.accounts.user_request(self.session, "GET", "/open-apis/x", params={"access_token": "bad"})
        self.assertEqual(before, len(self.http.calls))

    def test_unavailable_crypto_key_and_insecure_redirect_do_not_fallback(self):
        for changes in ({"token_key": ""}, {"token_key": "bad"}, {"redirect_uri": "http://localhost/callback"}, {"redirect_uri": "https://oops.example.test/callback?to=client"}):
            with self.subTest(changes=changes):
                accounts = fa.Accounts(self.tmp.name, dict(self.config, **changes), self.http)
                self.assertEqual("unavailable", accounts.status(self.session)["status"])
                with self.assertRaises(fa.AccountError):
                    accounts.begin(self.session)
        with mock.patch.object(fa, "Fernet", None):
            accounts = fa.Accounts(self.tmp.name, self.config, self.http)
            self.assertFalse(accounts.available)

    def test_wrong_key_cannot_use_existing_credentials(self):
        self.bind()
        accounts = fa.Accounts(self.tmp.name, dict(self.config, token_key=fa.Fernet.generate_key()), self.http)
        self.assertEqual("unavailable", accounts.status(self.session)["status"])
        before = len(self.http.calls)
        with self.assertRaises(fa.AccountError):
            accounts.user_request(self.session, "POST", "/open-apis/task/v2/tasks", {})
        self.assertEqual(before, len(self.http.calls))

    def test_task_create_requires_server_directory_and_readback(self):
        self.bind()
        body = {"summary": "Confirmed action", "client_token": "operation-12345",
                "members": [{"id": "ou_alice", "type": "user", "role": "assignee"}]}
        self.http.add({"code": 0, "data": {"task": {"guid": "task-guid"}}})
        self.http.add({"code": 0, "data": {"task": {"guid": "task-guid", "summary": "Confirmed action"}}})
        result = self.accounts.create_task_for_principal(self.accounts.principal(self.session), body, self.snapshot())
        self.assertEqual("task-guid", result["guid"])
        self.assertEqual("Bearer access-alice", self.http.calls[-2][2]["Authorization"])
        self.assertEqual("operation-12345", self.http.calls[-2][3]["client_token"])
        before = len(self.http.calls)
        body["members"][0]["id"] = "ou_forged"
        with self.assertRaises(fa.AccountError):
            self.accounts.create_task(self.session, body)
        self.assertEqual(before, len(self.http.calls))

    def test_task_readback_unknown_never_reattempts_create(self):
        self.bind()
        body = {"summary": "Confirmed action", "client_token": "operation-12345",
                "members": [{"id": "ou_alice", "type": "user", "role": "assignee"}]}
        self.http.add({"code": 0, "data": {"task": {"guid": "task-guid"}}})
        self.http.add(TimeoutError())
        with self.assertRaises(fa.AccountError) as error:
            self.accounts.create_task(self.session, body)
        self.assertTrue(error.exception.uncertain)
        self.assertEqual("FEISHU_TASK_RECEIPT_UNKNOWN", error.exception.code)
        creates = [call for call in self.http.calls if call[0] == "POST" and urlsplit(call[1]).path == "/open-apis/task/v2/tasks"]
        self.assertEqual(1, len(creates))

    def test_concurrent_refresh_uses_rotating_refresh_token_once(self):
        self.bind(token=self.token(expires=61))
        self.now += 2
        self.http.add(self.token("new-access", "new-refresh"))
        self.http.add({"code": 0})
        self.http.add({"code": 0})
        other_instance = fa.Accounts(self.tmp.name, self.config, self.http, lambda: self.now)
        with concurrent.futures.ThreadPoolExecutor(2) as pool:
            futures = [pool.submit(account.user_request, self.session, "GET", "/open-apis/task/v2/tasks")
                       for account in (self.accounts, other_instance)]
            for future in futures:
                self.assertEqual(0, future.result(timeout=5)["code"])
        refreshes = [call for call in self.http.calls if (call[3] or {}).get("grant_type") == "refresh_token"]
        self.assertEqual(1, len(refreshes))

    def test_readonly_identity_status_not_blocked_by_inflight_provider_request(self):
        self.bind()
        entered, release = threading.Event(), threading.Event()
        def blocked_request(*args):
            entered.set()
            if not release.wait(5):
                raise TimeoutError()
            return {"code": 0}
        self.http.add(blocked_request)
        with concurrent.futures.ThreadPoolExecutor(2) as pool:
            writing = pool.submit(self.accounts.user_request, self.session, "POST", "/open-apis/task/v2/tasks", {})
            self.assertTrue(entered.wait(1))
            try:
                reading = pool.submit(self.accounts.status_readonly_snapshot, self.session)
                self.assertEqual("bound", reading.result(timeout=0.25)["status"])
                self.assertEqual(self.accounts.principal_readonly_snapshot(self.session), reading.result()["principal_id"])
            finally:
                release.set()
            self.assertEqual(0, writing.result(timeout=1)["code"])


if __name__ == "__main__":
    unittest.main(verbosity=1)
