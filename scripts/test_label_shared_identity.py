#!/usr/bin/env python3
"""Team identity linkage, explicit migration and per-person sentence exceptions.

Every write is to a temporary fixture; no remote requests or model calls.
"""
import copy
import hashlib
import io
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import time
import unittest
from contextlib import redirect_stdout
import urllib.error
import urllib.request

import label_ai
import label_shared_identity as shared
import team_label as tl
from label_workflow import content_audit
from test_team_label_workflow import ALICE, BOB, SECRET, WorkflowFixture


class SharedIdentityTest(WorkflowFixture):
    def confirm(self, name=ALICE, speaker=ALICE, group='role:A'):
        return self.data.review_identity(name, self.identity_body(name=name, speaker=speaker, group=group))

    def test_shared_confirmation_is_visible_to_everyone_without_sentence_writes(self):
        result = self.confirm()
        self.assertTrue(result['shared'])
        self.assertEqual('team', result['scope'])
        for name in tl.PEOPLE:
            payload = self.data.identity_payload(name)
            group = next(g for g in payload['groups'] if g['id'] == 'role:A')
            self.assertEqual((True, ALICE, ALICE), (group['current'], group['speaker'], group['confirmed_by']))
            self.assertEqual(ALICE, self.labels(name=name)['a1']['speaker'])
            self.assertFalse(os.path.exists(self.data.labels_path('0235', name)))
            self.assertFalse(os.path.exists(self.data._identity_path(name)))
        saved = shared.read(self.data)
        self.assertEqual(1, saved['revision'])
        self.assertEqual(ALICE, saved['events'][-1]['by'])
        self.assertEqual(0o600, os.stat(shared.path(self.data)).st_mode & 0o777)

    def test_other_member_can_update_revoke_and_undo_with_one_global_revision(self):
        self.confirm()
        self.confirm(name=BOB, speaker=BOB)
        self.assertEqual(BOB, self.labels()['a1']['speaker'])
        self.data.review_identity(ALICE, self.identity_body(action='revoke'))
        self.assertFalse(self.labels().get('a1', {}).get('speaker'))
        self.undo(identity=True, name=BOB)
        self.assertEqual(BOB, self.labels()['a1']['speaker'])
        self.undo(identity=True, name=ALICE)
        self.assertEqual(ALICE, self.labels(name=BOB)['a1']['speaker'])
        self.assertEqual(5, self.data.identity_payload(ALICE)['revision'])
        self.assertEqual([ALICE, BOB, ALICE, BOB, ALICE], [e['by'] for e in shared.read(self.data)['events']])

    def test_stale_global_revision_and_reused_request_are_rejected(self):
        body = self.identity_body()
        first = self.data.review_identity(ALICE, body)
        self.data = tl.Data(self.folder)
        self.assertEqual(first, self.data.review_identity(ALICE, body))
        with self.assertRaises(ValueError):
            self.data.review_identity(ALICE, dict(body, speaker=BOB))
        with self.assertRaises(tl.RevisionConflict):
            self.data.review_identity(BOB, dict(body, request_id=self.request_id()))
        self.assertEqual(1, shared.read(self.data)['revision'])

    def test_personal_sentence_override_and_exclusion_beat_shared_but_not_other_people(self):
        self.confirm()
        self.set_row('a1', 'speaker', BOB)
        self.set_row('a2', 'speaker', None)
        mine = self.data.resolved_speakers('0235', ALICE)
        other = self.data.resolved_speakers('0235', BOB)
        self.assertEqual(BOB, mine['a1']['speaker'])
        self.assertEqual('single', mine['a1']['speaker_source']['mode'])
        self.assertEqual({'speaker_excluded': True}, mine['a2'])
        self.assertEqual(ALICE, other['a1']['speaker'])
        self.assertEqual(ALICE, other['a2']['speaker'])
        self.assertEqual(ALICE, self.data.resolved_speakers('0235')['a1']['speaker'])
        self.assertEqual(ALICE, self.data.resolved_speakers('0235')['a2']['speaker'])

    def test_machine_hints_and_role_claims_are_not_confirmed_names(self):
        self.data.claim('A', ALICE, BOB)
        self.assertEqual({}, self.data.resolved_speakers('0235'))
        self.assertEqual({}, self.data.resolved_speakers('0236', ALICE))
        self.confirm()
        source = self.data.resolved_speakers('0235')['a1']['speaker_source']
        self.assertEqual(('voice_group', True, 'team', 1, ALICE),
                         tuple(source[k] for k in ('mode', 'shared', 'scope', 'revision', 'by')))
        self.assertTrue(source['at'])

    def test_changed_source_stops_group_propagation_but_keeps_single_correction(self):
        self.confirm()
        self.set_row('a1', 'speaker', BOB)
        source = os.path.join(self.folder, 'meetings', '0236', 'meeting.json')
        changed = self.read_json(source)
        changed['utterances'][0]['text'] += '更正来源。'
        self.write_json(source, changed)
        self.data = tl.Data(self.folder)
        group = next(g for g in self.data.identity_payload(BOB)['groups'] if g['id'] == 'role:A')
        self.assertFalse(group['current'])
        self.assertIsNone(group['speaker'])
        self.assertEqual(BOB, self.data.resolved_speakers('0235', ALICE)['a1']['speaker'])
        self.assertEqual({}, self.data.resolved_speakers('0235'))

    def test_stale_single_correction_does_not_override_current_shared_name(self):
        self.set_row('a1', 'speaker', BOB)
        source = os.path.join(self.folder, 'meetings', '0235', 'meeting.json')
        changed = self.read_json(source)
        changed['utterances'][0]['text'] += '更正来源。'
        self.write_json(source, changed)
        self.data = tl.Data(self.folder)
        self.confirm()
        resolved = self.data.resolved_speakers('0235', ALICE)
        self.assertEqual(ALICE, resolved['a1']['speaker'])
        self.assertEqual('voice_group', resolved['a1']['speaker_source']['mode'])

    def test_legacy_materialized_group_answer_cannot_resurrect_a_revoked_shared_identity(self):
        group = self.data.groups['role:A']
        old = dict(revision=4, labels={'a1': dict(speaker=BOB,
            speaker_source=dict(mode='voice_group', id='role:A', fingerprint=group['fingerprint']))})
        self.data._write(self.data.labels_path('0235', ALICE), old)
        before = Path(self.data.labels_path('0235', ALICE)).read_bytes()
        self.assertEqual({}, self.data.resolved_speakers('0235', ALICE))
        self.confirm()
        self.assertEqual(ALICE, self.data.resolved_speakers('0235', ALICE)['a1']['speaker'])
        self.data.review_identity(BOB, self.identity_body(action='revoke', name=BOB))
        self.assertEqual({}, self.data.resolved_speakers('0235', ALICE))
        self.assertEqual(before, Path(self.data.labels_path('0235', ALICE)).read_bytes())

    def test_shared_names_are_not_independent_truth_and_are_absent_from_blind_labels(self):
        self.confirm()
        audit = content_audit(self.data.rows_with_claims('0235'), {ALICE: self.data.load('0235', ALICE)})
        self.assertEqual((0, 4), (audit['independent_speaker_rows'], audit['grouped_speaker_rows']))
        rows = self.data.meetings['0235']['rows']
        quote = label_ai.quote_meetings(self.folder, {'0235': rows}, 'fake', 2, 8,
            max_tokens=256, max_attempts=1, concurrency=1)
        label_ai.prepare_meetings(self.folder, {'0235': rows}, quote)
        blind = self.data.meeting_payload('0235', BOB, 'blind')
        self.assertTrue(blind['rows'])
        self.assertFalse(any(l.get('speaker_source', {}).get('shared') for l in blind['labels'].values()))
        self.assertFalse(any(l.get('speaker') for l in blind['labels'].values()))

    def test_actual_cli_server_returns_409_for_helper_conflicts(self):
        # Match systemd's __main__ entry point, not just imported test handlers.
        with socket.socket() as probe:
            probe.bind(('127.0.0.1', 0))
            port = probe.getsockname()[1]
        proc = subprocess.Popen([sys.executable, '-B', str(Path(tl.__file__).resolve()),
            'serve', '--data', self.folder, '--port', str(port)],
            env={**os.environ, 'LABEL_SECRET': SECRET}, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        base = 'http://127.0.0.1:' + str(port)
        headers = {'Authorization': 'Bearer ' + tl.make_key(SECRET, ALICE), 'Content-Type': 'application/json'}
        try:
            for _ in range(100):
                try:
                    with urllib.request.urlopen(urllib.request.Request(base + '/api/identity', headers=headers), timeout=.2) as response:
                        payload = json.load(response)
                    break
                except OSError:
                    if proc.poll() is not None:
                        self.fail('CLI fixture exited before listening')
                    time.sleep(.02)
            else:
                self.fail('CLI fixture did not listen')
            group = next(g for g in payload['groups'] if g['id'] == 'role:A')
            body = dict(action='confirm', request_id='cli-shared-confirm', revision=0,
                        group=group['id'], fingerprint=group['fingerprint'], speaker=ALICE)
            with urllib.request.urlopen(urllib.request.Request(base + '/api/identity',
                data=json.dumps(body).encode(), headers=headers), timeout=2) as response:
                self.assertEqual(1, json.load(response)['revision'])
            body['request_id'] = 'cli-shared-conflict'
            with self.assertRaises(urllib.error.HTTPError) as conflict:
                urllib.request.urlopen(urllib.request.Request(base + '/api/identity',
                    data=json.dumps(body).encode(), headers=headers), timeout=2)
            with conflict.exception:
                self.assertEqual(409, conflict.exception.code)
        finally:
            proc.terminate()
            proc.communicate(timeout=5)


class MigrationTest(WorkflowFixture):
    def personal_snapshot(self):
        approvals = {gid: dict(speaker=ALICE, fingerprint=g['fingerprint'], by=ALICE,
            at='2026-10-13T03:00:00', scope='voice_group',
            members=[dict(meeting=r['meeting'], id=r['id']) for r in g['members']])
            for gid, g in self.data.groups.items()}
        doc = dict(revision=5, approvals=approvals, history=[{}], seen={'original-request': 'original-hash'})
        self.data._write(self.data._identity_path(ALICE), doc)
        return doc

    def plan(self):
        return shared.migration_plan(self.data, ALICE, 5, len(self.data.groups))

    def test_get_does_not_import_personal_approvals_or_create_shared_storage(self):
        self.personal_snapshot()
        before = Path(self.data._identity_path(ALICE)).read_bytes()
        self.assertFalse(any(g['current'] for g in self.data.identity_payload(BOB)['groups']))
        self.assertEqual({}, self.data.resolved_speakers('0235'))
        self.assertFalse(os.path.exists(shared.path(self.data)))
        self.assertEqual(before, Path(self.data._identity_path(ALICE)).read_bytes())

    def test_explicit_migration_preserves_all_personal_bytes_and_original_provenance(self):
        self.personal_snapshot()
        self.data._write(self.data._identity_path(BOB), dict(revision=7, approvals={}, history=[{'old': 'answer'}]))
        paths = [self.data._identity_path(n) for n in (ALICE, BOB)]
        before = {p: hashlib.sha256(Path(p).read_bytes()).hexdigest() for p in paths}
        plan = self.plan()
        self.assertFalse(os.path.exists(shared.path(self.data)), 'Plan is read-only')
        result = shared.apply_migration(self.data, plan, plan['plan_hash'], BOB)
        self.assertEqual(('imported', len(self.data.groups)), (result['status'], result['groups']))
        self.assertEqual(before, {p: hashlib.sha256(Path(p).read_bytes()).hexdigest() for p in paths})
        approval = shared.read(self.data)['approvals']['role:A']
        self.assertEqual((ALICE, BOB, 5), (approval['by'], approval['imported_by'], approval['imported_source_revision']))
        self.assertEqual('2026-10-13T03:00:00', approval['at'])
        self.assertEqual(ALICE, self.labels(name=BOB)['a1']['speaker'])

    def test_migration_checks_source_revision_content_groups_target_and_plan_hash(self):
        original = self.personal_snapshot()
        plan = self.plan()
        with self.assertRaises(tl.RevisionConflict):
            shared.migration_plan(self.data, ALICE, 4)
        with self.assertRaises(ValueError):
            shared.apply_migration(self.data, plan, 'bad-hash', ALICE)
        changed = copy.deepcopy(original)
        changed['revision'] = 6
        self.data._write(self.data._identity_path(ALICE), changed)
        with self.assertRaises(tl.RevisionConflict):
            shared.apply_migration(self.data, plan, plan['plan_hash'], ALICE)
        changed['revision'] = 5
        changed['approvals']['role:A']['speaker'] = BOB
        self.data._write(self.data._identity_path(ALICE), changed)
        with self.assertRaises(tl.RevisionConflict):
            shared.apply_migration(self.data, plan, plan['plan_hash'], ALICE)
        self.data._write(self.data._identity_path(ALICE), original)
        self.data.groups['role:A']['fingerprint'] = 'changed-source'
        with self.assertRaises(tl.RevisionConflict):
            shared.apply_migration(self.data, plan, plan['plan_hash'], ALICE)
        self.assertFalse(os.path.exists(shared.path(self.data)))

    def test_changed_shared_target_blocks_old_plan(self):
        self.personal_snapshot()
        plan = self.plan()
        self.data.review_identity(BOB, self.identity_body(name=BOB, speaker=BOB))
        with self.assertRaises(tl.RevisionConflict):
            shared.apply_migration(self.data, plan, plan['plan_hash'], ALICE)

    def test_import_is_once_even_after_undo(self):
        self.personal_snapshot()
        plan = self.plan()
        shared.apply_migration(self.data, plan, plan['plan_hash'], ALICE)
        self.assertEqual('already_imported', shared.apply_migration(self.data, plan, plan['plan_hash'], BOB)['status'])
        self.undo(identity=True, name=BOB)
        self.assertFalse(self.data.resolved_speakers('0235'))
        self.assertEqual('already_imported', shared.apply_migration(self.data, plan, plan['plan_hash'], ALICE)['status'])
        self.assertFalse(self.data.resolved_speakers('0235'), 'Replayed import must not resurrect undone identities')
        fresh = self.plan()
        self.assertEqual('already_imported', shared.apply_migration(self.data, fresh, fresh['plan_hash'], ALICE)['status'])
        self.assertFalse(self.data.resolved_speakers('0235'), 'A new plan must not reimport the same personal snapshot')

    def test_migration_does_not_overwrite_a_differently_confirmed_team_group(self):
        self.personal_snapshot()
        self.data.review_identity(BOB, self.identity_body(name=BOB, speaker=BOB))
        with self.assertRaises(tl.RevisionConflict):
            self.plan()
        self.assertEqual(BOB, self.data.resolved_speakers('0235')['a1']['speaker'])

    def test_cli_plan_is_read_only_and_apply_checks_the_exact_plan(self):
        self.personal_snapshot()
        before = {str(p): p.read_bytes() for p in Path(self.folder).rglob('*') if p.is_file()}
        out = io.StringIO()
        with redirect_stdout(out):
            shared.main(['plan', '--data', self.folder, '--source', ALICE,
                         '--expected-source-revision', '5', '--expected-groups', str(len(self.data.groups))])
        plan = json.loads(out.getvalue())
        self.assertEqual(before, {str(p): p.read_bytes() for p in Path(self.folder).rglob('*') if p.is_file()})
        plan_path = Path(self.folder) / 'reviewed-plan.json'
        plan_path.write_text(json.dumps(plan), encoding='utf-8')
        out = io.StringIO()
        with redirect_stdout(out):
            shared.main(['apply', '--data', self.folder, '--plan', str(plan_path),
                         '--plan-hash', plan['plan_hash'], '--by', BOB])
        self.assertEqual('imported', json.loads(out.getvalue())['status'])
        self.assertEqual(ALICE, self.data.resolved_speakers('0235')['a1']['speaker'])


if __name__ == '__main__':
    unittest.main()
