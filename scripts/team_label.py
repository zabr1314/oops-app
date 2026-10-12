#!/usr/bin/env python3
"""Team labelling site for the discussion recordings: each person labels with a personal link, blind to the model
and to each other.

    team_label.py bundle 0235 0236 0238 --out build/label-data     # Mac: pack sentences + audio for the server
    team_label.py serve --data /var/lib/oops-label --port 8798     # server, behind nginx; LABEL_SECRET in the env
    team_label.py links --base https://giftedprofessor.xyz/oops-meeting/label/   # personal links (LABEL_SECRET)
    team_label.py merge --data <pulled data> 0236                   # → evidence/<session>/truth.json + disagreements

Per sentence a person marks who spoke, whether it is a task / decision / neither, the task owner, and which
sentences state the same task. Labels are stored per person (labels/<meeting>/<name>.json) and merged into one
truth file afterwards; sentences on which labellers disagree are listed instead of silently picking one.
Listens on 127.0.0.1 only. Audio is served in single-sentence clips, only with a valid personal key.
"""
import argparse
import base64
import hashlib
import hmac
import json
import os
import re
import shutil
import sys
import threading
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from label_meeting import clip_wav  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PEOPLE = ["林春源", "洪玉麟", "江古月", "黄丽萍"]
SPEAKER_OTHER = {"multi": "多人同时", "other": "其他人", "unclear": "听不清"}
OWNER_OTHER = {"collective": "大家", "unknown": "不确定"}
KINDS = ("task", "decision", "info", "noise")
# How the live tags (local_backend.TAGS) line up with the labels, for scoring the sentence triage itself.
LIVE_TAG = {"commitment": "task", "decision": "decision", "idea": "info", "constraint": "info", "chitchat": "noise"}
DUPS = "ABCDEFGHJK"
MEETING = re.compile(r"[0-9]{4}")
SHORT_MS = 1200  # rows this short ("对。") may be left without a speaker
SHORT_CHARS = 10  # shorter rows are context only on the page unless someone opens them


# ---------- keys ----------

def make_key(secret, name):
    tag = hmac.new(secret.encode(), ("label:" + name).encode(), hashlib.sha256).hexdigest()[:32]
    return base64.urlsafe_b64encode(name.encode()).decode().rstrip("=") + "." + tag


TEAM = "team"  # one shared link: the page asks who you are and sends it as X-Labeler


def check_key(secret, key):
    """The labeller's name, TEAM for the shared link, or None."""
    try:
        head, _ = key.split(".", 1)
        name = base64.urlsafe_b64decode(head + "=" * (-len(head) % 4)).decode()
    except (ValueError, UnicodeDecodeError, AttributeError):
        return None
    return name if (name in PEOPLE or name == TEAM) and hmac.compare_digest(make_key(secret, name), key) else None


# ---------- labels ----------

def clean(raw, rows):
    """Only known sentence ids and known values survive."""
    known = {u["id"] for u in rows}
    out = {}
    for uid, label in (raw or {}).items():
        if uid not in known or not isinstance(label, dict):
            continue
        item = {}
        if label.get("speaker") in PEOPLE or label.get("speaker") in SPEAKER_OTHER:
            item["speaker"] = label["speaker"]
        if label.get("kind") in KINDS:
            item["kind"] = label["kind"]
        if item.get("kind") == "task" and (label.get("owner") in PEOPLE or label.get("owner") in OWNER_OTHER):
            item["owner"] = label["owner"]
        if item.get("kind") in ("task", "decision") and isinstance(label.get("dup"), str) and len(label["dup"]) == 1 \
                and label["dup"] in DUPS:
            item["dup"] = label["dup"]
        if item:
            out[uid] = item
    return out


def chars(row):
    return len(re.sub(r"[^\w]", "", row["text"]))


def long_rows(rows):
    return sum(1 for u in rows if chars(u) >= SHORT_CHARS)


def complete(label, row):
    return bool(label.get("kind")) and (bool(label.get("speaker") or row.get("voice")) or row["end_ms"] - row["start_ms"] < SHORT_MS) \
        and (label.get("kind") != "task" or bool(label.get("owner")))


