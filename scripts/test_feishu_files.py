"""Real encryption + fake official file HTTP; no personal/live requests."""
import unittest

import feishu_accounts as fa
import test_feishu_accounts as account_tests


@unittest.skipUnless(fa.Fernet is not None, 'cryptography required')
class FileUploadTests(unittest.TestCase):
    setUp = account_tests.OAuthTests.setUp
    begin = account_tests.OAuthTests.begin
    bind = account_tests.OAuthTests.bind
    token = staticmethod(account_tests.OAuthTests.token)
    snapshot = account_tests.OAuthTests.snapshot

    def upload(self, **kw):
        return self.accounts.user_file_request_for_principal(self.accounts.principal(self.session),
            '原稿.pptx', b'original binary\x00\xff', expected_binding=self.snapshot(), transport=self.http, **kw)

    def test_personal_multipart_bytes_and_capabilities(self):
        status = self.bind(token=self.token(scope='im:resource im:message im:message.send_as_user'))
        self.assertTrue(status['capabilities']['files_upload'])
        self.assertTrue(status['capabilities']['agent_file_delivery'])
        self.http.add(dict(code=0, data=dict(file_key='file_original')))
        self.assertEqual(self.upload()['data']['file_key'], 'file_original')
        method, url, headers, body = self.http.calls[-1]
        self.assertEqual(method, 'POST'); self.assertTrue(url.endswith('/open-apis/im/v1/files'))
        self.assertEqual(headers['Authorization'], 'Bearer access-alice')
        self.assertIn('multipart/form-data; boundary=', headers['Content-Type'])
        self.assertIn(b'original binary\x00\xff', body)
        self.assertIn('原稿.pptx'.encode(), body)
        self.assertNotIn(b'test-client-secret', body)

    def test_file_upload_scope_is_distinct_from_message_send(self):
        self.bind()
        self.assertFalse(self.accounts.status(self.session)['capabilities']['files_upload'])
        with self.assertRaises(fa.AccountError) as error: self.upload()
        self.assertEqual(error.exception.code, 'FEISHU_PERMISSION_DENIED')
        self.assertEqual(len(self.http.calls), 2)  # only OAuth fake exchange/userinfo

    def test_unknown_write_not_retried_and_missing_receipt_is_unknown(self):
        self.bind(token=self.token(scope='im:resource'))
        self.http.add(TimeoutError('unknown'))
        before = len(self.http.calls)
        with self.assertRaises(fa.AccountError) as error: self.upload()
        self.assertTrue(error.exception.uncertain)
        self.assertEqual(len(self.http.calls), before + 1)
        self.http.add(dict(code=0, data={}))
        with self.assertRaises(fa.AccountError) as error: self.upload()
        self.assertTrue(error.exception.uncertain)

    def test_rebind_and_cross_tenant_recipient_block_before_upload(self):
        self.bind(token=self.token(scope='im:resource'))
        principal, old = self.accounts.principal(self.session), self.snapshot()
        self.bind(open_id='ou_new', token=self.token(scope='im:resource'))
        with self.assertRaises(fa.AccountError):
            self.accounts.user_file_request_for_principal(principal, 'x.pptx', b'x', expected_binding=old, transport=self.http)
        with self.assertRaises(fa.AccountError): self.upload(expected_recipients=['ou_unverified'])

    def test_invalid_name_empty_file_and_expired_auth_fail_closed(self):
        self.bind(token=self.token(scope='im:resource'))
        for name, data in [('../leak', b'x'), ('bad\r\nheader', b'x'), ('empty.pptx', b'')]:
            with self.subTest(name=name), self.assertRaises(fa.AccountError):
                self.accounts.user_file_request_for_principal(self.accounts.principal(self.session), name, data,
                    expected_binding=self.snapshot(), transport=self.http)
        self.http.add((401, dict(code=99991663)))
        # FakeHTTP normally returns dictionaries for the existing JSON transport;
        # multipart transport follows the real (HTTP status, payload) contract.
        def expired(*args): return 401, dict(code=99991663)
        with self.assertRaises(fa.AccountError) as error:
            self.accounts.user_file_request_for_principal(self.accounts.principal(self.session), 'x', b'x',
                expected_binding=self.snapshot(), transport=expired)
        self.assertEqual(error.exception.code, 'FEISHU_AUTH_EXPIRED')


if __name__ == '__main__': unittest.main()
