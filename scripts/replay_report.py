#!/usr/bin/env python3
"""Render a replay log (replay_meeting.py) as one HTML page: what Oops would have done, minute by minute.

    replay_report.py build/replay-0236.json build/replay-0236.html --title "10月5日 23:01 讨论（0236）"

Questions: the timeline shows the current rule (question_watch), from the log or from --questions. Logs made before
2026-10-12 also carry the old rule (judge 3 minutes later, at most 3 per meeting), kept for comparison in the summary.
Findings are written by hand into FINDINGS for each replay; everything else is computed from the log.
"""
import argparse
import html
import json

AUTO_RESEARCH_PER_MEETING = 3
TAGS = {"commitment": "待办", "decision": "决定", "idea": "想法", "constraint": "约束", "chitchat": "寒暄", "uncertain": "待判断"}


def research_plan(events):
    """Each question event → what the bot does with it under the current rule."""
    sent, out = 0, {}
    for e in sorted((e for e in events if e["kind"] == "question" and "judged_at_ms" in e), key=lambda e: e["judged_at_ms"]):
        a = e.get("answer") or {}
        if a.get("answered"):
            status = "answered"
        elif not a.get("worth"):
            status = "skip"
        elif sent < AUTO_RESEARCH_PER_MEETING:
            sent += 1
            status = "research"
        else:
            status = "capped"
        out[e["id"]] = dict(status=status, question=a.get("question", ""), judged_at_ms=e["judged_at_ms"])
    return out


