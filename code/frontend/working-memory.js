/* Current work is a factual projection. Never edit business state from this drawer. */
(() => {
  const drawer = document.createElement('dialog');
  drawer.id = 'workingMemoryDrawer';
  drawer.setAttribute('aria-labelledby', 'workingMemoryTitle');
  drawer.innerHTML = `<div class="drawerHead"><h2 id="workingMemoryTitle">当前工作摘要</h2><button type="button" id="workingMemoryClose">关闭</button></div>
    <p id="workingMemoryState" role="status"></p><div id="workingMemoryBody"></div>
    <p id="workingMemoryError" role="alert"></p><div class="actions"><button type="button" id="workingMemoryRefresh">刷新摘要</button></div>`;
  document.body.append(drawer);
  const find = id => drawer.querySelector('#' + id);
  const entry = document.createElement('button');
  entry.id = 'workingMemoryEntry'; entry.type = 'button';
  entry.textContent = '当前工作摘要'; entry.hidden = true;
  $('#editor .actions').prepend(entry);
  const previous = openForm;
  openForm = function(type, id) { previous(type, id); entry.hidden = type !== 'thing' || !id; };
  let target = '', sequence = 0;
  const labels = {notStarted:'未开始',working:'进行中',completed:'已完成',cancelled:'已取消'};
  function text(tag, value, parent, className = '') {
    const element = document.createElement(tag);
    element.textContent = value; element.className = className; parent.append(element);
    return element;
  }
  function render(result) {
    const parent = find('workingMemoryBody');
    if (result.state === 'inactive') {
      find('workingMemoryState').textContent = '事情已结束，已退出当前摘要。业务记录保留。';
      return;
    }
    const summary = result.summary;
    find('workingMemoryState').textContent = result.state === 'capacity_uncached'
      ? '当前摘要容量已满，以下为实时结果，未缓存。' : '已按当前业务记录整理';
    text('p', summary.path, parent, 'workingMemoryPath');
    const counts = text('div', '', parent, 'workingMemoryCounts');
    for (const [status, label] of Object.entries(labels)) text('span', `${label} ${summary.counts[status] || 0}`, counts);
    text('h3', '未结束行动', parent);
    if (!summary.actions.length) text('p', '当前没有未结束行动。', parent);
    const list = text('ul', '', parent, 'workingMemoryActions');
    for (const action of summary.actions) {
      const item = text('li', '', list);
      text('strong', action.name, item);
      text('p', `${labels[action.status] || action.status} · ${action.owner || '未指定负责人'} · ${action.plan_end || '日期未定'}`, item, 'workingMemoryMeta');
      const view = text('button', '查看事件', item);
      view.type = 'button';
      view.setAttribute('aria-label', '查看事件：' + action.name);
      view.onclick = async () => { drawer.close(); await locateWorkbench(action.id); };
    }
    if (summary.omitted) text('p', `部分行动：另有 ${summary.omitted} 项未列出，请在事件列表查看。`, parent, 'sourceHint');
    else if (summary.partial) text('p', '当前仅展示部分工作，完整内容请查看事件列表。', parent, 'sourceHint');
    text('p', '摘要只读。修改内容请编辑对应事情或事件。', parent, 'workingMemoryMeta');
  }
  async function refresh() {
    const ticket = ++sequence, id = target;
    find('workingMemoryBody').replaceChildren();
    find('workingMemoryError').textContent = '';
    find('workingMemoryState').textContent = '正在整理当前工作…';
    find('workingMemoryRefresh').disabled = true;
    try {
      const result = await api('/memory/working/' + encodeURIComponent(id) + '/refresh', 'POST');
      if (ticket !== sequence || target !== id || !drawer.open) return;
      render(result);
    } catch (error) {
      if (ticket !== sequence || !drawer.open) return;
      find('workingMemoryState').textContent = '摘要未更新';
      find('workingMemoryError').textContent = error.message + '；可手动刷新，未自动重试';
    } finally {
      if (ticket === sequence) find('workingMemoryRefresh').disabled = false;
    }
  }
  entry.onclick = () => {
    target = editing?.id;
    if ($('#editor').open) $('#editor').close();
    drawer.showModal(); refresh(); find('workingMemoryClose').focus();
  };
  find('workingMemoryRefresh').onclick = refresh;
  find('workingMemoryClose').onclick = () => drawer.close();
  drawer.addEventListener('close', () => { sequence++; $('#editThing')?.focus(); });
})();
