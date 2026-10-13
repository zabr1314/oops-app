#!/usr/bin/env python3
"""Voices the enrolled voiceprints cannot name, grouped into anonymous roles (角色A, 角色B …) that people claim.

    .venv-voice/bin/python scripts/voice_roles.py build/label-data 0235 0236 0238 \\
        --registry models/voiceprint/hk-registry-20261012.json [--check]

The meetings are clustered together (same microphone, same team), so a role means the same person in every one.
Sentences already pre-filled by voice_prefill.py are left out; so are sentences that clearly sound like an enrolled
person. Each role keeps the sentences close to its centre and three representative clips to listen to.
Writes meetings/<id>/roles.json: {roles: {角色A: {clips: [...]}}, rows: {sentence id: {role, score}}}.
--check compares the roles with the 40 hand-labelled clips in models/voiceprint/check (2026-10-06).
"""
import argparse
import json
import os
import re

import numpy as np
import sherpa_onnx
import soundfile as sf

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MIN_MS, MIN_CHARS = 1_500, 10
KNOWN_SCORE = 0.32  # closer than this to an enrolled voice: probably that person, not an unknown one
MERGE = 0.55  # average-linkage cosine similarity at which two groups are the same voice
MEMBER = 0.45  # a sentence belongs to a role at this similarity to its centre
MIN_ROLE_S = 40  # a role needs this much speech to be worth claiming
LETTERS = "ABCDEFGH"


def unit(v):
    return v / (np.linalg.norm(v) + 1e-9)


def embedder():
    ext = sherpa_onnx.SpeakerEmbeddingExtractor(sherpa_onnx.SpeakerEmbeddingExtractorConfig(
        model=os.path.join(ROOT, "models", "campplus_zh.onnx"), num_threads=4))

    def embed(samples):
        stream = ext.create_stream()
        stream.accept_waveform(16000, samples)
        stream.input_finished()
        if not ext.is_ready(stream):
            return None
        return unit(np.array(ext.compute(stream), dtype=np.float32))
    return embed


def enrolled(path):
    data = json.load(open(path, encoding="utf-8"))
    out = []
    for name, person in data["people"].items():
        for p in (person.get("profiles") or {"main": person}).values():
            out.append((name, unit(np.array(p["vector"], dtype=np.float32))))
    return out


