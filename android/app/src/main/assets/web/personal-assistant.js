/* Private account context. Credentials remain in the native HTTP client. */
(() => {
  'use strict';
  const JOURNAL = 'oops-personal-context-pending-v1';
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const clone = value => JSON.parse(JSON.stringify(value));
  const identifier = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(value);
  const SCENARIOS = ['通用','会议','汇报','写作','研究'];
  const PERSON_KINDS = [['fact','事实'],['preference','偏好'],['background','背景'],['commitment','约定']];
  const defaults = kind => kind === 'profile' ? {name:'',role:'',context:'',scenarios:['通用']} : kind === 'preferences'
    ? {enabled:false,tone:'',answer_length:'',focus:'',avoid:'',context:'',scenarios:['通用']} : {title:'',body:'',category:'background',scenarios:['通用']};
  const normalize = (kind,value) => {
    const result={...defaults(kind),...clone(value || {})};
    if (kind === 'memory' && result.category !== 'person') for (const key of ['person_id','person_name','person_kind']) delete result[key];
    return result;
  };
  const limits = {profile:{name:80,role:160,context:800},preferences:{tone:400,answer_length:80,focus:600,avoid:600,context:800},memory:{title:160,body:2000,category:30}};
  function create({send, render, storage, persistent = () => false, schedule = setTimeout}) {
    let serial = 0, identityKey = null, bindingRevision = null, scope = '', connected = false;
    let data = null, request = null, pending = null, drafts = {}, editing = 'profile:current', tab = 'profile';
    let error = '', message = '', visible = false, awaitingIdentity = false;
    let personFilter = null, suggestedName = '', people = [], manualPeople = new Map();
    const uid = prefix => prefix + '-' + (globalThis.crypto?.randomUUID?.() || Date.now().toString(36) + '-' + (++serial));
    function remember(value) {
      if (!persistent()) return true;
      try { if (value) { const raw=JSON.stringify(value);if(raw.length>24000)throw new Error('journal too large');storage.setItem(JOURNAL,raw); } else storage.removeItem(JOURNAL); return true; }
      catch { error = '当前设备无法保留原操作，请恢复本机存储后再保存。'; return false; }
    }
    function reset() {
      remember(null); data = null; request = null; pending = null; drafts = {}; error = ''; message = '';
      personFilter = null; suggestedName = ''; people = []; manualPeople = new Map();
      identityKey = null; bindingRevision = null; connected = false; awaitingIdentity = false; render();
    }
    function row(kind, id = 'current') {
      return kind === 'memory' ? data?.memories?.find(item => item.id === id) : data?.[kind];
    }
    function draftFor(kind, id = 'current') {
      const key = kind + ':' + id, item = row(kind, id);
      return drafts[key] ||= {kind,id,revision:item?.revision || 0,
        value:normalize(kind,item?.status === 'current' ? item.value : null),confirmed:false,dirty:false,conflict:false,
        sourceBlocked:['needs_review','source_unavailable'].includes(item?.status)};
    }
    function blockDraft(draft) {
      draft.value=defaults(draft.kind);draft.confirmed=false;draft.dirty=false;draft.conflict=true;draft.sourceBlocked=true;
      if(pending?.action==='personal.context.memory'&&pending.payload.memory_id===draft.id){
        pending.sourceBlocked=true;delete pending.payload.value;remember(pending);
      }
    }
    const current = () => editing ? drafts[editing] : null;
    function sendRequest(action, payload = {}) {
      if (!connected || awaitingIdentity) return;
      const requestId = uid('context-read');
      request = {requestId,action,identityKey,bindingRevision}; error = ''; message = '';
      send(action, {...clone(payload),requestId});
      schedule(() => {
        if (request?.requestId !== requestId) return;
        request = null;
        error = pending ? '保存结果尚未确认。请核对原操作；继续时只重试原请求。' : '读取超时，请重新刷新。';
        render();
      }, 20000);
      render();
    }
    function read() { if (!request) sendRequest('personal.context.read'); }
    function identity(key, revision, isConnected, serviceScope) {
      const changed = identityKey !== null && (identityKey !== key || scope !== serviceScope || bindingRevision !== revision);
      if (changed || !isConnected) reset();
      identityKey = key; bindingRevision = revision; connected = isConnected; scope = serviceScope; awaitingIdentity = false;
      if (connected && !pending && persistent()) {
        try {
          const raw = storage.getItem(JOURNAL) || 'null';
          const saved = raw.length <= 24000 ? JSON.parse(raw) : null;
          if (saved && saved.identityKey === key && saved.scope === scope && saved.bindingRevision === revision &&
              identifier(saved.payload?.op_id) && /^personal\.context\.(profile|preferences|memory|delete)$/.test(saved.action)) {
            pending = saved;
            if (saved.action !== 'personal.context.delete') {
              const kind = saved.action.split('.').at(-1), id = kind === 'memory' ? saved.payload.memory_id : 'current';
              drafts[kind + ':' + id] = {kind,id,revision:saved.payload.expected_revision,value:normalize(kind,saved.payload.value),confirmed:false,dirty:!saved.sourceBlocked,conflict:false,sourceBlocked:!!saved.sourceBlocked};
            }
            error = '上次保存结果尚未核实，请先核对原操作。';
          } else if (raw !== 'null') remember(null);
        } catch { remember(null); }
      }
      if (visible && connected) read();
      render();
    }
    function open(options = {}) {
      visible = true; awaitingIdentity = true; data = null; request = null; error = ''; message = '';
      people = (options.people || []).filter(person=>identifier(person.id)&&typeof person.name==='string'&&person.name.trim()).map(person=>({id:person.id,name:person.name.trim()}));
      personFilter = identifier(options.person?.id) ? {id:options.person.id,name:String(options.person.name || '').trim()} : null;
      suggestedName = personFilter ? '' : String(options.person?.name || '').trim();
      if (options.memory || options.person) { tab='memory';editing=null; } else { tab='profile';editing='profile:current'; }
      render();
    }
    function personChoices() {
      const choices=new Map();
      for (const person of people) choices.set(person.id,person);
      for (const memory of data?.memories || []) {
        const value=memory.status==='current'?memory.value:null;
        if (value?.category==='person' && identifier(value.person_id)) choices.set(value.person_id,{id:value.person_id,name:value.person_name?.trim() || '未命名人物'});
      }
      for (const [id,name] of manualPeople) choices.set(id,{id,name:name || '新建人物（待填写称呼）'});
      if (personFilter && !choices.has(personFilter.id)) choices.set(personFilter.id,personFilter);
      return [...choices.values()];
    }
    function validItem(item, kind, id) {
      const value=item?.value;
      const personValid=kind!=='memory'||item?.status!=='current'||(value?.category==='person'
        ? identifier(value.person_id)&&typeof value.person_name==='string'&&value.person_name.length<=80&&PERSON_KINDS.some(([key])=>key===value.person_kind)&&item.source?.kind==='manual'
        : !['person_id','person_name','person_kind'].some(key=>value&&Object.hasOwn(value,key)));
      return personValid && item && item.kind === kind && item.id === id && Number.isSafeInteger(item.revision) && item.revision > 0 &&
        ['current','deleted','needs_review','source_unavailable'].includes(item.status) &&
        (item.status === 'current' ? item.confirmed === true && item.value && typeof item.value === 'object' : item.value == null);
    }
    function receive(type, payload) {
      if (!request || payload.requestId !== request.requestId || request.identityKey !== identityKey) return false;
      if (type === 'error') {
        request = null; error = payload.message || '个人内容暂时不可用。';
        if (['FEISHU_BINDING_CHANGED','PERSONAL_CONTEXT_IDENTITY_CHANGED','FEISHU_NOT_CONNECTED','PERSONAL_SESSION_REQUIRED'].includes(payload.code) || payload.httpStatus === 401 || payload.httpStatus === 403) {
          reset(); error = '个人连接已变化，请重新核对账号后读取。';
        } else if (pending && payload.httpStatus >= 400 && payload.httpStatus < 500 && payload.code !== 'PERSONAL_CONTEXT_OPERATION_CONFLICT') {
          const kind = pending.action.split('.').at(-1), itemKind = kind === 'delete' ? 'memory' : kind;
          const d = drafts[itemKind + ':' + (itemKind === 'memory' ? pending.payload.memory_id : 'current')];
          if (d) { d.confirmed = false; d.conflict = payload.httpStatus === 409;if(payload.code==='PERSONAL_CONTEXT_SOURCE_CHANGED')blockDraft(d); }
          pending = null; remember(null);
        }
        render(); return true;
      }
      if (type !== 'personal.context') return false;
      const active = request;
      if (payload.identity_revision !== bindingRevision) { reset(); error = '账号绑定已变化，已清除旧正文，请重新读取。'; render(); return true; }
      request = null;
      if (active.action === 'personal.context.read') {
        if (!Number.isSafeInteger(payload.context_revision) || !Array.isArray(payload.memories) || payload.memories.length > 200 ||
            payload.profile != null && !validItem(payload.profile,'profile','current') ||
            payload.preferences != null && !validItem(payload.preferences,'preferences','current') ||
            payload.memories.some(item => !item || !identifier(item.id) || !validItem(item,'memory',item.id))) {
          data = null; error = '服务返回的个人内容无法核对，请刷新。'; render(); return true;
        }
        data = clone(payload);
        for (const [key,draft] of Object.entries(drafts)) {
          const latest=row(draft.kind,draft.id);
          if (['needs_review','source_unavailable'].includes(latest?.status)) {blockDraft(draft);continue;}
          if (draft.sourceBlocked && latest?.status==='current') delete drafts[key];
          else if (!draft.dirty && !pending) delete drafts[key];
          else if (!pending && (row(draft.kind,draft.id)?.revision || 0) !== draft.revision) { draft.conflict = true; draft.confirmed = false; }
        }
        draftFor('profile'); draftFor('preferences');
        message = pending ? '已读取当前版本。原保存结果仍需核实。' : '已从当前账号读取最新版本。';
      } else if (pending) {
        const kind = pending.action.split('.').at(-1), itemKind = kind === 'delete' ? 'memory' : kind;
        const id = itemKind === 'memory' ? pending.payload.memory_id : 'current';
        if (!validItem(payload.item,itemKind,id) || payload.operation_revision !== pending.payload.expected_revision + 1) {
          error = '原修改回包无法核对，请继续核对同一操作。'; render(); return true;
        }
        const item = clone(payload.item);
        if (data) { data.context_revision = payload.context_revision; if (itemKind === 'memory') data.memories = [...data.memories.filter(x => x.id !== id),item]; else data[itemKind] = item; }
        const key = itemKind + ':' + id, d = drafts[key];
        const newer = item.revision !== payload.operation_revision;
        if (d) {
          if (['needs_review','source_unavailable'].includes(item.status)) blockDraft(d);
          else if (newer) { d.conflict = true; d.confirmed = false; }
          else drafts[key] = {kind:itemKind,id,revision:item.revision,value:normalize(itemKind,item.status === 'current' ? item.value : null),confirmed:false,dirty:false,conflict:false};
        }
        pending = null; remember(null);
        if (kind === 'delete' && !newer) editing = null;
        message = newer ? '原操作已保存，随后已有其他更新。你的旧稿保留，请对照最新版本重新核对。' : '本人确认的内容已保存到当前账号。';
      }
      render(); return true;
    }
    function input(field, value) {
      const d = current(); if (!d || d.sourceBlocked || request || pending) return;
      if (field === 'confirmed') { d.confirmed = value === true; render(); return; }
      if (field.startsWith('scenario:')) {
        const scenario=field.slice(9);if(!SCENARIOS.includes(scenario))return;
        d.value.scenarios = value ? scenario==='通用'?['通用']:[...(d.value.scenarios || []).filter(x=>x!=='通用'&&x!==scenario),scenario]
          : (d.value.scenarios || []).filter(x=>x!==scenario);
        d.dirty=true;d.confirmed=false;render();return;
      }
      if (d.kind === 'memory' && field === 'category') {
        if (!['background','goal','fact','preference','person'].includes(value)) return;
        if(personFilter && value!=='person')return;
        d.value.category=value;
        if (value==='person') {
          d.value.person_id=personFilter?.id || '';d.value.person_name=personFilter?.name || '';d.value.person_kind='fact';
        } else for (const key of ['person_id','person_name','person_kind']) delete d.value[key];
        d.dirty=true;d.confirmed=false;render();return;
      }
      if (d.kind === 'memory' && d.value.category==='person' && field.startsWith('person_')) {
        if (field==='person_id') {
          const person=personChoices().find(person=>person.id===value);
          if (!person || personFilter && person.id!==personFilter.id) return;
          d.value.person_id=person.id;d.value.person_name=person.name;
        } else if (field==='person_name') {
          d.value.person_name=String(value);if(manualPeople.has(d.value.person_id))manualPeople.set(d.value.person_id,String(value));
          if(personFilter?.id===d.value.person_id)personFilter.name=String(value);
        } else if (field==='person_kind' && PERSON_KINDS.some(([kind])=>kind===value)) d.value.person_kind=value;
        else return;
        d.dirty=true;d.confirmed=false;if(field!=='person_name')render();return;
      }
      if (!Object.hasOwn(defaults(d.kind), field)) return;
      d.value[field] = value; d.dirty = true; d.confirmed = false; error = '';
    }
    function submit(remove = false) {
      const d = current(); if (!d || d.sourceBlocked || !data || request || pending || d.conflict || !d.confirmed) { error = '请先读取最新内容，并明确核对本次修改。'; render(); return; }
      if (d.kind === 'memory' && !remove && (!d.value.title.trim() || !d.value.body.trim())) { error = '请填写记忆标题和内容。'; render(); return; }
      if (d.kind === 'memory' && !remove && d.value.category==='person' &&
          (!identifier(d.value.person_id)||!d.value.person_name?.trim()||!PERSON_KINDS.some(([kind])=>kind===d.value.person_kind))) {
        error='请明确选择人物档案、填写称呼，并核对记忆类型。';render();return;
      }
      if (!remove && (!Array.isArray(d.value.scenarios) || !d.value.scenarios.length)) { error = '请明确选择至少一个适用场景。';render();return; }
      const payload = {op_id:uid('context-op'),expected_revision:d.revision,
        ...(remove ? {} : {confirmed:true,value:normalize(d.kind,d.value)}),
        ...(d.kind === 'memory' ? {memory_id:d.id,...(remove ? {} : {source:{kind:'manual'}})} : {})};
      const action = 'personal.context.' + (remove ? 'delete' : d.kind);
      const operation = {action,payload,identityKey,bindingRevision,scope};
      if (!remember(operation)) { render(); return; }
      pending = operation; sendRequest(action,payload);
    }
    function action(name, id) {
      if (name === 'refresh') { read(); return; }
      if (name === 'retry') { if (pending && !pending.sourceBlocked && !request) sendRequest(pending.action,pending.payload); return; }
      if (name === 'tab') { tab = id;personFilter=null;suggestedName='';editing = tab === 'memory' ? null : tab + ':current'; if (data && editing) draftFor(tab); render(); return; }
      if (name === 'all-memories') { personFilter=null;suggestedName='';tab='memory';editing=null;render();return; }
      if (name === 'person-select') {
        const person=personChoices().find(person=>person.id===id);if(!person)return;
        personFilter={...person};suggestedName='';tab='memory';editing=null;render();return;
      }
      if (name === 'draft-open') {
        const d=drafts['memory:'+id];if(!d||d.sourceBlocked||pending||request||personFilter&&d.value.person_id!==personFilter.id)return;
        tab='memory';editing='memory:'+id;render();return;
      }
      if (name === 'person-new') {
        if (pending || request || !data) return;
        const existing=current(),reuse=existing?.kind==='memory'&&existing.value.category==='person'&&existing.revision===0&&!personFilter;
        const label=suggestedName || (reuse?existing.value.person_name:'') || '';
        const personId=uid('PERSON');manualPeople.set(personId,label);
        personFilter={id:personId,name:label};suggestedName='';
        tab='memory';const memoryId=reuse?existing.id:uid('MEM');editing='memory:'+memoryId;
        const d=draftFor('memory',memoryId);d.value={...d.value,category:'person',person_id:personId,person_name:personFilter.name,person_kind:'fact'};d.dirty=true;render();return;
      }
      if (name === 'edit' || name === 'new') {
        if (pending || request || !data) return;
        if (name==='edit' && personFilter && row('memory',id)?.value?.person_id!==personFilter.id) return;
        tab = 'memory'; const memoryId = name === 'new' ? uid('MEM') : id; editing = 'memory:' + memoryId;
        const d=draftFor('memory',memoryId);
        if(name==='new' && personFilter)d.value={...d.value,category:'person',person_id:personFilter.id,person_name:personFilter.name,person_kind:'fact'};
        render(); return;
      }
      if (name === 'rebase') {
        const d = current(); if (!d || d.sourceBlocked || pending || !data) return;
        d.revision = row(d.kind,d.id)?.revision || 0; d.conflict = false; d.confirmed = false; message = '修改稿已保留。请对照当前版本，再勾选确认保存。'; render(); return;
      }
      if (name === 'save') submit();
      if (name === 'delete') submit(true);
    }
    const button = (name,label,disabled=false,id='') => `<button class="button secondary" type="button" data-act="personal-context" data-pa-action="${name}" data-id="${esc(id)}" ${disabled?'disabled':''}>${label}</button>`;
    function html() {
      let body = '<p class="meta">只读写当前本人账号的档案、偏好和已确认记忆。刷新读取另一设备的新版本；保存前逐次确认。</p>';
      if (awaitingIdentity) return body + '<p role="status">正在核对个人账号…</p>';
      if (!connected) return body + '<p>请先在「我的飞书」连接本人的账号，再回来读取。</p><button class="button primary" type="button" data-act="feishu-open">连接我的飞书</button>';
      body += `${error?`<p class="error-text" role="alert">${esc(error)}</p>`:''}${message?`<p class="meta" role="status">${esc(message)}</p>`:''}`;
      body += button('refresh','刷新同账号最新内容',!!request);
      if (pending) body += `<section class="card"><h3>原保存操作待核实</h3>${pending.sourceBlocked?`<p>来源已不可用，原请求正文已清除，不再重发。请核实原操作是否保存成功。</p><p class="meta">原操作：${esc(pending.payload.op_id)}</p>`:`<p>继续会使用同一个操作编号和原修改内容，不另建请求。</p>${button('retry','核对并继续原操作',!!request)}`}</section>`;
      if (!data) return body + (request ? '<p role="status">正在读取个人内容…</p>' : '');
      body += `<div class="segmented">${[['profile','档案'],['preferences','偏好'],['memory','记忆']].map(([key,label])=>button('tab',label,!!pending,key)).join('')}</div>`;
      if (tab === 'memory') {
        if(personFilter)body+=`<section class="card"><h3>关于 ${esc(personFilter.name || '待填写称呼的人物')}</h3><p class="meta">私人记录 · 档案 ${esc(personFilter.id)} · 不授予声纹或共享权限</p>${button('all-memories','查看全部个人记忆',!!pending)}</section>`;
        else body+=`<section class="card"><h3>${suggestedName?'先明确是哪一个人':'关于他人的私人记忆'}</h3><p class="meta">${suggestedName?`声音目录中的「${esc(suggestedName)}」尚无稳定人物编号。请明确选择已有档案或新建手工档案；同名不会合并。`:'选择已有稳定人物档案，或新建本人手工档案；无需先录声纹。'}</p>${personChoices().map(person=>button('person-select',`${esc(person.name)} · ${esc(person.id)}`,!!pending,person.id)).join('')}${button('person-new',suggestedName?`为「${esc(suggestedName)}」新建手工档案`:'新建手工人物档案',!!pending)}</section>`;
        const memories=data.memories.filter(item=>item.status!=='deleted'&&(!personFilter||item.value?.category==='person'&&item.value.person_id===personFilter.id));
        const retainedDrafts=Object.values(drafts).filter(draft=>draft.kind==='memory'&&draft.dirty&&(!personFilter||draft.value.category==='person'&&draft.value.person_id===personFilter.id));
        if(retainedDrafts.length)body+=`<section class="card stack"><h3>未保存的修改稿</h3>${retainedDrafts.map(draft=>`<div><strong>${esc(draft.value.title || '未命名草稿')}</strong>${draft.value.category==='person'?`<p class="meta">关于 ${esc(draft.value.person_name || '未命名人物')} · ${esc(draft.value.person_id || '尚未选定档案')}</p>`:''}<p>${esc(draft.value.body)}</p>${button('draft-open','继续核对这份修改稿',!!pending,draft.id)}</div>`).join('')}</section>`;
        body += `<div class="stack">${memories.map(item=>`<section class="card"><h3>${esc(item.value?.title || '依据待核对的记忆')}</h3>${item.value?.category==='person'?`<p class="meta">${esc(item.value.person_name)} · ${esc(PERSON_KINDS.find(([kind])=>kind===item.value.person_kind)?.[1] || '待核对')} · 本人手工记录，不是对方原话</p>`:''}<p>${esc(item.value?.body || '来源已失效，旧正文已隐藏。')}</p><p class="meta">v${item.revision} · ${esc(item.updated_at)}</p>${button('edit','核对或修改',!!pending,item.id)}</section>`).join('')}${!memories.length?'<p class="meta">这个范围还没有已保存的记忆。</p>':''}${button('new',personFilter?'添加关于此人的私人记忆':'添加本人确认的记忆',!!pending)}</div>`;
      }
      const d = current(); if (!d) return body;
      if(d.sourceBlocked)return body+'<p class="error-text">来源当前不可用，旧正文和修改稿已清除。请刷新核对来源后再继续。</p>';
      const locked = !!request || !!pending;
      const labels = {name:'称呼',role:'当前角色',context:'适用背景',enabled:'允许使用这些个人内容',tone:'回答方式',answer_length:'回答长度',focus:'当前关注',avoid:'个人边界',title:'记忆标题',body:'记忆内容',category:'记忆类型',person_name:'这条记忆里的人物称呼'};
      const fieldNames=d.kind==='memory'?['category',...(d.value.category==='person'?['person_id','person_name','person_kind']:[]),'title','body','scenarios']:Object.keys(defaults(d.kind));
      const fields = fieldNames.map(field => field === 'scenarios' ? `<fieldset><legend>适用场景</legend>${SCENARIOS.map(scenario=>`<label class="toggle-row"><span>${scenario}</span><input type="checkbox" data-pa-field="scenario:${scenario}" ${(d.value.scenarios || []).includes(scenario)?'checked':''} ${locked?'disabled':''}></label>`).join('')}</fieldset>`
        : field === 'enabled' ? `<label class="toggle-row"><span>${labels[field]}</span><input type="checkbox" data-pa-field="enabled" ${d.value.enabled?'checked':''} ${locked?'disabled':''}></label>`
        : field === 'category' ? `<label class="field-label">记忆类型<select class="text-input" data-pa-field="category" ${locked||personFilter?'disabled':''}>${[['background','背景'],['goal','目标'],['fact','事实'],['preference','偏好'],['person','关于某个人']].map(([value,label])=>`<option value="${value}" ${d.value.category===value?'selected':''}>${label}</option>`).join('')}</select></label>`
        : field === 'person_id' ? `<label class="field-label">明确选择人物档案<select class="text-input" data-pa-field="person_id" ${locked||personFilter?'disabled':''}><option value="">先选择人物档案</option>${personChoices().map(person=>`<option value="${esc(person.id)}" ${d.value.person_id===person.id?'selected':''}>${esc(person.name)} · ${esc(person.id)}</option>`).join('')}</select></label><p class="meta">本人手工记录，不是对方原话；只按人物编号关联，不按姓名匹配。</p>${!personFilter?button('person-new','新建手工人物档案',locked):''}`
        : field === 'person_kind' ? `<label class="field-label">关于此人的哪类记忆<select class="text-input" data-pa-field="person_kind" ${locked?'disabled':''}>${PERSON_KINDS.map(([kind,label])=>`<option value="${kind}" ${d.value.person_kind===kind?'selected':''}>${label}</option>`).join('')}</select></label>`
        : `<label class="field-label">${labels[field]}<textarea class="text-input" data-pa-field="${field}" rows="${field==='body'?4:2}" maxlength="${field==='person_name'?80:limits[d.kind][field]}" ${locked?'disabled':''}>${esc(d.value[field])}</textarea></label>`).join('');
      const latest = row(d.kind,d.id);
      return body + `<section class="card stack"><h3>${d.kind==='memory'?'本人确认的记忆':d.kind==='profile'?'我的档案':'我的助理偏好'}</h3><p class="meta">编辑依据 v${d.revision}${latest?` · 服务当前 v${latest.revision}`:''}</p>${d.conflict?`<p class="error-text">其他设备已更新。你的修改稿保留，请刷新后对照，不会覆盖最新版本。</p><pre class="meta">${esc(JSON.stringify(latest?.value || {},null,2))}</pre>${button('rebase','已对照最新版本，继续核对我的修改',!data || locked)}`:''}${fields}<label class="toggle-row"><span>我已核对本次内容；保存为本人确认的信息</span><input id="pa-confirm" type="checkbox" data-pa-field="confirmed" ${d.confirmed?'checked':''} ${locked||d.conflict?'disabled':''}></label><button id="pa-save" class="button primary" data-act="personal-context" data-pa-action="save" ${locked||d.conflict||!d.confirmed?'disabled':''}>确认保存到我的账号</button>${d.kind==='memory'&&d.revision?button('delete','确认删除这条记忆',locked||d.conflict||!d.confirmed):''}</section>`;
    }
    return {open,close:()=>{visible=false;},identity,reset,read,receive,input,action,html};
  }
  window.OopsPersonalAssistant = {create};
})();
