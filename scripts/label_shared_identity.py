#!/usr/bin/env python3
"""Team-confirmed voice groups, separate from every person's sentence answers.

Migration is explicit and source-bound. ``plan`` reads only; ``apply`` imports
the exact reviewed personal snapshot after checking its revision and every
current group fingerprint. Neither HTTP reads nor writes import old answers.
"""
import argparse
import contextlib
import datetime as dt
import fcntl
import hashlib
import json
import os
import tempfile


SCHEMA = 1


def now():
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec='seconds')


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False,
                                     separators=(',', ':')).encode()).hexdigest()


def path(data):
    return os.path.join(data.folder, 'identities', 'shared.json')


def read(data):
    doc = data._read(path(data), {})
    if (not isinstance(doc, dict) or doc and (doc.get('schema') != SCHEMA or doc.get('scope') != 'team'
            or not isinstance(doc.get('revision'), int) or isinstance(doc['revision'], bool)
            or not isinstance(doc.get('approvals'), dict))):
        raise ValueError('shared_identity_invalid')
    result = {'schema': SCHEMA, 'scope': 'team', 'revision': 0, 'history': [], 'seen': {},
              'approvals': {}, 'events': [], 'migrations': {}, **doc}
    if (not all(isinstance(result[key], dict) for key in ('seen', 'migrations'))
            or not all(isinstance(result[key], list) for key in ('history', 'events'))):
        raise ValueError('shared_identity_invalid')
    return result


@contextlib.contextmanager
def locked(data):
    # GET never creates this lock file. All mutations and the offline importer
    # share it, including independent processes using the same data directory.
    with data.lock:
        folder = os.path.dirname(path(data))
        os.makedirs(folder, exist_ok=True)
        with open(os.path.join(folder, '.shared.lock'), 'a+b') as stream:
            fcntl.flock(stream.fileno(), fcntl.LOCK_EX)
            try:
                yield
            finally:
                fcntl.flock(stream.fileno(), fcntl.LOCK_UN)


