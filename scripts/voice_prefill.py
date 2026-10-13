#!/usr/bin/env python3
"""Pre-fill the speaker of long sentences the live voiceprints are sure about, so the team labels the rest.

    .venv-voice/bin/python scripts/voice_prefill.py build/label-data 0235 0236 0238 \\
        --registry models/voiceprint/hk-registry-20261012.json

Writes meetings/<id>/voice.json: {sentence id: {name, score, gap}} for sentences of at least 10 characters whose
best match is >= ACCEPT and leads the runner-up by >= GAP. On 30 hand-labelled single-speaker clips (0236/0238,
2026-10-12) every clip above that bar was right (11/11, all 林春源/洪玉麟), but clips with two voices also clear it,
so a pre-filled name means "mainly this person". The team can overwrite it; overwrites are what measure it.
"""
import argparse
import json
import os
import re

import numpy as np
import sherpa_onnx
import soundfile as sf

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ACCEPT, GAP, MIN_CHARS = 0.40, 0.10, 10


def profiles(registry):
    names, vectors = [], []
    for name, person in registry["people"].items():
        for profile in (person.get("profiles") or {"main": person}).values():  # best capture source wins
            v = np.array(profile["vector"], dtype=np.float32)
            names.append(name)
            vectors.append(v / np.linalg.norm(v))
    return names, np.stack(vectors)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("data")
    parser.add_argument("meetings", nargs="+")
    parser.add_argument("--registry", required=True)
    args = parser.parse_args()
    with open(args.registry, encoding="utf-8") as f:
        names, matrix = profiles(json.load(f))
    extractor = sherpa_onnx.SpeakerEmbeddingExtractor(sherpa_onnx.SpeakerEmbeddingExtractorConfig(
        model=os.path.join(ROOT, "models", "campplus_zh.onnx"), num_threads=4))
    for mid in args.meetings:
        folder = os.path.join(args.data, "meetings", mid)
        with open(os.path.join(folder, "meeting.json"), encoding="utf-8") as f:
            rows = json.load(f)["utterances"]
        audio, rate = sf.read(os.path.join(folder, "audio.wav"), dtype="float32")
        assert rate == 16000
        out = {}
        for u in rows:
            if len(re.sub(r"[^\w]", "", u["text"])) < MIN_CHARS:
                continue
            stream = extractor.create_stream()
            stream.accept_waveform(16000, audio[u["start_ms"] * 16:u["end_ms"] * 16])
            stream.input_finished()
            if not extractor.is_ready(stream):
                continue
            v = np.array(extractor.compute(stream), dtype=np.float32)
            sims = matrix @ (v / np.linalg.norm(v))
            best = {}
            for name, sim in zip(names, sims):
                best[name] = max(best.get(name, -1.0), float(sim))
            (top, s1), (_, s2) = sorted(best.items(), key=lambda t: -t[1])[:2]
            if s1 >= ACCEPT and s1 - s2 >= GAP:
                out[u["id"]] = {"name": top, "score": round(s1, 3), "gap": round(s1 - s2, 3)}
        with open(os.path.join(folder, "voice.json"), "w", encoding="utf-8") as f:
            json.dump({"registry": os.path.basename(args.registry), "accept": ACCEPT, "gap": GAP, "rows": out},
                      f, ensure_ascii=False, indent=1)
        print(f"{mid}: 预填 {len(out)} 句", {n: sum(1 for x in out.values() if x["name"] == n) for n in set(names)})


if __name__ == "__main__":
    main()
