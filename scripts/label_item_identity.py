"""Attach confirmed speakers and explicit claiming clues to existing item evidence.

This module never assigns task owners or calls a model. Clues are exact source
sentences, deliberately conservative, and always require a person's final check.
"""
import re


_ACTION = r"(?:负责|跟进|申请|提交|发送|发给|发一下|发|问一下|问|联系|确认|查询|准备|整理|录制|录|开发|设计|测试|调研|处理|安排|完成|做|写|更新|修改|上传|提供|补充|购买|买)"
_CLAIM = re.compile(r"我(?:这边)?(?:(?:今天|明天|后天|稍后|随后|到时候|周[一二三四五六日天](?:前|后)?|比赛前))?"
                    r"(?:会|先|再|就|可以|要)?(?:来|去|把[^，,。！？!?；;]{1,14})?(?P<action>" + _ACTION + r")")
_HYPOTHETICAL = re.compile(r"(?:如果|假如|假设|要是|比如|例如|举例|打个比方|难道)")
_PAST = re.compile(r"(?:已经|之前|刚才|刚刚|昨天|上次|曾经|当时)")
_NEGATED = re.compile(r"(?:不是|不用|不需要|无需)我|我(?:这边)?(?:不|没|无法|不能)|我.*(?:但|不过).*(?:不|没)")
_QUOTED = re.compile(r'''[“‘「『"'].*?[”’」』"']''')


def is_claim(text):
    """Find explicit first-person action language, excluding quotes, questions and past acts."""
    text = _QUOTED.sub("", text or "")
    for found in re.finditer(r"[^。！？!?；;\n]+[。！？!?；;]?", text):
        clause = found.group().strip()
        if not clause or clause[-1:] in ("?", "？") or re.search(r"[吗么呢][。！!]?\s*$", clause):
            continue
        if _HYPOTHETICAL.search(clause) or _NEGATED.search(clause):
            continue
        for match in _CLAIM.finditer(clause):
            before, after = clause[:match.start()], clause[match.end():]
            if _PAST.search(clause) or re.search(r"(?:说|说过|表示|提到|觉得|以为|认为|让|叫|要|帮|替|请|是不是)[：:\s]*$", before):
                continue
            if re.match(r"(?:一下|下)?(?:了|过|完|好了|完成|的|时|已|不)", after):
                continue
            if re.search(r"(?:已[经]?[^，,。]{0,8}(?:完成|通过|成功|提交)|(?:申请|提交).{0,8}(?:通过了|成功了))", clause):
                continue
            return True
    return False


def attach(item, evidence, people):
    """Enrich only current evidence; identity corrections never rewrite a saved owner."""
    people = set(people)
    speakers, claimants, seen = [], [], set()
    for span in evidence:
        for row in span["rows"]:
            speaker = row.get("speaker")
            if speaker in people and speaker not in speakers:
                speakers.append(speaker)
            if item["kind"] != "task" or row["id"] in seen or not is_claim(row["text"]):
                continue
            seen.add(row["id"])
            claimants.append(dict(speaker=speaker if speaker in people else None, text=row["text"],
                                  ids=[row["id"]], start_ms=row["start_ms"], end_ms=row["end_ms"],
                                  source="explicit_first_person", speaker_source=row.get("speaker_source")))
    return dict(speakers=speakers, claimants=claimants,
                claimant_status="identified" if any(c["speaker"] for c in claimants) else
                "identity_pending" if claimants else "no_explicit_claim")
