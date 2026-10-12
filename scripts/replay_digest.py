#!/usr/bin/env python3
"""One page with what Oops produced for several replayed meetings: minutes, decisions, tasks, topics as a mind map,
the questions it handled, and live task drafts, side by side.

    replay_digest.py build/digest.html build/replay-0235.json:"22:18 第一次正式讨论" build/replay-0236.json:"23:01 ..." ...

Next to each replay-<id>.json it also reads, when present, stability-<id>.json (voted minutes, minutes_vote) and
board-<id>.json (the running task list, task_board.py simulate --out).
"""
import os
import html
import json
import sys

STATUS = {"release": "立刻在后台查好，没人答时推送", "research_late": "没人答，会后查", "quick": "没人答，模型先简答",
          "answered": "会上有人答了，不打扰", "over_budget": "值得查，但本场次数已用完"}


def meeting(path, label):
    log = json.load(open(path, encoding="utf-8"))
    rows = log["utterances"]
    ev = log["events"]
    minutes = next((e["minutes"] for e in ev if e["kind"] == "minutes"), {}) or {}
    stability, board_path = path.replace("replay-", "stability-"), path.replace("replay-", "board-")
    if os.path.isfile(stability):
        minutes = json.load(open(stability, encoding="utf-8"))["voted"][0]
    board = json.load(open(board_path, encoding="utf-8"))[-1]["board"] if os.path.isfile(board_path) else []
    questions = [e for e in ev if e["kind"] == "question" and e.get("final") in STATUS]
    repeats = sum(1 for e in ev if e["kind"] == "question" and e.get("final") == "repeat")
    drafts = [(e["id"], t["what"]) for e in ev if e["kind"] == "task" for t in e.get("tasks") or []]
    conflicts = [e for e in ev if e["kind"] == "conflict" and (e.get("result") or {}).get("conflict")]
    text = {u["id"]: u["text"] for u in rows}
    return dict(label=label, minutes_long=round(rows[-1]["end_ms"] / 60000) if rows else 0, finals=len(rows),
                speakers=sum(1 for u in rows if u.get("speaker")), minutes=minutes, repeats=repeats,
                questions=[dict(id=e["id"], status=STATUS[e["final"]], question=e["question"], quote=text[e["id"]][:160]) for e in questions],
                drafts=drafts, board=[t for t in board if t["status"] == "open"],
                closed=[t for t in board if t["status"] != "open"], conflicts=[dict(id=e["id"], text=text[e["id"]][:120], with_=(e["result"] or {}).get("with")) for e in conflicts])


def main():
    out, specs = sys.argv[1], sys.argv[2:]
    data = [meeting(*s.split(":", 1)) for s in specs]
    page = PAGE.replace("__DATA__", json.dumps(data, ensure_ascii=False).replace("</", "<\\/"))
    with open(out, "w", encoding="utf-8") as f:
        f.write(page)
    print(out)


