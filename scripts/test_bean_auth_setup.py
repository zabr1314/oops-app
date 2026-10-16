import io
import json
import os
from pathlib import Path
import tempfile
import time
import unittest

from bean_auth_setup import exchange, write_properties


class BeanAuthSetupTest(unittest.TestCase):
    def setUp(self):
        self.identity = {'user_id': 'test-user', 'device_id': 'test-device'}
        self.creds = {'app_id': 'test-app', 'app_key': 'private-business-key'}
        self.data = {'token': 'device-token', 'token_expire_time': int(time.time()) + 3600,
                     'license': {**self.identity, 'app_id': 'test-app', 'license_expire_time': int(time.time()) + 7200},
                     'license_signature': 'signed-device-license'}

    def opener(self, request, timeout):
        self.assertEqual(request.get_header('X-soundcore-sdk-version'), 'V1.3.02')
        self.assertEqual(request.get_header('X-product-code'), 'D3200')
        body = json.loads(request.data)
        self.assertEqual(body['device_id'], self.identity['device_id'])
        return io.StringIO(json.dumps({'code': 1, 'data': self.data}))

    def test_exchange_accepts_verified_identity(self):
        self.assertEqual(exchange(self.creds, self.identity, opener=self.opener), self.data)

    def test_mismatched_device_and_expired_credentials_are_rejected(self):
        self.data['license']['device_id'] = 'another-device'
        with self.assertRaisesRegex(ValueError, '身份'):
            exchange(self.creds, self.identity, opener=self.opener)
        self.data['license']['device_id'] = self.identity['device_id']
        self.data['token_expire_time'] = 1
        with self.assertRaisesRegex(ValueError, '到期'):
            exchange(self.creds, self.identity, opener=self.opener)

    def test_private_output_preserves_other_settings_and_excludes_business_key(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'local.properties'
            path.write_text('sdk.dir=/sdk\nVOLC_APP_ID=existing\nBEAN_TOKEN=old\n')
            write_properties(path, self.identity, self.data, False)
            result = path.read_text()
            self.assertIn('VOLC_APP_ID=existing', result)
            self.assertIn('BEAN_TOKEN=device-token', result)
            self.assertEqual(result.count('BEAN_TOKEN='), 1)
            self.assertNotIn(self.creds['app_key'], result)
            self.assertEqual(os.stat(path).st_mode & 0o777, 0o600)

    def test_vendor_error_cannot_echo_business_key(self):
        def failed(request, timeout):
            return io.StringIO(json.dumps({'code': 8002, 'message': self.creds['app_key']}))
        with self.assertRaises(ValueError) as error:
            exchange(self.creds, self.identity, opener=failed)
        self.assertNotIn(self.creds['app_key'], str(error.exception))


if __name__ == '__main__':
    unittest.main()
