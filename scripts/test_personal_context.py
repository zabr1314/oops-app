"""Offline personal context isolation, lifecycle and immutable-input checks."""
import copy
import contextlib
import json
import os
import sqlite3
import tempfile
import threading
import unittest

from personal_context import PersonalContext, PersonalContextError, _hash


class PersonalContextTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.identities = {
            'phone-a': dict(principal_id='phone-a', account_key='tenant:person-a', binding_revision=1),
            'phone-a2': dict(principal_id='phone-a2', account_key='tenant:person-a', binding_revision=7),
            'phone-b': dict(principal_id='phone-b', account_key='tenant:person-b', binding_revision=1),
        }
        self.source_state = 'current'
        self.fingerprint = 'server-fingerprint'
        self.store = self.make_store()

    def make_store(self):
        return PersonalContext(self.tmp.name, principal_guard=self.identity, source_guard=self.source,
                               clock=lambda: 1792100000)

    def identity(self, principal):
        return copy.deepcopy(self.identities.get(principal, {'active': False}))

    def source(self, principal, source, phase):
        if self.source_state == 'unavailable':
            raise OSError('source read temporarily unavailable')
        if self.source_state == 'invalid':
            return False
        if self.source_state == 'account_swap':
            self.identities[principal]['binding_revision'] += 1
        return dict(source, service_id='current-service', fingerprint=self.fingerprint)

    @staticmethod
    def body(value, revision=0, op='operation-1', **extra):
        return dict(dict(op_id=op, expected_revision=revision, confirmed=True, value=value), **extra)

    def memory(self, identifier='memory-1', revision=0, op='memory-save-1', source=None, body='明确核对的个人背景'):
        return self.store.save_memory('phone-a', self.body(dict(title='背景', body=body), revision, op,
            memory_id=identifier, source=source or {'kind': 'manual'}))

    def enable(self, revision=0, op='enable-1', **values):
        return self.store.save_preferences('phone-a', self.body(dict(enabled=True, **values), revision, op))

    def assert_code(self, code, action):
        with self.assertRaises(PersonalContextError) as caught:
            action()
        self.assertEqual(code, caught.exception.code)

    def test_same_verified_account_two_devices_share_but_other_account_cannot_read(self):
        self.store.save_profile('phone-a', self.body({'name': '本人', 'role': '产品负责人'}))
        self.memory()
        self.assertEqual('本人', self.store.read('phone-a2')['profile']['value']['name'])
        self.assertEqual(1, len(self.store.read('phone-a2')['memories']))
        self.assertIsNone(self.store.read('phone-b')['profile'])
        self.assertEqual([], self.store.read('phone-b')['memories'])
        self.assert_code('PERSONAL_CONTEXT_NOT_FOUND', lambda: self.store.snapshot('phone-b', ['memory-1']))

    def test_persistence_and_private_file_permissions(self):
        self.memory()
        self.assertEqual('明确核对的个人背景', self.make_store().read('phone-a')['memories'][0]['value']['body'])
        self.assertEqual(0o600, os.stat(self.store.path).st_mode & 0o777)
        self.assertEqual(0o700, os.stat(self.store.directory).st_mode & 0o777)

    def test_unknown_and_unbound_principals_cannot_read_or_save(self):
        self.assert_code('PERSONAL_CONTEXT_UNAUTHORIZED', lambda: self.store.read('unknown'))
        self.identities['phone-a']['account_key'] = ''
        self.assert_code('PERSONAL_CONTEXT_UNAUTHORIZED', lambda: self.memory())

    def test_optimistic_concurrency_and_idempotency(self):
        first = self.memory()
        replay = self.memory()
        self.assertEqual(first['item'], replay['item'])
        self.assertTrue(replay['replayed'])
        self.assertEqual(1, replay['context_revision'])
        self.assert_code('PERSONAL_CONTEXT_OPERATION_CONFLICT', lambda: self.memory(body='另一正文'))
        self.assert_code('PERSONAL_CONTEXT_REVISION_CONFLICT', lambda: self.memory(op='new-op'))
        updated = self.memory(revision=1, op='memory-edit', body='重新核对的背景')
        self.assertEqual(2, updated['item']['revision'])
        replay = self.memory()
        self.assertEqual(1, replay['operation_revision'])
        self.assertEqual(2, replay['item']['revision'])
        self.assertEqual('重新核对的背景', replay['item']['value']['body'])

    def test_delete_tombstone_and_old_save_replay_never_resurrects_content(self):
        self.memory()
        deleted = self.store.delete_memory('phone-a', dict(op_id='delete-1', expected_revision=1, memory_id='memory-1'))
        self.assertEqual('deleted', deleted['item']['status'])
        self.assertIsNone(deleted['item']['value'])
        self.assertEqual(2, deleted['item']['revision'])
        self.assertEqual('deleted', self.memory()['item']['status'])
        self.assertEqual('deleted', self.store.read('phone-a2')['memories'][0]['status'])
        self.assert_code('PERSONAL_CONTEXT_REVISION_CONFLICT', lambda: self.memory(op='create-after-delete'))

    def test_manual_confirmation_and_field_allowlist(self):
        cases = [self.body({'name': '人'}, confirmed=False),
                 self.body({'name': '人', 'authorization': 'all'}),
                 self.body({'name': '人'}, source={'kind': 'manual'})]
        for body in cases:
            with self.subTest(body=body), self.assertRaises(PersonalContextError):
                self.store.save_profile('phone-a', body)
        self.assert_code('PERSONAL_CONTEXT_INVALID', lambda: self.memory(source={'kind': 'manual', 'fingerprint': 'fake'}))
        self.assert_code('PERSONAL_CONTEXT_INVALID', lambda: self.memory(source={'kind': 'shared_external', 'url': 'https://example.com'}))
        self.assert_code('PERSONAL_CONTEXT_INVALID', lambda: self.memory(revision=True))

    def test_disabled_is_default_and_does_not_include_private_text(self):
        self.memory(body='不应出现在禁用快照的内容')
        snapshot = self.store.snapshot('phone-a')
        self.assertFalse(snapshot['enabled'])
        self.assertEqual([], snapshot['entry_refs'])
        self.assertEqual([], snapshot['context']['memories'])
        self.store.save_preferences('phone-a', self.body({'tone': '简洁'}, op='default-preferences'))
        self.assertFalse(self.store.snapshot('phone-a')['enabled'])
        self.enable(1)
        self.assertEqual('不应出现在禁用快照的内容', self.store.snapshot('phone-a')['context']['memories'][0]['body'])

    def test_snapshot_validation_rebuilds_trusted_text_not_client_supplied_context(self):
        self.enable(tone='先结论', avoid='不公开私人背景')
        self.memory()
        snapshot = self.store.snapshot('phone-a')
        fake = copy.deepcopy(snapshot)
        fake['context']['memories'][0]['body'] = '客户端伪造内容'
        checked = self.store.validate_snapshot('phone-a', fake)
        self.assertEqual('明确核对的个人背景', checked['context']['memories'][0]['body'])
        self.assertEqual(snapshot['snapshot_id'], checked['snapshot_id'])
        self.assert_code('PERSONAL_CONTEXT_SNAPSHOT_CHANGED', lambda: self.store.validate_snapshot('phone-b', snapshot))

    def test_changed_preferences_memory_and_identity_invalidate_fixed_snapshot(self):
        self.enable()
        self.memory()
        snapshot = self.store.snapshot('phone-a')
        self.memory(revision=1, op='edit-memory', body='新背景')
        self.assert_code('PERSONAL_CONTEXT_SNAPSHOT_CHANGED', lambda: self.store.validate_snapshot('phone-a', snapshot))
        snapshot = self.store.snapshot('phone-a')
        self.enable(1, op='avoid-change', avoid='新的回避事项')
        self.assert_code('PERSONAL_CONTEXT_SNAPSHOT_CHANGED', lambda: self.store.validate_snapshot('phone-a', snapshot))
        snapshot = self.store.snapshot('phone-a')
        self.identities['phone-a']['binding_revision'] += 1
        self.assert_code('PERSONAL_CONTEXT_SNAPSHOT_CHANGED', lambda: self.store.validate_snapshot('phone-a', snapshot))

    def test_unrelated_memory_edit_does_not_invalidate_explicit_selection(self):
        self.enable()
        self.memory()
        self.memory('memory-2', op='second-memory')
        snapshot = self.store.snapshot('phone-a', ['memory-1'])
        self.memory('memory-2', revision=1, op='edit-other', body='其他背景')
        self.assertEqual(snapshot['snapshot_id'], self.store.validate_snapshot('phone-a', snapshot)['snapshot_id'])

    def test_source_is_server_canonical_and_changed_source_purges_derived_text(self):
        self.enable()
        self.memory(source=dict(kind='meeting', session_id='meeting-1', utterance_ids=['u2', 'u1'], fingerprint='client-value'))
        item = self.store.read('phone-a')['memories'][0]
        self.assertEqual('server-fingerprint', item['source']['fingerprint'])
        snapshot = self.store.snapshot('phone-a')
        self.fingerprint = 'changed-server-fingerprint'
        item = self.store.read('phone-a')['memories'][0]
        self.assertEqual('needs_review', item['status'])
        self.assertEqual(2, item['revision'])
        self.assertIsNone(item['value'])
        self.fingerprint = 'server-fingerprint'
        self.assertEqual('needs_review', self.store.read('phone-a')['memories'][0]['status'])
        self.assert_code('PERSONAL_CONTEXT_SNAPSHOT_CHANGED', lambda: self.store.validate_snapshot('phone-a', snapshot))
        with sqlite3.connect(self.store.path) as db:
            self.assertEqual('{}', db.execute("SELECT value FROM entries WHERE kind='memory'").fetchone()[0])

    def test_temporarily_unavailable_source_is_hidden_but_not_destructively_invalidated(self):
        self.enable()
        self.memory(source=dict(kind='meeting', session_id='meeting-1', utterance_ids=['u1']))
        self.source_state = 'unavailable'
        item = self.store.read('phone-a')['memories'][0]
        self.assertEqual('source_unavailable', item['status'])
        self.assertIsNone(item['value'])
        self.assertEqual([], self.store.snapshot('phone-a')['context']['memories'])
        self.assert_code('PERSONAL_CONTEXT_SOURCE_CHANGED', lambda: self.store.snapshot('phone-a', ['memory-1']))
        self.source_state = 'current'
        self.assertEqual('current', self.store.read('phone-a')['memories'][0]['status'])

    def test_failed_explicit_snapshot_still_persists_source_invalidation(self):
        self.enable()
        self.memory(source=dict(kind='meeting', session_id='meeting-1', utterance_ids=['u1']))
        self.source_state = 'invalid'
        self.assert_code('PERSONAL_CONTEXT_SOURCE_CHANGED', lambda: self.store.snapshot('phone-a', ['memory-1']))
        self.source_state = 'current'
        self.assertEqual('needs_review', self.store.read('phone-a')['memories'][0]['status'])

    def test_snapshot_validation_persists_invalidation_before_rejecting_old_input(self):
        self.enable()
        self.memory(source=dict(kind='meeting', session_id='meeting-1', utterance_ids=['u1']))
        snapshot = self.store.snapshot('phone-a')
        self.source_state = 'invalid'
        self.assert_code('PERSONAL_CONTEXT_SNAPSHOT_CHANGED', lambda: self.store.validate_snapshot('phone-a', snapshot))
        self.source_state = 'current'
        self.assertEqual('needs_review', self.store.read('phone-a')['memories'][0]['status'])

    def test_account_swap_during_source_check_rolls_back_write(self):
        self.source_state = 'account_swap'
        self.assert_code('PERSONAL_CONTEXT_IDENTITY_CHANGED', lambda: self.memory(source=dict(kind='meeting', session_id='meeting-1', utterance_ids=['u1'])))
        self.source_state = 'current'
        self.assertEqual([], self.store.read('phone-a')['memories'])

    def test_account_swap_uses_new_namespace_and_cannot_access_old_snapshot(self):
        self.enable()
        self.memory()
        snapshot = self.store.snapshot('phone-a')
        self.assertLessEqual(len(json.dumps(snapshot['context'], ensure_ascii=False, sort_keys=True, separators=(',', ':'))), 12000)
        self.identities['phone-a'].update(account_key='tenant:person-b', binding_revision=2)
        self.assertEqual([], self.store.read('phone-a')['memories'])
        self.assert_code('PERSONAL_CONTEXT_SNAPSHOT_CHANGED', lambda: self.store.validate_snapshot('phone-a', snapshot))
        self.assertEqual(1, len(self.store.read('phone-a2')['memories']))

    def test_memory_and_snapshot_limits_fail_without_silent_truncation(self):
        self.assert_code('PERSONAL_CONTEXT_INVALID', lambda: self.memory(body='字' * 2001))
        self.enable()
        for index in range(22):
            self.memory('memory-' + str(index).zfill(2), op='save-' + str(index), body='字' * 1000)
        snapshot = self.store.snapshot('phone-a')
        self.assertLess(len(snapshot['context']['memories']), 20)
        self.assertTrue(any(item['status'] == 'limit' for item in snapshot['excluded']))
        self.assert_code('PERSONAL_CONTEXT_INVALID', lambda: self.store.snapshot('phone-a', ['memory-' + str(i) for i in range(21)]))
        self.assert_code('PERSONAL_CONTEXT_LIMIT', lambda: self.store.snapshot('phone-a', ['memory-' + str(i).zfill(2) for i in range(20)]))

    def test_two_store_instances_cannot_both_commit_same_expected_revision(self):
        other = self.make_store()
        barrier, results = threading.Barrier(2), []
        def write(store, operation):
            barrier.wait()
            try:
                store.save_profile('phone-a', self.body({'name': operation}, op=operation))
                results.append('saved')
            except PersonalContextError as error:
                results.append(error.code)
        threads = [threading.Thread(target=write, args=(store, op)) for store, op in [(self.store, 'op-1'), (other, 'op-2')]]
        for thread in threads: thread.start()
        for thread in threads: thread.join()
        self.assertCountEqual(['saved', 'PERSONAL_CONTEXT_REVISION_CONFLICT'], results)

    def test_commit_fence_rechecks_identity_after_the_earlier_readonly_check(self):
        @contextlib.contextmanager
        def fence(identity):
            self.identities[identity['principal_id']]['binding_revision'] += 1
            yield
        self.store.commit_guard = fence
        self.assert_code('PERSONAL_CONTEXT_IDENTITY_CHANGED', lambda: self.memory())
        self.store.commit_guard = None
        self.assertEqual([], self.store.read('phone-a')['memories'])

    def test_scenarios_are_preserved_filtered_and_part_of_snapshot_identity(self):
        self.enable(scenarios=['汇报'], context='向负责人汇报时')
        body = self.body(dict(title='汇报习惯', body='先说风险', scenarios=['汇报']),
                         op='report-memory', memory_id='report-memory', source={'kind': 'manual'})
        self.store.save_memory('phone-a', body)
        self.assertEqual(['汇报'], self.store.read('phone-a2')['memories'][0]['value']['scenarios'])
        report = self.store.snapshot('phone-a', scenario='汇报')
        self.assertEqual('向负责人汇报时', report['context']['preferences']['context'])
        self.assertEqual('先说风险', report['context']['memories'][0]['body'])
        meeting = self.store.snapshot('phone-a', scenario='会议')
        self.assertTrue(meeting['enabled'])
        self.assertIsNone(meeting['context']['preferences'])
        self.assertEqual([], meeting['context']['memories'])
        self.assertNotEqual(report['snapshot_id'], meeting['snapshot_id'])
        self.assertEqual(report['snapshot_id'], self.store.validate_snapshot('phone-a', report)['snapshot_id'])
        forged = copy.deepcopy(report)
        forged.update(scenario='会议', context=dict(profile=None, preferences=None, memories=[]))
        forged['snapshot_id'] = _hash(dict(subject=self.store._subject(self.identity('phone-a')),
            identity_revision=forged['identity_revision'], enabled=True, scenario='会议',
            entry_refs=forged['entry_refs'], context=forged['context']))
        self.assert_code('PERSONAL_CONTEXT_SNAPSHOT_CHANGED', lambda: self.store.validate_snapshot('phone-a', forged))
        self.assert_code('PERSONAL_CONTEXT_SCENARIO_MISMATCH', lambda: self.store.snapshot('phone-a', ['report-memory'], scenario='写作'))
        self.assert_code('PERSONAL_CONTEXT_INVALID', lambda: self.enable(1, op='bad-scope', scenarios=['任意']))
        self.assert_code('PERSONAL_CONTEXT_INVALID', lambda: self.store.snapshot('phone-a', scenario='未知'))


if __name__ == '__main__':
    unittest.main()