def write(data, doc):
    folder = os.path.dirname(path(data))
    os.makedirs(folder, exist_ok=True)
    fd, stage = tempfile.mkstemp(prefix='.shared-', dir=folder)
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, 'w', encoding='utf-8') as stream:
            json.dump(doc, stream, ensure_ascii=False, indent=1, allow_nan=False)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(stage, path(data))
        directory = os.open(folder, os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if os.path.exists(stage):
            os.unlink(stage)


def valid(group, approval, people, other):
    return bool(group and isinstance(approval, dict)
                and approval.get('fingerprint') == group['fingerprint']
                and approval.get('speaker') in people + list(other))


def shared_roster(data):
    """Canonical team names already confirmed in current groups, without importing answers."""
    from team_label import PEOPLE, SPEAKER_OTHER
    approvals = read(data)['approvals']
    return [name for name in PEOPLE if any(
        approval.get('speaker') == name and valid(data.groups.get(gid), approval, PEOPLE, SPEAKER_OTHER)
        for gid, approval in approvals.items() if isinstance(approval, dict))]


def record_event(doc, name, body, **extra):
    doc['events'].append(dict(revision=doc['revision'], action=body['action'],
        by=name, at=now(), request_id=body['request_id'],
        **{key: body[key] for key in ('group', 'fingerprint', 'speaker') if key in body}, **extra))


def review(data, name, body):
    from team_label import PEOPLE, SPEAKER_OTHER, RevisionConflict
    if name not in PEOPLE:
        raise ValueError('unknown reviewer')
    with locked(data):
        doc = read(data)
        if not data._begin(doc, body, 'approvals'):
            return data.identity_payload(name)
        if body.get('action') != 'undo':
            group = data.groups.get(body.get('group'))
            if not group or body.get('fingerprint') != group['fingerprint']:
                raise RevisionConflict('Voice group changed')
            if body['action'] == 'revoke':
                doc['approvals'].pop(group['id'], None)
            elif body['action'] == 'confirm' and body.get('speaker') in PEOPLE + list(SPEAKER_OTHER):
                doc['approvals'][group['id']] = dict(speaker=body['speaker'], fingerprint=group['fingerprint'],
                    by=name, at=now(), scope='voice_group', shared=True,
                    members=[dict(meeting=r['meeting'], id=r['id']) for r in group['members']])
            else:
                raise ValueError('unknown identity action')
        record_event(doc, name, body)
        write(data, doc)
        return data.identity_payload(name)


def migration_plan(data, source, expected_source_revision, expected_groups=None):
    from team_label import PEOPLE, SPEAKER_OTHER, RevisionConflict
    if source not in PEOPLE:
        raise ValueError('unknown source')
    with open(data._identity_path(source), 'rb') as stream:
        raw = stream.read()
    personal = json.loads(raw)
    if personal.get('revision') != expected_source_revision:
        raise RevisionConflict('Personal identity revision changed')
    approvals = personal.get('approvals') or {}
    if not approvals or (expected_groups is not None and len(approvals) != expected_groups):
        raise RevisionConflict('Personal identity group count changed')
    for gid, approval in approvals.items():
        if not valid(data.groups.get(gid), approval, PEOPLE, SPEAKER_OTHER):
            raise RevisionConflict('Personal identity group changed')
    shared = read(data)
    for gid, approval in approvals.items():
        existing = shared['approvals'].get(gid)
        if valid(data.groups.get(gid), existing, PEOPLE, SPEAKER_OTHER) and existing['speaker'] != approval['speaker']:
            raise RevisionConflict('Team identity already confirmed differently')
    source_sha = hashlib.sha256(raw).hexdigest()
    plan = dict(schema=SCHEMA, kind='shared_identity_import', source=source,
        source_revision=expected_source_revision, source_sha256=source_sha,
        import_key=digest(dict(source=source, revision=expected_source_revision, sha256=source_sha)),
        target_revision=shared['revision'], target_hash=digest(shared),
        approvals=approvals, group_count=len(approvals))
    return dict(plan, plan_hash=digest(plan))


def apply_migration(data, plan, plan_hash, by):
    from team_label import PEOPLE, RevisionConflict
    if by not in PEOPLE:
        raise ValueError('unknown reviewer')
    unsigned = {key: value for key, value in plan.items() if key != 'plan_hash'}
    if (plan.get('plan_hash') != plan_hash or digest(unsigned) != plan_hash
            or plan.get('schema') != SCHEMA or plan.get('kind') != 'shared_identity_import'):
        raise ValueError('migration_plan_invalid')
    with locked(data):
        doc = read(data)
        import_key = digest(dict(source=plan['source'], revision=plan['source_revision'], sha256=plan['source_sha256']))
        if plan.get('import_key') != import_key:
            raise ValueError('migration_plan_invalid')
        if import_key in doc['migrations']:
            return dict(status='already_imported', revision=doc['revision'],
                        groups=doc['migrations'][import_key]['groups'])
        fresh = migration_plan(data, plan['source'], plan['source_revision'], plan['group_count'])
        if fresh != plan:
            raise RevisionConflict('Migration source or team identities changed')
        body = dict(action='import', request_id='migration:' + plan_hash, revision=doc['revision'])
        data._begin(doc, body, 'approvals')
        stamp = now()
        for gid, approval in plan['approvals'].items():
            doc['approvals'][gid] = dict(approval, shared=True,
                imported_from=plan['source'], imported_source_revision=plan['source_revision'],
                imported_by=by, imported_at=stamp)
        doc['migrations'][import_key] = dict(groups=plan['group_count'], source=plan['source'], plan_hash=plan_hash,
            source_revision=plan['source_revision'], source_sha256=plan['source_sha256'],
            by=by, at=stamp, revision=doc['revision'])
        record_event(doc, by, body, source=plan['source'], source_revision=plan['source_revision'],
                     plan_hash=plan_hash, groups=list(plan['approvals']))
        write(data, doc)
        return dict(status='imported', revision=doc['revision'], groups=plan['group_count'])


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    prepare = commands.add_parser('plan')
    prepare.add_argument('--data', required=True)
    prepare.add_argument('--source', required=True)
    prepare.add_argument('--expected-source-revision', required=True, type=int)
    prepare.add_argument('--expected-groups', type=int)
    apply = commands.add_parser('apply')
    apply.add_argument('--data', required=True)
    apply.add_argument('--plan', required=True)
    apply.add_argument('--plan-hash', required=True)
    apply.add_argument('--by', required=True)
    args = parser.parse_args(argv)
    from team_label import Data
    # A plan must not recover/write unrelated pending content transactions.
    data = Data(args.data, recover_similarity=False)
    if args.command == 'plan':
        result = migration_plan(data, args.source, args.expected_source_revision, args.expected_groups)
    else:
        with open(args.plan, encoding='utf-8') as stream:
            plan = json.load(stream)
        result = apply_migration(data, plan, args.plan_hash, args.by)
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
