"""Personal minutes delivery contract tests; transport is always a fake."""
import copy
import json
import os
import tempfile
import threading
import time
import unittest
from unittest import mock

from minutes_delivery import DeliveryError, MinutesDelivery
from feishu_accounts import AccountError


class FakeApiError(ValueError):
    def __init__(self, uncertain=False):
        self.uncertain = uncertain
        self.code = 'FAKE_FAILURE'


class Accounts:
    def __init__(self):
        self.bindings = {'token-a': {'open_id': 'ou_a', 'tenant_key': 'tenant'},
                         'token-b': {'open_id': 'ou_b', 'tenant_key': 'tenant'}}
        self.revision = 1
        self.names = {'ou_a': 'Alice', 'ou_b': 'Bob', 'ou_c': 'Carol'}
        self.calls, self.validations = [], []
        self.fail, self.hook = None, None

    def principal(self, token):
        if token not in self.bindings:
            raise DeliveryError(401, 'NO_SESSION', '无用户会话')
        return token.replace('token-', 'person-')

    def status(self, token):
        return {'account': self.bindings[token], 'binding_revision': self.revision}

    def principal_readonly_snapshot(self, token):
        return self.principal(token)

    def status_readonly_snapshot(self, token):
        return self.status(token)

    def validate_recipients(self, token, ids, expected_names=None):
        self.validations.append((token, ids[:]))
        if any(i not in ('ou_a', 'ou_b', 'ou_c') for i in ids):
            raise DeliveryError(400, 'INVALID_RECIPIENT', '未知或跨组织收件人')
        if expected_names is not None and expected_names != {i: self.names[i] for i in ids}:
            raise DeliveryError(409, 'RECIPIENTS_CHANGED', '姓名已变化')
        return ids[:]

    def recipient_identities(self, token, ids):
        self.validate_recipients(token, ids)
        return {i: self.names[i] for i in ids}

    def user_request(self, token, method, path, body=None, params=None):
        self.calls.append((token, method, path, copy.deepcopy(body), copy.deepcopy(params)))
        if self.hook:
            self.hook(token, method, path, body, params)
        if self.fail:
            self.fail(token, method, path, body, params)
        if path.endswith('/members') and body['member_id'] == self.bindings[token]['open_id']:
            raise FakeApiError()  # Feishu rejects member:create on owner (1063003).
        if path.endswith('/children'):
            # Validate the Docx wire shape instead of accepting arbitrary JSON.
            children = body.get('children')
            if not isinstance(children, list) or not 1 <= len(children) <= 50:
                raise FakeApiError()
            for block in children:
                elements = block.get('text', {}).get('elements')
                if block.get('block_type') != 2 or not isinstance(elements, list) or not elements:
                    raise FakeApiError()
                for element in elements:
                    content = element.get('text_run', {}).get('content')
                    if not isinstance(content, str) or not content or len(content.encode('utf-16-le')) // 2 > 100000:
                        raise FakeApiError()
        data = {}
        if path == '/open-apis/docx/v1/documents':
            data = {'document': {'document_id': 'doc123'}}
        elif path.endswith('/public') and method == 'GET':
            data = {'permission_public': {'external_access': False, 'link_share_entity': 'closed', 'share_entity': 'only_full_access'}}
        elif path.endswith('/metas/batch_query'):
            data = {'metas': [{'doc_token': 'doc123', 'doc_type': 'docx', 'url': 'https://example.feishu.cn/docx/doc123'}]}
        elif path == '/open-apis/im/v1/messages':
            data = {'message_id': 'om_' + body['receive_id']}
        return {'code': 0, 'data': data}

    def user_request_for_principal(self, principal, method, path, body=None, params=None, expected_binding=None, expected_recipients=None, expected_recipient_names=None, before_request=None):
        token = principal.replace('person-', 'token-')
        actual = self.status(token)
        binding = {'binding_revision': actual['binding_revision'],
                   'account_open_id': (actual['account'] or {}).get('open_id'),
                   'tenant_key': (actual['account'] or {}).get('tenant_key')}
        if expected_binding != binding:
            raise DeliveryError(409, 'FEISHU_BINDING_CHANGED', '绑定已变化')
        if expected_recipients is not None:
            self.validate_recipients(token, expected_recipients, expected_recipient_names)
        if before_request is not None:
            before_request()
        return self.user_request(token, method, path, body, params)


class DeliveryTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.auth = Accounts()
        self.rows = {'m1': {'session_id': 'm1', 'ended_at': '2026-10-14T10:00:00Z',
                            'display_title': '会议标题', 'fingerprint': 'source-1'}}
        self.owners = {'m1': 'person-a'}
        self.delivery = self.new_delivery()

    def new_delivery(self):
        return MinutesDelivery(self.tmp.name, self.auth, lambda sid: self.rows[sid],
            lambda row: row['fingerprint'], lambda row: '# 原纪要\n需要核对',
            owner_fn=lambda sid, principal: self.owners.get(sid) == principal)

    def prepare(self):
        return self.delivery.prepare('token-a', 'm1')['draft']

    def review(self, recipients=None, permission='view'):
        draft = self.prepare()
        return self.delivery.save_review('token-a', 'm1', {'revision': draft['revision'], 'title': '已核对标题',
            'content': '用户修改后的纪要\n第二行', 'recipients': ['ou_b'] if recipients is None else recipients,
            'permission': permission})['draft']

    def confirm(self, draft, op_id='operation-1'):
        return self.delivery.confirm('token-a', 'm1', {'revision': draft['revision'], 'op_id': op_id})

    def test_prepare_is_private_unselected_and_view_by_default(self):
        draft = self.prepare()
        self.assertEqual(draft['recipients'], [])
        self.assertEqual(draft['permission'], 'view')
        self.assertEqual(draft['content'], '# 原纪要\n需要核对')
        self.assertEqual(self.prepare()['revision'], draft['revision'])
        self.assertEqual(self.auth.calls, [])

    def test_foreign_user_and_legacy_without_owner_cannot_read_or_send(self):
        with self.assertRaises(DeliveryError):
            self.delivery.prepare('token-b', 'm1')
        self.owners.clear()
        with self.assertRaises(DeliveryError):
            self.prepare()
        self.assertEqual(self.auth.calls, [])

    def test_validated_edit_is_the_only_sent_body_and_explicit_recipient(self):
        draft = self.review(['ou_b', 'ou_b'])
        self.assertEqual(draft['recipients'], ['ou_b'])
        out = self.confirm(draft)
        self.assertEqual(out['status'], 'sent')
        self.assertEqual(out['doc_url'], 'https://example.feishu.cn/docx/doc123')
        self.assertTrue(all(c[0] == 'token-a' for c in self.auth.calls))
        created = [c for c in self.auth.calls if c[2] == '/open-apis/docx/v1/documents']
        self.assertEqual(created[0][3], {'title': '已核对标题'})
        content = [c for c in self.auth.calls if c[2].endswith('/children')][0][3]
        self.assertEqual([c['text']['elements'][0]['text_run']['content'] for c in content['children']],
                         ['用户修改后的纪要', '第二行'])
        grants = [c for c in self.auth.calls if c[2].endswith('/members')]
        self.assertEqual([(c[3]['member_id'], c[3]['perm']) for c in grants], [('ou_b', 'view')])
        messages = [c for c in self.auth.calls if c[2] == '/open-apis/im/v1/messages']
        self.assertEqual([c[3]['receive_id'] for c in messages], ['ou_b'])
        self.assertNotIn('原纪要', json.dumps(messages, ensure_ascii=False))

    def test_precise_revision_required_and_confirm_cannot_replace_body(self):
        old = self.prepare()
        draft = self.review()
        with self.assertRaises(DeliveryError):
            self.confirm(old)
        body = {'revision': draft['revision'], 'op_id': 'operation-1', 'content': 'FORGED', 'recipients': ['ou_c']}
        out = self.delivery.confirm('token-a', 'm1', body)
        self.assertEqual(out['status'], 'sent')
        self.assertNotIn('FORGED', json.dumps(self.auth.calls))
        self.assertEqual(out['recipients'], ['ou_b'])

    def test_owner_keeps_notification_and_skips_forbidden_member_grant(self):
        draft = self.review(['ou_a'])
        out = self.confirm(draft)
        self.assertEqual(out['status'], 'sent')
        self.assertEqual(out['recipients'], ['ou_a'])
        self.assertFalse(any(c[2].endswith('/members') for c in self.auth.calls))
        messages = [c for c in self.auth.calls if c[2] == '/open-apis/im/v1/messages']
        self.assertEqual([c[3]['receive_id'] for c in messages], ['ou_a'])
        op = self.delivery._read('person-a')['operations'][out['op_id']]
        self.assertEqual(op['steps']['grant:ou_a']['status'], 'skipped')
        count = len(self.auth.calls)
        self.delivery = self.new_delivery()
        self.assertEqual(self.confirm(draft), out)
        self.assertEqual(len(self.auth.calls), count)

    def test_owner_and_other_grants_only_other_and_notifies_both(self):
        draft = self.review(['ou_a', 'ou_b'], 'edit')
        self.assertEqual(self.confirm(draft)['status'], 'sent')
        grants = [c for c in self.auth.calls if c[2].endswith('/members')]
        self.assertEqual([(c[3]['member_id'], c[3]['perm']) for c in grants], [('ou_b', 'edit')])
        self.assertEqual([c[3]['receive_id'] for c in self.auth.calls if c[2] == '/open-apis/im/v1/messages'], ['ou_a', 'ou_b'])

    def test_owner_message_rejected_retains_doc_and_same_operation_can_resume(self):
        draft = self.review(['ou_a'])
        def rejected(token, method, path, body, params):
            if path == '/open-apis/im/v1/messages':
                raise FakeApiError(uncertain=False)
        self.auth.fail = rejected
        out = self.confirm(draft)
        self.assertEqual(out['status'], 'failed')
        self.assertTrue(out['doc_url'])
        self.auth.fail = None
        self.assertEqual(self.confirm(draft)['status'], 'sent')
        self.assertEqual(len([c for c in self.auth.calls if c[2] == '/open-apis/docx/v1/documents']), 1)

    def test_owner_message_unknown_never_replays_with_new_operation(self):
        draft = self.review(['ou_a'])
        def timed_out(token, method, path, body, params):
            if path == '/open-apis/im/v1/messages':
                raise FakeApiError(uncertain=True)
        self.auth.fail = timed_out
        out = self.confirm(draft)
        self.assertEqual(out['status'], 'unknown')
        self.assertTrue(out['doc_url'])
        count = len(self.auth.calls)
        self.auth.fail = None
        self.delivery = self.new_delivery()
        self.assertEqual(self.confirm(draft, 'another-operation')['status'], 'unknown')
        self.assertEqual(len(self.auth.calls), count)

    def test_review_names_are_server_derived_and_rename_invalidates_saved_draft(self):
        draft = self.review(['ou_b'])
        self.assertEqual(draft['recipient_names'], {'ou_b': 'Bob'})
        self.auth.names['ou_b'] = 'New name'
        with self.assertRaises(DeliveryError) as error:
            self.confirm(draft)
        self.assertEqual(error.exception.code, 'RECIPIENTS_CHANGED')
        self.assertFalse(self.auth.calls)

    def test_legacy_draft_without_names_requires_explicit_resave(self):
        draft = self.review(['ou_b'])
        with self.delivery._state('token-a') as (_, state, save):
            state['drafts']['m1'].pop('recipient_names')
            save()
        with self.assertRaises(DeliveryError) as error:
            self.confirm(draft)
        self.assertEqual(error.exception.code, 'RECIPIENTS_CHANGED')
        self.assertFalse(self.auth.calls)

    def test_rename_at_external_boundary_stops_before_next_write(self):
        draft = self.review(['ou_b'])
        def rename(token, method, path, body, params):
            if path == '/open-apis/docx/v1/documents':
                self.auth.names['ou_b'] = 'Changed after creation'
        self.auth.hook = rename
        self.assertEqual(self.confirm(draft)['status'], 'invalidated')
        self.assertEqual([c[2] for c in self.auth.calls], ['/open-apis/docx/v1/documents'])

    def test_source_changes_during_recipient_preflight_prevent_business_request(self):
        draft = self.review(['ou_b'])
        original = self.auth.validate_recipients
        calls = []
        def withdrawn_after_lookup(token, ids, expected_names=None):
            result = original(token, ids, expected_names)
            calls.append(ids)
            if len(calls) == 2:  # confirm lookup then the locked document preflight
                self.rows['m1']['fingerprint'] = 'withdrawn-during-contact-lookup'
            return result
        self.auth.validate_recipients = withdrawn_after_lookup
        self.assertEqual(self.confirm(draft)['status'], 'invalidated')
        self.assertFalse(self.auth.calls)

    def review_content(self, content):
        draft = self.prepare()
        return self.delivery.save_review('token-a', 'm1', {'revision': draft['revision'], 'title': '用户核对的原标题',
            'content': content, 'recipients': ['ou_a'], 'permission': 'view'})['draft']

    def test_real_newlines_blank_paragraphs_and_crlf_have_nonempty_text_runs(self):
        canonical = '\n标题中文😀\n\n第二段\r\n\r\n尾巴\r末尾\n'
        draft = self.review_content(canonical)
        self.assertEqual(self.confirm(draft)['status'], 'sent')
        children = [block for call in self.auth.calls if call[2].endswith('/children') for block in call[3]['children']]
        runs = [block['text']['elements'][0]['text_run']['content'] for block in children]
        self.assertEqual(runs, [' ', '标题中文😀', ' ', '第二段', ' ', '尾巴', '末尾', ' '])
        self.assertEqual(draft['content'], canonical)  # serialization never rewrites reviewed content/hash
        self.assertEqual(draft['title'], '用户核对的原标题')
        self.assertEqual(draft['recipients'], ['ou_a'])
        self.assertEqual(self.delivery._read('person-a')['operations']['operation-1']['content_encoding'], 'plain_text_lines_v2')

    def test_long_unicode_content_keeps_safe_batches_and_run_lengths(self):
        canonical = '\n'.join(f'第{i}段😀' for i in range(85)) + '\n' + '字😀' * 900 + '\n\n尾'
        draft = self.review_content(canonical)
        self.assertEqual(self.confirm(draft)['status'], 'sent')
        batches = [call[3]['children'] for call in self.auth.calls if call[2].endswith('/children')]
        self.assertEqual([len(batch) for batch in batches], [40, 40, 9])
        runs = [block['text']['elements'][0]['text_run']['content'] for batch in batches for block in batch]
        self.assertTrue(all(1 <= len(run) <= 1600 for run in runs))
        self.assertTrue(all(len(run.encode('utf-16-le')) // 2 <= 3200 for run in runs))
        self.assertEqual(''.join(runs[85:87]), '字😀' * 900)
        self.assertEqual(runs[87:], [' ', '尾'])

    def test_known_failed_content_resumes_same_document_and_safe_numeric_diagnostic(self):
        draft = self.review_content('第一段\n\n最后段😀')
        def rejected(token, method, path, body, params):
            if path.endswith('/children'):
                raise AccountError(502, 'FEISHU_API_REJECTED', '固定安全提示', provider_code=1770006)
        self.auth.fail = rejected
        out = self.confirm(draft)
        self.assertEqual(out['status'], 'failed')
        self.assertIsNone(out['doc_url'])
        self.assertFalse(any(call[2].endswith('/members') or call[2] == '/open-apis/im/v1/messages' for call in self.auth.calls))
        with self.delivery._state('token-a') as (_, state, save):
            op = state['operations']['operation-1']
            self.assertEqual(op['steps']['content:0']['code'], 'FEISHU_API_REJECTED')
            self.assertEqual(op['steps']['content:0']['provider_code'], 1770006)
            self.assertNotIn('固定安全提示', json.dumps(op))
            op.pop('content_encoding')  # emulate the deployed pre-fix, explicitly rejected operation
            save()
        self.auth.fail = None
        self.assertEqual(self.confirm(draft)['status'], 'sent')
        self.assertEqual(len([call for call in self.auth.calls if call[2] == '/open-apis/docx/v1/documents']), 1)
        self.assertEqual(len([call for call in self.auth.calls if call[1] == 'PATCH' and call[2].endswith('/public')]), 1)
        writes = [call for call in self.auth.calls if call[2].endswith('/children')]
        self.assertEqual(len(writes), 2)
        self.assertEqual(writes[0][4]['client_token'], writes[1][4]['client_token'])
        self.assertTrue(all('/doc123/blocks/doc123/children' in call[2] for call in writes))
        restored = self.delivery._read('person-a')['operations']['operation-1']
        self.assertEqual(restored['content_encoding'], 'plain_text_lines_v2')
        self.assertEqual(restored['draft'], draft)

    def test_legacy_partially_written_content_keeps_original_batch_boundaries(self):
        canonical = '\n'.join(f'原第{i}行\r旧行内回车' for i in range(45))
        draft = self.review_content(canonical)
        original, batches = MinutesDelivery._text_blocks, []
        def legacy(content, encoding):
            return original(content, 'legacy_lf_lines')
        def reject_second_batch(token, method, path, body, params):
            if path.endswith('/children'):
                batches.append(copy.deepcopy(body['children']))
                if len(batches) == 2:
                    raise AccountError(502, 'FEISHU_API_REJECTED', '固定提示', provider_code=1770006)
        self.auth.fail = reject_second_batch
        with mock.patch.object(MinutesDelivery, '_text_blocks', side_effect=legacy):
            self.assertEqual(self.confirm(draft)['status'], 'failed')
        self.assertEqual([len(batch) for batch in batches], [40, 5])
        with self.delivery._state('token-a') as (_, state, save):
            op = state['operations']['operation-1']
            completed = copy.deepcopy(op['steps']['content:0'])
            op.pop('content_encoding')
            save()
        self.auth.fail = None
        self.assertEqual(self.confirm(draft)['status'], 'sent')
        writes = [call[3]['children'] for call in self.auth.calls if call[2].endswith('/children')]
        self.assertEqual([len(batch) for batch in writes], [40, 5, 5])
        self.assertEqual(writes[1], writes[2])
        restored = self.delivery._read('person-a')['operations']['operation-1']
        self.assertEqual(restored['content_encoding'], 'legacy_lf_lines')
        self.assertEqual(restored['steps']['content:0'], completed)
        self.assertEqual(len([call for call in self.auth.calls if call[2] == '/open-apis/docx/v1/documents']), 1)

    def test_unknown_content_write_never_replays_or_changes_encoding(self):
        draft = self.review_content('原第一段\n\n原最后段')
        def unknown(token, method, path, body, params):
            if path.endswith('/children'):
                raise AccountError(502, 'FEISHU_NETWORK_UNAVAILABLE', '固定提示', uncertain=True)
        self.auth.fail = unknown
        self.assertEqual(self.confirm(draft)['status'], 'unknown')
        before = len(self.auth.calls)
        self.auth.fail = None
        self.delivery = self.new_delivery()
        self.assertEqual(self.confirm(draft, 'different-content-op')['status'], 'unknown')
        self.assertEqual(len(self.auth.calls), before)
        self.assertEqual(self.delivery._read('person-a')['operations']['operation-1']['content_encoding'], 'plain_text_lines_v2')

    def test_no_recipients_no_send(self):
        draft = self.prepare()
        with self.assertRaises(DeliveryError):
            self.confirm(draft)
        self.assertEqual(self.auth.calls, [])

    def test_unknown_and_cross_tenant_ids_rejected(self):
        with self.assertRaises(DeliveryError):
            self.review(['ou_outsider'])
        with self.assertRaises(DeliveryError):
            self.review(['some@example.com'])
        with self.assertRaises(DeliveryError):
            self.review(['ou_b'], 'full_access')
        self.assertEqual(self.auth.calls, [])

    def test_source_change_revokes_confirmation_and_new_prepare_resets_audience(self):
        draft = self.review()
        self.rows['m1']['fingerprint'] = 'source-2'
        with self.assertRaises(DeliveryError):
            self.confirm(draft)
        refreshed = self.prepare()
        self.assertGreater(refreshed['revision'], draft['revision'])
        self.assertEqual(refreshed['recipients'], [])
        self.assertEqual(self.auth.calls, [])

    def test_binding_revision_change_and_disconnect_revoke_confirmation(self):
        draft = self.review()
        self.auth.revision += 1
        with self.assertRaises(DeliveryError):
            self.confirm(draft)
        self.assertEqual(self.auth.calls, [])
        draft = self.review()
        self.auth.bindings['token-a'] = None
        with self.assertRaises(DeliveryError):
            self.confirm(draft)
        self.assertEqual(self.auth.calls, [])

    def test_same_or_new_op_id_repeated_taps_do_not_duplicate(self):
        draft = self.review()
        first = self.confirm(draft)
        count = len(self.auth.calls)
        self.assertEqual(self.confirm(draft), first)
        self.assertEqual(self.confirm(draft, 'operation-new'), first)
        self.assertEqual(len(self.auth.calls), count)
        self.delivery = self.new_delivery()
        self.assertEqual(self.confirm(draft), first)
        self.assertEqual(len(self.auth.calls), count)

    def test_unknown_creation_is_never_blindly_replayed_after_restart(self):
        draft = self.review()
        def fail(token, method, path, body, params):
            if path == '/open-apis/docx/v1/documents':
                raise FakeApiError(uncertain=True)
        self.auth.fail = fail
        self.assertEqual(self.confirm(draft)['status'], 'unknown')
        self.delivery = self.new_delivery()
        self.auth.fail = None
        self.assertEqual(self.confirm(draft)['status'], 'unknown')
        self.assertEqual(self.confirm(draft, 'different-id')['status'], 'unknown')
        self.assertEqual(len(self.auth.calls), 1)
        changed = self.review()
        with self.assertRaises(DeliveryError):
            self.confirm(changed, 'different-id')

    def test_explicit_failed_permission_resumes_existing_document(self):
        draft = self.review(['ou_b', 'ou_c'], 'edit')
        def fail(token, method, path, body, params):
            if path.endswith('/members') and body['member_id'] == 'ou_c':
                raise FakeApiError()
        self.auth.fail = fail
        self.assertEqual(self.confirm(draft)['status'], 'partial')
        self.auth.fail = None
        self.assertEqual(self.confirm(draft)['status'], 'sent')
        self.assertEqual(len([c for c in self.auth.calls if c[2] == '/open-apis/docx/v1/documents']), 1)
        self.assertEqual(len([c for c in self.auth.calls if c[2].endswith('/children')]), 1)
        self.assertEqual(len([c for c in self.auth.calls if c[2].endswith('/members') and c[3]['member_id'] == 'ou_b']), 1)

    def test_unknown_message_stops_remaining_recipients(self):
        draft = self.review(['ou_b', 'ou_c'])
        def fail(token, method, path, body, params):
            if path == '/open-apis/im/v1/messages':
                raise FakeApiError(uncertain=True)
        self.auth.fail = fail
        self.assertEqual(self.confirm(draft)['status'], 'unknown')
        self.auth.fail = None
        self.assertEqual(self.confirm(draft)['status'], 'unknown')
        self.assertEqual(len([c for c in self.auth.calls if c[2] == '/open-apis/im/v1/messages']), 1)

    def test_source_withdrawal_between_shares_stops_messages(self):
        draft = self.review(['ou_b', 'ou_c'])
        def hook(token, method, path, body, params):
            if path.endswith('/members'):
                self.rows['m1']['fingerprint'] = 'source-withdrawn'
        self.auth.hook = hook
        self.assertEqual(self.confirm(draft)['status'], 'invalidated')
        self.assertEqual(len([c for c in self.auth.calls if c[2].endswith('/members')]), 1)
        self.assertFalse(any(c[2] == '/open-apis/im/v1/messages' for c in self.auth.calls))

    def test_metadata_read_failure_is_safe_to_resume_without_new_document(self):
        draft = self.review()
        def fail(token, method, path, body, params):
            if path.endswith('/metas/batch_query'):
                raise FakeApiError(uncertain=True)
        self.auth.fail = fail
        self.assertEqual(self.confirm(draft)['status'], 'failed')
        self.auth.fail = None
        self.assertEqual(self.confirm(draft)['status'], 'sent')
        self.assertEqual(len([c for c in self.auth.calls if c[2] == '/open-apis/docx/v1/documents']), 1)

    def test_url_must_be_official_response_for_exact_document(self):
        draft = self.review()
        original = self.auth.user_request
        def request(*args, **kwargs):
            result = original(*args, **kwargs)
            if args[2].endswith('/metas/batch_query'):
                result['data']['metas'][0]['url'] = 'https://attacker.example/docx/doc123'
            return result
        self.auth.user_request = request
        self.assertEqual(self.confirm(draft)['status'], 'failed')
        self.assertFalse(any(c[2].endswith('/members') for c in self.auth.calls))

    def test_parallel_confirm_has_one_delivery(self):
        draft = self.review()
        results = []
        threads = [threading.Thread(target=lambda: results.append(self.confirm(draft))) for i in range(2)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        self.assertEqual([r['status'] for r in results], ['sent', 'sent'])
        self.assertEqual(len([c for c in self.auth.calls if c[2] == '/open-apis/docx/v1/documents']), 1)

    def test_missing_revision_never_authorizes_save_or_confirm(self):
        draft = self.review()
        for body in ({'op_id': 'operation-1'}, {'op_id': 'operation-1', 'revision': True}):
            with self.assertRaises(DeliveryError):
                self.delivery.confirm('token-a', 'm1', body)
        with self.assertRaises(DeliveryError):
            self.delivery.save_review('token-a', 'm1', {'title': '更新', 'content': '正文', 'recipients': ['ou_b']})
        self.assertEqual(self.auth.calls, [])

    def test_status_retains_sent_history_and_marks_changed_source(self):
        draft = self.review()
        sent = self.confirm(draft)
        count = len(self.auth.calls)
        self.rows['m1']['fingerprint'] = 'changed'
        out = self.delivery.status('token-a', 'm1')
        self.assertEqual(out['delivery']['status'], 'sent')
        self.assertEqual(out['delivery']['doc_url'], sent['doc_url'])
        self.assertEqual(out['delivery']['source_status'], 'source_changed')
        self.assertEqual(out['draft']['review_status'], 'source_changed')
        self.assertEqual(len(self.auth.calls), count)
        with self.assertRaises(DeliveryError):
            self.confirm(draft)

    def test_expiry_purges_private_copies_and_retains_send_receipt(self):
        sent = self.confirm(self.review())
        self.rows['m1']['transcript_status'] = 'expired'
        self.delivery.invalidate('m1', 'source_expired', purge_content=True)
        out = self.delivery.status('token-a', 'm1')
        self.assertEqual(out['draft']['content'], '')
        self.assertEqual(out['delivery']['status'], 'sent')
        self.assertEqual(out['delivery']['doc_url'], sent['doc_url'])
        with open(next(os.path.join(self.tmp.name, n) for n in os.listdir(self.tmp.name) if n.endswith('.json')), encoding='utf-8') as source:
            self.assertNotIn('用户修改后的纪要', source.read())

    def test_explicit_invalidation_persists_even_if_source_hash_returns(self):
        draft = self.review()
        self.delivery.invalidate('m1', 'source_deleted', purge_content=True)
        self.delivery = self.new_delivery()
        with self.assertRaises(DeliveryError):
            self.confirm(draft)
        self.assertEqual(self.auth.calls, [])
        self.assertEqual(self.delivery.status('token-a', 'm1')['draft']['content'], '')

    def test_binding_race_at_transport_stops_before_using_new_account(self):
        draft = self.review()
        original = self.auth.user_request_for_principal
        def raced(*args, **kwargs):
            self.auth.bindings['token-a'] = {'open_id': 'ou_NEW', 'tenant_key': 'other'}
            self.auth.revision += 1
            return original(*args, **kwargs)
        self.auth.user_request_for_principal = raced
        self.assertEqual(self.confirm(draft)['status'], 'invalidated')
        self.assertEqual(self.auth.calls, [])

    def wait_status(self, expected, timeout=3):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            result = self.delivery.status('token-a', 'm1')['delivery']
            if result and result['status'] == expected:
                return result
            time.sleep(0.005)
        self.fail('timed out waiting for ' + expected)

    def test_async_queue_and_status_do_not_wait_for_blocked_network(self):
        draft = self.review()
        entered, release = threading.Event(), threading.Event()
        def hook(token, method, path, body, params):
            if path == '/open-apis/docx/v1/documents':
                entered.set()
                release.wait(3)
        self.auth.hook = hook
        try:
            began = time.monotonic()
            queued = self.delivery.confirm_async('token-a', 'm1', {'revision': draft['revision'], 'op_id': 'async-operation'})
            self.assertLess(time.monotonic() - began, 0.3)
            self.assertEqual(queued['status'], 'sending')
            self.assertTrue(entered.wait(1))
            began = time.monotonic()
            current = self.delivery.status('token-a', 'm1')
            self.assertLess(time.monotonic() - began, 0.3)
            self.assertEqual(current['delivery']['status'], 'sending')
            began = time.monotonic()
            repeat = self.delivery.confirm_async('token-a', 'm1', {'revision': draft['revision'], 'op_id': 'different-tap'})
            self.assertLess(time.monotonic() - began, 0.3)
            self.assertEqual(repeat['op_id'], 'async-operation')
            self.assertEqual(len(self.auth.calls), 1)
        finally:
            release.set()
        self.wait_status('sent')
        self.assertEqual(len([c for c in self.auth.calls if c[2] == '/open-apis/docx/v1/documents']), 1)

    def test_async_validates_owner_revision_source_and_binding_before_queue(self):
        draft = self.review()
        body = {'revision': draft['revision'], 'op_id': 'async-operation'}
        with self.assertRaises(DeliveryError):
            self.delivery.confirm_async('token-b', 'm1', body)
        with self.assertRaises(DeliveryError):
            self.delivery.confirm_async('token-a', 'm1', dict(body, revision=1))
        self.rows['m1']['fingerprint'] = 'changed'
        with self.assertRaises(DeliveryError):
            self.delivery.confirm_async('token-a', 'm1', body)
        self.rows['m1']['fingerprint'] = 'source-1'
        self.auth.revision += 1
        with self.assertRaises(DeliveryError):
            self.delivery.confirm_async('token-a', 'm1', body)
        self.assertEqual(self.auth.calls, [])
        self.assertEqual(self.delivery._read('person-a')['operations'], {})

    def test_async_worker_preflight_failure_is_persisted(self):
        draft = self.review()
        def failed(*args, **kwargs):
            raise DeliveryError(409, 'FEISHU_BINDING_CHANGED', '绑定改变')
        self.delivery.confirm = failed
        out = self.delivery.confirm_async('token-a', 'm1', {'revision': draft['revision'], 'op_id': 'async-operation'})
        self.assertEqual(out['status'], 'sending')
        final = self.wait_status('invalidated')
        self.assertEqual(final['reason'], 'FEISHU_BINDING_CHANGED')
        self.assertEqual(self.auth.calls, [])

    def test_async_unknown_write_cannot_be_requeued_with_new_id_after_restart(self):
        draft = self.review()
        def fail(token, method, path, body, params):
            if path == '/open-apis/docx/v1/documents':
                raise FakeApiError(uncertain=True)
        self.auth.fail = fail
        body = {'revision': draft['revision'], 'op_id': 'async-operation'}
        self.delivery.confirm_async('token-a', 'm1', body)
        self.wait_status('unknown')
        self.delivery = self.new_delivery()
        self.auth.fail = None
        out = self.delivery.confirm_async('token-a', 'm1', dict(body, op_id='different-tap'))
        self.assertEqual(out['status'], 'unknown')
        self.assertEqual(out['op_id'], 'async-operation')
        self.assertEqual(len(self.auth.calls), 1)


if __name__ == '__main__':
    unittest.main()
