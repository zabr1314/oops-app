#!/usr/bin/env python3
"""Local, conservative text similarity for explicit annotation propagation.

This is a lexical score, not a semantic model or a confidence estimate. It
uses only the supplied transcript units, without network or model calls. The
caller owns current human answers, authentication and explicit confirmation.
Reserved blind sentences must be excluded before indexing and remain excluded
even if they happen to contain identical text.
"""
import math
import re
import unicodedata
from collections import Counter
from difflib import SequenceMatcher


VERSION = "text-char-v1"
ALLOWED_KINDS = frozenset(("fact", "info", "noise"))
THRESHOLDS = (60, 70, 80)
_FILLER = re.compile(r"嗯+|呃+|额+|哦+|噢+|啊+|呀+|哎+|唉+")
_PREFIX = re.compile(r"^(?:(?:对啊|对呀|对的|对对|对|然后|所以|其实|就是|那么|那个|这个)(?:[，,、。.!！?？\s]+|$))+")
_WORD = re.compile(r"[^\w]", re.UNICODE)
_NEGATIVE = re.compile(r"并非|无法|不可|不能|没有|禁止|否认|不是|未|无|没|不|勿")
_NUMBER = re.compile(r"\d+(?:[.,]\d+)*(?:%|％)?|第[零〇一二两三四五六七八九十百千万亿]+|[零〇一二两三四五六七八九十百千万亿]+(?:年|月|日|号|点|时|分|秒|天|周|个|人|台|次|遍|份|件|元|块|成|岁)")
_TIME = re.compile(r"今天|明天|昨天|后天|前天|今晚|明晚|昨晚|上午|下午|中午|晚上|早上|本周|这周|上周|下周|本月|上月|下月|今年|去年|明年|周[一二三四五六日天]|星期[一二三四五六日天]")
_LATIN = re.compile(r"[a-z][a-z0-9]*(?:[-_.][a-z0-9]+)*", re.I)
_VOCATIVE = re.compile(r"^(?:那个|这个)?([\u4e00-\u9fff]{2,4})[，,：:]")
_NAME_CUE = re.compile(r"(?:姓名(?:是|叫)?|名字(?:是|叫)?|叫做|负责人(?:是|叫)?|联系人(?:是|叫)?|交给|问问|找一下)([\u4e00-\u9fff]{2,4})(?=[，,。.!！?？\s]|$)")
_NOT_NAME = frozenset(("对啊", "对呀", "对的", "对对", "没错", "所以", "然后", "其实", "这个", "那个", "就是", "比如", "还有", "我觉得", "我认为", "我感觉", "也就是说"))


def normalize_text(text):
    """Remove punctuation and a small explicit set of conversational fillers."""
    text = unicodedata.normalize("NFKC", str(text or "")).lower().strip()
    clean = _WORD.sub("", _PREFIX.sub("", _FILLER.sub("", text).lstrip("，,、。.!！?？ ")))
    if clean:
        return clean
    # A pure acknowledgement is still useful as a noise grouping anchor.
    # Collapse only a single repeated character, never arbitrary phrases/names.
    plain = _WORD.sub("", text)
    return plain[:1] if plain and len(set(plain)) == 1 else plain


def _guards(text, protected_terms):
    raw = unicodedata.normalize("NFKC", text).lower()
    normalized = normalize_text(raw)
    # Matching negative words alone is insufficient: swapping which object is
    # negated must not propagate a confirmation. Keep the local following scope.
    negative = []
    for match in _NEGATIVE.finditer(normalized):
        scope = re.split(r"但是|但|不过|而且|而|可是|却", normalized[match.end():], maxsplit=1)[0][:10]
        negative.append((match.group(), scope))
    names = set(_NAME_CUE.findall(raw))
    first = _VOCATIVE.search(raw)
    if first and first.group(1) not in _NOT_NAME and not _FILLER.fullmatch(first.group(1)):
        names.add(first.group(1))
    names.update(term for term in protected_terms if term in normalized)
    return dict(negative=tuple(negative), numbers=tuple(sorted(_NUMBER.findall(raw))),
                times=tuple(sorted(_TIME.findall(raw))), latin=tuple(sorted(_LATIN.findall(raw))),
                names=tuple(sorted(names)))


def _ngrams(text, size):
    return Counter(text[i:i + size] for i in range(max(0, len(text) - size + 1)))


def _cosine(a, b):
    if not a or not b:
        return 0.0
    numerator = sum(value * b.get(key, 0) for key, value in a.items())
    return numerator / math.sqrt(sum(value * value for value in a.values()) * sum(value * value for value in b.values()))