PAGE = r"""<title>10 月 5 日讨论产出</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Noto+Sans+SC:wght@400;500;700&family=JetBrains+Mono:wght@500&display=swap">
<style>
/* Layout: one tab per meeting; inside, the minutes as a mind map first, then what Oops did live. */
:root{--bg:#f7f6fb;--panel:#fff;--fg:#1d1a2b;--mut:#6c6880;--line:#e3e0ee;--brand:#6d5be8;--brand-soft:#ece9ff;--warn:#b45309;--warn-soft:#fdf0dc;
--sans:"Noto Sans SC",system-ui,-apple-system,"PingFang SC",sans-serif;--mono:"JetBrains Mono",ui-monospace,Menlo,monospace}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#15131d;--panel:#1e1b29;--fg:#efedf7;--mut:#a29db6;--line:#322e42;--brand:#9a8cff;--brand-soft:#2b2648;--warn:#fbbf24;--warn-soft:#3a2c10;color-scheme:dark}}
:root[data-theme="dark"]{--bg:#15131d;--panel:#1e1b29;--fg:#efedf7;--mut:#a29db6;--line:#322e42;--brand:#9a8cff;--brand-soft:#2b2648;--warn:#fbbf24;--warn-soft:#3a2c10;color-scheme:dark}
*{box-sizing:border-box}body{background:var(--bg);color:var(--fg);font:15px/1.65 var(--sans);margin:0}
.wrap{max-width:1040px;margin:0 auto;padding-inline:20px;padding-block:28px 64px;display:grid;gap:24px}
h1{font-size:26px;margin:0;text-wrap:balance}h2{font-size:18px;margin:0 0 10px}h3{font-size:15px;margin:0 0 6px}
.eyebrow{font:500 12px var(--mono);letter-spacing:.08em;text-transform:uppercase;color:var(--brand)}
.lede{color:var(--mut);max-width:70ch;margin:6px 0 0}
.tabs{display:flex;gap:8px;flex-wrap:wrap}
.tabs button{font:inherit;border:1px solid var(--line);background:var(--panel);color:var(--fg);border-radius:10px;padding:8px 14px;cursor:pointer;text-align:left}
.tabs button[aria-selected="true"]{border-color:var(--brand);background:var(--brand-soft)}
.tabs button small{display:block;color:var(--mut);font-size:12px}
.tabs button:focus-visible{outline:2px solid var(--brand);outline-offset:2px}
.overview{font-size:16px;max-width:72ch;margin:0}
.facts{display:flex;flex-wrap:wrap;gap:6px 18px;color:var(--mut);font-size:13px;font-variant-numeric:tabular-nums}
.map{display:grid;grid-template-columns:minmax(0,1fr);gap:12px}
.branches{display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:12px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:12px 14px;min-width:0}
.card.key{border-color:var(--brand)}
.card ul{margin:0;padding-left:18px;display:grid;gap:4px;font-size:14px}
.owner{color:var(--brand);font-weight:600}.none{color:var(--mut);font-size:14px;margin:0}
.list{display:grid;gap:8px}
.item{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:10px 14px;display:grid;gap:4px;min-width:0}
.item .st{font-size:12px;color:var(--brand);font-weight:600}.item .q{font-weight:500}.item .quote{color:var(--mut);font-size:13px;overflow-wrap:anywhere}
.note{background:var(--warn-soft);color:var(--fg);border-radius:10px;padding:10px 14px;font-size:14px;max-width:80ch}
.note b{color:var(--warn)}
details summary{cursor:pointer;color:var(--mut);font-size:14px}
</style>
<div class="wrap">
  <header><div class="eyebrow">Oops 回放 · 10 月 5 日晚</div><h1>三段讨论，Oops 的产出</h1>
  <p class="lede">这三段是用 DJI 录音笔录的，当时 Oops 还没上线。下面是把录音交给 Oops 重新跑一遍的结果：会后纪要（独立写 3 次、只保留多数一致的内容）、会上怎么处理提出的问题、实时任务清单（合并草稿并排 P0–P3）。只生成给团队看，没有发到飞书。</p></header>
  <div class="tabs" role="tablist" id="tabs"></div>
  <main id="body" class="list"></main>
</div>
<script>
const D=__DATA__;
const $=s=>document.querySelector(s);
const esc=s=>String(s??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const ul=(xs,f)=>xs&&xs.length?`<ul>${xs.map(x=>`<li>${f(x)}</li>`).join('')}</ul>`:'<p class="none">（无）</p>';
function show(i){
  document.querySelectorAll('#tabs button').forEach((b,j)=>b.setAttribute('aria-selected',String(i===j)));
  const m=D[i], n=m.minutes||{};
  $('#body').innerHTML=`
  <section class="map"><p class="overview">${esc(n.overview||'这一段没有整理出实质内容。')}</p>
    <div class="facts"><span>${m.minutes_long} 分钟</span><span>${m.finals} 段转写</span><span>${m.speakers} 段能认出说话人</span></div>
    <div class="branches">
      <div class="card key"><h3>决定</h3>${ul(n.decisions,d=>esc(d.text))}</div>
      <div class="card key"><h3>待办</h3>${ul(n.actions,a=>(a.owner?`<span class="owner">${esc(a.owner)}</span>：`:'')+esc(a.task)+(a.owner?'':'（负责人待定）')+(a.due?`（${esc(a.due)}）`:''))}</div>
      ${(n.topics||[]).map(t=>`<div class="card"><h3>${esc(t.topic)}</h3>${ul(t.points,esc)}</div>`).join('')}
      <div class="card"><h3>纪要里的待查问题</h3>${ul(n.open_questions,q=>esc(q.question))}</div>
    </div></section>
  <section><h2>会上提出的问题，Oops 怎么处理</h2>
    ${m.repeats?`<p class="none" style="margin-bottom:8px">另有 ${m.repeats} 次是同一问题换个说法，已合并。</p>`:''}
    <div class="list">${m.questions.length?m.questions.map(q=>`<div class="item"><span class="st">${esc(q.status)}</span><span class="q">${esc(q.question)}</span><span class="quote">原话：${esc(q.quote)}</span></div>`).join(''):'<p class="none">没有需要查的问题。</p>'}</div></section>
  ${m.conflicts.length?`<section><h2>可能前后矛盾的说法</h2><div class="list">${m.conflicts.map(c=>`<div class="item"><span class="q">${esc(c.text)}</span>${c.with_?`<span class="quote">之前：${esc(typeof c.with_==='string'?c.with_:(c.with_.text||''))}</span>`:''}</div>`).join('')}</div></section>`:''}
  <section><h2>会上的实时任务清单</h2>
    <p class="none" style="margin-bottom:8px">会上逐条生成了 ${m.drafts.length} 条待办草稿，Oops 边听边合并、排优先级，最后留下 ${m.board.length} 条；只有 P0 会在会上请大家当场确认，其余会后统一处理。</p>
    <div class="branches">${['P0','P1','P2','P3'].map(p=>{const xs=m.board.filter(t=>t.priority===p);return xs.length?`<div class="card ${p==='P0'?'key':''}"><h3>${p}${p==='P0'?' · 会上确认':''}</h3>${ul(xs,t=>(t.owner?`<span class="owner">${esc(t.owner)}</span>：`:'')+esc(t.what))}</div>`:''}).join('')}</div>
    ${m.closed.length?`<details style="margin-top:8px"><summary>会上自动作废或已完成 ${m.closed.length} 条</summary><div class="card" style="margin-top:8px">${ul(m.closed,t=>esc(t.what)+` <span class="none" style="display:inline">· ${esc(t.reason)}</span>`)}</div></details>`:''}
    <details style="margin-top:8px"><summary>原始草稿 ${m.drafts.length} 条</summary><div class="card" style="margin-top:8px">${ul(m.drafts,d=>esc(d[1])+` <span class="none" style="display:inline">· ${esc(d[0])}</span>`)}</div></details></section>`;
}
$('#tabs').innerHTML=D.map((m,i)=>`<button role="tab" aria-selected="false">${esc(m.label)}<small>${m.minutes_long} 分钟 · ${(m.minutes.decisions||[]).length} 个决定 · ${(m.minutes.actions||[]).length} 条待办</small></button>`).join('');
document.querySelectorAll('#tabs button').forEach((b,i)=>b.onclick=()=>show(i));
show(0);
</script>
"""

if __name__ == "__main__":
    main()
