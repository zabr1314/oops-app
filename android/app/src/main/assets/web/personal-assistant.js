/* Private account context. Credentials remain in the native HTTP client. */
(() => {
  'use strict';
  const JOURNAL = 'oops-personal-context-pending-v1';
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const clone = value => JSON.parse(JSON.stringify(value));
  const identifier = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(value);
  const SCENARIOS = ['通用','会议','汇报','写作','研究'];
  const defaults = kind => kind === 'profile' ? {name:'',role:'',context:'',scenarios:['通用']} : kind === 'preferences'
    ? {enabled:false,tone:'',answer_length:'',focus:'',avoid:'',context:'',scenarios:['通用']} : {title:'',body:'',category:'background',scenarios:['通用']};
  const normalize = (kind,value) => ({...defaults(kind),...clone(value || {})});
  const limits = {profile:{name:80,role:160,context:800},preferences:{tone:400,answer_length:80,focus:600,avoid:600,context:800},memory:{title:160,body:2000,category:30}};
  function create({send, render, storage, persistent = () => false, schedule = setTimeout}) {
    let serial = 0, identityKey = null, bindingRevision = null, scope = '', connected = false;
    let data = null, request = null, pending = null, drafts = {}, editing = 'profile:current', tab = 'profile';
    let error = '', message = '', visible = false, awaitingIdentity = false;
    const uid = prefix => prefix + '-' + (globalThis.crypto?.randomUUID?.() || Date.now().toString(36) + '-' + (++serial));
    function remember(value) {
      if (!persistent()) return true;
      try { if (value) { const raw=JSON.stringify(value);if(raw.length>24000)throw new Error('journal too large');storage.setItem(JOURNAL,raw); } else storage.removeItem(JOURNAL); return true; }
      catch { error = '当前设备无法保留原操作，请恢复本机存储后再保存。'; return false; }
    }
    function reset() {
      remember(null); data = null; request = null; pending = null; drafts = {}; error = ''; message = '';
      identityKey = null; bindingRevision = null; connected = false; awaitingIdentity = false; render();
    }
    function row(kind, id = 'current') {
      return kind === 'memory' ? data?.memories?.find(item => item.id === id) : data?.[kind];
    }
    function draftFor(kind, id = 'current') {
      const key = kind + ':' + id, item = row(kind, id);
      return drafts[key] ||= {kind,id,revision:item?.revision || 0,
        value:normalize(kind,item?.status === 'current' ? item.value : null),confirmed:false,dirty:false,conflict:false};
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
              drafts[kind + ':' + id] = {kind,id,revision:saved.payload.expected_revision,value:normalize(kind,saved.payload.value),confirmed:false,dirty:true,conflict:false};
            }
            error = '上次保存结果尚未核实，请先核对原操作。';
          } else if (raw !== 'null') remember(null);
        } catch { remember(null); }
      }
      if (visible && connected) read();
      render();
    }
    function open() { visible = true; awaitingIdentity = true; data = null; request = null; error = ''; message = ''; render(); }
    function validItem(item, kind, id) {
      return item && item.kind === kind && item.id === id && Number.isSafeInteger(item.revision) && item.revision > 0 &&
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
          if (d) { d.confirmed = false; d.conflict = payload.httpStatus === 409; }
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
            payload.memories.some(item => !identifier(item.id) || !validItem(item,'memory',item.id))) {
          data = null; error = '服务返回的个人内容无法核对，请刷新。'; render(); return true;
        }
        data = clone(payload);
        for (const [key,draft] of Object.entries(drafts)) {
          if (!draft.dirty && !pending) delete drafts[key];
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
          if (newer) { d.conflict = true; d.confirmed = false; }
          else drafts[key] = {kind:itemKind,id,revision:item.revision,value:normalize(itemKind,item.status === 'current' ? item.value : null),confirmed:false,dirty:false,conflict:false};
        }
        pending = null; remember(null);
        if (kind === 'delete' && !newer) editing = null;
        message = newer ? '原操作已保存，随后已有其他更新。你的旧稿保留，请对照最新版本重新核对。' : '本人确认的内容已保存到当前账号。';
      }
      render(); return true;
    }
    function input(field, value) {
      const d = current(); if (!d || request || pending) return;
      if (field === 'confirmed') { d.confirmed = value === true; render(); return; }
      if (field.startsWith('scenario:')) {
        const scenario=field.slice(9);if(!SCENARIOS.includes(scenario))return;
        d.value.scenarios = value ? scenario==='通用'?['通用']:[...(d.value.scenarios || []).filter(x=>x!=='通用'&&x!==scenario),scenario]
          : (d.value.scenarios || []).filter(x=>x!==scenario);
        d.dirty=true;d.confirmed=false;render();return;
      }
      if (!Object.hasOwn(defaults(d.kind), field)) return;
      d.value[field] = value; d.dirty = true; d.confirmed = false; error = '';
    }
    function submit(remove = false) {
      const d = current(); if (!d || !data || request || pending || d.conflict || !d.confirmed) { error = '请先读取最新内容，并明确核对本次修改。'; render(); return; }
      if (d.kind === 'memory' && !remove && (!d.value.title.trim() || !d.value.body.trim())) { error = '请填写记忆标题和内容。'; render(); return; }
      if (!remove && (!Array.isArray(d.value.scenarios) || !d.value.scenarios.length)) { error = '请明确选择至少一个适用场景。';render();return; }
      const payload = {op_id:uid('context-op'),expected_revision:d.revision,
        ...(remove ? {} : {confirmed:true,value:clone(d.value)}),
        ...(d.kind === 'memory' ? {memory_id:d.id,...(remove ? {} : {source:{kind:'manual'}})} : {})};
      const action = 'personal.context.' + (remove ? 'delete' : d.kind);
      const operation = {action,payload,identityKey,bindingRevision,scope};
      if (!remember(operation)) { render(); return; }
      pending = operation; sendRequest(action,payload);
    }
    function action(name, id) {
      if (name === 'refresh') { read(); return; }
      if (name === 'retry') { if (pending && !request) sendRequest(pending.action,pending.payload); return; }
      if (name === 'tab') { tab = id; editing = tab === 'memory' ? null : tab + ':current'; if (data && editing) draftFor(tab); render(); return; }
      if (name === 'edit' || name === 'new') { tab = 'memory'; const memoryId = name === 'new' ? uid('MEM') : id; editing = 'memory:' + memoryId; draftFor('memory',memoryId); render(); return; }
      if (name === 'rebase') {
        const d = current(); if (!d || pending || !data) return;
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
      if (pending) body += `<section class="card"><h3>原保存操作待核实</h3><p>继续会使用同一个操作编号和原修改内容，不另建请求。</p>${button('retry','核对并继续原操作',!!request)}</section>`;
      if (!data) return body + (request ? '<p role="status">正在读取个人内容…</p>' : '');
      body += `<div class="segmented">${[['profile','档案'],['preferences','偏好'],['memory','记忆']].map(([key,label])=>button('tab',label,!!pending,key)).join('')}</div>`;
      if (tab === 'memory') body += `<div class="stack">${data.memories.filter(item=>item.status!=='deleted').map(item=>`<section class="card"><h3>${esc(item.value?.title || '依据待核对的记忆')}</h3><p>${esc(item.value?.body || '来源已失效，旧正文已隐藏。')}</p><p class="meta">v${item.revision} · ${esc(item.updated_at)}</p>${button('edit','核对或修改',!!pending,item.id)}</section>`).join('')}${button('new','添加本人确认的记忆',!!pending)}</div>`;
      const d = current(); if (!d) return body;
      const locked = !!request || !!pending;
      const labels = {name:'称呼',role:'当前角色',context:'适用背景',enabled:'允许使用这些个人内容',tone:'回答方式',answer_length:'回答长度',focus:'当前关注',avoid:'个人边界',title:'记忆标题',body:'记忆内容',category:'记忆类型'};
      const fields = Object.keys(defaults(d.kind)).map(field => field === 'scenarios' ? `<fieldset><legend>适用场景</legend>${SCENARIOS.map(scenario=>`<label class="toggle-row"><span>${scenario}</span><input type="checkbox" data-pa-field="scenario:${scenario}" ${(d.value.scenarios || []).includes(scenario)?'checked':''} ${locked?'disabled':''}></label>`).join('')}</fieldset>`
        : field === 'enabled' ? `<label class="toggle-row"><span>${labels[field]}</span><input type="checkbox" data-pa-field="enabled" ${d.value.enabled?'checked':''} ${locked?'disabled':''}></label>`
        : field === 'category' ? `<label class="field-label">记忆类型<select class="text-input" data-pa-field="category" ${locked?'disabled':''}>${[['background','背景'],['goal','目标'],['fact','事实'],['preference','偏好']].map(([value,label])=>`<option value="${value}" ${d.value.category===value?'selected':''}>${label}</option>`).join('')}</select></label>`
        : `<label class="field-label">${labels[field]}<textarea class="text-input" data-pa-field="${field}" rows="${field==='body'?4:2}" maxlength="${limits[d.kind][field]}" ${locked?'disabled':''}>${esc(d.value[field])}</textarea></label>`).join('');
      const latest = row(d.kind,d.id);
      return body + `<section class="card stack"><h3>${d.kind==='memory'?'本人确认的记忆':d.kind==='profile'?'我的档案':'我的助理偏好'}</h3><p class="meta">编辑依据 v${d.revision}${latest?` · 服务当前 v${latest.revision}`:''}</p>${d.conflict?`<p class="error-text">其他设备已更新。你的修改稿保留，请刷新后对照，不会覆盖最新版本。</p><pre class="meta">${esc(JSON.stringify(latest?.value || {},null,2))}</pre>${button('rebase','已对照最新版本，继续核对我的修改',!data || locked)}`:''}${fields}<label class="toggle-row"><span>我已核对本次内容；保存为本人确认的信息</span><input id="pa-confirm" type="checkbox" data-pa-field="confirmed" ${d.confirmed?'checked':''} ${locked||d.conflict?'disabled':''}></label><button id="pa-save" class="button primary" data-act="personal-context" data-pa-action="save" ${locked||d.conflict||!d.confirmed?'disabled':''}>确认保存到我的账号</button>${d.kind==='memory'&&d.revision?button('delete','确认删除这条记忆',locked||d.conflict||!d.confirmed):''}</section>`;
    }
    return {open,close:()=>{visible=false;},identity,reset,read,receive,input,action,html};
  }
  window.OopsPersonalAssistant = {create};
})();
