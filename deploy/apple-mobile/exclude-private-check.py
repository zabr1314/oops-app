#!/usr/bin/env python3
"""Exclude one explicitly authorized private check from automatic public history.

Only open-access.json is changed. The personal access database is read-only.
No meeting text, credentials, other scopes, services or backend data are changed.
"""
import argparse
import copy
import datetime as dt
import fcntl
import json
import os
from pathlib import Path
import re
import sqlite3
import stat
import sys
import tempfile
import urllib.parse
import uuid

CONFIG = Path('/var/lib/oops-history/open-access.json')
ACCESS_DB = Path('/var/lib/oops-history/access.sqlite3')
BACKUPS = Path('/var/backups/oops-apple-mobile')
IDENTIFIER = re.compile(r'[A-Za-z0-9_-]{1,100}')
MAX_CONFIG = 2_000_000


class Refusal(Exception):
    def __init__(self, code):
        self.code = code


def require(condition, code):
    if not condition:
        raise Refusal(code)


def parse_uuid(value):
    try:
        parsed = uuid.UUID(value)
        require(str(parsed) == value.lower(), 'SESSION_ID_MUST_BE_CANONICAL_UUID')
        return str(parsed)
    except (ValueError, AttributeError):
        raise Refusal('SESSION_ID_MUST_BE_VALID_UUID') from None


def same_session(value, session_id):
    if value == session_id:
        return True
    try:
        return isinstance(value, str) and str(uuid.UUID(value)) == session_id
    except (ValueError, AttributeError):
        return False


def valid_identifiers(value, limit):
    return isinstance(value, list) and len(value) <= limit and all(
        isinstance(item, str) and IDENTIFIER.fullmatch(item) for item in value)


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result, 'DUPLICATE_CONFIG_KEY')
        result[key] = value
    return result


def decode(raw):
    def invalid(_):
        raise Refusal('NONFINITE_CONFIG_VALUE')
    return json.loads(raw, object_pairs_hook=unique_object, parse_constant=invalid)


def validate_config(value, session_id):
    require(isinstance(value, dict), 'OPEN_ACCESS_CONFIG_INVALID')
    fixed = value.get('meetings', [])
    require(valid_identifiers(fixed, 200), 'FIXED_MEETING_LIST_INVALID')
    require(not any(same_session(item, session_id) for item in fixed), 'SESSION_PRESENT_IN_FIXED_SCOPE')
    automatic = value.get('auto_meetings')
    require(isinstance(automatic, dict), 'AUTOMATIC_SCOPE_CONFIG_MISSING')
    excluded = automatic.get('excluded_meetings', [])
    require(valid_identifiers(excluded, 10000), 'EXCLUSION_LIST_INVALID')
    require(session_id in excluded or len(excluded) < 10000, 'EXCLUSION_LIST_AT_CAPACITY')
    return excluded


def reject_personal_scope(session_id):
    require(ACCESS_DB.is_file() and not ACCESS_DB.is_symlink() and ACCESS_DB.resolve() == ACCESS_DB,
            'PERSONAL_ACCESS_DB_UNAVAILABLE')
    # Scan only the kind/scope columns, never invite or session credential hashes.
    # Conservatively reject even expired rows that have not yet been removed.
    uri = 'file:' + urllib.parse.quote(str(ACCESS_DB), safe='/') + '?mode=ro'
    connection = sqlite3.connect(uri, uri=True, timeout=5, isolation_level=None)
    try:
        connection.execute('PRAGMA query_only=ON')
        connection.execute('BEGIN')
        cursor = connection.execute('SELECT kind,scope FROM access')
        for kind, encoded in cursor:
            require(kind in ('invite', 'session') and isinstance(encoded, str) and len(encoded) <= MAX_CONFIG,
                    'PERSONAL_SCOPE_SCHEMA_UNRECOGNIZED')
            scope = decode(encoded)
            require(isinstance(scope, list) and all(isinstance(item, str) and IDENTIFIER.fullmatch(item) for item in scope),
                    'PERSONAL_SCOPE_INVALID')
            require(not any(same_session(item, session_id) for item in scope), 'SESSION_PRESENT_IN_PERSONAL_SCOPE')
        connection.execute('COMMIT')
    finally:
        connection.close()


def write_private(path, data, uid=0, gid=0):
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    os.fchown(descriptor, uid, gid)
    with os.fdopen(descriptor, 'wb') as target:
        target.write(data)
        target.flush()
        os.fsync(target.fileno())


