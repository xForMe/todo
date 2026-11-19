/* REQ-F-014: explicit candidate confirmation, scoped prompts and uncertain-write recovery. */
(() => {
  const drawer = document.createElement('dialog');
  drawer.id = 'matterPlanningDrawer';
  drawer.setAttribute('aria-labelledby', 'mpTitle');
  drawer.innerHTML = `<div class="mpLayout"><header class="mpHeader"><div class="mpTop"><h2 id="mpTitle">智能拆解</h2><div id="mpTools"><select id="mpType" aria-label="事情类型"></select><button id="mpGenerate">重新生成</button></div><button id="mpClose" aria-label="关闭">关闭</button></div><p id="mpContext"></p><nav id="mpSettingsTabs" class="mpSettingsTabs" role="tablist" aria-label="设置分类" hidden><button id="mpChannelsTab" role="tab" aria-controls="mpChannelsPanel" aria-selected="true">数据渠道</button><button id="mpPromptsTab" role="tab" aria-controls="mpPromptsPanel" aria-selected="false" tabindex="-1">提示词</button></nav></header><div class="mpBody"><div id="mpError" role="alert"></div><section id="mpSplit"><div class="mpToolbar"><details><summary>补充要求</summary><textarea id="mpInstructions" maxlength="2000" rows="2" aria-label="补充要求" placeholder="例如：只拆关键节点"></textarea></details><button id="mpAdd">补充事件</button></div><div id="mpRows"></div></section><section id="mpSettings" hidden><section id="mpChannelsPanel" role="tabpanel" aria-labelledby="mpChannelsTab"><div class="mpChannel"><div><strong>飞书聊天</strong><p>管理聊天来源与读取授权</p></div><button id="mpSource">管理</button></div></section><section id="mpPromptsPanel" role="tabpanel" aria-labelledby="mpPromptsTab" hidden><button id="mpLoadRetry" hidden>重新加载</button><div class="mpConfig"><div class="mpTypeColumn"><div class="mpTypeLabel"><span>事情类型</span><button id="mpNew" type="button" class="quiet" title="新增类型" aria-label="新增类型"><svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg></button></div><nav id="mpTypes" aria-label="事情类型"></nav></div><form id="mpConfigForm"><label>类型名称<input id="mpName" maxlength="40" required></label><label>拆解提示词<textarea id="mpPrompt" maxlength="4000" rows="10" required></textarea></label><div class="mpConfigActions"><label class="mpEnabled"><input id="mpEnabled" type="checkbox">启用</label><button id="mpSave" class="primary">保存配置</button></div></form></div></section></section></div><footer class="mpFooter"><span id="mpCount"></span><button id="mpRecover" hidden>核对结果</button><button id="mpRetry" hidden>重试原操作</button><button id="mpAccept" class="primary">确认创建</button></footer></div>`;
  document.body.append(drawer);
  const q = id => drawer.querySelector('#mp' + id);
  const drafts = new Map();
  let target = '', mode = 'split', current = null, catalog = [], configId = '', configVersion = 0;
  let serial = 0, processing = false, loading = false, pending = null, typesLoaded = false;
  try { pending = JSON.parse(sessionStorage.getItem('todo.matterPlanningWrite') || 'null'); } catch {}
  const recovery = document.createElement('button');
  recovery.id = 'matterPlanningRecovery'; recovery.textContent = '核对拆解操作'; recovery.hidden = !pending;
  recovery.onclick = () => { drawer.showModal(); recover(); };
  $('.workspaceBar').append(recovery);
  function remember(value) {
    pending = value; recovery.hidden = !value;
    if (value) sessionStorage.setItem('todo.matterPlanningWrite', JSON.stringify(value));
    else sessionStorage.removeItem('todo.matterPlanningWrite');
  }
  function error(message = '') { q('Error').textContent = message; q('Error').hidden = !message; }
  function controls() {
    const locked = processing || loading || !!pending;
    drawer.querySelector('.mpFooter').hidden = mode === 'settings' && !pending;
    drawer.querySelectorAll('input,textarea,select').forEach(x => x.disabled = locked);
    q('Generate').disabled = locked || !current;
    q('Add').disabled = locked || !current;
    q('Save').disabled = locked || !configId || !typesLoaded;
    q('Accept').disabled = locked || !current || current.changed || !current.items.some(x => x.selected);
    q('Recover').hidden = !pending; q('Recover').disabled = processing;
    q('Retry').hidden = !pending; q('Retry').disabled = processing;
    q('Count').textContent = mode === 'split' && current ? `已选 ${current.items.filter(x => x.selected).length} / ${current.items.length} 项` : '';
    q('New').disabled = locked || !typesLoaded; q('LoadRetry').disabled = locked;
    q('Types').querySelectorAll('button').forEach(b => b.disabled = locked || !typesLoaded);
    if (mode === 'settings' && !typesLoaded) q('ConfigForm').querySelectorAll('input,textarea').forEach(x => x.disabled = true);
  }
  function view(next) {
    mode = next; q('Split').hidden = mode !== 'split'; q('Settings').hidden = mode !== 'settings';
    q('Tools').hidden = mode !== 'split'; q('Accept').hidden = mode !== 'split';
    q('Title').textContent = mode === 'split' ? '智能拆解' : '设置';
    q('Context').textContent = mode === 'split' ? get(target)?.name || '' : '';
    q('Context').hidden = mode === 'settings'; q('SettingsTabs').hidden = mode !== 'settings';
  }
  q('Close').onclick = () => drawer.close();
  drawer.addEventListener('close', () => { serial++; loading = false; controls(); });
  async function open(id) {
    if (pending) { notify('请先核对上次拆解操作'); return; }
    target = id; view('split'); current = drafts.get(id) || {items:[], manual:false, type:'', instructions:'', changed:false, generation:null};
    drafts.set(id, current); error(); q('Rows').textContent = '正在读取…'; drawer.showModal();
    const ticket = ++serial; loading = true; controls();
    try {
      const ctx = await api('/matters/' + encodeURIComponent(id) + '/decomposition');
      if (ticket !== serial || !drawer.open) return;
      if (current.snapshot && current.snapshot !== ctx.snapshot) current.changed = true;
      current.snapshot = ctx.snapshot; current.existing = ctx.events;
      catalog = ctx.types; fillTypes(); q('Instructions').value = current.instructions;
      loading = false; renderRows();
      if (!current.generation && !current.items.length) await generate();
      else if (current.changed) error('上下文已变化，请重新生成并核对。');
    } catch (e) { if (ticket === serial) { current = null; q('Rows').textContent = ''; error(e.message); } }
    finally { if (ticket === serial) { loading = false; controls(); } }
  }
  function fillTypes() {
    q('Type').innerHTML = '<option value="">自动判断</option>' + catalog.map(t => `<option value="${esc(t.id)}" ${!t.enabled?'disabled':''}>${esc(t.name)}${t.enabled?'':'（停用）'}</option>`).join('');
    q('Type').value = current?.type || '';
  }
  q('Type').onchange = () => { current.type = q('Type').value; current.manual = !!current.type; current.changed = true; error('类型已修改，请重新生成。'); controls(); };
  q('Instructions').oninput = () => { current.instructions = q('Instructions').value; current.changed = true; controls(); };
  async function generate() {
    if (processing || loading || pending || !current) return;
    const ticket = ++serial, id = target, draft = current;
    loading = true; error(); q('Rows').textContent = '正在生成建议…'; controls();
    try {
      const ctx = await api('/matters/' + encodeURIComponent(id) + '/decomposition');
      if (ticket !== serial || !drawer.open) return;
      catalog = ctx.types;
      const result = await api('/matters/' + encodeURIComponent(id) + '/decomposition', 'POST', {
        snapshot:ctx.snapshot, type_id:draft.manual?draft.type:'', instructions:draft.instructions,
      });
      if (ticket !== serial || !drawer.open) return;
      if (!result.suggestions.length) { error('没有新建议，当前编辑已保留。'); return; }
      draft.snapshot = result.snapshot; draft.generation = result.generation_id;
      draft.type = result.basis.type_id; draft.basis = result.basis; draft.changed = false;
      draft.items = result.suggestions.map(s => ({...s, selected:!ctx.events.some(e => e.name === s.name), duplicate:ctx.events.some(e => e.name === s.name), owner:'',planStart:'',planEnd:''}));
      draft.editing = null; fillTypes();
    } catch (e) { if (ticket === serial) error(e.message); }
    finally { if (ticket === serial) { loading = false; renderRows(); controls(); } }
  }
  q('Generate').onclick = generate;
  function renderRows() {
    if (!current) return;
    q('Rows').innerHTML = `<div class="mpCaption">建议事件 · ${current.items.length} 项</div>` + current.items.map((item,i) => `<article class="mpCandidate" data-index="${i}"><div class="mpRow"><input type="checkbox" data-field="selected" aria-label="选择第${i+1}个事件" ${item.selected?'checked':''}><div class="mpCopy"><strong>${esc(item.name)||'未命名事件'}</strong><p>${esc(item.description)||'尚未填写预期结果'}</p>${item.duplicate?'<small class="error">已有同名事件，请修改名称区分本轮行动</small>':''}</div><button data-edit="${i}" title="编辑事件" aria-label="编辑第${i+1}个事件" class="quiet mpIcon"><svg class="icon" viewBox="0 0 24 24"><path d="m15 4 5 5-11 11-6 1 1-6L15 4Zm-2 2 5 5"/></svg></button><button data-remove="${i}" title="舍弃建议" aria-label="舍弃第${i+1}个事件" class="quiet mpIcon"><svg class="icon" viewBox="0 0 24 24"><path d="m6 6 12 12M18 6 6 18"/></svg></button></div>${current.editing===i?`<div class="mpEdit"><label>事件名称<input data-field="name" maxlength="120" value="${esc(item.name)}"></label><label>预期结果<textarea data-field="description" rows="2" maxlength="2000">${esc(item.description)}</textarea></label><div class="mpDates"><label>责任人<input data-field="owner" maxlength="80" value="${esc(item.owner)}"></label><label>开始日期<input type="date" data-field="planStart" value="${esc(item.planStart)}"></label><label>结束日期<input type="date" data-field="planEnd" value="${esc(item.planEnd)}"></label></div><small>${esc(item.reason)}</small><button data-edit="${i}">收起</button></div>`:''}</article>`).join('');
    controls();
  }
  q('Rows').onclick = e => {
    if (pending || processing || loading) return;
    const edit = e.target.closest('[data-edit]'), remove = e.target.closest('[data-remove]');
    if (edit) { const i = Number(edit.dataset.edit); current.editing = current.editing === i ? null : i; renderRows(); }
    if (remove) { current.items.splice(Number(remove.dataset.remove),1); current.editing = null; renderRows(); }
  };
  q('Rows').oninput = e => {
    const card = e.target.closest('[data-index]'), field = e.target.dataset.field;
    if (!card || !field || pending) return;
    current.items[Number(card.dataset.index)][field] = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
    controls();
  };
  q('Add').onclick = () => { if (!current || pending || loading) return; current.items.push({name:'',description:'',reason:'手动补充',owner:'',planStart:'',planEnd:'',selected:true}); current.editing = current.items.length-1; renderRows(); q('Rows').querySelector('[data-field=name]')?.focus(); };
  q('Accept').onclick = () => {
    if (!current || pending || loading || current.changed) return;
    const selected = current.items.filter(x => x.selected);
    if (!selected.length || selected.some(x => !x.name.trim() || (x.planStart && x.planEnd && x.planEnd < x.planStart))) { error('名称不能为空，结束日期不能早于开始。'); return; }
    const events = selected.map(x => ({type:'event',parent:target,name:x.name.trim(),description:x.description,owner:x.owner,planStart:x.planStart,planEnd:x.planEnd,status:'notStarted'}));
    write({kind:'events',target,path:'/matters/'+encodeURIComponent(target)+'/decomposition/confirm',method:'POST',body:{operation_id:crypto.randomUUID(),snapshot:current.snapshot,generation_id:current.generation,events}});
  };
  async function write(intent) {
    if (processing) return;
    remember(intent); processing = true; error(); controls();
    try { const result = await api(intent.path,intent.method,intent.body); await saved(intent,result); }
    catch(e) { if (e.status>=400&&e.status<500) remember(null); error(e.message); }
    finally { processing = false; controls(); }
  }
  async function saved(intent,result) {
    if (intent.kind === 'events') {
      const rows = await api('/items');
      if (!result.created?.every(x => rows.some(r => r.id === x.id))) throw Error('创建结果待核对');
      db.items = rows; drafts.delete(intent.target); remember(null); drawer.close(); render(); notify('事件已创建并读回');
    } else {
      catalog = await api('/decomposition/types'); remember(null);
      if (drawer.open && mode === 'settings') editType(result.type.id);
      notify('提示词配置已保存并读回');
    }
  }
  async function recover() {
    if (!pending || processing) return;
    const intent = pending; processing = true; controls(); error();
    try { const result = await api('/event-operations/'+intent.body.operation_id); await saved(intent,result); }
    catch(e) { error(e.message); }
    finally { processing = false; controls(); }
  }
  q('Recover').onclick = recover; q('Retry').onclick = () => { if (pending) write(pending); };
  async function settings() {
    serial++; loading = false; view('settings'); settingsTab(q('ChannelsTab')); error(); drawer.showModal();
    await refreshTypes();
  }
  async function refreshTypes() {
    const ticket = ++serial; loading = true; typesLoaded = false; q('LoadRetry').hidden = true; error(); controls();
    try { const rows = await api('/decomposition/types'); if(ticket !== serial || !drawer.open)return; catalog = rows; typesLoaded = true; editType(rows.some(t => t.id === configId) ? configId : rows[0]?.id); }
    catch(e) { if(ticket===serial){error(e.message);q('LoadRetry').hidden=false;} }
    finally { if(ticket===serial){loading=false;controls();} }
  }
  function editType(id) {
    const item = catalog.find(t => t.id === id); configId = item?.id || crypto.randomUUID(); configVersion = item?.version || 0;
    q('Types').innerHTML = catalog.map(t => `<button type="button" data-type="${esc(t.id)}" class="${t.id===configId?'active':''}">${esc(t.name)}${t.enabled?'':' · 停用'}</button>`).join('');
    q('Name').value = item?.name || ''; q('Prompt').value = item?.prompt || ''; q('Enabled').checked = item?.enabled ?? true; controls();
  }
  q('Types').onclick = e => { const b = e.target.closest('[data-type]'); if(b&&!pending&&!loading)editType(b.dataset.type); };
  q('New').onclick = () => editType(null); q('LoadRetry').onclick = refreshTypes;
  function settingsTab(activeTab) {
    for (const tab of q('SettingsTabs').querySelectorAll('[role=tab]')) {
      const selected = tab === activeTab;
      drawer.querySelector('#' + tab.getAttribute('aria-controls')).hidden = !selected;
      tab.setAttribute('aria-selected', String(selected));
      tab.tabIndex = selected ? 0 : -1;
    }
    if (activeTab === q('StorageTab')) drawer.dispatchEvent(new Event('image-storage-open'));
    if (activeTab === q('ModelTab')) drawer.dispatchEvent(new Event('model-settings-open'));
  }
  drawer.addEventListener('image-storage-select', () => settingsTab(q('StorageTab')));
  q('SettingsTabs').onclick = e => {
    const tab = e.target.closest('[role=tab]');
    if (tab && tab.id !== 'mpStorageTab') settingsTab(tab);
  };
  q('SettingsTabs').onkeydown = e => {
    if (!['ArrowLeft','ArrowRight','Home','End'].includes(e.key)) return;
    e.preventDefault(); const tabs=[...q('SettingsTabs').querySelectorAll('[role=tab]')], index=tabs.indexOf(document.activeElement);
    const next=e.key==='Home'?0:e.key==='End'?tabs.length-1:(index+(e.key==='ArrowRight'?1:-1)+tabs.length)%tabs.length;
    settingsTab(tabs[next]);tabs[next].focus();
  };
  q('Source').onclick = () => {
    drawer.close();
    $('#sourceDrawer').addEventListener('close', () => settingsButton.focus(), {once:true});
    openSources(null);
  };
  q('ConfigForm').onsubmit = e => { e.preventDefault(); if(pending||processing||loading)return; write({kind:'type',path:'/decomposition/types/'+encodeURIComponent(configId),method:'PUT',body:{operation_id:crypto.randomUUID(),expected_version:configVersion,name:q('Name').value.trim(),prompt:q('Prompt').value.trim(),enabled:q('Enabled').checked}}); };
  const settingsButton = document.querySelector('.sidebarBottom button[onclick]');
  settingsButton.onclick = settings; settingsButton.title = '设置'; settingsButton.innerHTML = settingsButton.querySelector('svg').outerHTML + ' 设置';
  function entry() {
    const host = $('#events'), headers = host?.querySelectorAll('.panelHead');
    if(!headers?.length||host.querySelector('#matterPlanningEntry'))return;
    const button = document.createElement('button'); button.id='matterPlanningEntry'; button.textContent='智能拆解'; button.className='primary'; button.onclick=()=>open(selection.thing);
    button.disabled=!get(selection.thing)||!pendingItem(get(selection.thing));
    const header = headers[headers.length-1], actions = document.createElement('div');
    actions.className = 'matterPlanningActions'; actions.setAttribute('role','group'); actions.setAttribute('aria-label','事件操作');
    actions.append(...header.querySelectorAll(':scope > button'),button); header.append(actions);
  }
  function pendingItem(item) {return ['notStarted','working'].includes(item.status);}
  new MutationObserver(entry).observe($('#events'),{childList:true,subtree:true}); entry(); controls();
})();
