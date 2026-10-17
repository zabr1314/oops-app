"""Raw meeting assets on the team server: original PCM audio, final sentences and the raw ASR stream.

Upload is resumable and verified: the device declares each file's size and SHA-256, appends 1 MB chunks
that are each hash-checked, and `complete` re-hashes every whole file before marking the session
archived. The device only frees its local copy after `complete` succeeds. Kept until the meeting is
deleted; deleted sessions leave a tombstone so a delayed retry cannot re-create them.
"""
import datetime as dt
import hashlib
import io
import json
import logging
import os
import re
import shutil
import threading
import wave
from archive_policy import ArchivePolicyError, policy_from_request, expired, require_live

FILES = {"audio.pcm": 4_000_000_000, "finals.jsonl": 200_000_000, "asr.jsonl": 1_000_000_000,
         "timing.jsonl": 200_000_000, "meta.json": 100_000}
CHUNK_LIMIT = 1_100_000
CLIP_LIMIT_MS, CLIP_PAD_MS = 30_000, 300
BYTES_PER_MS = 32  # 16 kHz mono s16le; byte 0 of audio.pcm is session time 0
SESSION = re.compile(r"[A-Za-z0-9-]{8,80}")
TRANSCRIPT_FILES = {'finals.jsonl', 'asr.jsonl', 'timing.jsonl', 'meta.json'}
DERIVED_TRANSCRIPT_FILES = {'asr_review.json'}  # server-side second reading (asr_review); expires with the transcript


class RecordingError(ValueError):
    def __init__(self, status, message, **extra):
        super().__init__(message)
        self.status, self.extra = status, extra


