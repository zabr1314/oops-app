"""Server-owned action evidence. App hashes are expectations, never a source of truth."""
import hashlib
import json
import re


class ActionSourceError(ValueError):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


def digest(value):
    return hashlib.sha256(value.encode('utf-8')).hexdigest()


def fingerprint(value):
    return digest(json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':')))


def board_source_hash(utterance):
    """Preserve the old board hash for generation 1; later generations cannot revive old candidates."""
    shape = {k: utterance.get(k) for k in ('text', 'speaker', 'review')}
    if utterance.get('_action_source_generation', 1) > 1:
        shape['_action_source_revision'] = utterance.get('_action_source_revision')
    return digest(json.dumps(shape, sort_keys=True, ensure_ascii=False))


def board_source_row(row, utterance):
    state = row.get('action_source_versions', {}).get(utterance['id']) or {}
    return dict(utterance, review=row.get('reviews', {}).get(utterance['id'], {}),
                _action_source_generation=state.get('generation', 1), _action_source_revision=raw_revision(row, utterance))


def review_shape(value):
    return {key: value.get(key) for key in ('speaker', 'owner', 'verdict') if value.get(key) is not None}


def raw_shape(row, utterance):
    return {key: utterance.get(key) for key in ('text', 'start_ms', 'end_ms', 'speaker', 'tag', 'segments')} | {
        'review': review_shape(row.get('reviews', {}).get(utterance['id'], utterance.get('review') or {}))}


def excerpt_shape(utterance):
    return {key: utterance.get(key) for key in ('text', 'start_ms', 'end_ms', 'speaker', 'tag', 'confirmed')} | {
        'review': review_shape(utterance.get('review') or {}), 'invalid': utterance.get('source_status') == 'changed'}


def refresh_versions(row, previous):
    """Per-source generations survive text edits followed by undo; appending other lines is harmless.

    First explicit retention and natural expiry do not change the source. Rewriting or removing an
    existing excerpt does. Last full-source fingerprints contain no recoverable full text.
    """
    previous = previous or {}
    old_raw = {u['id']: u for u in previous.get('utterances', [])}
    raw = {u['id']: u for u in row.get('utterances', [])}
    old_kept = {u['id']: u for u in previous.get('retained_evidence', [])}
    kept = {u['id']: u for u in row.get('retained_evidence', [])}
    versions = dict(previous.get('action_source_versions', row.get('action_source_versions', {})))
    for uid in set(old_raw) | set(raw) | set(old_kept) | set(kept):
        prior = versions.get(uid) or {}
        generation = prior.get('generation', 1)
        changed = uid in old_raw and uid in raw and raw_shape(previous, old_raw[uid]) != raw_shape(row, raw[uid])
        changed = changed or (uid in old_kept and (uid not in kept or excerpt_shape(old_kept[uid]) != excerpt_shape(kept[uid])))
        if uid in old_raw and uid not in raw and row.get('transcript_status') != 'expired': changed = True
        if changed: generation += 1
        full = fingerprint(raw_shape(row, raw[uid])) if uid in raw else prior.get('fingerprint')
        if not full and uid in old_raw: full = fingerprint(raw_shape(previous, old_raw[uid]))
        versions[uid] = dict(generation=generation, fingerprint=full)
    row['action_source_versions'] = versions
    # Only a newly confirmed/reconfirmed excerpt adopts the current full-source revision.
    for uid, u in kept.items():
        refresh = u.pop('_action_rebind', False)
        if uid in raw and (refresh or not u.get('source_revision')) and u.get('source_status') != 'changed':
            u['source_text_hash'] = digest(raw[uid]['text'])
            u['source_revision'] = raw_revision(row, raw[uid])
            u['source_board_hash'] = board_source_hash(board_source_row(row, raw[uid]))


def raw_revision(row, utterance):
    state = row.get('action_source_versions', {}).get(utterance['id']) or {}
    return f"v1:{state.get('generation', 1)}:{fingerprint(raw_shape(row, utterance))}"


def last_raw_revision(row, uid):
    state = row.get('action_source_versions', {}).get(uid) or {}
    return f"v1:{state.get('generation', 1)}:{state.get('fingerprint')}" if state.get('fingerprint') else None


def excerpt_revision(row, utterance):
    generation = (row.get('action_source_versions', {}).get(utterance['id']) or {}).get('generation', 1)
    return f"v1r:{generation}:{fingerprint(excerpt_shape(utterance))}"


