/* REQ-F-014: explicit candidate confirmation, scoped prompts and uncertain-write recovery. */
const todoMatterPlanning = (() => {
  const drawer = document.createElement('dialog');
  drawer.id = 'matterPlanningDrawer';
  drawer.setAttribute('aria-labelledby', 'mpTitle');
  drawer.innerHTML = `
    <div class="mpLayout">
      <header class="mpHeader">
        <div class="mpTop">
          <div class="mpChromeSlot" data-mp-chrome="title"></div>
          <div id="mpTools"></div>
          <div class="mpChromeSlot" data-mp-chrome="close"></div>
        </div>
        <div class="mpChromeSlot" data-mp-chrome="context"></div>
        <nav id="mpSettingsTabs" class="mpSettingsTabs" role="tablist" aria-label="设置分类" hidden></nav>
      </header>
      <div class="mpBody">
        <div class="mpChromeSlot" data-mp-chrome="feedback"></div>
        <section id="mpSplit"></section>
        <section id="mpSettings" hidden>
          <section id="mpChannelsPanel" role="tabpanel" aria-labelledby="mpChannelsTab"></section>
          <section id="mpPromptsPanel" role="tabpanel" aria-labelledby="mpPromptsTab" hidden></section>
        </section>
      </div>
      <footer class="mpFooter"></footer>
    </div>`;
  document.body.append(drawer);
  const q = id => drawer.querySelector('#mp' + id);
  // The storage and model scripts append their native panels before the React startup gate opens.
  const tools = q('Tools'), split = q('Split'), settingsHost = q('Settings'), tabs = q('SettingsTabs');
  const footer = drawer.querySelector('.mpFooter');
  const chrome = Object.fromEntries([...drawer.querySelectorAll('[data-mp-chrome]')].map(slot => [slot.dataset.mpChrome, slot]));
  const drafts = new Map();
  let target = '', mode = 'split', current = null, catalog = [], promptCatalog = [], configId = '', configVersion = 0;
  let serial = 0, processing = false, loading = false, pending = null, typesLoaded = false;
  try { pending = JSON.parse(sessionStorage.getItem('todo.matterPlanningWrite') || 'null'); } catch {}
  const paintRecovery = todoWorkspaceShell.addEntry({id:'matterPlanningRecovery',kind:'text',label:'核对拆解操作',
    hidden:!pending,onClick:()=>{if(!drawer.open)drawer.showModal();void recover()}});
  function remember(value) {
    pending = value; paintRecovery({hidden:!value});
    if (value) sessionStorage.setItem('todo.matterPlanningWrite', JSON.stringify(value));
    else sessionStorage.removeItem('todo.matterPlanningWrite');
  }
  let splitReact, promptReact, shellReact;
  let rowStatus = '', rowSerial = 0, typeLoadFailed = false, shellError = '', activeSettingsTab = 'mpChannelsTab';
  let typeDraft = {name:'', prompt:'', enabled:false};
  const settingsTabs = [
    {id:'mpChannelsTab',panel:'mpChannelsPanel',label:'数据渠道'},
    {id:'mpPromptsTab',panel:'mpPromptsPanel',label:'提示词'},
    {id:'mpStorageTab',panel:'mpStoragePanel',label:'图片存储',open:'image-storage-open'},
    {id:'mpModelTab',panel:'mpModelPanel',label:'大模型',open:'model-settings-open'},
  ];
  function close() { drawer.close(); }
  function enableReactSettingsShell(mount) {
    shellReact = mount(tabs, q('ChannelsPanel'), chrome, openChannelSources);
    paintChrome();
  }
  function paintChrome() {
    const settings=mode==='settings';
    const model={settings,title:settings?'设置':'智能拆解',context:settings?'':get(target)?.name||'',error:shellError};
    shellReact({tabs:settingsTabs,active:activeSettingsTab,onSelect:settingsTab,model,actions:{close}});
  }
  function enableReactPrompts(mount) {
    promptReact = mount(q('PromptsPanel'));
    paintPrompts();
  }
  function enableReactSplit(mount) {
    splitReact = mount(tools, split, footer);
    paintSplit();
  }
  function error(message = '') { shellError=message; paintChrome(); }
  function paintSplit() {
    const locked = processing || loading || !!pending;
    footer.hidden = mode === 'settings' && !pending;
    splitReact({ mode, types:catalog, draft:current, rowStatus, locked, pending:!!pending, processing,
      actions:{ type:changeType, instructions:changeInstructions, generate, edit:toggleCandidate, remove:removeCandidate,
        field:changeCandidate, add:addCandidate, accept:acceptCandidates, recover, retry:retryWrite }, canRetry:canRetryWrite() });
  }
  function paintPrompts() {
    const locked = processing || loading || !!pending;
    promptReact({ types:promptCatalog, selected:configId, draft:typeDraft, locked:locked || !typesLoaded,
      showReload:typeLoadFailed, reloadDisabled:locked,
      actions:{ reload:refreshTypes, add:()=>selectType(null), select:selectType, change:changeTypeDraft, save:saveType } });
  }
  function controls() { paintSplit(); paintPrompts(); }
  function view(next) {
    mode = next;
    split.hidden = tools.hidden = mode !== 'split';
    settingsHost.hidden = tabs.hidden = mode !== 'settings';
    controls(); paintChrome();
  }
  drawer.addEventListener('close', () => {
    if (!drawer.open) { serial++; loading = false; controls(); }
  });
  async function open(id) {
    if (pending) { notify('请先核对上次拆解操作'); return; }
    target = id; view('split'); current = drafts.get(id) || {items:[], manual:false, type:'', instructions:'', changed:false, generation:null};
    drafts.set(id, current); error(); rowStatus = '正在读取…'; drawer.showModal();
    const ticket = ++serial; loading = true; controls();
    try {
      const ctx = await api('/matters/' + encodeURIComponent(id) + '/decomposition');
      if (ticket !== serial || !drawer.open) return;
      if (current.snapshot && current.snapshot !== ctx.snapshot) current.changed = true;
      current.snapshot = ctx.snapshot; current.existing = ctx.events;
      catalog = ctx.types;
      loading = false; renderRows();
      if (!current.generation && !current.items.length) await generate();
      else if (current.changed) error('上下文已变化，请重新生成并核对。');
    } catch (e) { if (ticket === serial) { current = null; rowStatus = ''; error(e.message); } }
    finally { if (ticket === serial) { loading = false; controls(); } }
  }
  function splitLocked() { return !current || !!pending || processing || loading; }
  function changeType(value) {
    if (splitLocked()) return;
    current.type = value; current.manual = !!value; current.changed = true;
    error('类型已修改，请重新生成。'); controls();
  }
  function changeInstructions(value) {
    if (splitLocked()) return;
    current.instructions = value; current.changed = true; controls();
  }
  async function generate() {
    if (processing || loading || pending || !current) return;
    const ticket = ++serial, id = target, draft = current;
    loading = true; error(); rowStatus = '正在生成建议…'; controls();
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
      draft.items = result.suggestions.map(s => ({...s, key:++rowSerial, selected:!ctx.events.some(e => e.name === s.name), duplicate:ctx.events.some(e => e.name === s.name), owner:'',planStart:'',planEnd:''}));
      draft.editing = null;
    } catch (e) { if (ticket === serial) error(e.message); }
    finally { if (ticket === serial) { loading = false; renderRows(); controls(); } }
  }
  function renderRows() {
    if (!current) return;
    rowStatus = '';
    controls();
  }
  function toggleCandidate(index) {
    if (splitLocked() || !current.items[index]) return;
    current.editing = current.editing === index ? null : index; renderRows();
  }
  function removeCandidate(index) {
    if (splitLocked() || !current.items[index]) return;
    current.items.splice(index, 1); current.editing = null; renderRows();
  }
  function changeCandidate(index, field, value) {
    if (splitLocked() || !current.items[index] || !['selected','name','description','owner','planStart','planEnd'].includes(field)) return;
    current.items[index][field] = value; controls();
  }
  function addCandidate() {
    if (splitLocked()) return;
    current.items.push({key:++rowSerial,name:'',description:'',reason:'手动补充',owner:'',planStart:'',planEnd:'',selected:true});
    current.editing = current.items.length-1;
    renderRows();
    split.querySelector('#mpRows [data-field=name]')?.focus();
  }
  function acceptCandidates() {
    if (splitLocked() || current.changed) return;
    const selected = current.items.filter(x => x.selected);
    if (!selected.length || selected.some(x => !x.name.trim() || (x.planStart && x.planEnd && x.planEnd < x.planStart))) { error('名称不能为空，结束日期不能早于开始。'); return; }
    const events = selected.map(x => ({type:'event',parent:target,name:x.name.trim(),description:x.description,owner:x.owner,planStart:x.planStart,planEnd:x.planEnd,status:'notStarted'}));
    write({kind:'events',target,path:'/matters/'+encodeURIComponent(target)+'/decomposition/confirm',method:'POST',body:{operation_id:crypto.randomUUID(),snapshot:current.snapshot,generation_id:current.generation,events}});
  };
  function canRetryWrite() { return !!pending && !pending.acknowledged; }
  function retryWrite() { if (canRetryWrite()) void write(pending); }
  async function write(intent) {
    if (processing || intent.acknowledged) return;
    remember(intent); processing = true; error(); controls();
    let acknowledged = false;
    try {
      const result = await api(intent.path,intent.method,intent.body);
      acknowledged = true;
      remember({...intent, acknowledged:true});
      await saved(intent,result);
    } catch(e) {
      if (!acknowledged && e.status>=400 && e.status<500) remember(null);
      error(acknowledged ? '已收到保存响应，但未能读回结果，请核对结果。' : e.message);
    } finally { processing = false; controls(); }
  }
  async function saved(intent,result) {
    if (intent.kind === 'events') {
      const rows = await api('/items');
      if (!Array.isArray(result.created) || result.created.length !== intent.body.events.length ||
          !result.created.every(x => rows.some(r => r.id === x.id && r.parent === intent.target && r.type === 'event'))) {
        throw Error('创建结果待核对');
      }
      db.items = rows; drafts.delete(intent.target); remember(null); drawer.close(); render(); notify('事件已创建并读回');
    } else {
      const expected = intent.body;
      const id = decodeURIComponent(intent.path.slice('/decomposition/types/'.length));
      const matches = type => type?.id === id && type.version === expected.expected_version + 1 &&
        type.name === expected.name && type.prompt === expected.prompt && type.enabled === expected.enabled;
      const rows = await api('/decomposition/types');
      const latest = Array.isArray(rows) && rows.find(type => type.id === id);
      const superseded = latest && Number.isInteger(latest.version) && latest.version > expected.expected_version + 1;
      if (!matches(result.type) || (!matches(latest) && !superseded)) {
        throw Error('尚未读到已保存的提示词版本，请核对结果。');
      }
      promptCatalog = rows; typesLoaded = true; typeLoadFailed = false; remember(null);
      editType(id);
      notify(superseded ? '已核对原保存结果，当前显示更新版本。' : '提示词配置已保存并读回');
    }
  }
  async function recover() {
    if (!pending || processing) return;
    const intent = pending; processing = true; controls(); error();
    try {
      const result = await api('/event-operations/'+intent.body.operation_id);
      if (!intent.acknowledged) remember({...intent, acknowledged:true});
      await saved(intent,result);
    } catch(e) { error(e.message); }
    finally { processing = false; controls(); }
  }
  async function settings() {
    if (drawer.open) return;
    serial++; loading = false; view('settings'); settingsTab('mpChannelsTab'); error(); drawer.showModal();
    await refreshTypes();
  }
  async function refreshTypes() {
    if (loading || processing || pending) return;
    const ticket = ++serial; loading = true; typesLoaded = false; typeLoadFailed = false; error(); controls();
    try {
      const rows = await api('/decomposition/types');
      if (ticket !== serial || !drawer.open) return;
      promptCatalog = rows; typesLoaded = true;
      editType(rows.some(t => t.id === configId) ? configId : rows[0]?.id);
    } catch(e) { if(ticket===serial){error(e.message);typeLoadFailed=true;} }
    finally { if(ticket===serial){loading=false;controls();} }
  }
  function editType(id) {
    const item = promptCatalog.find(t => t.id === id);
    configId = item?.id || crypto.randomUUID(); configVersion = item?.version || 0;
    typeDraft = {name:item?.name || '', prompt:item?.prompt || '', enabled:item?.enabled ?? true};
    controls();
  }
  function canEditType() { return drawer.open && mode === 'settings' && typesLoaded && !pending && !loading && !processing; }
  function selectType(id) { if (canEditType()) editType(id); }
  function changeTypeDraft(field, value) { if (canEditType()) { typeDraft[field] = value; controls(); } }
  function settingsTab(id, focus = false) {
    if (mode !== 'settings') return;
    const next = settingsTabs.find(tab=>tab.id===id);
    if (!next) return;
    activeSettingsTab = id;
    // Retain panel shells and their form roots; selection only changes visibility.
    for (const {id:tabId,panel} of settingsTabs) drawer.querySelector('#'+panel).hidden = tabId !== id;
    paintChrome();
    if (focus) drawer.querySelector('#'+id)?.focus({preventScroll:true});
    if (next.open) drawer.dispatchEvent(new Event(next.open));
  }
  function openChannelSources() {
    if (!drawer.open || mode!=='settings' || activeSettingsTab!=='mpChannelsTab') return;
    drawer.close();
    $('#sourceDrawer').addEventListener('close', () => todoWorkspaceShell.focus('workspaceSettings'), {once:true});
    void openSources(null);
  }
  function saveType() {
    if (!canEditType() || !configId) return;
    const {enabled} = typeDraft;
    const name = typeDraft.name.trim(), prompt = typeDraft.prompt.trim();
    if (!name || !prompt) { error('请填写类型名称和拆解提示词。'); return; }
    void write({kind:'type',path:'/decomposition/types/'+encodeURIComponent(configId),method:'PUT',body:{
      operation_id:crypto.randomUUID(),expected_version:configVersion,name,prompt,enabled
    }});
  }
  return { open, settings, enableReactSplit, enableReactPrompts, enableReactSettingsShell };
})();