def merge(rows, by_person):
    """One truth from several labellers. A field counts when everyone who set it agrees; otherwise it is a dispute."""
    tasks, decisions, non_tasks, speakers, disputes, groups = [], [], [], {}, [], {}
    kinds = {}
    for u in rows:
        labels = {p: ls[u["id"]] for p, ls in by_person.items() if u["id"] in ls}
        if not labels:
            continue
        row_disputes = {}
        values = {}
        for field in ("kind", "speaker", "owner"):
            seen = {p: l[field] for p, l in labels.items() if l.get(field)}
            if len(set(seen.values())) > 1:
                row_disputes[field] = seen
            elif seen:
                values[field] = next(iter(seen.values()))
        if row_disputes:
            disputes.append({"utterance": u["id"], "text": u["text"], **row_disputes})
        kind = values.get("kind")
        if "kind" not in row_disputes and kind:
            kinds[u["id"]] = kind
        if "kind" not in row_disputes and kind == "task":
            owner = values.get("owner")
            tasks.append({"utterance": u["id"], "phrase": u["text"][:40], "owner": owner if owner in PEOPLE else None,
                          **({"note": OWNER_OTHER[owner]} if owner in OWNER_OTHER else {})})
        elif "kind" not in row_disputes and kind == "decision":
            decisions.append({"utterance": u["id"], "phrase": u["text"][:40]})
        elif "kind" not in row_disputes and kind in ("info", "noise"):  # hard negatives for task finding
            non_tasks.append({"utterance": u["id"], "phrase": u["text"][:40], "kind": kind})
        if "speaker" not in row_disputes and values.get("speaker"):
            speakers[u["id"]] = values["speaker"]
        for p, l in labels.items():  # duplicate groups are per person: letters mean nothing across people
            if l.get("dup"):
                groups.setdefault((p, l["dup"]), []).append(u["id"])
    dup_sets = sorted({tuple(ids) for ids in groups.values() if len(ids) >= 2})
    # Pre-filled voiceprint names nobody overwrote; kept apart so they never pass as human speaker labels.
    voice_only = {u["id"]: u["voice"] for u in rows if u.get("voice") and u["id"] not in speakers
                  and not any(ls.get(u["id"], {}).get("speaker") for ls in by_person.values())}
    voice_overruled = {u["id"]: {"voice": u["voice"], "human": speakers[u["id"]]} for u in rows
                       if u.get("voice") and speakers.get(u["id"]) and speakers[u["id"]] != u["voice"]}
    return {"tasks": tasks, "decisions": decisions, "non_tasks": non_tasks, "kinds": kinds, "speakers": speakers,
            "voice_prefill_unreviewed": voice_only, "voice_prefill_overruled": voice_overruled,
            "duplicates": [list(g) for g in dup_sets], "disputes": disputes, "labelers": sorted(by_person)}


# ---------- storage ----------

class Data:
    def __init__(self, folder):
        self.folder = folder
        self.meetings = {}
        for mid in sorted(os.listdir(os.path.join(folder, "meetings"))):
            path = os.path.join(folder, "meetings", mid)
            if not MEETING.fullmatch(mid) or not os.path.isfile(os.path.join(path, "audio.wav")):
                continue
            with open(os.path.join(path, "meeting.json"), encoding="utf-8") as f:
                meeting = json.load(f)
            voice = {}
            if os.path.isfile(os.path.join(path, "voice.json")):  # voice_prefill.py: speakers the voiceprints are sure of
                with open(os.path.join(path, "voice.json"), encoding="utf-8") as f:
                    voice = json.load(f)["rows"]
            for u in meeting["utterances"]:
                if voice.get(u["id"], {}).get("name") in PEOPLE:
                    u["voice"] = voice[u["id"]]["name"]
            self.meetings[mid] = {"id": mid, "title": meeting.get("title", mid), "rows": meeting["utterances"],
                                  "wav": os.path.join(path, "audio.wav")}
        self.lock = threading.Lock()

    def labels_path(self, mid, name):
        return os.path.join(self.folder, "labels", mid, name + ".json")

    def load(self, mid, name):
        path = self.labels_path(mid, name)
        if not os.path.isfile(path):
            return {}
        with open(path, encoding="utf-8") as f:
            return clean(json.load(f).get("labels"), self.meetings[mid]["rows"])

    def save(self, mid, name, raw):
        labels = clean(raw, self.meetings[mid]["rows"])
        path = self.labels_path(mid, name)
        with self.lock:
            os.makedirs(os.path.dirname(path), exist_ok=True)
            with open(path + ".tmp", "w", encoding="utf-8") as f:
                json.dump({"meeting": mid, "labeler": name, "labels": labels}, f, ensure_ascii=False, indent=1)
            os.replace(path + ".tmp", path)
        return labels

    def progress(self, mid):
        rows = {u["id"]: u for u in self.meetings[mid]["rows"]}
        out = {}
        for name in PEOPLE:
            labels = self.load(mid, name)
            if labels:
                out[name] = sum(1 for uid, l in labels.items() if chars(rows[uid]) >= SHORT_CHARS and complete(l, rows[uid]))
        return out


# ---------- http ----------

