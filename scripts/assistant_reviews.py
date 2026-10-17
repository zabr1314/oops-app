"""Source-bound, read-only overlay for explicitly reviewed meetings.

The private record is independent of the owning meeting store.  Readers never
write, call providers, or use an unavailable source as a replacement transcript.
``cleanup`` is an explicit retention-worker operation, separate from reads.
"""
import collections
import datetime as dt
import hashlib
import json
import os
import re
import stat
import tempfile


REVIEW_SOURCES = {
    'd401d862-7b4c-48d2-9d8a-c99cbe879daa': ('assistant-review-d401d862-20261017', 337),
    'a332ef13-7fce-4895-9726-4d4ca548be83': ('assistant-review-a332ef13-20261017', 225),
}
DEFAULT_REVIEW_DIR = '/var/lib/oops-history/assistant-reviews'
DEFAULT_RECEIPT_DIR = '/var/lib/oops-history/assistant-review-receipts'
MAX_RECORD_BYTES = 4 * 1024 * 1024
SOURCE_FIELDS = ('id', 'text', 'start_ms', 'end_ms', 'speaker')
TAGS = frozenset(('decision', 'commitment', 'idea', 'fact', 'question',
                  'constraint', 'chitchat', 'uncertain'))
HEX_HASH = re.compile(r'[0-9a-f]{64}')
REVIEW_SCOPE = 'after-meeting contextual classification; not original processing traces or human confirmation'
MANIFEST_KEYS = ('version', 'kind', 'label', 'run_id', 'created_at', 'source_session_id',
                 'source_snapshot_hash', 'source_hash', 'sentence_count', 'reviewer',
                 'provider_api_calls', 'confidence_kind', 'scope', 'counts')


class ReviewError(ValueError):
    """A safe, non-content failure reason for the optional overlay."""
    def __init__(self, status, reason):
        super().__init__(reason)
        self.status, self.reason = status, reason


def _digest(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True,
                                    separators=(',', ':'), allow_nan=False).encode()).hexdigest()


def _hash(value):
    return isinstance(value, str) and HEX_HASH.fullmatch(value) is not None


def _text(value, maximum):
    return isinstance(value, str) and bool(value.strip()) and len(value) <= maximum


def _directory(directory):
    root = os.path.abspath(os.fspath(directory))
    if os.path.realpath(root) != root:
        raise ReviewError('unavailable', 'review_path_unavailable')
    flags = os.O_RDONLY | getattr(os, 'O_DIRECTORY', 0) | getattr(os, 'O_NOFOLLOW', 0)
    descriptor = os.open(root, flags)
    if not stat.S_ISDIR(os.fstat(descriptor).st_mode):
        os.close(descriptor)
        raise ReviewError('unavailable', 'review_path_unavailable')
    return root, descriptor


def _identity(value):
    return value.st_dev, value.st_ino, value.st_size, value.st_mtime_ns


def _read_record(directory, sid):
    """Open only the pinned basename; bounded reads never follow a symlink."""
    root, parent = _directory(directory)
    try:
        descriptor = os.open(sid + '.json', os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0), dir_fd=parent)
        with os.fdopen(descriptor, 'rb') as source:
            before = os.fstat(source.fileno())
            if not stat.S_ISREG(before.st_mode) or before.st_size > MAX_RECORD_BYTES:
                raise ReviewError('invalid', 'review_record_invalid')
            body = source.read(MAX_RECORD_BYTES + 1)
            after = os.fstat(source.fileno())
        if len(body) > MAX_RECORD_BYTES or _identity(before) != _identity(after):
            raise ReviewError('invalid', 'review_record_invalid')
        try:
            value = json.loads(body)
        except (ValueError, UnicodeError):
            raise ReviewError('invalid', 'review_record_invalid') from None
        if not isinstance(value, dict):
            raise ReviewError('invalid', 'review_record_invalid')
        return value, _identity(after), root
    finally:
        os.close(parent)


def _manifest(record, sid):
    run_id, sentence_count = REVIEW_SOURCES[sid]
    value = record.get('manifest')
    if not isinstance(value, dict):
        raise ReviewError('invalid', 'review_manifest_invalid')
    expected = dict(version=1, kind='assistant_posthoc', label='本次助手复核', run_id=run_id,
                    source_session_id=sid, sentence_count=sentence_count,
                    reviewer='current_conversation_assistant', provider_api_calls=0,
                    confidence_kind='not_scored', scope=REVIEW_SCOPE)
    if any(value.get(key) != item or type(value.get(key)) is not type(item) for key, item in expected.items()):
        raise ReviewError('invalid', 'review_manifest_invalid')
    if not _hash(value.get('source_snapshot_hash')) or not _hash(value.get('source_hash')):
        raise ReviewError('invalid', 'review_manifest_invalid')
    stamp = value.get('created_at')
    try:
        valid_stamp = isinstance(stamp, str) and len(stamp) <= 50 and dt.datetime.fromisoformat(stamp.replace('Z', '+00:00')).tzinfo is not None
    except ValueError:
        valid_stamp = False
    counts = value.get('counts')
    if (not valid_stamp or not isinstance(counts, dict) or set(counts) != TAGS
            or any(type(number) is not int or number < 0 for number in counts.values())
            or sum(counts.values()) != sentence_count):
        raise ReviewError('invalid', 'review_manifest_invalid')
    return {key: value[key] for key in MANIFEST_KEYS}