def usable_excerpt(row, utterance):
    return (utterance.get('confirmed') is True and utterance.get('source_status') != 'changed'
            and (not utterance.get('source_revision') or utterance['source_revision'] == last_raw_revision(row, utterance['id'])))


def binding_for(row, ids, expected_texts=None, expected_speakers=None):
    if (not isinstance(ids, list) or not ids or len(ids) > 20 or any(not isinstance(uid, str) for uid in ids)
            or len(set(ids)) != len(ids)):
        raise ActionSourceError('ACTION_SOURCE_INVALID', '请选择不重复的当前原话')
    raw = {u['id']: u for u in row.get('utterances', [])}
    kept = {u['id']: u for u in row.get('retained_evidence', [])}
    sources = []
    for uid in ids:
        u, kind = raw.get(uid), 'transcript'
        if u is None or expected_texts is not None and expected_texts.get(uid) != u['text']:
            u, kind = kept.get(uid), 'saved_excerpt'
            if u is None or not usable_excerpt(row, u):
                raise ActionSourceError('ACTION_SOURCE_UNAVAILABLE', '原话已不可用，请重新打开当前来源')
        review = row.get('reviews', {}).get(uid, u.get('review') or {})
        if review.get('verdict') == 'rejected':
            raise ActionSourceError('ACTION_SOURCE_REVOKED', '这条来源已被撤回，请重新核对')
        if expected_texts is not None and expected_texts.get(uid) != u['text']:
            raise ActionSourceError('ACTION_SOURCE_CHANGED', '原话已变化，请重新读取后起草')
        speaker = review.get('speaker') or u.get('speaker')
        if expected_speakers is not None and uid in expected_speakers and expected_speakers[uid] != speaker:
            raise ActionSourceError('ACTION_SOURCE_CHANGED', '说话人核对尚未同步，请重新读取后起草')
        sources.append(dict(id=uid, kind=kind, text_hash=digest(u['text']),
                            source_revision=raw_revision(row, u) if kind == 'transcript' else excerpt_revision(row, u),
                            quote=u['text'][:280], speaker=speaker, review=review_shape(review)))
    return dict(version=1, session_id=row['session_id'], sources=sources)


def has_source(request):
    # Empty/old malformed evidence is still source-bearing, never a manual-task escape hatch.
    return request.get('session_id') is not None or 'evidence' in request


def validate_binding(row, request):
    evidence = request.get('evidence')
    binding = evidence.get('source_binding') if isinstance(evidence, dict) else None
    if not isinstance(binding, dict):
        raise ActionSourceError('SOURCE_BINDING_REQUIRED', '旧来源草稿缺少核对版本，请重新读取原话并起草')
    sources = binding.get('sources')
    if (type(binding.get('version')) is not int or binding.get('version') != 1 or binding.get('session_id') != row['session_id']
            or request.get('session_id') != row['session_id'] or not isinstance(sources, list)
            or not sources or len(sources) > 20 or any(not isinstance(s, dict) for s in sources)):
        raise ActionSourceError('ACTION_SOURCE_INVALID', '来源核对合同无效')
    ids = [s.get('id') for s in sources]
    if (any(not isinstance(uid, str) for uid in ids) or len(set(ids)) != len(ids)
            or evidence.get('utterance_ids') != ids):
        raise ActionSourceError('ACTION_SOURCE_INVALID', '来源编号与核对范围不一致')
    raw = {u['id']: u for u in row.get('utterances', [])}
    kept = {u['id']: u for u in row.get('retained_evidence', [])}
    context = binding.get('context_sources', [])
    if (not isinstance(context, list) or len(context) > 20 or any(not isinstance(s, dict) or not isinstance(s.get('id'), str) for s in context)
            or len(set(ids + [s['id'] for s in context])) != len(ids) + len(context)):
        raise ActionSourceError('ACTION_SOURCE_INVALID', '上下文依赖编号无效或重复')
    for source in sources + context:
        uid, kind, quote = source['id'], source.get('kind'), source.get('quote')
        if (kind not in ('transcript', 'saved_excerpt') or not isinstance(quote, str) or not quote or len(quote) > 280
                or not isinstance(source.get('text_hash'), str) or not re.fullmatch('[0-9a-f]{64}', source['text_hash'])
                or not isinstance(source.get('source_revision'), str)):
            raise ActionSourceError('ACTION_SOURCE_INVALID', '来源版本或短原话格式无效')
        u = raw.get(uid) if kind == 'transcript' else kept.get(uid)
        if kind == 'transcript' and u is None:
            # Natural expiry may use only the independently confirmed short quote, never the full text again.
            u = kept.get(uid)
            valid = (row.get('transcript_status') == 'expired' and u is not None and usable_excerpt(row, u)
                     and u.get('source_text_hash') == source['text_hash']
                     and u.get('source_revision') == source['source_revision'] and quote in u['text'])
        else:
            valid = (u is not None and quote in u['text'] and digest(u['text']) == source['text_hash']
                     and source['source_revision'] == (raw_revision(row, u) if kind == 'transcript' else excerpt_revision(row, u))
                     and (kind != 'saved_excerpt' or usable_excerpt(row, u)))
        review = row.get('reviews', {}).get(uid, (u or {}).get('review') or {})
        if (not valid or review.get('verdict') == 'rejected' or source.get('speaker') != (review.get('speaker') or (u or {}).get('speaker'))
                or source.get('review') != review_shape(review)):
            raise ActionSourceError('ACTION_SOURCE_CHANGED', '来源已变化、撤回或不可用，请重新读取并核对')
    if evidence.get('quote') != ' '.join(s['quote'] for s in sources):
        raise ActionSourceError('ACTION_SOURCE_INVALID', '提交原话与本次核对的短依据不一致')
    return binding