def build(log, title, findings, questions=None):
    rows = log["utterances"]
    events = log["events"]
    tag = {e["id"]: e for e in events if e["kind"] == "tag"}
    tasks = {e["id"]: e["tasks"] for e in events if e["kind"] == "task"}
    old = research_plan(events)
    if questions is None:
        questions = [e for e in events if e["kind"] == "question" and "final" in e]
    plan = {q["id"]: q for q in questions if q["status"] != "skip"}
    minutes = next((e["minutes"] for e in events if e["kind"] == "minutes"), {})
    latencies = sorted(e["latency_ms"] for e in tag.values())
    counts = {}
    for e in tag.values():
        counts[e["tag"]] = counts.get(e["tag"], 0) + 1
    timeline = []
    for u in rows:
        t = tag.get(u["id"], {})
        timeline.append(dict(id=u["id"], start=u["start_ms"], end=u["end_ms"], speaker=u.get("speaker"), text=u["text"],
                             tag=t.get("tag"), prob=t.get("prob"), clause=t.get("task_clause"),
                             tasks=tasks.get(u["id"]), research=plan.get(u["id"])))
    data = dict(title=title, timeline=timeline, minutes=minutes, counts=counts, tags=TAGS,
                p50=latencies[len(latencies) // 2] if latencies else None,
                questions=len(old), old_research=[k for k, v in old.items() if v["status"] == "research"],
                research=[k for k, v in plan.items() if v["final"] in ("release", "research_late")],
                quick=[k for k, v in plan.items() if v["final"] == "quick"],
                speakers=sum(1 for u in rows if u.get("speaker")), findings=findings)
    return PAGE.replace("__TITLE__", html.escape(title)).replace("__DATA__", json.dumps(data, ensure_ascii=False).replace("</", "<\\/"))


FINDINGS = [
    {"level": "critical", "title": "有效、无效分不开",
     "body": "74 段里 59 段被标成「想法」，只有 5 段算寒暄。手机按 20 秒左右一段送去判断，一段里常常既有闲聊又有正事，"
             "所以几乎都落到「想法」。纪要靠模型自己挑重点，句子分类没有起到筛选作用。",
     "fix": "改成按句判断（标注页已经拆好句子），并用团队标注的「有效 / 无效」校准。"},
    {"level": "good", "title": "查资料：已改并上线（10 月 12 日）",
     "body": "原规则把 28 段像问题的话里 3 段派去查，其中两段是同一个问题，另一段只是在举例。这场会是在讨论 Oops 该怎么做，"
             "很多「问题」其实是举例，比如 13 分钟左右「你们价格大概成本至少现在是多少」是在描述助手会帮你查什么，不是真的在问。"
             "新规则只挑出 3 个真问题：现成的声纹识别方案、有没有工具已经做到从对话到执行的闭环（这两个立刻在后台查，没人答就推送），"
             "以及 AI 怎么自动发现会上的问题（不太紧急，等了 90 秒，会上有人接着讲清楚了，就不查）。同一问题的第二种问法自动合并。",
     "fix": "问题一出现就判断；要紧的立刻在后台查好，等 90 秒没人答再推送，有人答了就只附在纪要里；概念类问题直接由模型简答，不占搜索次数。"},
    {"level": "warn", "title": "任务：抓到 1 个真任务，误报 1 个",
     "body": "4 段被标成待办，模型补出 2 个任务草稿。21:52「你赶快去多玩玩 CoT」是真的布置；7:35「你来再帮我们提提问题」"
             "是在举例说明产品会怎么用，不是要谁去做。所有任务都没有负责人，因为这场只有 24 段能靠声纹认出是谁说的。",
     "fix": "任务判断也要分清「举例、设想」和「真的布置」；古月、丽萍重新录声纹，让负责人能自动填上。"},
    {"level": "good", "title": "纪要可以直接当思维导图骨架",
     "body": "会后纪要给出 1 个决定、2 个待办、4 个议题（每个 3 条要点）和 2 个待查问题，内容基本对得上讨论。"
             "议题和要点就是思维导图的分支和叶子，每条都能回指原话。",
     "fix": "用团队标注检查有没有漏掉重要的「有效」内容，再把纪要直接渲染成导图。"},
]


PAGE = r"""<title>0236 回放报告</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Noto+Sans+SC:wght@400;500;700&family=JetBrains+Mono:wght@400;600&display=swap">
<style>
/* Layout: a summary band, findings as a short list, then the meeting as a time ruler with Oops actions inline, and the minutes as a tree. */
:root{--bg:#f7f6fb;--panel:#ffffff;--fg:#1d1a2b;--mut:#6c6880;--line:#e3e0ee;--brand:#6d5be8;--brand-soft:#ece9ff;
--good:#15803d;--good-soft:#e3f5e8;--warn:#b45309;--warn-soft:#fdf0dc;--bad:#c2410c;--bad-soft:#fde7dc;
--sans:"Noto Sans SC",system-ui,-apple-system,"PingFang SC",sans-serif;--mono:"JetBrains Mono",ui-monospace,Menlo,monospace}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#15131d;--panel:#1e1b29;--fg:#efedf7;--mut:#a29db6;--line:#322e42;--brand:#9a8cff;--brand-soft:#2b2648;
--good:#4ade80;--good-soft:#173322;--warn:#fbbf24;--warn-soft:#3a2c10;--bad:#fb923c;--bad-soft:#3b2214;color-scheme:dark}}
:root[data-theme="dark"]{--bg:#15131d;--panel:#1e1b29;--fg:#efedf7;--mut:#a29db6;--line:#322e42;--brand:#9a8cff;--brand-soft:#2b2648;
--good:#4ade80;--good-soft:#173322;--warn:#fbbf24;--warn-soft:#3a2c10;--bad:#fb923c;--bad-soft:#3b2214;color-scheme:dark}
*{box-sizing:border-box}
body{background:var(--bg);color:var(--fg);font:15px/1.65 var(--sans);margin:0}
.wrap{max-width:1040px;margin:0 auto;padding-inline:20px;padding-block:28px 64px;display:grid;gap:36px}
h1{font-size:26px;line-height:1.3;margin:0;text-wrap:balance}h2{font-size:19px;margin:0 0 12px;text-wrap:balance}
.eyebrow{font:600 12px var(--mono);letter-spacing:.08em;text-transform:uppercase;color:var(--brand)}
.lede{color:var(--mut);max-width:68ch;margin:6px 0 0}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px}
.stat{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:12px 14px}
.stat b{display:block;font:600 24px var(--mono);font-variant-numeric:tabular-nums}.stat span{color:var(--mut);font-size:13px}
.findings{display:grid;gap:10px}
.finding{display:grid;grid-template-columns:auto 1fr;gap:4px 12px;background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:14px 16px}
.finding .lvl{grid-row:span 3;font:600 11px var(--mono);padding:2px 8px;border-radius:999px;height:fit-content;white-space:nowrap}
.lvl.critical{background:var(--bad-soft);color:var(--bad)}.lvl.warn{background:var(--warn-soft);color:var(--warn)}.lvl.good{background:var(--good-soft);color:var(--good)}
.finding h3{margin:0;font-size:16px}.finding p{margin:0;max-width:72ch}.finding .fix{color:var(--mut);font-size:14px}
.finding .fix::before{content:"改进：";color:var(--brand);font-weight:600}
.bar{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-bottom:12px}
.bar button{font:inherit;font-size:13px;border:1px solid var(--line);background:var(--panel);color:var(--fg);border-radius:999px;padding:4px 12px;cursor:pointer}
.bar button[aria-pressed="true"]{background:var(--brand);border-color:var(--brand);color:#fff}
.bar button:focus-visible{outline:2px solid var(--brand);outline-offset:2px}
.tl{display:grid;gap:0;border-top:1px solid var(--line)}
.ev{display:grid;grid-template-columns:52px 1fr;gap:12px;padding:10px 0;border-bottom:1px solid var(--line)}
.ev .t{font:500 13px var(--mono);color:var(--mut);font-variant-numeric:tabular-nums;padding-top:2px}
.ev .body{min-width:0;display:grid;gap:6px}
.ev .meta{display:flex;flex-wrap:wrap;gap:6px;align-items:center;font-size:12px}
.chip{border-radius:6px;padding:1px 7px;font-size:12px;border:1px solid var(--line);color:var(--mut)}
.chip.commitment,.chip.decision,.chip.constraint{border-color:var(--brand);color:var(--brand);background:var(--brand-soft)}
.chip.chitchat{border-style:dashed}
.who{font-weight:600;font-size:13px}.who.unknown{color:var(--mut);font-weight:400}
.ev .txt{margin:0;max-width:78ch;overflow-wrap:anywhere}
.ev.quiet .txt{color:var(--mut);font-size:14px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.act{border-left:3px solid var(--brand);background:var(--brand-soft);border-radius:0 8px 8px 0;padding:6px 10px;font-size:14px;max-width:78ch}
.act.capped,.act.false{border-color:var(--bad);background:var(--bad-soft)}.act.skip{border-color:var(--line);background:transparent;color:var(--mut)}
.act b{font-weight:600}
.tree{display:grid;gap:14px}
.tree .root{font-weight:700;font-size:16px}.tree .overview{color:var(--mut);max-width:72ch;margin:0}
.branches{display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:12px}
.branch{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:12px 14px;min-width:0}
.branch h4{margin:0 0 6px;font-size:15px}.branch ul{margin:0;padding-left:18px;display:grid;gap:4px;font-size:14px}
.branch.kind h4{color:var(--brand)}
.note{color:var(--mut);font-size:13px;max-width:78ch}
@media (max-width:560px){.ev{grid-template-columns:44px 1fr}.finding{grid-template-columns:1fr}.finding .lvl{grid-row:auto;width:fit-content}}
@media (prefers-reduced-motion:no-preference){.ev{transition:background .15s}}
</style>
<div class="wrap">
  <header><div class="eyebrow">Oops 回放 · 真实会议</div><h1 id="title"></h1>
  <p class="lede">把这场 24 分钟的真实讨论，按手机实际发送的 74 段转写，交给线上同一套后端重新判断一遍（香港服务器上的 Jev 和 DeepSeek，只读，不写飞书）。下面按时间列出 Oops 当时会做什么。说话人来自声纹预填，只覆盖春源和玉麟有把握的段落。</p></header>
  <section class="stats" id="stats" aria-label="概要"></section>
  <section><h2>主要发现</h2><div class="findings" id="findings"></div></section>
  <section><h2>时间线</h2>
    <div class="bar" role="group" aria-label="筛选"><button id="f-act" aria-pressed="true">只看 Oops 有动作的</button><button id="f-all" aria-pressed="false">全部 74 段</button></div>
    <div class="tl" id="timeline"></div>
    <p class="note">「查资料」按 10 月 12 日上线的新规则推算（question_watch）。待办草稿和问题改写来自 DeepSeek，原话由代码核对过。</p></section>
  <section><h2>会后纪要 → 思维导图</h2><div class="tree" id="tree"></div></section>
</div>
<script>
const D=__DATA__;
const $=s=>document.querySelector(s);
const esc=s=>String(s??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const clock=ms=>{const s=Math.floor(ms/1000);return Math.floor(s/60)+':'+String(s%60).padStart(2,'0')};
$('#title').textContent=D.title+' 回放报告';
const n=D.timeline.length, c=D.counts;
$('#stats').innerHTML=[
  [n,'段转写（约 20 秒一段）'],[c.idea||0,'段被判为「想法」'],[(c.commitment||0)+' → '+D.timeline.filter(r=>r.tasks&&r.tasks.length).length,'段待办 → 任务草稿'],
  D.old_research.length?[D.old_research.length+' → '+D.research.length,'自动查资料：原规则 → 新规则']:[D.research.length,'段问题自动去查'],[(D.p50/1000).toFixed(2)+' 秒','每段判断耗时（中位数）'],[D.speakers+' / '+n,'段能认出说话人']
].map(([v,l])=>`<div class="stat"><b>${esc(v)}</b><span>${esc(l)}</span></div>`).join('');
const LV={critical:'需要先改',warn:'要改进',good:'可以用'};
$('#findings').innerHTML=D.findings.map(f=>`<article class="finding"><span class="lvl ${f.level}">${LV[f.level]}</span><h3>${esc(f.title)}</h3><p>${esc(f.body)}</p><p class="fix">${esc(f.fix)}</p></article>`).join('');
const FALSE_POSITIVE=new Set(['u23']);
function actions(r){
  const out=[];
  if(r.tasks&&r.tasks.length) r.tasks.forEach(t=>out.push(`<div class="act ${FALSE_POSITIVE.has(r.id)?'false':''}"><b>待办草稿</b>：${esc(t.what)}${t.due_raw?'（'+esc(t.due_raw)+'）':''} · 负责人：${esc(t.owner_name||'待确认')}${FALSE_POSITIVE.has(r.id)?' · <b>误报</b>：这里是在举例说明产品用法':''}</div>`));
  else if(r.tag==='commitment') out.push(`<div class="act skip">标成待办，但补全时没找到具体要做的事，不出草稿</div>`);
  const q=r.research;
  if(q){
    const at=clock(q.at_ms), later=clock(q.at_ms+90000);
    const say={release:`<b>${at} 立刻在后台查</b>，${later} 仍没人答，推送结果`,research_late:`<b>${later} 没人答，开始查</b>`,
      answered:q.status==='research'?`<b>${at} 立刻在后台查</b>，会上有人答了，结果只附在纪要里`:`${later} 会上有人答了，不查`,
      quick:`<b>${later} 没人答，模型先简答</b>`,over_budget:`${later} 没人答，但本场查资料次数已用完`,repeat:`和 ${esc(q.same_as)} 是同一个问题，合并`}[q.final];
    if(say) out.push(`<div class="act ${['answered','repeat','over_budget'].includes(q.final)?'skip':''}">${say}：${esc(q.question)}</div>`);
  }
  return out;
}
function render(all){
  $('#timeline').innerHTML=D.timeline.map(r=>{
    const acts=actions(r), loud=acts.some(a=>!a.includes('act skip'))||['commitment','decision','constraint'].includes(r.tag);
    if(!all&&!loud) return '';
    return `<div class="ev ${loud?'':'quiet'}"><span class="t">${clock(r.start)}</span><div class="body">
      <div class="meta"><span class="who ${r.speaker?'':'unknown'}">${esc(r.speaker||'未识别')}</span>${r.tag?`<span class="chip ${r.tag}">${esc(D.tags[r.tag]||r.tag)}${r.prob!=null?' '+Math.round(r.prob*100)+'%':''}</span>`:''}<span class="chip">${esc(r.id)}</span></div>
      <p class="txt">${esc(r.text)}</p>${acts.join('')}</div></div>`}).join('');
  $('#f-act').setAttribute('aria-pressed',String(!all));$('#f-all').setAttribute('aria-pressed',String(all));
}
$('#f-act').onclick=()=>render(false);$('#f-all').onclick=()=>render(true);render(false);
const m=D.minutes||{};
const list=(items,f)=>items&&items.length?`<ul>${items.map(x=>`<li>${f(x)}</li>`).join('')}</ul>`:'<ul><li>（无）</li></ul>';
$('#tree').innerHTML=`<div class="root">${esc(D.title)}</div><p class="overview">${esc(m.overview||'')}</p><div class="branches">
  ${(m.topics||[]).map(t=>`<div class="branch"><h4>${esc(t.topic)}</h4>${list(t.points,esc)}</div>`).join('')}
  <div class="branch kind"><h4>决定</h4>${list(m.decisions,d=>esc(d.text))}</div>
  <div class="branch kind"><h4>待办</h4>${list(m.actions,a=>esc(a.task)+(a.owner?'（'+esc(a.owner)+'）':'（负责人待确认）'))}</div>
  <div class="branch kind"><h4>待查问题</h4>${list(m.open_questions,q=>esc(q.question))}</div></div>`;
</script>
"""


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("log")
    p.add_argument("out")
    p.add_argument("--title", required=True)
    p.add_argument("--questions", help="question_watch.py simulate --out file")
    args = p.parse_args()
    with open(args.log, encoding="utf-8") as f:
        log = json.load(f)
    questions = json.load(open(args.questions, encoding="utf-8")) if args.questions else None
    with open(args.out, "w", encoding="utf-8") as f:
        f.write(build(log, args.title, FINDINGS, questions))
    print(args.out)


if __name__ == "__main__":
    main()