def _sha256(path):
    digest = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def _write_json(path, value):
    temp = path + ".tmp"
    fd = os.open(temp, os.O_CREAT | os.O_TRUNC | os.O_WRONLY, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        json.dump(value, f, ensure_ascii=False, indent=1)
        f.flush()
        os.fsync(f.fileno())
    os.replace(temp, path)


def _read_json(path):
    with open(path, encoding='utf-8') as source:
        return json.load(source)


class Recordings:
    def __init__(self, directory, deleted=lambda sid: False, policies=None, require_storage_policy=False):
        self.root, self.deleted = directory, deleted
        self.policies, self.require_storage_policy = policies, require_storage_policy
        os.makedirs(directory, mode=0o700, exist_ok=True)
        os.chmod(directory, 0o700)
        self.lock = threading.RLock()

    def _live(self, policy, asset, manifest=None):
        if manifest and manifest.get(asset + '_expired_at'):
            raise RecordingError(410, '本场会议资产已过保留期', asset=asset,
                                 expires_at=manifest[asset + '_expired_at'])
        try:
            require_live(policy, asset)
        except ArchivePolicyError as error:
            raise RecordingError(error.status, str(error), **error.extra) from None

    def _expire(self, sid, now=None):
        """Leave a metadata tombstone so a late upload can never recreate expired files."""
        folder = self.folder(sid)
        path = os.path.join(folder, 'manifest.json')
        if not os.path.isfile(path): return 0
        manifest = self._manifest(sid)
        policy = manifest.get('storage_policy')
        if not policy: return 0
        removed, changed = 0, False
        for asset, names in (('audio', {'audio.pcm'}), ('transcript', TRANSCRIPT_FILES | DERIVED_TRANSCRIPT_FILES)):
            if expired(policy, asset, now):
                for name in names:
                    target = os.path.join(folder, name)
                    if os.path.isfile(target): os.unlink(target); removed += 1
                key = asset + '_expired_at'
                if key not in manifest:
                    manifest[key] = policy[asset + '_expires_at']; changed = True
        if changed:
            # A diagnostic metadata value must not become a hidden transcript after expiry.
            manifest['meta'] = {k: v for k, v in manifest.get('meta', {}).items()
                                if k in ('session_id', 'source', 'started_at', 'audio_ended_at', 'bytes', 'capped')}
            _write_json(path, manifest)
        return removed

    def cleanup(self, now=None):
        removed = 0
        with self.lock:
            for sid in os.listdir(self.root):
                if SESSION.fullmatch(sid) and os.path.isdir(os.path.join(self.root, sid)):
                    try:
                        removed += self._expire(sid, now)
                    except (OSError, ValueError, KeyError, TypeError):
                        logging.getLogger(__name__).warning('Skipped unreadable recording metadata: %s', sid)
        return removed

    def folder(self, sid):
        if not isinstance(sid, str) or not SESSION.fullmatch(sid):
            raise RecordingError(400, "会话编号无效")
        return os.path.join(self.root, sid)

    def _manifest(self, sid):
        path = os.path.join(self.folder(sid), "manifest.json")
        if not os.path.isfile(path):
            raise RecordingError(409, "请先提交文件清单")
        return _read_json(path)

    def meta(self, sid):
        """What the phone said about the recording (strings, as declared in the manifest)."""
        return self._manifest(sid).get("meta") or {}

    def history_evidence(self, sid):
        """Read-only list hint; never wait for a whole-file upload/hash lock.

        Only a completed, matching zero-byte declaration proves an empty asset.
        A missing archive may still be waiting on the phone and remains unknown.
        """
        folder = self.folder(sid)
        manifest = self._manifest(sid)
        files = manifest.get('files')
        audio = files.get('audio.pcm') if isinstance(files, dict) else None
        if not isinstance(audio, dict) or type(audio.get('size')) is not int:
            return dict(status='unknown', reason='recording_unknown')
        if audio['size'] > 0 or self._received(folder, 'audio.pcm') > 0:
            return dict(status='retained', reason='has_recording')
        if not os.path.isfile(os.path.join(folder, 'audio.pcm')):
            return dict(status='unknown', reason='recording_unknown')
        if audio['size'] != 0 or manifest.get('audio_expired_at') or expired(manifest.get('storage_policy'), 'audio'):
            return dict(status='unknown', reason='recording_expired')
        done = _read_json(os.path.join(folder, 'complete.json'))
        if done.get('session_id') != sid or done.get('files') != files:
            return dict(status='unknown', reason='recording_sync_pending')
        finals = files.get('finals.jsonl') or {}
        if not isinstance(finals, dict) or type(finals.get('size', 0)) is not int:
            return dict(status='unknown', reason='recording_unknown')
        if finals.get('size', 0) > 0 or self._received(folder, 'finals.jsonl') > 0:
            return dict(status='retained', reason='has_recording_transcript')
        raw = files.get('asr.jsonl') or {}
        if not isinstance(raw, dict) or type(raw.get('size', 0)) is not int:
            return dict(status='unknown', reason='recording_unknown')
        raw_size = self._received(folder, 'asr.jsonl')
        if raw_size != raw.get('size', 0) or raw_size > 65536:
            return dict(status='unknown', reason='asr_log_unknown')
        # Handshake/EOS packets are not speech. Inspect only a small completed
        # diagnostic log, so text received but not yet synced is still protected.
        def has_text(value):
            if isinstance(value, dict):
                return any((key in ('text', 'transcript') and isinstance(item, str) and item.strip()) or has_text(item)
                           for key, item in value.items())
            return isinstance(value, list) and any(has_text(item) for item in value)
        if raw_size:
            with open(os.path.join(folder, 'asr.jsonl'), encoding='utf-8') as source:
                for line in source:
                    packet = json.loads(line)
                    if isinstance(packet, dict) and 'payload' in packet:
                        packet = packet['payload']
                        if isinstance(packet, str): packet = json.loads(packet)
                    if not isinstance(packet, dict):
                        return dict(status='unknown', reason='asr_log_unknown')
                    if not any(key in packet for key in ('result', 'code', 'header')):
                        return dict(status='unknown', reason='asr_log_unknown')
                    if has_text(packet):
                        return dict(status='retained', reason='asr_text_not_synced')
        return dict(status='empty', reason='confirmed_empty_archive')

    def _received(self, folder, name):
        path = os.path.join(folder, name)
        return os.path.getsize(path) if os.path.isfile(path) else 0

    def manifest(self, sid, body):
        files = body.get("files")
        if not isinstance(files, list) or not files or len(files) > len(FILES):
            raise RecordingError(400, "文件清单无效")
        declared = {}
        for item in files:
            name, size, sha = (item or {}).get("name"), (item or {}).get("size"), (item or {}).get("sha256")
            if name not in FILES or name in declared or type(size) is not int or not 0 <= size <= FILES[name] \
                    or not isinstance(sha, str) or not re.fullmatch(r"[0-9a-f]{64}", sha):
                raise RecordingError(400, f"文件 {name} 的大小或校验值无效")
            declared[name] = {"size": size, "sha256": sha}
        if "audio.pcm" not in declared or declared["audio.pcm"]["size"] % 2:
            raise RecordingError(400, "缺少 16 kHz 单声道 PCM 录音")
        meta = body.get("meta") if isinstance(body.get("meta"), dict) else {}
        with self.lock:
            if self.deleted(sid):
                raise RecordingError(410, "该会议已删除，不再接收录音")
            folder = self.folder(sid)
            manifest_path = os.path.join(folder, 'manifest.json')
            old = self._manifest(sid) if os.path.isfile(manifest_path) else {}
            try:
                policy = (self.policies.accept(sid, body, legacy=bool(old) and not old.get('storage_policy')) if self.policies else
                          policy_from_request(body, old.get('storage_policy'), bool(old) and not old.get('storage_policy'), self.require_storage_policy))
            except ArchivePolicyError as error:
                raise RecordingError(error.status, str(error), **error.extra) from None
            self._expire(sid)
            self._live(policy, 'audio', old)
            if any(name in TRANSCRIPT_FILES for name in declared): self._live(policy, 'transcript', old)
            os.makedirs(folder, mode=0o700, exist_ok=True)
            done = os.path.join(folder, "complete.json")
            if os.path.isfile(done) and _read_json(done)["files"] == declared:
                return {"session_id": sid, "complete": True, "storage_policy": policy,
                        "received": {n: f["size"] for n, f in declared.items()}}
            for name in os.listdir(folder):  # a changed manifest restarts any file that no longer fits
                if name in FILES and (name not in declared or self._received(folder, name) > declared[name]["size"]):
                    os.unlink(os.path.join(folder, name))
            if os.path.isfile(done):
                os.unlink(done)
            _write_json(os.path.join(folder, "manifest.json"), {
                "session_id": sid, "files": declared, "format": "pcm_s16le_16000_mono",
                "storage_policy": policy,
                **{key: old[key] for key in ('audio_expired_at', 'transcript_expired_at') if key in old},
                "meta": {k: str(v)[:200] for k, v in list(meta.items())[:20]
                         if not any(key in old for key in ('audio_expired_at', 'transcript_expired_at'))
                         or k in ('session_id', 'source', 'started_at', 'audio_ended_at', 'bytes', 'capped')},
                "declared_at": dt.datetime.now(dt.timezone.utc).isoformat()})
            return {"session_id": sid, "complete": False, "storage_policy": policy,
                    "received": {name: self._received(folder, name) for name in declared}}

    def chunk(self, sid, name, offset, data, sha):
        if name not in FILES:
            raise RecordingError(400, "文件名无效")
        if not data or len(data) > CHUNK_LIMIT or hashlib.sha256(data).hexdigest() != sha:
            raise RecordingError(400, "分块为空、过大或校验失败")
        with self.lock:
            if self.deleted(sid):
                raise RecordingError(410, "该会议已删除，不再接收录音")
            self._expire(sid)
            manifest = self._manifest(sid)
            self._live(manifest.get('storage_policy'), 'audio' if name == 'audio.pcm' else 'transcript', manifest)
            declared = manifest["files"].get(name)
            if declared is None:
                raise RecordingError(400, "清单里没有这个文件")
            folder = self.folder(sid)
            current = self._received(folder, name)
            if offset != current:
                raise RecordingError(409, "续传位置不一致", received=current)
            if offset + len(data) > declared["size"]:
                raise RecordingError(400, "超出清单声明的大小")
            fd = os.open(os.path.join(folder, name), os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
            try:
                os.write(fd, data)
                os.fsync(fd)
            finally:
                os.close(fd)
            return {"received": current + len(data)}

    def complete(self, sid):
        with self.lock:
            if self.deleted(sid): raise RecordingError(410, '该会议已删除，不再接收录音')
            self._expire(sid)
            manifest = self._manifest(sid)
            self._live(manifest.get('storage_policy'), 'audio', manifest)
            if any(name in TRANSCRIPT_FILES for name in manifest['files']): self._live(manifest.get('storage_policy'), 'transcript', manifest)
            folder = self.folder(sid)
            for name, declared in manifest["files"].items():
                path = os.path.join(folder, name)
                if self._received(folder, name) != declared["size"]:
                    raise RecordingError(409, f"{name} 尚未传完", received=self._received(folder, name))
                if declared["size"] == 0:
                    # Empty assets send no chunks. Materialize only a missing empty
                    # file, including manifests accepted before this behavior existed.
                    try:
                        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
                    except FileExistsError:
                        pass  # preserve existing files for the same whole-file check
                    else:
                        try:
                            os.fsync(fd)
                        finally:
                            os.close(fd)
                if _sha256(path) != declared["sha256"]:
                    os.unlink(path)  # corrupt: restart this file from zero
                    raise RecordingError(409, f"{name} 整体校验失败，需重传", received=0)
            record = {"session_id": sid, "files": manifest["files"],
                      "completed_at": dt.datetime.now(dt.timezone.utc).isoformat()}
            _write_json(os.path.join(folder, "complete.json"), record)
            return dict(record, complete=True)

    def status(self, sid):
        with self.lock:
            return self._status(sid)

    def _status(self, sid):
        if self.deleted(sid): raise RecordingError(410, '该会议已删除')
        self._expire(sid)
        folder = self.folder(sid)
        if not os.path.isdir(folder):
            raise RecordingError(404, "没有这场会议的录音")
        done = os.path.join(folder, "complete.json")
        manifest = self._manifest(sid)
        policy = manifest.get('storage_policy')
        assets = {asset: ('expired' if manifest.get(asset + '_expired_at') or expired(policy, asset) else 'available' if
                   any(self._received(folder, n) for n in names) else 'pending')
                  for asset, names in (('audio', {'audio.pcm'}), ('transcript', {'finals.jsonl', 'asr.jsonl'}))}
        result = (dict(_read_json(done), complete=True) if os.path.isfile(done) else
                  {'session_id': sid, 'complete': False, 'received': {name: self._received(folder, name) for name in manifest['files']}})
        return dict(result, storage_policy=policy, assets=assets,
                    expires_at={asset: policy[asset + '_expires_at'] for asset in ('audio', 'transcript')} if policy else {})

    def clip(self, sid, start_ms, end_ms):
        """WAV of one sentence from the archived audio, for listening back after the phone has moved on."""
        if any(type(n) is not int for n in (start_ms, end_ms)) or not 0 <= start_ms < end_ms \
                or end_ms - start_ms > CLIP_LIMIT_MS:
            raise RecordingError(400, f"片段时间无效或超过 {CLIP_LIMIT_MS // 1000} 秒")
        path = os.path.join(self.folder(sid), "audio.pcm")
        with self.lock:
            self._expire(sid)
            if os.path.isfile(os.path.join(self.folder(sid), 'manifest.json')):
                manifest = self._manifest(sid)
                self._live(manifest.get('storage_policy'), 'audio', manifest)
            if self.deleted(sid) or not os.path.isfile(path):
                raise RecordingError(404, "服务器上还没有这场会议的录音")
            size = os.path.getsize(path)
            if end_ms * BYTES_PER_MS > size:
                raise RecordingError(409, "录音还没有上传到这一段")
            first = max(0, start_ms - CLIP_PAD_MS) * BYTES_PER_MS
            last = min(size - size % 2, (end_ms + CLIP_PAD_MS) * BYTES_PER_MS)
            with open(path, "rb") as source:
                source.seek(first)
                pcm = source.read(last - first)
        out = io.BytesIO()
        with wave.open(out, "wb") as target:
            target.setnchannels(1)
            target.setsampwidth(2)
            target.setframerate(16000)
            target.writeframes(pcm)
        return out.getvalue()

    def delete(self, sid):
        with self.lock:
            try:
                folder = self.folder(sid)
            except RecordingError:
                return {"deleted": False}  # ids that could never hold audio
            if os.path.isdir(folder):
                shutil.rmtree(folder)
            return {"deleted": True}
