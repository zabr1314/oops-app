/* Independent, page-memory-only Agent experience. No real sender, contract, URL or transport. */
((root) => {
  'use strict';
  if (!/\/roadshow-demo\.html$/.test(root.location?.pathname || '') && root.OOPS_ROADSHOW_DEMO_DOCUMENT !== true) return;
  const clone=v=>v==null?v:JSON.parse(JSON.stringify(v));
  const list=v=>Array.isArray(v)?v:[];
  const esc=v=>String(v ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const uid=p=>p+'-'+root.crypto.randomUUID();
  const statuses={pending_review:'待核对',in_progress:'进行中',demo_completed:'已完成',demo_submitted:'交接已登记',demo_running:'正在整理草稿',demo_replied:'草稿可查看',demo_cancelled:'已取消'};
  const button=(act,label,id='',style='secondary',disabled=false)=>`<button class="button ${style}" type="button" data-raft-act="${esc(act)}" ${id?`data-raft-id="${esc(id)}"`:''} ${disabled?'disabled':''}>${esc(label)}</button>`;
  function create(options={}) {
    const seed=clone(root.OopsRoadshowDemoData || {}),registry=()=>root.OopsRoadshowDemoMemory;
    const memberNames=list(seed.team).map(member=>typeof member==='string'?member:member.name).filter(Boolean);
    const names=memberNames.length?memberNames:['林春源','洪玉麟','江古月','Lydia'];
    const agentIds=['demo-agent-organizer','demo-agent-researcher','demo-agent-mobile','demo-agent-collaborator'];
    const agents=names.map((name,n)=>({id:agentIds[n] || 'demo-agent-member-'+n,name,role:'参与任务整理、讨论与核对'}));
    const rawTasks=list(Array.isArray(seed.tasks)?seed.tasks:seed.tasks?.items);
    const tasks=rawTasks.map((t,n)=>{
      const local=t.local_result;
      const body=typeof local==='string'?local:local?.body ?? local?.content ?? local?.text ?? local?.summary;
      const results=body==null || body===''?[]:[{id:local?.id || 'demo-task-local-result-'+n,
        title:local?.title || (t.what || t.title || '任务')+' · 草稿',body:clone(body),kind:local?.kind || local?.format || '文字草稿',mock:true}];
      return {id:'demo-collaboration-task-'+n,source_task_id:t.id || t.op_id || '',title:t.what || t.title || '待办',
        text:t.detail || t.description || t.quote || '根据讨论上下文准备可核对的草稿。',status:t.demo_status==='demo_completed'?'pending_review':t.demo_status || 'pending_review',
        sourceLabel:t.meeting?.title || t.source_meeting?.title || '相关讨论',owner:t.who || t.owner || '负责人待核对',original:clone(t),replies:[],reviews:[],results,communications:[],mock:true};
    });
    const collaborations=list(seed.collaborations || seed.raft?.handoffs || seed.raft?.tasks);
    collaborations.forEach((c,n)=>{
      const title=c.title || c.task_title || '已有成果与协作记录 '+(n+1);
      const row={id:'demo-existing-collaboration-'+n,source_task_id:c.task_id || c.source_task_id || '',title,text:c.text || c.brief || c.description || '把讨论整理成可查看的成果，并保留上下文。',
        status:'demo_replied',sourceLabel:'协作任务',owner:names[0],agent:agents[n%agents.length].id,replies:[],reviews:[],results:[],communications:[],mock:true};
      row.replies=list(c.messages || c.replies).map((r,i)=>({id:r.id || 'demo-reply-'+n+'-'+i,sender:r.sender_name || (typeof r.sender==='object'?r.sender?.name:r.sender) || r.role || agents[n%agents.length].name,
        text:r.text || r.content || r.message || '已整理一份可核对的草稿。',created_at:r.created_at || '',mock:true}));
      row.results=list(c.results || c.artifacts).map((r,i)=>({id:r.id || 'demo-result-'+n+'-'+i,title:r.title || r.name || '成果草稿',
        body:r.body || r.content || r.text || r.summary || '草稿内容待补充。',kind:r.kind || r.type || '文字草稿',mock:true}));
      row.communications=[...list(c.deliveries).map((d,i)=>({id:d.id || 'demo-existing-delivery-'+n+'-'+i,text:d.label || d.text || '',mock:true})),
        ...list(c.annotations).map((a,i)=>({id:a.id || 'demo-existing-annotation-'+n+'-'+i,text:a.text || a.note || '',mock:true}))].filter(entry=>entry.text);
      row.status=row.replies.length?'demo_replied':'pending_review';
      const existing=row.source_task_id && tasks.find(t=>t.source_task_id===row.source_task_id || t.original?.op_id===row.source_task_id);
      if (existing) {
        existing.agent=row.agent;existing.replies.push(...row.replies);existing.results.push(...row.results);existing.communications.push(...row.communications);existing.status=row.status;
      } else tasks.unshift(row);
    });
    if (!tasks.length) tasks.push({id:'demo-existing-task',title:'整理路演体验与资料入口',text:'汇集体验入口、素材清单与说明，先交草稿再核对。',status:'pending_review',sourceLabel:'协作任务',owner:names[0],replies:[],reviews:[],results:[],communications:[],mock:true});
    const state={active:false,selected:tasks[0]?.id || '',source:null,filter:'all',query:'',detailResult:null,review:null,
      draft:{title:'',text:'',members:[agents[0].id],confirm:false},follow:{text:'',members:[agents[0].id],confirm:false},notice:'',manual:false};
    const timers=new Set();
    const current=()=>tasks.find(t=>t.id===state.selected);
    const redraw=()=>{if(state.active)options.render?.();};
    const notify=message=>{state.notice=message;options.toast?.(message);redraw();};
    const later=(fn,delay)=>{const id=setTimeout(()=>{timers.delete(id);if(state.active)fn();},delay);timers.add(id);};
    const clearTimers=()=>{timers.forEach(clearTimeout);timers.clear();};
    const badge=status=>`<span class="badge ${status==='demo_completed'?'green':status==='pending_review'?'gray':'purple'}">${esc(statuses[status] || '待核对')}</span>`;
    const disclosure=()=>'<section class="card"><h3>围绕任务持续协作</h3><p class="meta">把讨论、处理进展与成果放回同一事项，重要内容由本人核对。</p></section>';
    const memberHtml=(name,selected)=>agents.map(a=>`<label class="check-row"><input type="checkbox" data-raft-field="${name}" data-raft-id="${a.id}" ${selected.includes(a.id)?'checked':''}><span><strong>${esc(a.name)}</strong><small style="display:block">${esc(a.role)}</small></span></label>`).join('');
    const field=(name,label,value,multi=false)=>`<label class="form-field"><span>${esc(label)}</span>${multi?`<textarea rows="4" maxlength="12000" data-raft-field="${name}">${esc(value)}</textarea>`:`<input maxlength="200" data-raft-field="${name}" value="${esc(value)}">`}</label>`;
    function sourceRow(reference) {
      const candidates=registry()?.getCandidates?.() || [];
      let item=candidates.find(t=>t.item_id===reference.item_id && (t.source_meeting?.id===reference.source_meeting_id || t.source_meeting?.id===reference.session_id));
      if (item) return {title:item.title || item.what,text:item.detail || item.what || item.title,owner:item.owner || '负责人待核对',sourceLabel:item.source_meeting?.title || '相关讨论',original:item};
      const m=(registry()?.getMeetings?.() || []).find(m=>m.session_id===reference.session_id);
      item=list(m?.items).find(t=>t.id===reference.item_id);
      if (item) return {title:item.title,text:item.detail || item.title,owner:item.owner_hint || '负责人待核对',sourceLabel:m.title || m.display_title,original:item};
      return {title:'讨论候选的协作草稿',text:'先澄清范围、负责人和时间，再准备一份可核对的草稿。',owner:'负责人待核对',sourceLabel:'相关讨论',original:null};
    }
    function resultBody(row) {
      return ['【'+row.title+' · 草稿】','',
        '目标：'+row.text,'',
        '一、对齐范围','保留当前讨论的目标、条件和未决问题；待核对项不写成既定事实。','',
        '二、准备交付','1. 将相关资料归到当前任务。','2. 标出待本人选择的方案与需要补充的信息。','3. 提供可继续修改的步骤与检查清单。','',
        '三、回到原任务','草稿、处理进展与回复都留在这件任务里，便于本人继续补充、改写和核对。','',
        '核对重点：范围、负责人、截止时间和验收标准。'].join('\n');
    }
    function dispatchDemo(row,agentIds) {
      row.status='demo_submitted';row.agent=agentIds[0] || agents[0].id;
      row.communications.push({id:uid('demo-event'),text:'交接草稿已登记。'});
      state.selected=row.id;state.notice='正在整理任务草稿';redraw();
      later(()=>{row.status='demo_running';row.communications.push({id:uid('demo-event'),text:'正在整理任务上下文。'});redraw();},550);
      later(()=>{
        row.status='demo_replied';row.replies.push({id:uid('demo-reply'),sender:agents.find(a=>a.id===row.agent)?.name || '协作 Agent',
          text:'已准备一份可核对的草稿，范围、负责人和截止时间仍需本人判断。',mock:true});
        row.results.push({id:uid('demo-result'),title:row.title+' · 成果草稿',kind:'文字草稿',body:resultBody(row),mock:true});
        state.notice='回复与草稿已放回这件任务，等待本人核对';redraw();
      },1500);
    }
    function draftHtml() {
      const source=state.source?.row;
      return `<section class="card"><h3>${source?'从会议候选继续':'手写协作任务'}</h3>
        ${source?`<span class="badge gray">原事项仍待本人核对</span><p class="meta">${esc(source.sourceLabel)} · 原负责人 ${esc(source.owner)}</p>`:''}
        ${field('title','任务标题',state.draft.title)}${field('text','任务简报：目标、要求与限制',state.draft.text,true)}
        <h3>选择协作成员</h3>${memberHtml('members',state.draft.members)}
        <label class="check-row"><input type="checkbox" data-raft-field="confirm" ${state.draft.confirm?'checked':''}><span>我已核对任务简报、执行范围和协作成员</span></label>
        ${button('dispatch','交给 Oops','','primary',!state.draft.confirm || !state.draft.title.trim() || !state.draft.text.trim() || !state.draft.members.length)}
        <p class="meta">负责人、期限和成果要求仍可继续核对。</p></section>`;
    }
    function detailHtml(row) {
      if (!row) return '';
      const activeResult=state.detailResult && row.results.find(r=>r.id===state.detailResult);
      return `<section class="card"><div class="card-head"><h2>${esc(row.title)}</h2>${badge(row.status)}</div><p style="white-space:pre-wrap">${esc(row.text)}</p>
        <p class="meta">${esc(row.sourceLabel || '协作任务')} · 负责人 ${esc(row.owner || '待核对')} · 完成由本人验收</p>
        <div class="inline-actions">${button('use','核对简报 / 继续交接',row.id)}${button('thread-open','查看任务讨论',row.id,'quiet')}
        ${row.status==='demo_submitted' || row.status==='demo_running'?button('cancel','取消本次交接',row.id,'quiet'):''}</div></section>
        <section class="card"><h3>处理进展</h3>${row.communications.length?row.communications.map(c=>`<p class="meta">${esc(c.text)}</p>`).join(''):'<p class="meta">任务上下文已保留，可继续核对简报与执行范围。</p>'}</section>
        <section class="card"><h3>回到原任务的回复</h3>${row.replies.length?row.replies.map(r=>`<article class="card" style="background:var(--surface-soft,#f6f3ff)"><span class="badge purple">任务回复</span><p class="meta">${esc(r.sender)}</p><p style="white-space:pre-wrap">${esc(r.text)}</p><div class="inline-actions">${button('review-progress','核对为进展',r.id)}${button('review-artifact','核对为成果',r.id)}</div></article>`).join(''):'<p class="meta">暂未收到这件任务的回复，可继续核对简报。</p>'}</section>
        <section class="card"><h3>成果与可继续修改的草稿</h3>${row.results.length?row.results.map(r=>`<button class="card clickable" type="button" data-raft-act="result-open" data-raft-id="${esc(r.id)}"><span class="badge gray">成果草稿</span><h3>${esc(r.title)}</h3><p class="meta">${esc(r.kind || '文字草稿')} · 查看内容 ${String(r.body || '').length} 字</p></button>`).join(''):'<p class="meta">草稿整理后会放在这里，便于继续查看与修改。</p>'}
        ${activeResult?`<article class="card" style="background:var(--surface-soft,#f6f3ff)"><h3>${esc(activeResult.title)}</h3><pre style="white-space:pre-wrap;overflow-wrap:anywhere;font:inherit;font-size:14px">${esc(typeof activeResult.body==='string'?activeResult.body:JSON.stringify(activeResult.body,null,2))}</pre>${button('result-close','收起成果内容','','quiet')}</article>`:''}</section>
        ${row.reviews.length?`<section class="card"><h3>核对记录</h3>${row.reviews.map(r=>`<span class="badge gray">${r.kind==='artifact'?'成果核对':'进展核对'}</span><p>${esc(r.note)}</p>`).join('')}</section>`:''}
        ${state.review?`<section class="card"><h3>${state.review.kind==='artifact'?'成果核对':'进展核对'}</h3>${field('review-note','核对说明',state.review.note,true)}<label class="check-row"><input type="checkbox" data-raft-field="review-confirm" ${state.review.confirm?'checked':''}><span>我已核对当前内容与说明</span></label>${button('review-save','保存核对','','primary',!state.review.confirm || !state.review.note.trim())}${button('review-cancel','取消','','quiet')}</section>`:''}
        <section class="card"><h3>继续补充</h3>${field('follow-text','补充范围、要求或需要调整的地方',state.follow.text,true)}${memberHtml('follow-members',state.follow.members)}
        <label class="check-row"><input type="checkbox" data-raft-field="follow-confirm" ${state.follow.confirm?'checked':''}><span>我已核对补充内容，继续处理同一任务</span></label>${button('continue','补充到本任务','','primary',!state.follow.confirm || !state.follow.text.trim())}</section>
        <section class="card"><p>收到回复后仍需核对成果，完成由本人验收。</p>${button('complete','标记完成',row.id,'secondary',row.status==='demo_completed')}</section>`;
    }
    function html() {
      const visible=tasks.filter(t=>(state.filter==='all' || (state.filter==='pending_review'?t.status==='pending_review':state.filter==='in_progress'?['in_progress','demo_submitted','demo_running','demo_replied'].includes(t.status):t.status==='demo_completed')) && (!state.query || (t.title+' '+t.text).toLowerCase().includes(state.query.toLowerCase())));
      return `<div class="stack task-list">${disclosure()}<section class="card"><div class="card-head"><h2>Oops 协作群</h2><span class="badge purple">任务协作空间</span></div><p>围绕同一任务保留上下文、处理进展与成果。</p>${button('group-open','查看协作成员','','quiet')}${button('new','新建协作任务','','primary')}${button('refresh','刷新内容','','quiet')}</section>
        ${state.notice?`<div class="notice">${esc(state.notice)}</div>`:''}
        ${state.showMembers?`<section class="card"><h3>协作成员</h3>${agents.map(a=>`<p><strong>${esc(a.name)}</strong><br><span class="meta">${esc(a.role)}</span></p>`).join('')}<p class="meta">围绕当前任务选择协作成员，核对范围后继续。</p></section>`:''}
        ${state.manual || state.source?draftHtml():''}
        <div id="demo-raft-detail">${detailHtml(current())}</div>
        <section class="card"><h3>任务与协作记录</h3><div class="search-input"><input data-raft-field="query" placeholder="搜索任务或成果" value="${esc(state.query)}"></div><div class="inline-actions">${[['all','全部'],['pending_review','待核对'],['in_progress','进行中'],['demo_completed','已完成']].map(([k,label])=>`<button class="chip ${state.filter===k?'selected':''}" type="button" data-raft-act="filter" data-raft-id="${k}">${label}</button>`).join('')}</div></section>
        ${visible.map(t=>`<button class="card clickable" type="button" data-raft-act="select" data-raft-id="${esc(t.id)}"><div class="card-head"><h3>${esc(t.title)}</h3>${badge(t.status)}</div><p class="meta">${esc(t.sourceLabel)} · ${t.replies.length}条任务回复 · ${t.results.length}份草稿</p><p class="meta">${esc(t.text.slice(0,100))}</p></button>`).join('') || '<section class="card"><p>没有符合筛选的任务，可换个条件。</p></section>'}
        ${state.source?'<button class="button quiet" type="button" data-act="back">回到原任务</button>':''}
      </div>`;
    }
    function action(node) {
      const act=node?.getAttribute?.('data-raft-act');if (!act) return false;
      if (node.disabled) return true;
      const id=node.getAttribute('data-raft-id'),row=current();
      if (act==='select' || act==='task-use') {state.selected=id;state.manual=false;state.detailResult=null;state.review=null;redraw();root.document.getElementById('demo-raft-detail')?.scrollIntoView({block:'start'});}
      else if (act==='filter') {state.filter=id;redraw();}
      else if (act==='new') {state.source=null;state.manual=true;state.draft={title:'',text:'',members:[agents[0].id],confirm:false};redraw();}
      else if (act==='use') {const t=tasks.find(t=>t.id===id);if(t){state.selected=t.id;state.manual=true;state.draft={title:t.title,text:t.text,members:[t.agent || agents[0].id],confirm:false};redraw();}}
      else if (act==='dispatch' || act==='compact-dispatch') {
        if(!state.draft.confirm || !state.draft.title.trim() || !state.draft.text.trim() || !state.draft.members.length) return true;
        const target={id:uid('demo-collaboration'),title:state.draft.title.trim(),text:state.draft.text.trim(),owner:'待本人核对',status:'pending_review',sourceLabel:state.source?.row.sourceLabel || '手写任务',replies:[],reviews:[],results:[],communications:[],mock:true};tasks.unshift(target);state.manual=false;state.source=null;state.draft.confirm=false;dispatchDemo(target,[...state.draft.members]);
      } else if (act==='continue' && row) {
        if (!state.follow.confirm || !state.follow.text.trim()) return true;
        row.communications.push({id:uid('demo-follow'),text:'补充：'+state.follow.text.trim()});row.text+='\n补充：'+state.follow.text.trim();state.follow.text='';state.follow.confirm=false;dispatchDemo(row,state.follow.members);
      } else if (act==='result-open') {state.detailResult=id;redraw();}
      else if (act==='result-close') {state.detailResult=null;redraw();}
      else if ((act==='review-progress' || act==='review-artifact') && row) {state.review={replyId:id,kind:act==='review-artifact'?'artifact':'progress',note:'',confirm:false};redraw();}
      else if (act==='review-cancel') {state.review=null;redraw();}
      else if (act==='review-save' && row && state.review?.confirm && state.review.note.trim()) {row.reviews.push({...state.review,note:state.review.note.trim(),id:uid('demo-review'),mock:true});state.review=null;notify('核对内容已更新');}
      else if (act==='complete') {const t=tasks.find(t=>t.id===id);if(t){t.status='demo_completed';t.communications.push({id:uid('demo-complete'),text:'本人已选择完成。'});notify('任务已标记完成');}}
      else if (act==='cancel' && row) {clearTimers();row.status='demo_cancelled';notify('本次交接已取消');}
      else if (act==='group-open') {state.showMembers=!state.showMembers;redraw();}
      else if (act==='thread-open') {if(id)state.selected=id;state.notice='当前为这件任务的讨论与进展';redraw();}
      else if (act==='refresh') {notify('当前协作内容已更新');}
      else notify('当前暂不支持此操作');
      return true;
    }
    function input(node) {
      const fieldName=node?.getAttribute?.('data-raft-field');if(!fieldName) return false;
      if (fieldName==='title' || fieldName==='text') {state.draft[fieldName]=node.value;state.draft.confirm=false;}
      else if (fieldName==='members' || fieldName==='follow-members') {const ids=fieldName==='members'?state.draft.members:state.follow.members,id=node.getAttribute('data-raft-id');const next=node.checked?[...new Set([...ids,id])]:ids.filter(x=>x!==id);if(fieldName==='members'){state.draft.members=next;state.draft.confirm=false;}else{state.follow.members=next;state.follow.confirm=false;}}
      else if (fieldName==='confirm') state.draft.confirm=node.checked;
      else if (fieldName==='follow-text') {state.follow.text=node.value;state.follow.confirm=false;}
      else if (fieldName==='follow-confirm') state.follow.confirm=node.checked;
      else if (fieldName==='review-note' && state.review) state.review.note=node.value;
      else if (fieldName==='review-confirm' && state.review) state.review.confirm=node.checked;
      else if (fieldName==='query') state.query=node.value;
      // Do not redraw text inputs on every keystroke; update only submit/check availability.
      const refreshButtons=()=>{
        const dispatch=root.document.querySelector('[data-raft-act="dispatch"]');if(dispatch)dispatch.disabled=!state.draft.confirm || !state.draft.title.trim() || !state.draft.text.trim() || !state.draft.members.length;
        const follow=root.document.querySelector('[data-raft-act="continue"]');if(follow)follow.disabled=!state.follow.confirm || !state.follow.text.trim();
        const review=root.document.querySelector('[data-raft-act="review-save"]');if(review)review.disabled=!state.review?.confirm || !state.review.note.trim();
      };
      if(fieldName==='query') {const pos=node.selectionStart;redraw();const next=root.document.querySelector('[data-raft-field="query"]');if(next){next.focus();next.setSelectionRange(pos,pos);}}
      else refreshButtons();
      return true;
    }
    return {
      html,action,input,
      receive(type){return type==='raft.result';},
      enter(){state.active=true;redraw();},
      leave(){state.active=false;clearTimers();state.review=null;state.draft.confirm=false;state.follow.confirm=false;},
      reset(){clearTimers();state.source=null;state.manual=false;state.review=null;state.draft.confirm=false;state.follow.confirm=false;state.notice='任务上下文已重置';},
      openSource(reference,returnRoute,mode={}){const row=sourceRow(reference);state.returnRoute=clone(returnRoute);state.source={reference:clone(reference),returnRoute:clone(returnRoute),compact:!!mode.compact,row};state.manual=false;state.draft={title:row.title,text:row.text+'\n\n继续前请核对范围、负责人和时间。',members:[agents[0].id],confirm:false};state.notice='从会议候选继续，请先核对任务简报';return true;},
      openManual(){state.source=null;state.manual=false;state.returnRoute=null;return true;},
      openTask(reference){const id=String(reference || '').replace(/^demo-task:/,'');const row=tasks.find(t=>t.id===id || t.source_task_id===id || t.original?.op_id===id);if(!row)return false;state.selected=row.id;state.manual=false;state.source=null;state.detailResult=null;state.notice='查看任务详情与草稿';return true;},
      sourceReturnRoute(){return state.source?.returnRoute || state.returnRoute?clone(state.source?.returnRoute || state.returnRoute):null;},
      refresh(){notify('当前内容已更新');return Promise.resolve();},
    };
  }
  root.OopsDemoRaft={create};
})(window);
