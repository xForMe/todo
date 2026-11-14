/* TECH-014: display helpers only. Existing API and write flows remain in workbench.js. */
function wbIcon(name) {
  const paths = {
    arrow: '<path d="M5 12h14m-5-5 5 5-5 5"/>',
    refresh: '<path d="M20 7v5h-5M4 17v-5h5M6 6a8 8 0 0 1 13 2M5 16a8 8 0 0 0 13 2"/>',
    calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M7 3v4m10-4v4M3 11h18"/>',
    list: '<path d="M9 6h12M9 12h12M9 18h12M3 6h1M3 12h1M3 18h1"/>',
    star: '<path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-2.9-5.6 2.9 1.1-6.2L3 9.6l6.2-.9L12 3Z"/>',
    check: '<circle cx="12" cy="12" r="9"/><path d="m8 12 3 3 5-6"/>',
  };
  return `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true">${paths[name] || paths.list}</svg>`;
}

function wbEmptyState(kind) {
  const options = {
    events: ['list', '当前没有待推进的行动', '可以切换筛选，或到目标与事情中安排下一步。'],
    attention: ['star', '把重要的事情放在这里', '在事情旁点亮星标，持续留意后续进展。'],
    reviews: ['check', '当前没有待评估的事情', '本周评估会在有待评估事情时出现在这里。'],
  };
  const [icon, title, hint] = options[kind];
  return `<div class="empty wbEmpty">${wbIcon(icon)}<b>${title}</b><p>${hint}</p></div>`;
}

function wbSetScope(id) {
  wbScope = id;
  wbPages = { events: 0, attention: 0, reviews: 0 };
  drawWorkbench();
}

function wbRenderHeading(goals) {
  const date = document.getElementById('workspaceDate');
  if (date && wbSnapshot) date.textContent = `${wbSnapshot.today} · 北京时间`;
  return `<div class="wbHeading"><div><h1>工作台</h1><p>聚焦行动，让每件事有进展。</p></div>
    <div class="wbControls"><label for="wbScope">目标范围</label><select id="wbScope" onchange="wbSetScope(this.value)"><option value="">全部目标</option>${goals.map(g => `<option value="${g.id}" ${wbScope === g.id ? 'selected' : ''}>${esc(g.name)}</option>`).join('')}</select><button onclick="loadWorkbench()" ${wbLoading ? 'disabled' : ''} aria-label="刷新工作台">${wbIcon('refresh')}${wbLoading ? '读取中…' : '刷新'}</button></div></div>`;
}

function wbRenderOverview(goals, matters) {
  return `<div class="wbSectionTitle"><h2>目标概览 <span class="wbCount">${goals.length}</span></h2><small>按事情状态计数，不代表目标达成率</small></div><div class="wbOverview">${goals.map(g => {
    const ms = matters.filter(m => wbPath(m).goal.id === g.id);
    const modules = wbItems().filter(x => x.type === 'module' && x.parent === g.id).length;
    return `<button class="wbGoal" onclick="wbSetScope('${g.id}')" aria-label="筛选目标：${esc(g.name)}"><span class="wbGoalTitle"><strong>${esc(g.name)}</strong>${wbIcon('arrow')}</span><span class="wbGoalStats"><span><b>${modules}</b> 模块</span><span><b>${ms.length}</b> 事情</span><span><b>${ms.filter(x => x.status === 'completed').length}</b> 已完成事情</span></span></button>`;
  }).join('') || '<div class="empty"><b>从一个目标开始</b><span>把想达成的结果，变成可以推进的事情。</span><button class="primary" onclick="showWorkbench(\'work\')">前往目标与事情</button></div>'}</div>`;
}
