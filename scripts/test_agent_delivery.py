"""Synthetic artifacts + fake personal API only; never models or live Feishu."""
import copy
import hashlib
import json
import os
import tempfile
import unittest

from agent_delivery import AgentDelivery, result_manifest
from feishu_actions import Jobs, FeishuActions
from minutes_delivery import DeliveryError
from test_minutes_delivery import Accounts, FakeApiError


class AgentDeliveryTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.jobs = Jobs(os.path.join(self.tmp.name, 'jobs'))
        self.auth = Accounts()
        self.job, _ = self.jobs.add('ppt', dict(session_id='m1', minutes_source_fingerprint='source-1'), ['ou_b'], key='request1')
        self.jid = self.job['id']
        folder = os.path.join(self.jobs.dir, 'files', self.jid)
        os.makedirs(folder)
        for name, content in [('结果.md', '原成果正文'.encode()), ('原文件.pptx', b'original-pptx')]:
            with open(os.path.join(folder, name), 'wb') as out: out.write(content)
        manifest, _ = result_manifest(self.jobs.dir, self.jid)
        self.job.update(status='done', generation_status='ready', title='工作成果', result_manifest=manifest, result_revision=1)
        self.jobs.save(self.job)
        self.current, self.owned = True, True
        self.uploads, self.upload_failure = [], None
        self.before_upload = None
        self.auth.user_file_request_for_principal = self.upload
        self.delivery = self.new_delivery()

    def upload(self, principal, name, content, expected_binding=None, expected_recipients=None,
               expected_recipient_names=None, before_request=None):
        token = principal.replace('person-', 'token-')
        self.auth.validate_recipients(token, expected_recipients, expected_recipient_names)
        if self.before_upload: self.before_upload()
        if before_request: before_request()
        self.uploads.append((principal, name, content, expected_binding, expected_recipients))
        if self.upload_failure: raise self.upload_failure
        return dict(code=0, data=dict(file_key='file_original'))

    def new_delivery(self):
        def source(job):
            if not self.current: raise ValueError('source changed')
        return AgentDelivery(os.path.join(self.tmp.name, 'deliveries'), self.auth, self.jobs,
            lambda job, principal: self.owned and principal == 'person-a', source)

    def review(self, files=None):
        draft = self.delivery.prepare('token-a', self.jid)['draft']
        return self.delivery.save_review('token-a', self.jid, dict(revision=draft['revision'],
            title='核对后的成果', content='本人修改的正文', recipients=['ou_b', 'ou_c'], permission='view',
            attachments=['原文件.pptx'] if files is None else files, attachment_copies_confirmed=True))['draft']

    def confirm(self, draft, op='same-operation'):
        return self.delivery.confirm('token-a', self.jid, dict(revision=draft['revision'], op_id=op))

    def test_prepare_private_files_unselected_and_original_owner_only(self):
        view = self.delivery.prepare('token-a', self.jid)
        self.assertEqual(view['draft']['attachments'], [])
        self.assertEqual(view['draft']['recipients'], [])
        self.assertEqual(self.auth.calls, [])
        self.assertEqual(self.delivery.artifact('token-a', self.jid, '原文件.pptx'), b'original-pptx')
        with self.assertRaises(DeliveryError): self.delivery.prepare('token-b', self.jid)
        self.owned = False
        with self.assertRaises(DeliveryError): self.delivery.prepare('token-a', self.jid)

    def test_original_file_sends_with_personal_account_and_journal(self):
        draft = self.review()
        result = self.confirm(draft)
        self.assertEqual(result['status'], 'sent')
        self.assertEqual(len(self.uploads), 1)
        self.assertEqual(self.uploads[0][0:3], ('person-a', '原文件.pptx', b'original-pptx'))
        files = [c for c in self.auth.calls if c[2].endswith('/messages') and c[3]['msg_type'] == 'file']
        self.assertEqual([f[3]['receive_id'] for f in files], ['ou_b', 'ou_c'])
        before = len(self.auth.calls)
        self.confirm(draft, 'different-click')
        self.assertEqual(len(self.auth.calls), before)
        self.assertEqual(len(self.uploads), 1)

    def test_known_file_message_failure_resumes_same_artifacts_per_recipient(self):
        draft = self.review()
        def fail(token, method, path, body, params):
            if path.endswith('/messages') and body.get('msg_type') == 'file' and body['receive_id'] == 'ou_c':
                raise FakeApiError(False)
        self.auth.fail = fail
        self.assertEqual(self.confirm(draft)['status'], 'partial')
        self.auth.fail = None
        self.delivery = self.new_delivery()  # process restart, same journal
        self.assertEqual(self.confirm(draft)['status'], 'sent')
        self.assertEqual(len(self.uploads), 1)
        sent_b = [c for c in self.auth.calls if c[2].endswith('/messages') and c[3].get('msg_type') == 'file' and c[3]['receive_id'] == 'ou_b']
        self.assertEqual(len(sent_b), 1)
        created = [c for c in self.auth.calls if c[2] == '/open-apis/docx/v1/documents']
        self.assertEqual(len(created), 1)

    def test_unknown_upload_never_replayed_or_bypassed(self):
        draft = self.review()
        self.upload_failure = FakeApiError(True)
        self.assertEqual(self.confirm(draft)['status'], 'unknown')
        self.upload_failure = None
        self.delivery = self.new_delivery()
        self.assertEqual(self.confirm(draft, 'new-operation')['status'], 'unknown')
        self.assertEqual(len(self.uploads), 1)

    def test_known_upload_failure_only_retries_upload_after_restart(self):
        draft = self.review()
        self.upload_failure = FakeApiError(False)
        self.assertEqual(self.confirm(draft)['status'], 'partial')
        before = len(self.auth.calls)
        self.upload_failure = None
        self.delivery = self.new_delivery()
        self.assertEqual(self.confirm(draft)['status'], 'sent')
        self.assertEqual(len(self.uploads), 2)
        new = self.auth.calls[before:]
        messages = [c for c in new if c[2].endswith('/messages')]
        self.assertTrue(messages and all(c[3]['msg_type'] == 'file' for c in messages))
        self.assertFalse(any(c[2].endswith(('/documents', '/children', '/members')) for c in new))

    def test_crash_with_pending_file_upload_becomes_unknown_without_network(self):
        draft = self.review()
        with self.delivery._state('token-a') as (_, state, save):
            state['operations']['crashed-op'] = dict(op_id='crashed-op', session_id=self.jid,
                revision=draft['revision'], status='sending', draft=copy.deepcopy(draft),
                recipients=draft['recipients'], permission='view', steps={'file:pending': dict(status='pending', read=False)})
            save()
        self.delivery = self.new_delivery()
        self.assertEqual(self.confirm(draft, 'crashed-op')['status'], 'unknown')
        self.assertEqual(self.uploads, []); self.assertEqual(self.auth.calls, [])

    def test_source_withdrawal_between_upload_and_message_blocks_remaining_send(self):
        draft = self.review()
        original = self.auth.user_file_request_for_principal
        def upload_then_withdraw(*args, **kw):
            result = original(*args, **kw)
            self.current = False
            return result
        self.auth.user_file_request_for_principal = upload_then_withdraw
        self.assertEqual(self.confirm(draft)['status'], 'invalidated')
        self.assertFalse(any(c[3].get('msg_type') == 'file' for c in self.auth.calls if c[2].endswith('/messages')))

    def test_partial_file_send_cannot_be_bypassed_with_new_review_revision(self):
        draft = self.review()
        self.upload_failure = FakeApiError(False)
        self.assertEqual(self.confirm(draft)['status'], 'partial')
        changed = self.review([])
        with self.assertRaises(DeliveryError) as error: self.confirm(changed, 'new-revision-op')
        self.assertEqual(error.exception.code, 'PREVIOUS_DELIVERY_UNRESOLVED')

    def test_source_binding_and_file_changes_withdraw_confirmation(self):
        draft = self.review()
        self.auth.revision += 1
        with self.assertRaises(DeliveryError): self.confirm(draft)
        self.auth.revision -= 1
        self.current = False
        with self.assertRaises(DeliveryError): self.confirm(draft)
        self.current = True
        with open(os.path.join(self.jobs.dir, 'files', self.jid, '原文件.pptx'), 'wb') as out: out.write(b'changed')
        with self.assertRaises(DeliveryError): self.confirm(draft)
        self.assertEqual(self.auth.calls, [])

    def test_file_copy_requires_separate_confirmation(self):
        draft = self.delivery.prepare('token-a', self.jid)['draft']
        with self.assertRaises(DeliveryError) as error:
            self.delivery.save_review('token-a', self.jid, dict(revision=draft['revision'], title='x', content='x',
                recipients=['ou_b'], attachments=['原文件.pptx']))
        self.assertEqual(error.exception.code, 'FILE_COPY_CONFIRMATION_REQUIRED')

    def test_review_freezes_server_verified_names_and_rename_requires_new_review(self):
        draft = self.review()
        self.assertEqual(draft['recipient_names'], dict(ou_b='Bob', ou_c='Carol'))
        self.auth.names['ou_b'] = 'Different person label'
        with self.assertRaises(DeliveryError) as error: self.confirm(draft)
        self.assertEqual(error.exception.code, 'RECIPIENTS_CHANGED')
        self.assertEqual(self.auth.calls, []); self.assertEqual(self.uploads, [])

    def test_source_or_original_file_change_while_waiting_for_upload_lock_stops_upload(self):
        for change in ('source', 'file'):
            with self.subTest(change=change):
                # Reset fixture and journals so the first case's withdrawn
                # source cannot mask the independent original-file check.
                self.setUp()
                draft = self.review()
                def changed_at_boundary():
                    if change == 'source':
                        self.current = False
                    else:
                        with open(os.path.join(self.jobs.dir, 'files', self.jid, '原文件.pptx'), 'wb') as out:
                            out.write(b'changed while waiting')
                self.before_upload = changed_at_boundary
                result = self.confirm(draft)
                self.assertEqual(result['status'], 'invalidated')
                self.assertEqual(self.uploads, [])
                self.assertFalse(any(c[3].get('msg_type') == 'file' for c in self.auth.calls if c[2].endswith('/messages')))

    def test_legacy_private_result_requires_current_source_owner_and_snapshot(self):
        self.job.pop('result_manifest'); self.job.pop('generation_status')
        self.jobs.save(self.job)
        self.assertTrue(self.delivery.prepare('token-a', self.jid)['draft'])
        self.job['payload'].pop('minutes_source_fingerprint'); self.jobs.save(self.job)
        with self.assertRaises(DeliveryError): self.delivery.prepare('token-a', self.jid)

    def test_symlink_artifact_rejected(self):
        os.symlink('/etc/hosts', os.path.join(self.jobs.dir, 'files', self.jid, 'leak'))
        with self.assertRaises(DeliveryError): self.delivery.prepare('token-a', self.jid)


class GenerationReceiptTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup)
        self.jobs = Jobs(self.tmp.name)
        self.job, _ = self.jobs.add('report', dict(session_id='m1', minutes_source_fingerprint='fp'), [], key='same-key')
        self.jobs.take('fake', 0)
        self.actions = object.__new__(FeishuActions)
        self.actions.jobs = self.jobs
        self.actions.current_job_minutes = lambda job: None
        self.actions.log = lambda line: None

    def test_upload_and_result_receipts_replay_without_regeneration(self):
        jid = self.job['id']
        self.assertEqual(self.jobs.add_chunk(jid, 'file.pptx', 0, b'abc')['received'], 3)
        self.assertEqual(self.jobs.add_chunk(jid, 'file.pptx', 0, b'abc')['received'], 3)
        body = dict(ok=True, markdown='fixed result', files=[dict(name='file.pptx', size=3, sha256=hashlib.sha256(b'abc').hexdigest())])
        first = self.actions.job_result(jid, body)
        self.assertEqual(first['generation_status'], 'ready')
        self.assertEqual(first, self.actions.job_result(jid, body))
        self.assertEqual(first, self.actions.job_result(jid, dict(ok=False, error='lost reply')))
        self.assertEqual(self.jobs.add_chunk(jid, 'file.pptx', 0, b'abc')['received'], 3)
        with self.assertRaises(ValueError): self.jobs.add_chunk(jid, 'file.pptx', 3, b'new')

    def test_transfer_failure_and_expired_lease_do_not_enqueue_generation(self):
        jid = self.job['id']
        self.actions.job_result(jid, dict(ok=False, phase='transfer', error='upload failed'))
        self.assertIsNone(self.jobs.take('another-helper', 0))
        same, created = self.jobs.add('report', {}, [], key='same-key')
        self.assertFalse(created); self.assertEqual(same['id'], jid)
        job = self.jobs.load(jid); job.update(status='running', lease_until='2000-01-01T00:00:00Z'); self.jobs.save(job)
        self.assertIsNone(self.jobs.take('another-helper', 0))
        self.assertEqual(self.jobs.load(jid)['generation_status'], 'unknown')

    def test_source_withdrawn_after_generation_preserves_private_result_only(self):
        def stale(job): raise ValueError('changed')
        self.actions.current_job_minutes = stale
        self.actions.job_result(self.job['id'], dict(ok=True, markdown='history', files=[]))
        job = self.jobs.load(self.job['id'])
        self.assertEqual(job['generation_status'], 'ready')
        self.assertEqual(job['delivery_status'], 'invalidated')


if __name__ == '__main__': unittest.main()