def _judgments(record, sentences, manifest):
    sentence_count = manifest['sentence_count']
    items = record.get('items')
    if (not isinstance(items, list) or len(items) != sentence_count
            or len(sentences) != sentence_count
            or any(not isinstance(sentence, dict) for sentence in sentences)):
        raise ReviewError('invalid', 'review_items_invalid')
    ids = [sentence.get('id') for sentence in sentences]
    if any(not isinstance(uid, str) or not uid for uid in ids) or len(set(ids)) != sentence_count:
        raise ReviewError('invalid', 'review_items_invalid')
    judgments, counts = [], collections.Counter()
    for index, (item, sentence) in enumerate(zip(items, sentences), 1):
        if (not isinstance(item, dict) or type(item.get('index')) is not int or item['index'] != index
                or item.get('id') != sentence['id'] or item.get('tag') not in TAGS
                or not _text(item.get('reason'), 1000) or not _text(item.get('evidence_quote'), 2000)
                or not isinstance(sentence.get('text'), str) or item['evidence_quote'] not in sentence['text']):
            raise ReviewError('invalid', 'review_items_invalid')
        secondary = item.get('secondary')
        if not isinstance(secondary, list) or len(secondary) > 2:
            raise ReviewError('invalid', 'review_items_invalid')
        clean_secondary = []
        for additional in secondary:
            if (not isinstance(additional, dict) or additional.get('tag') not in TAGS
                    or not _text(additional.get('quote'), 2000) or additional['quote'] not in sentence['text']):
                raise ReviewError('invalid', 'review_items_invalid')
            clean_secondary.append(dict(tag=additional['tag'], quote=additional['quote']))
        counts[item['tag']] += 1
        judgments.append(dict(tag=item['tag'], reason=item['reason'], evidence_quote=item['evidence_quote'],
                              secondary=clean_secondary,
                              source_binding={key: sentence.get(key) for key in SOURCE_FIELDS}))
    if {tag: counts[tag] for tag in TAGS} != manifest['counts']:
        raise ReviewError('invalid', 'review_counts_invalid')
    adjustments = record.get('review_adjustments')
    if not isinstance(adjustments, list) or len(adjustments) > sentence_count:
        raise ReviewError('invalid', 'review_adjustments_invalid')
    seen = set()
    for adjustment in adjustments:
        if not isinstance(adjustment, dict):
            raise ReviewError('invalid', 'review_adjustments_invalid')
        index = adjustment.get('index')
        if (type(index) is not int or not 1 <= index <= sentence_count or index in seen
                or adjustment.get('id') != ids[index - 1]
                or adjustment.get('initial_tag') not in TAGS
                or adjustment.get('reviewed_tag') != items[index - 1]['tag']
                or not _text(adjustment.get('reason'), 1000)):
            raise ReviewError('invalid', 'review_adjustments_invalid')
        seen.add(index)
    return judgments


def attach(result, source_contract_hash, review_dir=DEFAULT_REVIEW_DIR):
    """Return the fresh replay with an optional overlay; never modify its input.

    The caller must first enforce scope and call the owning store's fresh row()
    to enforce deletion and expiry. ``source_contract_hash`` must be that row's
    reanalysis_source_hash, never a value supplied by the client or sidecar.
    Only explicitly registered meetings can receive an overlay. A failed overlay returns
    the original replay plus a safe status, with no stale review body.
    """
    source = result.get('source') if isinstance(result, dict) else None
    if not isinstance(source, dict) or source.get('session_id') not in REVIEW_SOURCES:
        return result
    sid = source['session_id']
    try:
        record, _, _ = _read_record(review_dir, sid)
        manifest = _manifest(record, sid)
        if (not _hash(source_contract_hash) or not _hash(record.get('source_contract_hash'))
                or source_contract_hash != record['source_contract_hash']):
            raise ReviewError('source_changed', 'review_source_changed')
        sentences = result.get('sentences')
        if not isinstance(sentences, list):
            raise ReviewError('invalid', 'review_items_invalid')
        if (source.get('kind') != 'history' or source.get('snapshot_hash') != manifest['source_snapshot_hash']
                or _digest([{key: sentence.get(key) for key in SOURCE_FIELDS} for sentence in sentences
                            if isinstance(sentence, dict)]) != manifest['source_hash']):
            raise ReviewError('source_changed', 'review_source_changed')
        judgments = _judgments(record, sentences, manifest)
        revision = _digest(record)
        reviewed_source = dict(source, original_source_snapshot_hash=source['snapshot_hash'])
        reviewed_source['snapshot_hash'] = _digest(dict(original_source_snapshot_hash=source['snapshot_hash'],
                                                        content_review_revision=revision, content_review_status='ready'))
        return dict(result, source=reviewed_source,
                    sentences=[dict(sentence, content_review=judgment) for sentence, judgment in zip(sentences, judgments)],
                    content_review=dict(manifest, revision=revision),
                    content_review_status=dict(version=1, status='ready'))
    except ReviewError as error:
        status, reason = error.status, error.reason
    except (OSError, ValueError, TypeError, KeyError, OverflowError):
        status, reason = 'unavailable', 'review_unavailable'
    return dict(result, content_review_status=dict(version=1, status=status, reason=reason))