# Explicit daily drafts extend the same signed source contract without archiving text.
import secrets
import math
import threading
import time

class SourceChanged(ValueError):
    def __init__(self, reason, message):
        self.reason = reason
        super().__init__(message)


def receipt_fingerprint(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True,
                                    separators=(',', ':')).encode()).hexdigest()


def text_hash(value):
    return hashlib.sha256(value.encode('utf-8')).hexdigest()


def normalized(value):
    return re.sub(r'\s+', ' ', value).strip()


def evidence_request(body):
    sid, evidence = body.get('session_id'), body.get('evidence')
    if not isinstance(sid, str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,100}', sid) or not isinstance(evidence, dict):
        raise SourceChanged('source_missing', '请从当前原话重新起草，不能提交没有来源的行动')
    ids, quote = evidence.get('utterance_ids'), evidence.get('quote')
    start, end = evidence.get('clip_start_ms'), evidence.get('clip_end_ms')
    if (not isinstance(ids, list) or not 1 <= len(ids) <= 60
            or any(not isinstance(uid, str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,100}', uid) for uid in ids)
            or len(set(ids)) != len(ids)
            or not isinstance(quote, str) or not quote.strip() or len(quote) > 12000
            or type(start) not in (int, float) or type(end) not in (int, float)
            or not 0 <= start < end):
        raise SourceChanged('source_missing', '请重新选择有效的原话、句子编号和时间范围')
    return sid, ids, normalized(quote), start, end


class DailyReceipts:
    TTL_SECONDS, LIMIT = 300, 512

    def __init__(self):
        self.lock, self.values = threading.RLock(), {}

    def _prune(self, now):
        self.values = {key: value for key, value in self.values.items() if value['expires'] > now}
        while len(self.values) >= self.LIMIT:
            self.values.pop(next(iter(self.values)))

    def binding(self, req):
        rows = req.get('utterances') or []
        if not isinstance(rows, list) or not rows or any(not isinstance(row, dict) for row in rows):
            raise SourceChanged('source_missing', '请先选择本次日常记录中的短原话')
        ids = [row.get('id') for row in rows]
        context = [row for row in req.get('context') or [] if isinstance(row, dict) and row.get('id') not in ids]
        all_rows = rows + context
        if (len(all_rows) > 20 or any(not isinstance(row.get('id'), str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,100}', row['id']) or not isinstance(row.get('text'), str)
                                     or not row['text'].strip() for row in all_rows)
                or len({row['id'] for row in all_rows}) != len(all_rows)
                or sum(len(row['text']) for row in all_rows) + max(0, len(all_rows) - 1) > 280):
            raise SourceChanged('daily_evidence_too_long', '日常行动含上下文的必要短依据须不超过280字，请重新选择')
        if (any(type(row.get('start_ms')) not in (int, float) or type(row.get('end_ms')) not in (int, float)
                or not math.isfinite(row['start_ms']) or not math.isfinite(row['end_ms'])
                or not 0 <= row['start_ms'] < row['end_ms'] for row in all_rows)
                or max(row['end_ms'] for row in all_rows) - min(row['start_ms'] for row in all_rows) > 300000):
            raise SourceChanged('daily_evidence_outside_buffer', '日常短依据及上下文须在同一五分钟范围内')
        def source(row):
            return dict(id=row['id'], kind='daily_excerpt', text_hash=digest(row['text']),
                        source_revision='v1d:' + fingerprint({key: row.get(key) for key in
                            ('id', 'text', 'start_ms', 'end_ms', 'speaker')}), quote=row['text'],
                        speaker=row.get('speaker'), review={})
        return dict(version=1, session_id=req.get('session_id'), scope='daily',
                    sources=[source(row) for row in rows], context_sources=[source(row) for row in context])

    def issue(self, req):
        if req.get('recording_mode') != 'daily':
            return None
        rows = req.get('utterances')
        if not isinstance(rows, list) or not rows or len(rows) > 60:
            raise SourceChanged('source_missing', '请先选择本次日常记录中的短原话')
        if any(not isinstance(row, dict) or not isinstance(row.get('text'), str) for row in rows):
            raise SourceChanged('source_missing', '日常行动的原话正文无效')
        quote = ' '.join(row['text'] for row in rows)
        if not quote.strip() or len(quote) > 280:
            raise SourceChanged('daily_evidence_too_long', '日常行动请选择不超过280字的必要短原话后重新起草')
        body = dict(session_id=req.get('session_id'), evidence=dict(
            utterance_ids=[row.get('id') for row in rows], quote=quote,
            clip_start_ms=rows[0].get('start_ms'), clip_end_ms=rows[-1].get('end_ms')))
        sid, ids, quote, start, end = evidence_request(body)
        if end - start > 300000:
            raise SourceChanged('daily_evidence_outside_buffer', '日常行动的依据须在最近五分钟范围内')
        hashes = {}
        for row in rows:
            if (not isinstance(row.get('text'), str) or not row['text'].strip()
                    or type(row.get('start_ms')) not in (int, float) or type(row.get('end_ms')) not in (int, float)
                    or not start <= row['start_ms'] < row['end_ms'] <= end):
                raise SourceChanged('source_missing', '日常行动的原话时间或正文无效')
            hashes[row['id']] = text_hash(row['text'])
        source = dict(session_id=sid, ids=ids, quote_hash=text_hash(quote), start_ms=start,
                      end_ms=end, text_hashes=hashes)
        binding = self.binding(req)
        source['binding_hash'] = fingerprint(binding)
        source['source_revisions'] = {row['id']: row['source_revision']
                                      for row in binding['sources'] + binding['context_sources']}
        for row in req.get('context') or []:
            if isinstance(row, dict) and row.get('id') not in hashes:
                hashes[row['id']] = text_hash(row['text'])
        source['fingerprint'] = receipt_fingerprint(source)
        now, token = time.monotonic(), secrets.token_urlsafe(32)
        with self.lock:
            self._prune(now)
            # A new version of a previously cited daily sentence withdraws its
            # old receipts; no original sentence text is retained here.
            for key, value in list(self.values.items()):
                old = value['source']
                if old['session_id'] == sid and any(uid in old.get('source_revisions', {})
                        and old['source_revisions'][uid] != revision
                        for uid, revision in source['source_revisions'].items()):
                    self.values.pop(key)
            self.values[token] = dict(source=source, expires=now + self.TTL_SECONDS)
        return token

    def validate(self, body, expected=None):
        sid, ids, quote, start, end = evidence_request(body)
        token = body.get('source_receipt')
        binding = body.get('evidence', {}).get('source_binding')
        if not isinstance(binding, dict) or binding.get('scope') != 'daily':
            raise SourceChanged('source_binding_required', '日常行动须携带完整的短依据来源合同')
        if body['evidence'].get('quote') != ' '.join(row['quote'] for row in binding.get('sources', [])):
            raise SourceChanged('source_changed', '引用与本次短依据合同不一致，请重新起草')
        binding_hash = fingerprint({key: value for key, value in binding.items() if key != 'proof'})
        with self.lock:
            self._prune(time.monotonic())
            value = self.values.get(token) if isinstance(token, str) else None
            if not value:
                raise SourceChanged('daily_receipt_expired', '日常原话许可已失效，请从当前原话重新起草并确认')
            source = dict(value['source'])
        if (source.get('binding_hash') != binding_hash or source['session_id'] != sid or source['ids'] != ids or source['quote_hash'] != text_hash(quote)
                or source['start_ms'] != start or source['end_ms'] != end
                or expected and expected.get('fingerprint') != source['fingerprint']):
            raise SourceChanged('source_changed', '日常行动的原话已变化，请重新起草并核对')
        return dict(source, kind='daily_receipt', status='current')