def make_handler(data, secret):
    page = (PAGE.replace("__PEOPLE__", json.dumps(PEOPLE, ensure_ascii=False))
            .replace("__SPOTHER__", json.dumps(SPEAKER_OTHER, ensure_ascii=False))
            .replace("__OWOTHER__", json.dumps(OWNER_OTHER, ensure_ascii=False))
            .replace("__SHORT__", str(SHORT_MS)).replace("__DUPS__", DUPS)).encode()
    index = {mid: {u["id"]: u for u in m["rows"]} for mid, m in data.meetings.items()}

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def send(self, status, body, kind="application/json; charset=utf-8"):
            self.send_response(status)
            self.send_header("Content-Type", kind)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "private, max-age=86400" if kind == "audio/wav" else "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Referrer-Policy", "no-referrer")
            self.end_headers()
            self.wfile.write(body)

        def who(self, query):
            auth = self.headers.get("Authorization", "")
            key = auth[7:] if auth.startswith("Bearer ") else (query.get("k") or [""])[0]
            name = check_key(secret, key)
            if name == TEAM:
                picked = urllib.parse.unquote(self.headers.get("X-Labeler", ""))
                return picked if picked in PEOPLE else TEAM
            return name

        def do_GET(self):
            url = urllib.parse.urlsplit(self.path)
            query = urllib.parse.parse_qs(url.query)
            if url.path in ("/", "/index.html"):
                return self.send(200, page, "text/html; charset=utf-8")
            name = self.who(query)
            if not name:
                return self.send(401, b'{"error":"link"}')
            if url.path == "/api/me":
                if name == TEAM:
                    return self.send(200, json.dumps({"name": None, "people": PEOPLE}, ensure_ascii=False).encode())
                meetings = [{"id": mid, "title": m["title"], "count": long_rows(m["rows"]),
                             "minutes": round(m["rows"][-1]["end_ms"] / 60000) if m["rows"] else 0,
                             "progress": data.progress(mid)} for mid, m in data.meetings.items()]
                return self.send(200, json.dumps({"name": name, "meetings": meetings}, ensure_ascii=False).encode())
            m = re.fullmatch(r"/api/meeting/([0-9]{4})", url.path)
            if m and name == TEAM:
                return self.send(400, b'{"error":"who"}')
            if m and m.group(1) in data.meetings:
                mid = m.group(1)
                rows = [{"id": u["id"], "text": u["text"], "start_ms": u["start_ms"], "end_ms": u["end_ms"], "chars": chars(u),
                         **({"voice": u["voice"]} if u.get("voice") else {})}
                        for u in data.meetings[mid]["rows"]]  # blind: no model output, nobody else's labels
                return self.send(200, json.dumps({"id": mid, "rows": rows, "labels": data.load(mid, name)},
                                                 ensure_ascii=False).encode())
            m = re.fullmatch(r"/clip/([0-9]{4})/([A-Za-z0-9_-]{1,40})\.wav", url.path)
            if m and m.group(2) in index.get(m.group(1), {}):
                u = index[m.group(1)][m.group(2)]
                pad = 0 if (query.get("pad") or [""])[0] == "0" else 300
                return self.send(200, clip_wav(data.meetings[m.group(1)]["wav"], u["start_ms"], u["end_ms"], pad), "audio/wav")
            self.send(404, b"{}")

        def do_POST(self):
            url = urllib.parse.urlsplit(self.path)
            name = self.who({})
            if not name or name == TEAM:
                return self.send(401, b'{"error":"link"}')
            m = re.fullmatch(r"/api/meeting/([0-9]{4})/labels", url.path)
            if not m or m.group(1) not in data.meetings:
                return self.send(404, b"{}")
            size = int(self.headers.get("Content-Length") or 0)
            if not 0 < size <= 1_500_000:
                return self.send(400, b"{}")
            try:
                labels = data.save(m.group(1), name, json.loads(self.rfile.read(size)))
            except (json.JSONDecodeError, ValueError):
                return self.send(400, b"{}")
            self.send(200, json.dumps({"saved": len(labels)}).encode())

    return Handler


# ---------- commands ----------

def bundle(args):
    import dji_to_eval
    for short in args.meetings:
        stem = dji_to_eval.recording(short)
        sid = dji_to_eval.session_id(stem)
        with open(os.path.join(ROOT, "evidence", sid, "meeting.json"), encoding="utf-8") as f:
            meeting = json.load(f)
        if meeting.get("purpose") != "meeting-development":
            sys.exit(f"{short} 不是开发集，不放进团队标注")
        dest = os.path.join(args.out, "meetings", short)
        os.makedirs(dest, exist_ok=True)
        day = stem.split("_")[1]
        title = f"{int(day[4:6])}月{int(day[6:8])}日 {day[8:10]}:{day[10:12]} 讨论（{short}）"
        rows = [{k: u[k] for k in ("id", "parent", "text", "start_ms", "end_ms")} for u in meeting["utterances"]]
        with open(os.path.join(dest, "meeting.json"), "w", encoding="utf-8") as f:
            json.dump({"id": short, "session": sid, "title": title, "utterances": rows}, f, ensure_ascii=False)
        shutil.copyfile(os.path.join(ROOT, "test-media", stem + ".wav"), os.path.join(dest, "audio.wav"))
        print(f"{short}: {len(rows)} 句 → {dest}")


def secret_from_env():
    secret = os.environ.get("LABEL_SECRET", "")
    if len(secret) < 32:
        sys.exit("LABEL_SECRET 未设置或太短")
    return secret