def _receipt(directory, value):
    root = os.path.abspath(os.fspath(directory))
    if os.path.realpath(root) != root:
        raise ReviewError('unavailable', 'receipt_path_unavailable')
    os.makedirs(root, mode=0o700, exist_ok=True)
    _, descriptor = _directory(root)
    os.close(descriptor)
    sid = value['source_session_id']
    if sid not in REVIEW_SOURCES:
        raise ReviewError('invalid', 'receipt_source_invalid')
    path = os.path.join(root, sid + '.json')
    if os.path.islink(path):
        raise ReviewError('unavailable', 'receipt_path_unavailable')
    descriptor, temporary = tempfile.mkstemp(prefix='.assistant-review-receipt-', dir=root)
    try:
        os.fchmod(descriptor, 0o600)
        with os.fdopen(descriptor, 'w', encoding='utf-8') as target:
            json.dump(value, target, ensure_ascii=False, allow_nan=False, separators=(',', ':'))
            target.flush()
            os.fsync(target.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def _cleanup_one(sid, source_lookup, contract_hash, review_dir, receipt_dir):
    """Purge only the dedicated sidecar when its owning source is invalidated.

    ``source_lookup(sid)`` is StoredHistory.row; its 404/410 errors authorize
    removal. ``contract_hash(row)`` is reanalysis_source_hash. Other lookup
    failures retain the record for a later worker run. No meeting is changed.
    The receipt retains only identifiers, hashes, timestamps and a reason code.
    """
    result = dict(review_removed=0, receipts_kept=0, invalid_skipped=0, unavailable_skipped=0,
                  changed_during_cleanup=0)
    try:
        _, parent = _directory(review_dir)
        try:
            names = os.listdir(parent)
        finally:
            os.close(parent)
    except FileNotFoundError:
        return result
    except (OSError, ReviewError):
        result['unavailable_skipped'] += 1
        return result
    # Only this registered basename is eligible, never a general directory purge.
    if sid + '.json' not in names:
        return result
    try:
        record, identity, root = _read_record(review_dir, sid)
        manifest = _manifest(record, sid)
        if not _hash(record.get('source_contract_hash')):
            raise ReviewError('invalid', 'review_manifest_invalid')
    except (OSError, ValueError, TypeError, KeyError, ReviewError):
        result['invalid_skipped'] += 1
        return result
    try:
        row = source_lookup(sid)
        current_hash = contract_hash(row)
        if not _hash(current_hash):
            result['unavailable_skipped'] += 1
            return result
        reason = 'source_changed' if current_hash != record['source_contract_hash'] else None
    except Exception as error:
        status = getattr(error, 'status', None)
        if status not in (404, 410):
            result['unavailable_skipped'] += 1
            return result
        reason = 'source_deleted' if status == 404 else 'source_expired'
    if reason is None:
        return result
    try:
        _, parent = _directory(root)
        try:
            current = os.stat(sid + '.json', dir_fd=parent, follow_symlinks=False)
            if not stat.S_ISREG(current.st_mode) or _identity(current) != identity:
                result['changed_during_cleanup'] += 1
                return result
            receipt = dict(version=1, kind='assistant_posthoc_cleanup', run_id=manifest['run_id'],
                           source_session_id=sid, source_contract_hash=record['source_contract_hash'],
                           review_revision=_digest(record), content_purged=True, cleanup_reason=reason,
                           purged_at=dt.datetime.now(dt.timezone.utc).isoformat())
            os.unlink(sid + '.json', dir_fd=parent)
            result['review_removed'] += 1
            # A receipt may only claim removal after that removal succeeded.
            _receipt(receipt_dir, receipt)
            result['receipts_kept'] += 1
        finally:
            os.close(parent)
    except (OSError, ReviewError, ValueError, TypeError):
        result['unavailable_skipped'] += 1
    return result


def cleanup(source_lookup, contract_hash, review_dir=DEFAULT_REVIEW_DIR, receipt_dir=DEFAULT_RECEIPT_DIR):
    """Apply the original retention guards independently to registered reviews."""
    result = dict(review_removed=0, receipts_kept=0, invalid_skipped=0, unavailable_skipped=0,
                  changed_during_cleanup=0)
    for sid in REVIEW_SOURCES:
        current = _cleanup_one(sid, source_lookup, contract_hash, review_dir, receipt_dir)
        for key in result:
            result[key] += current[key]
    return result