def backup(original, info, session_id):
    require(not BACKUPS.is_symlink() and BACKUPS.parent.resolve() == BACKUPS.parent, 'UNSAFE_BACKUP_ROOT')
    BACKUPS.mkdir(mode=0o700, exist_ok=True)
    require(BACKUPS.stat().st_uid == 0 and not BACKUPS.stat().st_mode & 0o077, 'UNSAFE_BACKUP_PERMISSIONS')
    stamp = dt.datetime.now(dt.timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')
    directory = BACKUPS / ('PRIVATE_CHECK_' + stamp)
    directory.mkdir(mode=0o700)
    write_private(directory / 'open-access.before.json', original)
    metadata = dict(target=str(CONFIG), session_id=session_id,
                    original_uid=info.st_uid, original_gid=info.st_gid,
                    original_mode=oct(stat.S_IMODE(info.st_mode)),
                    change='append only this UUID to auto_meetings.excluded_meetings',
                    personal_access_db_modified=False)
    write_private(directory / 'restore-metadata.json', (json.dumps(metadata, indent=2) + '\n').encode())
    return directory


def same_original(info, original):
    current = CONFIG.stat()
    require((current.st_dev, current.st_ino, current.st_uid, current.st_gid) ==
            (info.st_dev, info.st_ino, info.st_uid, info.st_gid) and CONFIG.read_bytes() == original,
            'OPEN_ACCESS_CHANGED_CONCURRENTLY')


def change(session_id):
    require(sys.platform.startswith('linux') and os.geteuid() == 0, 'ROOT_ON_LINUX_REQUIRED')
    os.umask(0o077)
    require(CONFIG.is_file() and not CONFIG.is_symlink() and CONFIG.resolve() == CONFIG, 'OPEN_ACCESS_FILE_UNAVAILABLE')
    with CONFIG.open('rb') as original_file:
        fcntl.flock(original_file.fileno(), fcntl.LOCK_EX)
        info = os.fstat(original_file.fileno())
        require(stat.S_ISREG(info.st_mode), 'OPEN_ACCESS_NOT_REGULAR_FILE')
        original = original_file.read(MAX_CONFIG + 1)
        require(len(original) <= MAX_CONFIG, 'OPEN_ACCESS_FILE_TOO_LARGE')
        before = decode(original)
        excluded = validate_config(before, session_id)
        reject_personal_scope(session_id)
        proposed = copy.deepcopy(before)
        already_excluded = session_id in excluded
        if not already_excluded:
            proposed['auto_meetings']['excluded_meetings'] = [*excluded, session_id]
        expected = excluded if already_excluded else [*excluded, session_id]
        require(proposed['auto_meetings'].get('excluded_meetings', []) == expected, 'INVALID_SINGLE_ID_CHANGE')
        directory = backup(original, info, session_id)
        # Recheck both potential sources of wider access immediately before write.
        reject_personal_scope(session_id)
        same_original(info, original)
        raw = (json.dumps(proposed, ensure_ascii=False, indent=2, allow_nan=False) + '\n').encode()
        descriptor, name = tempfile.mkstemp(prefix='.private-check-', dir=CONFIG.parent)
        committed = False
        try:
            os.fchmod(descriptor, stat.S_IMODE(info.st_mode))
            os.fchown(descriptor, info.st_uid, info.st_gid)
            with os.fdopen(descriptor, 'wb') as target:
                target.write(raw)
                target.flush()
                os.fsync(target.fileno())
            same_original(info, original)
            os.replace(name, CONFIG)
            committed = True
            parent_fd = os.open(CONFIG.parent, os.O_RDONLY | os.O_DIRECTORY)
            try:
                os.fsync(parent_fd)
            finally:
                os.close(parent_fd)
            after = decode(CONFIG.read_bytes())
            validate_config(after, session_id)
            require(after['auto_meetings'].get('excluded_meetings', []) == expected
                    and session_id in after['auto_meetings'].get('excluded_meetings', []), 'EXCLUSION_READBACK_FAILED')
            compare = copy.deepcopy(after)
            if 'excluded_meetings' in before['auto_meetings']:
                compare['auto_meetings']['excluded_meetings'] = copy.deepcopy(before['auto_meetings']['excluded_meetings'])
            else:
                compare['auto_meetings'].pop('excluded_meetings', None)
            require(compare == before, 'OTHER_CONFIG_FIELDS_CHANGED')
            new_info = CONFIG.stat()
            require(stat.S_IMODE(new_info.st_mode) == stat.S_IMODE(info.st_mode) and
                    (new_info.st_uid, new_info.st_gid) == (info.st_uid, info.st_gid), 'OWNER_OR_MODE_READBACK_FAILED')
            reject_personal_scope(session_id)
        except (Refusal, OSError, ValueError, KeyError, sqlite3.Error):
            # Do not restore the old automatic range after a write: that could
            # expose this session. Leave the exclusion and stop for inspection.
            if committed:
                return dict(status='verification_required', session_id=session_id, backup=str(directory),
                            automatic_exclusion_written=True,
                            message='Readback/scope conflict after write; keep recording sync on hold. No other scope was rewritten.')
            raise
        finally:
            if os.path.exists(name):
                os.unlink(name)
        return dict(status='excluded', session_id=session_id, already_excluded=already_excluded,
                    backup=str(directory), owner_preserved=True,
                    mode=oct(stat.S_IMODE(info.st_mode)), mode_preserved=True,
                    fixed_list_unchanged=True, personal_scope_conflict=False,
                    only_auto_exclusion_changed=True)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--session-id', required=True, help='Exact UUID explicitly authorized for this private check')
    args = parser.parse_args(argv)
    try:
        result = change(parse_uuid(args.session_id))
    except Refusal as error:
        result = dict(status='refused', reason=error.code, config_changed=False)
    except (OSError, ValueError, KeyError, sqlite3.Error):
        result = dict(status='refused', reason='READ_OR_WRITE_GUARD_FAILED', config_changed=False)
    print(json.dumps(result, ensure_ascii=False))
    return 0 if result['status'] == 'excluded' else 1


if __name__ == '__main__':
    raise SystemExit(main())