class SimilarityIndex:
    """Index current units and return direct anchor matches across the supplied scope.

    Each unit must have id, ids, text, fingerprint and kind. Excluded sentence
    IDs (including the blind reservation) and excluded unit IDs are never
    indexed. A missing/uncertain/task/decision kind is never indexed. No match
    can reach another match through a third item; every score uses the anchor.

    protected_terms should include known participant names and relevant proper
    names. A deterministic text method cannot recognize every Chinese name.
    Therefore the UI must show every proposed member before the human applies
    the category. Scores may group different meanings that share many words.
    """
    def __init__(self, units, excluded_ids=(), protected_terms=()):
        excluded = set(excluded_ids)
        terms = tuple(sorted({normalize_text(term) for term in protected_terms if normalize_text(term)}))
        self.units = {}
        self._texts = {}
        self._guards = {}
        self._vectors = {}
        for unit in units:
            if not isinstance(unit, dict) or unit.get("kind") not in ALLOWED_KINDS:
                continue
            uid, ids = unit.get("id"), unit.get("ids")
            if (not isinstance(uid, str) or not uid or not isinstance(ids, list) or not ids
                    or any(not isinstance(value, str) or not value for value in ids)
                    or len(ids) != len(set(ids)) or not isinstance(unit.get("fingerprint"), str)
                    or not unit["fingerprint"] or not isinstance(unit.get("text"), str)):
                continue
            if uid in self.units:
                raise ValueError("duplicate_similarity_unit")
            if uid in excluded or excluded.intersection(ids):
                continue
            text = normalize_text(unit["text"])
            if not text and unit['kind'] == 'noise':
                # Preserve the actual filler instead of treating all stripped
                # utterances as identical; repeated 嗯嗯 and 嗯 can still match.
                compact = _WORD.sub('', unicodedata.normalize('NFKC', unit['text']).lower())
                text = re.sub(r'(.)\1+', r'\1', compact)
            if not text:
                continue
            self.units[uid] = dict(id=uid, ids=ids[:], text=unit["text"], fingerprint=unit["fingerprint"], kind=unit["kind"])
            self._texts[uid] = text
            self._guards[uid] = _guards(unit["text"], terms)
        # Corpus statistics contain no blind text. They are frozen for this
        # source index, independently of which labels a reviewer later saves.
        for size in (2, 3):
            counts = {uid: _ngrams(text, size) for uid, text in self._texts.items()}
            df = Counter(key for value in counts.values() for key in value)
            total = len(counts)
            self._vectors[size] = {uid: {key: value * (1 + math.log((1 + total) / (1 + df[key])))
                                        for key, value in grams.items()} for uid, grams in counts.items()}

    def score(self, anchor_id, candidate_id):
        """Return 0..1 lexical similarity, or zero when a guard rejects it."""
        if anchor_id not in self.units or candidate_id not in self.units:
            return 0.0
        if self.units[anchor_id]["kind"] != self.units[candidate_id]["kind"]:
            return 0.0
        if self._guards[anchor_id] != self._guards[candidate_id]:
            return 0.0
        a, b = self._texts[anchor_id], self._texts[candidate_id]
        if a == b:
            return 1.0
        # Very short text has too little evidence for a fuzzy match. Allow only
        # normalized duplicates (including brief noise) in this case.
        if min(len(a), len(b)) < 6 or min(len(a), len(b)) / max(len(a), len(b)) < .55:
            return 0.0
        ordered = SequenceMatcher(None, a, b, autojunk=False).ratio()
        return .55 * ordered + .30 * _cosine(self._vectors[2][anchor_id], self._vectors[2][candidate_id]) + .15 * _cosine(self._vectors[3][anchor_id], self._vectors[3][candidate_id])

    def matches(self, anchor_id, threshold=80, allowed_ids=None, limit=100):
        """Return sorted candidate members, excluding the anchor itself.

        Threshold is a percentage of this named lexical score. A result's
        displayed integer score is floored, so 79.9 never displays as an 80%
        eligible match. allowed_ids can restrict the current pending/filter
        scope; it cannot reinclude a blind or unsupported unit.
        """
        if isinstance(threshold, bool) or threshold not in THRESHOLDS:
            raise ValueError("similarity_threshold_must_be_60_70_or_80")
        if not isinstance(limit, int) or isinstance(limit, bool) or not 1 <= limit <= 100:
            raise ValueError("similarity_limit_must_be_1_to_100")
        if anchor_id not in self.units:
            return []
        allowed = set(allowed_ids) if allowed_ids is not None else None
        matches = []
        for uid, unit in self.units.items():
            if uid == anchor_id or (allowed is not None and uid not in allowed):
                continue
            score = self.score(anchor_id, uid)
            if score + 1e-12 >= threshold / 100:
                matches.append(dict(id=uid, ids=unit["ids"][:], fingerprint=unit["fingerprint"],
                                    kind=unit["kind"], score=min(100, math.floor(100 * score + 1e-10)),
                                    similarity=round(score, 6), method=VERSION))
        matches.sort(key=lambda item: (-item["similarity"], item["id"]))
        return matches[:limit]