def links(args):
    secret = secret_from_env()
    print(f"全队\t{args.base}#k={make_key(secret, TEAM)}")
    for name in PEOPLE:
        print(f"{name}\t{args.base}#k={make_key(secret, name)}")


def merge_cmd(args):
    import dji_to_eval
    for short in args.meetings:
        with open(os.path.join(args.data, "meetings", short, "meeting.json"), encoding="utf-8") as f:
            meeting = json.load(f)
        rows = meeting["utterances"]
        folder = os.path.join(args.data, "labels", short)
        by_person = {}
        for name in PEOPLE:
            path = os.path.join(folder, name + ".json")
            if os.path.isfile(path):
                with open(path, encoding="utf-8") as f:
                    by_person[name] = clean(json.load(f).get("labels"), rows)
        truth = {"meeting": meeting["session"], "source": "team_label", **merge(rows, by_person)}
        out = os.path.join(ROOT, "evidence", meeting["session"], "truth.json")
        with open(out, "w", encoding="utf-8") as f:
            json.dump(truth, f, ensure_ascii=False, indent=1)
        print(f"{short}: 标注人 {truth['labelers']}，任务 {len(truth['tasks'])}，决定 {len(truth['decisions'])}，"
              f"分歧 {len(truth['disputes'])} → {out}")
        print(json.dumps(dji_to_eval.fold_truth(short), ensure_ascii=False))


def serve(args):
    secret = secret_from_env()
    data = Data(args.data)
    server = ThreadingHTTPServer(("127.0.0.1", args.port), make_handler(data, secret))
    print(f"团队标注：127.0.0.1:{args.port}，{len(data.meetings)} 场", flush=True)
    server.serve_forever()


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="cmd", required=True)
    b = sub.add_parser("bundle"); b.add_argument("meetings", nargs="+"); b.add_argument("--out", required=True)
    s = sub.add_parser("serve"); s.add_argument("--data", required=True); s.add_argument("--port", type=int, default=8798)
    lk = sub.add_parser("links"); lk.add_argument("--base", required=True)
    m = sub.add_parser("merge"); m.add_argument("meetings", nargs="+"); m.add_argument("--data", required=True)
    args = parser.parse_args(argv)
    {"bundle": bundle, "serve": serve, "links": links, "merge": merge_cmd}[args.cmd](args)