def agglomerate(vectors, threshold):
    """Average-linkage clustering on cosine similarity; small enough (a few hundred sentences) to do directly."""
    groups = [[i] for i in range(len(vectors))]
    sims = vectors @ vectors.T
    while len(groups) > 1:
        best, pair = -1.0, None
        for a in range(len(groups)):
            for b in range(a + 1, len(groups)):
                s = sims[np.ix_(groups[a], groups[b])].mean()
                if s > best:
                    best, pair = s, (a, b)
        if best < threshold:
            break
        a, b = pair
        groups[a] += groups.pop(b)
    return groups


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("data")
    p.add_argument("meetings", nargs="+")
    p.add_argument("--registry", required=True)
    p.add_argument("--check", action="store_true")
    args = p.parse_args()
    embed, known = embedder(), enrolled(args.registry)
    items = []  # (meeting, row, seconds, vector)
    audio = {}
    for mid in args.meetings:
        folder = os.path.join(args.data, "meetings", mid)
        rows = json.load(open(os.path.join(folder, "meeting.json"), encoding="utf-8"))["utterances"]
        voice = json.load(open(os.path.join(folder, "voice.json"), encoding="utf-8"))["rows"]
        audio[mid], _ = sf.read(os.path.join(folder, "audio.wav"), dtype="float32")
        for u in rows:
            ms = u["end_ms"] - u["start_ms"]
            if u["id"] in voice or ms < MIN_MS or len(re.sub(r"[^\w]", "", u["text"])) < MIN_CHARS:
                continue
            v = embed(audio[mid][u["start_ms"] * 16:u["end_ms"] * 16])
            if v is None or max(float(k @ v) for _, k in known if True) >= KNOWN_SCORE and \
                    max(known, key=lambda k: float(k[1] @ v))[0] in ("林春源", "洪玉麟"):
                continue
            items.append((mid, u, ms / 1000, v))
    vectors = np.stack([it[3] for it in items])
    groups = sorted(agglomerate(vectors, MERGE), key=lambda g: -sum(items[i][2] for i in g))
    roles = []
    for g in groups:
        if sum(items[i][2] for i in g) < MIN_ROLE_S or len(roles) >= len(LETTERS):
            continue
        centre = unit(vectors[g].mean(axis=0))
        roles.append(dict(name="角色" + LETTERS[len(roles)], centre=centre))
    rows_out = {mid: {} for mid in args.meetings}
    for mid, u, seconds, v in items:
        scored = sorted(((float(r["centre"] @ v), r["name"]) for r in roles), reverse=True)
        if scored and scored[0][0] >= MEMBER and (len(scored) == 1 or scored[0][0] - scored[1][0] >= 0.05):
            rows_out[mid][u["id"]] = dict(role=scored[0][1], score=round(scored[0][0], 3))
    for r in roles:  # representative clips: close to the centre, 2–6 s, from different meetings where possible
        members = [(float(r["centre"] @ v), mid, u) for mid, u, s, v in items
                   if rows_out[mid].get(u["id"], {}).get("role") == r["name"] and 2 <= s <= 6]
        members.sort(key=lambda m: -m[0])
        picked, seen = [], set()
        for score, mid, u in members:
            if mid not in seen or len(members) <= 3:
                picked.append(dict(meeting=mid, id=u["id"], text=u["text"], score=round(score, 3)))
                seen.add(mid)
            if len(picked) == 3:
                break
        r["clips"] = picked
        r["seconds"] = round(sum(s for mid, u, s, v in items if rows_out[mid].get(u["id"], {}).get("role") == r["name"]))
    summary = {r["name"]: dict(clips=r["clips"], seconds=r["seconds"]) for r in roles}
    for mid in args.meetings:
        with open(os.path.join(args.data, "meetings", mid, "roles.json"), "w", encoding="utf-8") as f:
            json.dump(dict(roles=summary, rows=rows_out[mid], made_from=args.meetings), f, ensure_ascii=False, indent=1)
    print(f"{len(items)} 句未识别的长句 → {len(roles)} 个角色")
    for r in roles:
        counts = {mid: sum(1 for x in rows_out[mid].values() if x["role"] == r["name"]) for mid in args.meetings}
        print(f"  {r['name']}：{r['seconds']} 秒，{counts}；代表片段：{[c['meeting'] + '/' + c['id'] for c in r['clips']]}")
    if args.check:
        check(roles, embed, known)


def check(roles, embed, known):
    """How the roles line up with the clips people labelled by ear (models/voiceprint/check)."""
    folder = os.path.join(ROOT, "models", "voiceprint", "check")
    manifest = json.load(open(os.path.join(folder, "manifest.json"), encoding="utf-8"))
    answers = json.load(open(os.path.join(folder, "answers.json"), encoding="utf-8"))
    table = {}
    for m in manifest:
        truth = answers.get(m["clip"])
        x, _ = sf.read(os.path.join(folder, m["clip"]), dtype="float32")
        v = embed(x)
        if v is None or not truth:
            continue
        scored = sorted(((float(r["centre"] @ v), r["name"]) for r in roles), reverse=True)
        role = scored[0][1] if scored and scored[0][0] >= MEMBER else "—"
        table.setdefault(truth, {}).setdefault(role, 0)
        table[truth][role] += 1
    print("人工标注 → 角色：")
    for truth, roles_ in sorted(table.items()):
        print(f"  {truth}：{roles_}")


if __name__ == "__main__":
    main()
