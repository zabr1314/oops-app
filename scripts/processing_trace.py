"""Bounded processing observations, retained only with an existing meeting archive.

Daily/unarchived requests stay in memory for at most five minutes. A later sync
attaches only observations whose exact source still matches; context is stored
only when every piece is bound unambiguously to a current sentence.
"""
import copy
import datetime as dt
import threading
import time
from collections import OrderedDict

from replay_history import source_hash, transcript_expired


def sanitize_for_storage(row):
    """Remove withdrawn target/context copies whenever the owning meeting writes."""
    if not row.get('processing_trace'):
        return
    if transcript_expired(row):
        row.pop('processing_trace', None)
        return
    reviews = row.get('reviews') or {}
    current = {}
    for source in row.get('utterances') or []:
        source = dict(source)
        review = reviews.get(source['id'])
        if review and not review.get('source_changed_at'):
            source['review'] = review
        else:
            source.pop('review', None)
        current[source['id']] = source_hash(source)
    events = []
    for event in row['processing_trace']:
        if not isinstance(event, dict) or current.get(event.get('id')) != event.get('source_hash'):
            continue
        event = dict(event)
        references = event.get('context_sources')
        if not isinstance(references, list) or any(not isinstance(ref, dict)
                or current.get(ref.get('id')) != ref.get('source_hash') for ref in references):
            event.pop('context', None)
            event.pop('validated_context', None)
            event['context_status'] = 'source_changed' if references is not None else event.get('context_status', 'not_recorded')
        events.append(event)
    row['processing_trace'] = events


class ProcessingTrace:
    def __init__(self, ttl=300, limit=1024):
        self.ttl, self.limit = ttl, limit
        self.pending, self.lock = OrderedDict(), threading.RLock()

    def prune(self, now=None):
        now = time.monotonic() if now is None else now
        with self.lock:
            for key, value in list(self.pending.items()):
                if now - value['at'] >= self.ttl:
                    self.pending.pop(key, None)

    def record_tag(self, request, result, stages=()):
        sid, uid = request.get('session_id'), request.get('utterance_id')
        if not isinstance(sid, str) or not isinstance(uid, str):
            return
        raw = dict(id=uid, text=request.get('text'), start_ms=request.get('start_ms'), end_ms=request.get('end_ms'))
        if request.get('speaker') is not None:
            raw['speaker'] = request['speaker']
        event = dict(kind='tag', id=uid, at_ms=request.get('end_ms'),
            recorded_at=dt.datetime.now(dt.timezone.utc).isoformat(), result=copy.deepcopy(result),
            stages=copy.deepcopy(list(stages)))
        with self.lock:
            self.prune()
            key = (sid, uid)
            self.pending[key] = dict(at=time.monotonic(), source=raw, event=event,
                                     context=copy.deepcopy(request.get('context') or []))
            self.pending.move_to_end(key)
            while len(self.pending) > self.limit:
                self.pending.popitem(last=False)

    def attach(self, meetings, sid):
        """Under the owning store's lock, so delete/sync cannot race a trace write."""
        self.prune()
        with meetings.lock:
            try:
                row = meetings.load(sid)
            except FileNotFoundError:
                return 0
            if transcript_expired(row):
                return 0
            current = {u['id']: u for u in row['utterances']}
            events = {event['id']: event for event in row.get('processing_trace') or []
                      if isinstance(event, dict) and event.get('id') in current
                      and event.get('source_hash') == source_hash(current[event['id']])}
            added = 0
            with self.lock:
                for key, pending in list(self.pending.items()):
                    if key[0] != sid or key[1] not in current:
                        continue
                    source = current[key[1]]
                    if any(source.get(field) != pending['source'].get(field) for field in ('id', 'text', 'start_ms', 'end_ms')):
                        self.pending.pop(key, None)
                        continue
                    if 'speaker' in pending['source'] and pending['source']['speaker'] != ((source.get('review') or {}).get('speaker') or source.get('speaker')):
                        self.pending.pop(key, None)
                        continue
                    event = dict(pending['event'], source_hash=source_hash(source))
                    context, references = [], []
                    for part in pending['context']:
                        text = part if isinstance(part, str) else part.get('text') if isinstance(part, dict) else None
                        if not isinstance(text, str) or not text:
                            break
                        matches = [u for u in row['utterances'] if u['id'] != source['id']
                                   and u.get('end_ms', 0) <= source.get('start_ms', 0)
                                   and (u.get('text') == text or u.get('text', '').endswith(text))]
                        if len(matches) != 1:
                            break
                        matched = matches[0]
                        context.append(text)
                        references.append(dict(id=matched['id'], source_hash=source_hash(matched)))
                    if len(context) == len(pending['context']):
                        event.update(context=context, context_sources=references, context_status='recorded')
                    else:
                        event['context_status'] = 'unbound_not_retained'
                    events[event['id']] = event
                    self.pending.pop(key, None)
                    added += 1
            # Purge invalidated records too; they are not a versioned transcript.
            kept = sorted(events.values(), key=lambda e: (e.get('at_ms') or 0, e['id']))[-20000:]
            if row.get('processing_trace', []) != kept:
                row['processing_trace'] = kept
                sanitize_for_storage(row)
                meetings.write(sid, row)
            return added