PAGE = r"""<!doctype html><html lang="zh"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer"><title>Oops 讨论标注</title>
<style>
:root{color-scheme:light;--bg:#f7f6fb;--fg:#1d1b26;--mut:#6f6b80;--line:#e4e1ee;--card:#fff;--brand:#6d5be8;--brand-soft:#ece9ff;--ok:#16a34a;--dec:#d97706;--cur:#fff8d6}
@media(prefers-color-scheme:dark){:root:not([data-theme="light"]){color-scheme:dark;--bg:#16151c;--fg:#f2f1f7;--mut:#a29fb3;--line:#34313f;--card:#211f2a;--brand:#8f80ff;--brand-soft:#2d2850;--cur:#3a3420}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,-apple-system,"PingFang SC",sans-serif}
header{position:sticky;top:0;z-index:5;background:var(--bg);border-bottom:1px solid var(--line);padding:8px 16px}
.hrow{display:flex;gap:8px 14px;align-items:center;flex-wrap:wrap;max-width:1000px;margin:0 auto}
h1{font-size:16px;margin:0}.mut{color:var(--mut);font-size:13px}
.tabs{display:flex;gap:6px;flex-wrap:wrap}.tabs button,.tool{border:1px solid var(--line);background:var(--card);color:var(--fg);border-radius:999px;padding:4px 12px;font:inherit;font-size:13px;cursor:pointer}
.tabs button.on{background:var(--brand);border-color:var(--brand);color:#fff}.tool.on{background:var(--brand-soft);border-color:var(--brand)}
select.tool{padding:4px 8px}
main{max-width:1000px;margin:0 auto;padding:8px 16px 120px}
details.help{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:8px 14px;margin:10px 0;font-size:14px}
details.help summary{cursor:pointer;font-weight:600}details.help li{margin:3px 0}kbd{border:1px solid var(--line);border-radius:4px;padding:0 4px;font-size:12px;background:var(--bg)}
.row{background:var(--card);border:1px solid var(--line);border-left:4px solid transparent;border-radius:12px;padding:8px 12px;margin:6px 0;scroll-margin:120px 0 160px}
.row.mini{padding:2px 12px;margin:2px 0;background:none;border-color:transparent}.row.mini .txt{font-size:14px;color:var(--mut)}.row.mini .c{min-height:24px;padding:0 8px;font-size:12px;color:var(--mut)}.row.mini.cur{box-shadow:0 0 0 1px var(--line)}
.row.done{border-left-color:var(--ok)}.row.k-task{border-left-color:var(--brand)}.row.k-decision{border-left-color:var(--dec)}.row.k-info{border-left-color:#0e9f8e}
.row.cur{box-shadow:0 0 0 2px var(--brand)}.row.playing{background:var(--cur)}
.top{display:flex;gap:10px;align-items:flex-start}.t{color:var(--mut);font-variant-numeric:tabular-nums;min-width:42px;font-size:12px;padding-top:4px}
.txt{flex:1;font-size:16px;cursor:pointer}.play{border:1px solid var(--line);background:none;color:var(--fg);border-radius:8px;padding:3px 10px;cursor:pointer;font:inherit;font-size:13px;flex:none}
.ctl{display:flex;gap:6px 12px;flex-wrap:wrap;margin-top:6px;align-items:center}
.grp{display:inline-flex;align-items:center;gap:4px;flex-wrap:wrap}.grp>span{color:var(--mut);font-size:12px;margin-right:2px}
.c{border:1px solid var(--line);background:none;color:var(--fg);border-radius:8px;padding:3px 9px;font:inherit;font-size:13px;cursor:pointer;min-height:30px}
.c.on{background:var(--brand);border-color:var(--brand);color:#fff}.c.on.dec{background:var(--dec);border-color:var(--dec)}.c.on.vp{background:var(--brand-soft);color:var(--fg);border-style:dashed;border-color:var(--brand)}.vpnote{font-style:normal;font-size:12px;color:var(--mut);margin-left:4px}
.c.on.neg{background:var(--mut);border-color:var(--mut)}.c.on.inf{background:#0e9f8e;border-color:#0e9f8e}
.sep{width:1px;height:20px;background:var(--line)}
#state.err{color:#dc2626;font-weight:600}
.empty{padding:40px 0;text-align:center;color:var(--mut)}
#gate{max-width:420px;margin:15vh auto;padding:0 16px;text-align:center}
@media(max-width:640px){header{padding:6px 12px}main{padding:4px 10px 120px}h1{display:none}.t{display:none}.txt{font-size:15px}
.row{padding:8px 10px}.ctl{gap:6px}.grp>span{display:none}.c{padding:2px 7px;min-height:32px}.hide-s{display:none}.tool{padding:3px 9px}
.grp+.grp{padding-left:8px;border-left:1px solid var(--line)}}
</style>
<div id="gate" hidden><h1>请用个人链接打开</h1><p class="mut">这个页面只对团队成员开放。请使用发给你的完整链接（包含 #k= 的那一段）。</p></div>
<div id="pick" hidden style="max-width:420px;margin:15vh auto;padding:0 16px;text-align:center"><h1>你是谁？</h1>
<p class="mut">选一次就记住，每个人的标注分开保存。</p><div class="tabs" id="pickers" style="justify-content:center;margin-top:16px"></div></div>
<div id="app" hidden>
<header><div class="hrow"><h1>Oops 讨论标注</h1><div class="tabs" id="tabs"></div><span class="mut" id="me"></span><span class="mut" id="state">已保存</span></div>
<div class="hrow" style="margin-top:6px"><span class="mut" id="prog"></span>
<button class="tool" id="cont" title="从当前句开始连续播放，边听边标（快捷键 P）">▶ 连续播放</button>
<select class="tool" id="rate" title="播放速度"><option value="1">1×</option><option value="1.25">1.25×</option><option value="1.5">1.5×</option><option value="1.75">1.75×</option></select>
<select class="tool" id="filter"><option value="all">全部句子</option><option value="todo">只看没标完的</option><option value="who">只看说话人待定的</option><option value="marked">只看任务/决定</option></select></div></header>
<main><details class="help" id="help"><summary>怎么标（1 分钟看完）</summary><ul>
<li><b>只标长句</b>：不到 10 个字的短句（「对」「可以的」）显示成灰色小字，不用标，听和看上下文就行。如果短句本身就是任务或决定（比如「你来。」「行，就这么定」），点它右边的「标」再标。</li>
<li><b>谁说的</b>：春源、玉麟声纹有把握的句子已经预填（虚线框），听着不对就点正确的人改掉，对的不用动。其余句子请听一下，点说话人。几个人同时说选「多人」，听不出或不是我们四个人选「听不清」。</li>
<li><b>任务</b>：有人要去做的具体事，自己认领（“我来改”）或被安排（“你把文档发我”）都算，再选负责人；大家一起做选「大家」。</li>
<li><b>决定</b>：大家定下来的结论，例如“那就先做声纹”。只是提想法、还在讨论的不算。</li>
<li><b>有效</b>：不是任务也不是决定，但值得写进纪要或思维导图的内容：想法、方案、理由、问题、数据、限制条件。像“回头再看看”“可以考虑”这种听起来像任务但没人要做的，也标「有效」。</li>
<li><b>无效</b>：闲聊、跑题、口头禅、重复、说了一半没意义的话。会后整理时可以直接丢掉的。</li>
<li><b>同一件事</b>：同一个任务或决定说了好几遍，就给这几句选同一个字母。</li>
<li>每次点击自动保存。你看不到模型的判断，也看不到别人的标注，按自己的理解标就好。</li>
<li class="hide-s">键盘：<kbd>↑</kbd><kbd>↓</kbd> 换句，<kbd>空格</kbd> 听，<kbd>P</kbd> 连续播放，<kbd>1</kbd>–<kbd>4</kbd> 说话人（春源/玉麟/古月/丽萍），<kbd>5</kbd> 多人，<kbd>0</kbd> 听不清，<kbd>T</kbd> 任务，<kbd>D</kbd> 决定，<kbd>I</kbd> 有效，<kbd>N</kbd> 无效，<kbd>Q</kbd><kbd>W</kbd><kbd>E</kbd><kbd>R</kbd> 负责人，<kbd>A</kbd> 负责人为大家。</li>
</ul></details><div id="list"></div></main></div>
<script>
const PEOPLE=__PEOPLE__, SP_OTHER=__SPOTHER__, OW_OTHER=__OWOTHER__, SHORT=__SHORT__, DUPS="__DUPS__";
const SHORTN={"林春源":"春源","洪玉麟":"玉麟","江古月":"古月","黄丽萍":"丽萍"};
const $=s=>document.querySelector(s), esc=s=>s.replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const clock=ms=>{const s=Math.floor(ms/1000);return Math.floor(s/60)+':'+String(s%60).padStart(2,'0')};
const store={get(k){try{return localStorage.getItem(k)}catch(e){return null}},set(k,v){try{localStorage.setItem(k,v)}catch(e){}}};
let KEY='', ME=null, M=null, U=[], L={}, cur=0, audio=new Audio(), cont=false, saveTimer=null, dirty=false;
const hash=new URLSearchParams(location.hash.slice(1));
if(hash.get('k')){KEY=hash.get('k');store.set('oops-label-key',KEY);history.replaceState(null,'',location.pathname+location.search)} else KEY=store.get('oops-label-key')||'';
let WHO=store.get('oops-label-who')||'';
const api=(p,o={})=>fetch(p.replace(/^\//,''),{...o,headers:{...(o.headers||{}),Authorization:'Bearer '+KEY,...(WHO?{'X-Labeler':encodeURIComponent(WHO)}:{})}});
const shortRow=u=>u.end_ms-u.start_ms<SHORT;
const complete=(l,u)=>!!(l&&l.kind&&(l.speaker||u.voice||shortRow(u))&&(l.kind!=='task'||l.owner));
const whoOpen=u=>!isMini(u)&&!u.voice&&!(L[u.id]||{}).speaker;
function chip(k,v,label,on,cls=''){return `<button class="c ${cls} ${on?'on':''}" data-k="${k}" data-v="${v}">${label}</button>`}
const isMini=u=>u.chars<10;const OPEN=new Set();
function rowHTML(u,i){const l=L[u.id]||{};
  if(isMini(u)&&!OPEN.has(u.id)&&!Object.keys(l).length)return `<div class="row mini ${i===cur?'cur':''}" data-i="${i}" id="r-${u.id}"><div class="top"><span class="t">${clock(u.start_ms)}</span><div class="txt">${esc(u.text)}</div><button class="c" data-open="1">标</button><button class="play" data-play="1">▶</button></div></div>`;
  const vp=!l.speaker&&u.voice;
  const sp=PEOPLE.map(p=>chip('speaker',p,SHORTN[p],l.speaker===p||(vp&&u.voice===p),vp&&u.voice===p?'vp':'')).join('')+chip('speaker','multi','多人',l.speaker==='multi')+chip('speaker','unclear','听不清',l.speaker==='unclear');
  const kd=chip('kind','task','任务',l.kind==='task')+chip('kind','decision','决定',l.kind==='decision','dec')+chip('kind','info','有效',l.kind==='info','inf')+chip('kind','noise','无效',l.kind==='noise','neg');
  const ow=l.kind==='task'?`<span class="grp"><span>负责人</span>${PEOPLE.map(p=>chip('owner',p,SHORTN[p],l.owner===p)).join('')}${chip('owner','collective','大家',l.owner==='collective')}${chip('owner','unknown','不确定',l.owner==='unknown')}</span>`:'';
  const dp=(l.kind==='task'||l.kind==='decision')?`<span class="grp"><span>同一件事</span><select class="tool" data-k="dup"><option value="">—</option>${DUPS.split('').map(c=>`<option ${l.dup===c?'selected':''}>${c}</option>`).join('')}</select></span>`:'';
  return `<div class="row ${complete(l,u)?'done':''} ${l.kind?'k-'+l.kind:''} ${i===cur?'cur':''}" data-i="${i}" id="r-${u.id}">
   <div class="top"><span class="t">${clock(u.start_ms)}</span><div class="txt">${esc(u.text)}</div><button class="play" data-play="1">▶</button></div>
   <div class="ctl"><span class="grp"><span>谁说的</span>${sp}${vp?'<em class="vpnote">声纹已填，错了再改</em>':''}</span><span class="grp"><span>类型</span>${kd}</span>${ow}${dp}</div></div>`}
function visible(u){const f=$('#filter').value,l=L[u.id]||{};return f==='all'||(f==='todo'&&!isMini(u)&&!complete(l,u))||(f==='who'&&whoOpen(u))||(f==='marked'&&(l.kind==='task'||l.kind==='decision'))}
function renderList(){const html=U.map((u,i)=>visible(u)?rowHTML(u,i):'').join('');$('#list').innerHTML=html||'<div class="empty">没有符合条件的句子</div>';renderProg()}
function renderRow(i){const el=document.getElementById('r-'+U[i].id);if(!el)return;const tmp=document.createElement('div');tmp.innerHTML=rowHTML(U[i],i);const n=tmp.firstElementChild;if(el.classList.contains('playing'))n.classList.add('playing');el.replaceWith(n)}
function renderProg(){let done=0,t=0,d=0;const need=U.filter(u=>!isMini(u)).length;U.forEach(u=>{const l=L[u.id];if(!isMini(u)&&complete(l,u))done++;if(l&&l.kind==='task')t++;if(l&&l.kind==='decision')d++});
  const who=U.filter(whoOpen).length;$('#prog').textContent=`说话人待定 ${who} 句 · 长句已标 ${done}/${need}（${Math.round(done*100/Math.max(1,need))}%）· 任务 ${t} · 决定 ${d}`;
  const tab=document.querySelector(`#tabs button[data-m="${M}"] small`);if(tab)tab.textContent=` ${Math.round(done*100/Math.max(1,need))}%`}
function setCur(i,scroll=true){if(i<0||i>=U.length)return;const old=cur;cur=i;renderRow(old);renderRow(i);store.set('oops-label-cur-'+M,String(i));
  const el=document.getElementById('r-'+U[i].id);if(el&&scroll)el.scrollIntoView({block:'nearest',behavior:'smooth'})}
function setField(i,k,v){const u=U[i],l=L[u.id]=L[u.id]||{};l[k]=(l[k]===v||v==='')?undefined:v;
  if(l.kind!=='task')delete l.owner;if(l.kind!=='task'&&l.kind!=='decision')delete l.dup;Object.keys(l).forEach(x=>l[x]===undefined&&delete l[x]);if(!Object.keys(l).length)delete L[u.id];
  renderRow(i);renderProg();queueSave()}
function queueSave(){dirty=true;store.set('oops-label-draft-'+M,JSON.stringify(L));$('#state').className='mut';$('#state').textContent='保存中…';clearTimeout(saveTimer);saveTimer=setTimeout(save,500)}
async function save(){const mid=M,body=JSON.stringify(L);try{const r=await api(`/api/meeting/${mid}/labels`,{method:'POST',headers:{'Content-Type':'application/json'},body});
  if(!r.ok)throw new Error(r.status);if(mid===M){dirty=false;$('#state').textContent='已保存'}}catch(e){$('#state').className='err';$('#state').textContent='保存失败，网络恢复后会自动重试';clearTimeout(saveTimer);saveTimer=setTimeout(save,4000)}}
function play(i,pad){const u=U[i];document.querySelectorAll('.row.playing').forEach(e=>e.classList.remove('playing'));
  audio.pause();audio=new Audio(`clip/${M}/${u.id}.wav?pad=${pad?'':'0'}&k=${encodeURIComponent(KEY)}`);audio.playbackRate=+$('#rate').value;
  const el=document.getElementById('r-'+u.id);if(el)el.classList.add('playing');
  audio.onended=()=>{if(el)el.classList.remove('playing');if(cont&&i+1<U.length){setCur(i+1);play(i+1,false)}else stopCont()};
  audio.play().catch(()=>stopCont());
  if(i+1<U.length){const n=new Audio(`clip/${M}/${U[i+1].id}.wav?pad=0&k=${encodeURIComponent(KEY)}`);n.preload='auto'}}
function stopCont(){cont=false;$('#cont').classList.remove('on');$('#cont').textContent='▶ 连续播放'}
function toggleCont(){if(cont){cont=false;audio.pause();stopCont();document.querySelectorAll('.row.playing').forEach(e=>e.classList.remove('playing'));return}
  cont=true;$('#cont').classList.add('on');$('#cont').textContent='❚❚ 暂停';play(cur,false)}
$('#list').addEventListener('click',e=>{const row=e.target.closest('.row');if(!row)return;const i=+row.dataset.i;
  if(e.target.dataset.open){OPEN.add(U[i].id);setCur(i,false);renderRow(i);return}
  if(e.target.dataset.play){if(i!==cur)setCur(i,false);stopCont();play(i,true);return}
  if(e.target.classList.contains('c')){if(i!==cur)setCur(i,false);setField(i,e.target.dataset.k,e.target.dataset.v);return}
  if(e.target.classList.contains('txt')&&i!==cur)setCur(i,false)});
$('#list').addEventListener('change',e=>{const row=e.target.closest('.row');if(row&&e.target.dataset.k)setField(+row.dataset.i,e.target.dataset.k,e.target.value)});
$('#filter').addEventListener('change',renderList);$('#cont').addEventListener('click',toggleCont);
$('#rate').addEventListener('change',()=>{audio.playbackRate=+$('#rate').value;store.set('oops-label-rate',$('#rate').value)});
document.addEventListener('keydown',e=>{if(e.target.tagName==='SELECT'||e.metaKey||e.ctrlKey||e.altKey||!U.length)return;const k=e.key.toLowerCase();
  const sp={'1':PEOPLE[0],'2':PEOPLE[1],'3':PEOPLE[2],'4':PEOPLE[3],'5':'multi','0':'unclear'},ow={q:PEOPLE[0],w:PEOPLE[1],e:PEOPLE[2],r:PEOPLE[3],a:'collective'},kd={t:'task',d:'decision',i:'info',n:'noise'};
  if(k==='arrowdown'||k==='j'){e.preventDefault();setCur(nextVisible(cur,1))}else if(k==='arrowup'||k==='k'){e.preventDefault();setCur(nextVisible(cur,-1))}
  else if(k===' '){e.preventDefault();stopCont();play(cur,true)}else if(k==='p'){toggleCont()}
  else if(sp[k])setField(cur,'speaker',sp[k]);else if(kd[k])setField(cur,'kind',kd[k]);else if(ow[k]&&(L[U[cur].id]||{}).kind==='task')setField(cur,'owner',ow[k])});
function nextVisible(i,step){for(let j=i+step;j>=0&&j<U.length;j+=step)if(visible(U[j])&&(!isMini(U[j])||OPEN.has(U[j].id)||L[U[j].id]))return j;return i}
async function openMeeting(mid){if(dirty)await save();stopCont();audio.pause();M=mid;store.set('oops-label-meeting',mid);
  document.querySelectorAll('#tabs button').forEach(b=>b.classList.toggle('on',b.dataset.m===mid));$('#list').innerHTML='<div class="empty">加载中…</div>';
  const r=await api('/api/meeting/'+mid);const d=await r.json();U=d.rows;L=d.labels||{};
  const draft=store.get('oops-label-draft-'+mid);if(draft){try{const x=JSON.parse(draft);if(Object.keys(x).length>Object.keys(L).length){L=x;queueSave()}}catch(e){}}
  cur=Math.min(+(store.get('oops-label-cur-'+mid)||0),U.length-1);renderList();const el=document.getElementById('r-'+U[cur].id);if(el)el.scrollIntoView({block:'center'})}
(async()=>{if(!KEY){$('#gate').hidden=false;return}const r=await api('/api/me');if(!r.ok){$('#gate').hidden=false;return}
  ME=await r.json();
  if(!ME.name){if(WHO){WHO='';store.set('oops-label-who','')}$('#pick').hidden=false;$('#pickers').innerHTML=ME.people.map(p=>`<button data-p="${p}" style="font-size:16px;padding:8px 18px">${p}</button>`).join('');
    $('#pickers').onclick=e=>{const b=e.target.closest('button');if(!b)return;WHO=b.dataset.p;store.set('oops-label-who',WHO);location.reload()};return}
  $('#app').hidden=false;$('#me').innerHTML=esc(ME.name)+(WHO?' <a href="#" id="switch" style="color:var(--brand)">换人</a>':'');
  const sw=document.getElementById('switch');if(sw)sw.onclick=async e=>{e.preventDefault();if(dirty)await save();store.set('oops-label-who','');location.reload()};$('#rate').value=store.get('oops-label-rate')||'1';
  if(store.get('oops-label-help-seen'))$('#help').open=false;else{$('#help').open=true;store.set('oops-label-help-seen','1')}
  $('#tabs').innerHTML=ME.meetings.map(m=>`<button data-m="${m.id}" title="${esc(m.title)} · ${m.minutes} 分钟 · ${m.count} 个长句 · ${Object.entries(m.progress).map(([p,n])=>SHORTN[p]+' '+Math.round(n*100/m.count)+'%').join('，')||'还没人标'}">${m.id}<small> ${Math.round((m.progress[ME.name]||0)*100/m.count)}%</small></button>`).join('');
  $('#tabs').addEventListener('click',e=>{const b=e.target.closest('button');if(b&&b.dataset.m!==M)openMeeting(b.dataset.m)});
  const last=store.get('oops-label-meeting');openMeeting(ME.meetings.some(m=>m.id===last)?last:ME.meetings[0].id)})();
window.addEventListener('hashchange',()=>{if(new URLSearchParams(location.hash.slice(1)).get('k'))location.reload()});
window.addEventListener('beforeunload',e=>{if(dirty){save();e.preventDefault()}});
</script></html>"""


if __name__ == "__main__":
    main()
