/* Module memory: explicit confirmation, stale response guards and uncertain-write recovery. */
(() => {
  const drawer = document.createElement('dialog');
  drawer.id = 'memoryDrawer';
  drawer.setAttribute('aria-labelledby', 'memoryTitle');
  drawer.innerHTML = `<div class="drawerHead"><h2 id="memoryTitle">模块记忆</h2><button type="button" id="memoryClose" aria-label="关闭模块记忆">关闭</button></div>
    <p id="memoryPath"></p><p id="memoryState" role="status"></p>
    <form id="memoryForm"><label for="memoryDescription">模块职责</label><textarea id="memoryDescription" maxlength="2000" rows="5"></textarea>
    <label for="memoryAliases">简称（每行一个，最多20个）</label><textarea id="memoryAliases" rows="3" maxlength="1620"></textarea>
    <p class="sourceHint">确认后用于辅助判断工作归属。事件不会自动加入长期记忆。</p>
    <div class="actions"><button class="primary" type="submit" id="memorySave">确认保存</button><button type="button" id="memoryDisable">停用</button></div></form>
    <div class="actions"><button type="button" id="memoryIndex">生成向量索引</button><button type="button" id="memoryRefresh">刷新</button><button type="button" id="memoryRecover">核对保存结果</button></div>
    <p id="memoryError" role="alert"></p>`;
  document.body.append(drawer);
  const entry = document.createElement('button');
  entry.type = 'button'; entry.textContent = '模块记忆'; entry.hidden = true;
  entry.id = 'moduleMemoryEntry';
  $('#editor .actions').prepend(entry);
  const previous = openForm;
  openForm = function(type, id) { previous(type, id); entry.hidden = type !== 'module' || !id; };
  const find = id => drawer.querySelector('#' + id);
  let card = null, target = '', sequence = 0, processing = false, configured = false;
  let intent;
  try { intent = JSON.parse(sessionStorage.getItem('todo.memoryWrite') || 'null'); } catch { intent = null; }
  const recovery = document.createElement('button');
  recovery.id = 'memoryRecoveryEntry';
  recovery.type = 'button'; recovery.textContent = '核对记忆保存'; recovery.hidden = !intent;
  $('.workspaceBar').append(recovery);
  function remember(value) {
    intent = value;
    if (value) sessionStorage.setItem('todo.memoryWrite', JSON.stringify(value));
    else sessionStorage.removeItem('todo.memoryWrite');
    recovery.hidden = !value;
  }
  function controls() {
    find('memorySave').disabled = processing || !card || !!intent;
    find('memoryDisable').disabled = processing || !card?.version || !card?.enabled || !!intent;
    find('memoryIndex').disabled = processing || !card?.usable || !configured || !!intent;
    find('memoryRefresh').disabled = processing;
    find('memoryRecover').hidden = !intent;
    find('memoryRecover').disabled = processing;
    find('memoryDescription').disabled = processing || !!intent || !card;
    find('memoryAliases').disabled = processing || !!intent || !card;
  }
  function display(value) {
    card = value; find('memoryPath').textContent = card.path;
    find('memoryDescription').value = card.description;
    find('memoryAliases').value = card.aliases.join('\n');
    find('memoryState').textContent = card.status;
    controls();
  }
  async function refresh() {
    const ticket = ++sequence, id = target;
    card = null; controls(); find('memoryError').textContent = '';
    try {
      const result = await api('/memory/modules/' + encodeURIComponent(id));
      if (ticket !== sequence || target !== id || !drawer.open) return;
      configured = result.embedding_configured;
      display(result.card);
      const labels = {not_indexed:'未生成索引',running:'索引处理中（超时后先核对）',ready:'索引已生成',failed:'索引失败，未重试',unknown:'索引结果未知',stale:'旧索引已失效'};
      find('memoryState').textContent += ' · ' + (labels[result.index_state] || result.index_state);
      if (!configured) find('memoryState').textContent += ' · 向量服务未配置或未授权，精确匹配可用';
    } catch (error) { if (ticket === sequence) find('memoryError').textContent = error.message; }
  }
  async function open(id) {
    target = id; card = null; find('memoryPath').textContent = ''; controls();
    if ($('#editor').open) $('#editor').close();
    if (!drawer.open) drawer.showModal();
    await refresh();
    find('memoryClose').focus();
  }
  entry.onclick = () => open(editing?.id);
  recovery.onclick = () => open(intent?.module_id);
  find('memoryClose').onclick = () => drawer.close();
  drawer.addEventListener('close', () => { sequence++; $('#editModule')?.focus(); });
  find('memoryRefresh').onclick = refresh;
  async function save(active) {
    if (processing || !card || intent) return;
    const aliases = find('memoryAliases').value.split('\n').map(x => x.trim()).filter(Boolean);
    if (aliases.length > 20 || aliases.some(x => x.length > 80)) { find('memoryError').textContent = '简称最多20个，每个最多80字'; return; }
    const id = target, ticket = sequence;
    const body = {operation_id:crypto.randomUUID(),expected_version:card.version,scope_version:card.scope_version,description:find('memoryDescription').value,aliases,enabled:active};
    remember({module_id:id,operation_id:body.operation_id});
    processing = true; controls(); find('memoryError').textContent = '';
    try {
      const saved = await api('/memory/modules/' + encodeURIComponent(id), 'PUT', body);
      remember(null);
      if (ticket === sequence && id === target) display(saved);
    } catch (error) {
      if (error.status >= 400 && error.status < 500) remember(null);
      if (ticket === sequence) find('memoryError').textContent = error.message + (intent ? '；请先核对保存结果' : '；输入已保留');
    } finally { processing = false; controls(); }
  }
  find('memoryForm').onsubmit = event => { event.preventDefault(); save(true); };
  find('memoryDisable').onclick = () => save(false);
  find('memoryRecover').onclick = async () => {
    if (!intent || processing) return;
    processing = true; controls();
    try {
      await api('/memory/operations/' + encodeURIComponent(intent.operation_id));
      remember(null); await refresh();
    } catch (error) { find('memoryError').textContent = error.message; }
    finally { processing = false; controls(); }
  };
  find('memoryIndex').onclick = async () => {
    if (processing || !card?.usable || intent) return;
    processing = true; controls(); find('memoryError').textContent = '';
    try {
      await api('/memory/modules/' + encodeURIComponent(target) + '/index', 'POST', {operation_id:crypto.randomUUID(),expected_version:card.version});
      await refresh();
    } catch (error) { find('memoryError').textContent = error.message + '；刷新核对索引状态，不会自动重试'; }
    finally { processing = false; controls(); }
  };
})();
