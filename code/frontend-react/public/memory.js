/* Module memory: explicit confirmation, stale response guards and uncertain-write recovery. */
const todoModuleMemory = (() => {
  const drawer = document.createElement('dialog');
  drawer.id = 'memoryDrawer';
  drawer.setAttribute('aria-labelledby', 'memoryTitle');
  document.body.append(drawer);
  let card = null, target = '', sequence = 0, processing = false, loading = false, configured = false;
  let memoryReact = null, path = '', status = '', message = '';
  let draft = {description:'', aliases:''};
  function enableReact(mount) { memoryReact = mount(drawer); controls(); }
  let intent;
  try { intent = JSON.parse(sessionStorage.getItem('todo.memoryWrite') || 'null'); } catch { intent = null; }
  const paintRecovery=todoWorkspaceShell.addEntry({id:'memoryRecoveryEntry',kind:'text',label:'核对记忆保存',
    hidden:!intent,onClick:()=>open(intent?.module_id)});
  function remember(value) {
    intent = value;
    if (value) sessionStorage.setItem('todo.memoryWrite', JSON.stringify(value));
    else sessionStorage.removeItem('todo.memoryWrite');
    paintRecovery({hidden:!value});
  }
  function controls() {
    const busy = processing || loading;
    const editable = !busy && !!card && !intent;
    const canDisable = editable && !!card.version && card.enabled;
    const canIndex = editable && card.usable && configured;
    memoryReact?.({model:{path,status,error:message,draft,processing:busy,pending:!!intent,editable,canDisable,canIndex},
      actions:{close, refresh, recover, index:generateIndex, save, change:changeDraft}});
  }
  function changeDraft(field, value) {
    if (card && !intent && !processing && !loading) { draft = {...draft,[field]:value}; controls(); }
  }
  function display(value, details) {
    card = value; path = card.path; status = card.status;
    draft = {description:card.description, aliases:card.aliases.join('\n')};
    if (details) {
      configured = details.embedding_configured;
      const labels = {not_indexed:'未生成索引',running:'索引处理中（超时后先核对）',ready:'索引已生成',failed:'索引失败，未重试',unknown:'索引结果未知',stale:'旧索引已失效'};
      status += ' · ' + (labels[details.index_state] || details.index_state);
      if (!configured) status += ' · 向量服务未配置或未授权，精确匹配可用';
    }
    controls();
  }
  const modulePath = id => '/memory/modules/' + encodeURIComponent(id);
  const isCurrent = (ticket,id) => ticket === sequence && target === id && drawer.open;
  function validCard(value,id) {
    return value?.module_id === id && Number.isInteger(value.version) && value.version >= 0 &&
      typeof value.description === 'string' && Array.isArray(value.aliases);
  }
  async function readCard(id) {
    const result = await api(modulePath(id));
    if (!validCard(result?.card,id)) throw Error('未能读回模块记忆。');
    return result;
  }
  async function refresh() {
    if (!target || !drawer.open || loading || processing) return;
    const ticket = ++sequence, id = target;
    loading = true; card = null; message = ''; controls();
    try {
      const result = await readCard(id);
      if (isCurrent(ticket,id)) display(result.card,result);
    } catch (error) {
      if (isCurrent(ticket,id)) message = error.message;
    } finally {
      if (isCurrent(ticket,id)) { loading = false; controls(); }
    }
  }
  function close() { drawer.close(); }
  function open(id) {
    if (!memoryReact || !id || drawer.open || processing) return;
    target = id; card = null; path = ''; status = ''; message = ''; configured = false; loading = false;
    draft = {description:'', aliases:''}; controls();
    if ($('#editor').open) $('#editor').close();
    drawer.showModal(); drawer.querySelector('#memoryClose').focus(); void refresh();
  }
  drawer.addEventListener('close', () => {
    if (drawer.open) return;
    sequence++; loading = false; $('#editModule')?.focus();
  });
  async function save(active) {
    if (!drawer.open || processing || loading || !card || intent || (!active && (!card.version || !card.enabled))) return;
    const aliases = draft.aliases.split('\n').map(x => x.trim()).filter(Boolean);
    if (aliases.length > 20 || aliases.some(x => x.length > 80)) {
      message = '简称最多20个，每个最多80字'; controls(); return;
    }
    const id = target, ticket = sequence;
    const description = draft.description;
    const body = {operation_id:crypto.randomUUID(),expected_version:card.version,scope_version:card.scope_version,description,aliases,enabled:active};
    remember({module_id:id,operation_id:body.operation_id});
    processing = true; message = ''; controls();
    try {
      const saved = await api(modulePath(id), 'PUT', body);
      if (!validCard(saved,id) || saved.version !== body.expected_version + 1 || saved.enabled !== active) {
        throw Error('未能核实已保存的模块记忆。');
      }
      remember(null);
      if (isCurrent(ticket,id)) display(saved);
    } catch (error) {
      if (error.status >= 400 && error.status < 500) remember(null);
      if (isCurrent(ticket,id)) message = error.message + (intent ? '；请先核对保存结果' : '；输入已保留');
    } finally { processing = false; controls(); }
  }
  async function recover() {
    if (!drawer.open || !intent || processing || loading) return;
    const {module_id:id, operation_id:operationId} = intent;
    const ticket = sequence, viewId = target;
    processing = true; message = ''; controls();
    try {
      const receipt = await api('/memory/operations/' + encodeURIComponent(operationId));
      if (!validCard(receipt,id) || !receipt.version) throw Error('回执与待核对模块不匹配。');
      const result = await readCard(id);
      if (result.card.version < receipt.version) throw Error('尚未读到已保存的模块记忆版本。');
      remember(null);
      if (isCurrent(ticket,viewId) && viewId === id) display(result.card,result);
    } catch (error) {
      if (isCurrent(ticket,viewId)) message = error.message + '；保存结果仍待核对';
    } finally { processing = false; controls(); }
  }
  async function generateIndex() {
    if (!drawer.open || processing || loading || !card?.usable || !configured || intent) return;
    const id = target, ticket = sequence, version = card.version;
    processing = true; message = ''; controls();
    try {
      await api(modulePath(id) + '/index', 'POST', {operation_id:crypto.randomUUID(),expected_version:version});
      if (!isCurrent(ticket,id)) return;
      const result = await readCard(id);
      if (isCurrent(ticket,id)) display(result.card,result);
    } catch (error) {
      if (isCurrent(ticket,id)) message = error.message + '；刷新核对索引状态，不会自动重试';
    } finally { processing = false; controls(); }
  }
  return { enableReact, open };
})();
