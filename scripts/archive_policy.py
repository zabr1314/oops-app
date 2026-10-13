"""Explicit per-session archive consent; legacy assets never acquire a new expiry implicitly."""
import datetime as dt
import json
import os
import re
import threading

FIELDS = ('recording_mode', 'cloud_save_confirmed', 'audio_retention_days',
          'transcript_retention_days', 'archive_started_at')
DAYS = (7, 30, 90)


class ArchivePolicyError(ValueError):
    def __init__(self, status, message, **extra):
        super().__init__(message)
        self.status, self.extra = status, extra


def instant(value):
    if not isinstance(value, str) or len(value) > 60:
        raise ArchivePolicyError(400, '存档开始日期无效')
    normalized = value[:-1] + '+00:00' if value.endswith('Z') else value
    normalized = re.sub(r'\.(\d+)(?=[+-]\d{2}:\d{2}$)',
                        lambda m: '.' + m[1][:6].ljust(6, '0'), normalized)
    try:
        parsed = dt.datetime.fromisoformat(normalized)
        if parsed.tzinfo is None:
            raise ValueError()
        return parsed.astimezone(dt.timezone.utc)
    except ValueError:
        raise ArchivePolicyError(400, '存档开始日期必须含时区') from None


def policy_from_request(req, existing=None, legacy=False, required=True, now=None):
    """All retries carry the original consent; no retry or changed preference extends an expiry."""
    present = any(key in req for key in FIELDS)
    if not present:
        if existing is not None:
            if required:
                raise ArchivePolicyError(400, '请携带本场会议原有的云端保存确认')
            return existing
        if legacy or not required:
            return None
        raise ArchivePolicyError(400, '新会议须明确选择云端保存')
    if req.get('recording_mode') != 'meeting' or req.get('cloud_save_confirmed') is not True:
        raise ArchivePolicyError(400, '日常临时聆听或未确认会议不能归档或同步全文')
    stamp = req.get('archive_started_at')
    began = instant(stamp)
    if began > (now or dt.datetime.now(dt.timezone.utc)) + dt.timedelta(minutes=5):
        raise ArchivePolicyError(400, '存档开始时间不能在未来')
    if req.get('started_at') is not None and instant(req['started_at']) != began:
        raise ArchivePolicyError(400, '正式会议须从新的会话开始时间存档')
    days = {}
    for key in ('audio_retention_days', 'transcript_retention_days'):
        value = req.get(key, 30)
        if type(value) is not int or value not in DAYS:
            raise ArchivePolicyError(400, '原声和全文保留期须分别选择7、30或90天')
        days[key] = value
    result = dict(version=1, recording_mode='meeting', cloud_save_confirmed=True,
                  archive_started_at=began.isoformat(), **days,
                  audio_expires_at=(began + dt.timedelta(days=days['audio_retention_days'])).isoformat(),
                  transcript_expires_at=(began + dt.timedelta(days=days['transcript_retention_days'])).isoformat())
    if existing is not None and result != existing:
        raise ArchivePolicyError(409, '本场会议保存策略已确定，重试不能更改或延长期限')
    if legacy and existing is None:
        raise ArchivePolicyError(409, '历史会议不自动套用新的保存期限')
    return result


def expired(policy, asset, now=None):
    return bool(policy and instant(policy[asset + '_expires_at']) <= (now or dt.datetime.now(dt.timezone.utc)))


def require_live(policy, asset, now=None):
    if expired(policy, asset, now):
        raise ArchivePolicyError(410, '本场会议的' + ('原声' if asset == 'audio' else '全文') + '已过保留期',
                                 asset=asset, expires_at=policy[asset + '_expires_at'])


class ArchivePolicies:
    """One consent contract shared by transcript sync and resumable raw uploads."""
    def __init__(self, directory, legacy_check=None):
        self.dir, self.lock = directory, threading.RLock()
        self.legacy_check = legacy_check or (lambda sid: False)
        os.makedirs(directory, mode=0o700, exist_ok=True)
        os.chmod(directory, 0o700)

    def accept(self, sid, req, legacy=False):
        if not isinstance(sid, str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,100}', sid):
            raise ArchivePolicyError(400, '会话编号无效')
        path = os.path.join(self.dir, sid + '.json')
        with self.lock:
            old = None
            if os.path.isfile(path):
                with open(path, encoding='utf-8') as source:
                    old = json.load(source)
            value = policy_from_request(req, existing=old, legacy=legacy or self.legacy_check(sid))
            if value is not None and old is None:
                temp = path + '.tmp'
                fd = os.open(temp, os.O_CREAT | os.O_TRUNC | os.O_WRONLY, 0o600)
                with os.fdopen(fd, 'w', encoding='utf-8') as target:
                    json.dump(value, target)
                    target.flush(); os.fsync(target.fileno())
                os.replace(temp, path)
            return value
