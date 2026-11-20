/* Display helpers and same-origin React loader; the controller owns API and state. */
let wbRenderReact = null;
let wbSelectionReact = null;
let wbEventsReact = null;
let wbEventTree = null;
let wbEditorReact = null;
let wbEditorView = null;
let wbEventDrawerReact = null;
let wbEventDrawerView = null;
const wbRequiredReactMounts = [
  'mount', 'mountNotice', 'mountIconHint', 'mountSelection', 'mountDependencyWaiting', 'mountEvents',
  'mountEditor', 'mountEventDrawer', 'mountPlanDrawer', 'mountDailyDrawer', 'mountPriorityDrawer',
  'mountMoveDrawer', 'mountDeleteDrawer', 'mountSourceDrawer', 'mountFollowDrawer', 'mountRecognitionDrawer',
  'mountSuggestionDrawer', 'mountImageDrawer', 'mountImageViewer', 'mountInlineImages', 'mountImageStorage',
  'mountModelCatalog', 'mountMatterPlanningSplit', 'mountMatterPrompts', 'mountSettingsShell',
  'mountWorkingMemory', 'mountModuleMemory', 'mountMemoryCandidates', 'mountWorkbenchDrawer',
  'mountPendingWrite', 'mountConnectionTools', 'mountWorkspaceNavigation', 'mountWorkspaceBar',
];

function wbLoadReact() {
  const script = document.createElement('script');
  script.src = '/dist/workbench-react.js';
  const showStartupError = () => {
    $('#frontendStartupMessage').textContent = '界面未能加载。请先构建前端，再刷新页面。';
  };
  script.onload = () => {
    const react = globalThis.TodoReactWorkbench;
    // Check the bundle before taking over any native host.
    if (react?.frontendContract !== 1 || wbRequiredReactMounts.some(name => typeof react[name] !== 'function')) {
      showStartupError();
      return;
    }
    try {
      wbMountReactFrontend(react);
      document.body.removeAttribute('data-ui-startup');
    } catch (error) {
      showStartupError();
      console.error('React frontend failed to initialize', error);
    }
  };
  script.onerror = showStartupError;
  document.head.append(script);
}

function wbMountReactFrontend(react) {
  enableReactNotice(react.mountNotice);
  enableReactIconHint(react.mountIconHint);
  wbRenderReact = react.mount(wbHome);
  wbSelectionReact = react.mountSelection(wbWork);
  wbDrawSelection(get(selection.goal), get(selection.module), get(selection.thing));
  todoDependencies.enableReactWaiting(react.mountDependencyWaiting);
  todoDependencies.closeWaiting();
  wbEventsReact = react.mountEvents($('#events'));
  wbDrawEvents();
  void loadEventTree();
  wbMountEditor(react);
  wbMountEventDrawer(react.mountEventDrawer);
  mountPlanDrawer(react.mountPlanDrawer);
  mountDailyDrawer(react.mountDailyDrawer);
  mountPriorityDrawer(react.mountPriorityDrawer);
  mountMoveDrawer(react.mountMoveDrawer);
  mountDeleteDrawer(react.mountDeleteDrawer);
  mountSourceDrawer(react.mountSourceDrawer);
  mountFollowDrawer(react.mountFollowDrawer);
  mountRecognitionDrawer(react.mountRecognitionDrawer);
  mountSuggestionDrawer(react.mountSuggestionDrawer);
  todoImages.mountImages(react.mountImageDrawer, react.mountImageViewer, react.mountInlineImages);
  todoImages.mountStorage(react.mountImageStorage);
  todoModelSettings.enableReact(react.mountModelCatalog);
  todoMatterPlanning.enableReactSplit(react.mountMatterPlanningSplit);
  todoMatterPlanning.enableReactPrompts(react.mountMatterPrompts);
  todoMatterPlanning.enableReactSettingsShell(react.mountSettingsShell);
  todoWorkingMemory.enableReact(react.mountWorkingMemory);
  todoModuleMemory.enableReact(react.mountModuleMemory);
  todoMemoryCandidates.enableReact(react.mountMemoryCandidates);
  wbMountDrawer(react.mountWorkbenchDrawer);
  mountPendingWrite(react.mountPendingWrite, react.mountConnectionTools);
  todoWorkspaceShell.mount(react.mountWorkspaceNavigation, react.mountWorkspaceBar);
  drawWorkbench();
}

function wbMountEventDrawer(mount) {
  wbEventDrawerReact = mount(eventContent,eventHeader,eventFeedback);
  wbDrawEventDrawer({});
}

function wbDrawEventDrawer(patch) {
  wbEventDrawerView = { ...wbEventDrawerView, ...patch };
  wbEventDrawerReact({ model: wbEventDrawerView, chrome: eventChromeModel(), actions: {
    close: closeEvent, images: id => todoImages.open(id), recover: recoverEvent, retry: retryEvent,
    daily: id => setDailyReview(id, true), plan: openPlanChange, edit: openWorkbenchEditor,
    remove: openDeletion, openEvent, move: openEventMove, submitChildren: saveChildren,
    generate: generateSplit, showTip, hideTip,
  } });
}

function wbMountEditor(react) {
  const form = $('#form');
  wbEditorReact = react.mountEditor(form);
  wbOpenEditorView('', '', false, null, undefined, editorActionModels(null));
}

function wbOpenEditorView(title, context, work, id, item, actions) {
  wbEditorView = {
    session: (wbEditorView?.session || 0) + 1, title, context, work, error: '', busy: false,
    plan: work ? id : null, labels: states, actions,
    fields: {
      name: item?.name || '', description: item?.description || '', owner: item?.owner || '',
      planStart: item?.planStart?.slice(0, 10) || '', planEnd: item?.planEnd?.slice(0, 10) || '',
      status: item ? statusOf(item) : 'notStarted',
    },
    onCancel: () => $('#editor').close(), onHistory: id => openPlanChange(id, true),
    onShowTip: showTip, onHideTip: hideTip,
  };
  wbEditorReact(wbEditorView);
}

function wbUpdateEditorView(patch) {
  Object.assign(wbEditorView, patch);
  wbEditorReact(wbEditorView);
}

function wbThingProps(goal, module, thing) {
  const priorities = new Map((priorityData?.items || []).map(item => [item.id, item]));
  const items = module ? children('thing', module.id) : [];
  return {
    rows: items.map(item => {
      const priority = priorities.get(item.id);
      const active = pending(item);
      const watched = wbWatched(item.id);
      const status = statusOf(item);
      return {
        id: item.id, name: item.name, description: item.description, owner: item.owner || '未指定',
        start: item.planStart?.slice(0, 10) || '未设置', end: item.planEnd?.slice(0, 10) || '未设置',
        status, statusLabel: states[status], selected: item.id === thing?.id,
        priorityLabel: priority ? priorityLabels[priority.priority] : '优先级读取失败',
        priorityDisabled: !priority || !active,
        assessment: priority && active ? (priority.due ? '本周待评估' : '本周已评估') : '',
        watched, hidden: (priorityDueOnly && !priority?.due) || (wbOnly && !watched),
      };
    }),
    emptyType: items.length ? null : module ? 'thing' : goal ? 'module' : 'goal', canAddThing: !!module,
    priorityAvailable: !!priorityData, dueOnly: priorityDueOnly, watchedOnly: wbOnly,
    watchError: !!wbError, watchDisabled: !!(wbBusy || wbPending || wbError || wbLoading),
    onDueOnly(value) { priorityDueOnly = value; wbDrawThings(); },
    onWatchedOnly(value) { wbOnly = value; wbDrawThings(); },
    onSelect: select, onOpen: openForm, onPriority: openPriority, onAttention: setAttention,
    onShowTip: showTip, onHideTip: hideTip,
  };
}

function wbDrawThings() {
  wbSelectionReact.drawThings(wbThingProps(get(selection.goal), get(selection.module), get(selection.thing)));
}

function wbDrawSelection(goal, module, thing) {
  wbSelectionReact.draw({
    breadcrumb: { text: '工作空间  /  目标与事情' + (goal ? '  /  ' + goal.name : '')
      + (module ? '  /  ' + module.name : '') },
    toolbar: {
      goals: children('goal'), modules: goal ? children('module', goal.id) : [],
      goalId: goal?.id || '', moduleId: module?.id || '',
      onSelect: select, onOpen: openForm, onShowTip: showTip, onHideTip: hideTip,
    },
    things: wbThingProps(goal, module, thing),
  });
}

function wbEventItem(item) {
  const status = statusOf(item);
  return {
    id: item.id, name: item.name, description: item.description, owner: item.owner || '未指定',
    start: item.planStart?.slice(0, 10) || '未设置', end: item.planEnd?.slice(0, 10) || '未设置',
    status, statusLabel: states[status], history: planCounts[item.id] || 0, active: pending(item),
  };
}

function wbEventSummary(events) {
  const valid = events.filter(item => statusOf(item) !== 'cancelled');
  const done = valid.filter(item => statusOf(item) === 'completed').length;
  return {
    rate: valid.length ? Math.round(done / valid.length * 100) + '%' : '暂无进度',
    valid: valid.length, done, cancelled: events.length - valid.length,
  };
}

function wbStructuredRows(events, view) {
  const { byId, edges } = todoDependencies.index(view, events);
  const dependencyContext = { byId, edges, today: view.today };
  const childrenByParent = new Map();
  const nested = new Set();
  for (const branch of view.branches) {
    const parent = branch.parent_id, child = byId.get(branch.child_id);
    if (!byId.has(parent) || !child) continue;
    if (!childrenByParent.has(parent)) childrenByParent.set(parent, []);
    childrenByParent.get(parent).push(child);
    nested.add(child.id);
  }
  const rows = [], visited = new Set();
  const stack = events.filter(item => !nested.has(item.id)).reverse().map(item => [item, 0]);
  while (stack.length) {
    const [item, depth] = stack.pop();
    if (visited.has(item.id)) continue;
    visited.add(item.id);
    const childRows = childrenByParent.get(item.id) || [];
    rows.push({ item, depth, childRows });
    for (let i = childRows.length - 1; i >= 0; i--) stack.push([childRows[i], depth + 1]);
  }
  const totals = new Map();
  for (let i = rows.length - 1; i >= 0; i--) {
    const { item, childRows } = rows[i];
    const counts = childRows.length ? { valid: 0, done: 0 } : {
      valid: Number(statusOf(item) !== 'cancelled'), done: Number(statusOf(item) === 'completed'),
    };
    for (const child of childRows) {
      const subtotal = totals.get(child.id);
      if (subtotal) { counts.valid += subtotal.valid; counts.done += subtotal.done; }
    }
    totals.set(item.id, counts);
  }
  return {
    summary: wbEventSummary(events.filter(item => !childrenByParent.has(item.id))),
    rows: rows.map(({ item, depth, childRows }) => ({
      ...wbEventItem(item), depth, children: childRows.length, ...totals.get(item.id),
      waitReasons: todoDependencies.reasons(item, dependencyContext), hasPredecessors: edges.has(item.id),
    })),
  };
}

function wbEventSuggestions() {
  const rows = aiSuggestions.filter(suggestion => suggestion.thing_id === selection.thing
    || (!suggestion.thing_id && isChatSuggestion(suggestion))).flatMap(suggestion => {
    let data;
    try { data = JSON.parse(suggestion.body); } catch { return []; }
    if (!data || typeof data.name !== 'string') return [];
    const linked = suggestion.state === 'linked';
    return [{
      id: suggestion.id,
      heading: (!suggestion.thing_id ? '归属待确认 · ' : linked ? '新进展 · ' : '待确认 · ') + data.name,
      fields: `责任人：${data.owner || '待确认'} · 结束：${data.plan_end || '待确认'} · 建议状态：${states[data.status]}`,
      basis: '原文依据：' + data.evidence,
      reject: linked ? '关联有误' : '舍弃建议', rejectIcon: actionIconPaths[linked ? 'unlink' : 'close'],
      accept: linked ? '' : suggestion.action === 'new' ? '确认新增事件' : '确认修改事件',
      showTip, hideTip,
    }];
  });
  return { rows, onDecide: decideSuggestion, onOpen: id => {
    const current = aiSuggestions.find(suggestion => suggestion.id === id);
    if (current) openSuggestion(current);
  } };
}

function wbDrawEvents() {
  const thing = get(selection.thing);
  const base = thing ? children('event', thing.id) : [];
  const loaded = base.length && wbEventTree?.id === thing.id ? wbEventTree : null;
  const currentItems = new Map(base.map(item => [item.id, item]));
  const ordered = loaded?.items?.map(item => currentItems.get(item.id)).filter(Boolean);
  const view = loaded?.view && wbStructuredRows(ordered, loaded.view);
  const summary = loaded?.message ? { text: loaded.message } : view ? {
    text: `事件完成率 ${view.summary.rate} · 最末级完成 ${view.summary.done} / 有效 ${view.summary.valid} · 取消 ${view.summary.cancelled}`,
  } : wbEventSummary(base);
  const rows = view?.rows || base.map(wbEventItem);
  const followById = new Map(followRules.map(rule => [rule.event_id, rule]));
  wbEventsReact({
    thing: thing ? { ...wbEventItem(thing), watched: wbWatched(thing.id) } : null,
    events: rows.map(row => ({ ...row, followTitle: '自动催办：' + (followById.get(row.id)?.status || '未开启') })),
    summary, pendingCount: base.filter(pending).length, structured: !!view,
    watchDisabled: !!(wbBusy || wbPending || wbError || wbLoading),
    actions: {
      openForm, sources: openSources, delete: openDeletion, plan: openPlanChange, attention: setAttention,
      toggle, event: openEvent, daily: id => setDailyReview(id, true), follow: openFollowRule,
      images: todoImages.open, decompose: todoMatterPlanning.open, showTip, hideTip,
    },
  }, wbEventSuggestions());
}

function wbGoalSummary(goals, matters, items) {
  const byGoal = new Map(goals.map(goal => [goal.id, {
    id: goal.id, name: goal.name, modules: 0, matters: 0, completed: 0,
  }]));
  for (const item of items) {
    if (item.type !== 'module') continue;
    const goal = byGoal.get(item.parent);
    if (goal) goal.modules++;
  }
  for (const matter of matters) {
    const goal = byGoal.get(wbPath(matter).goal.id);
    if (goal) {
      goal.matters++;
      if (matter.status === 'completed') goal.completed++;
    }
  }
  return [...byGoal.values()];
}
function wbReactPanels({ ready, rules, filtered, actions, watched, reviews, dependencies, follows }) {
  const mapPage = (key, rows, mapRow) => {
    const page = wbPage(key, rows);
    return { ...page, rows: page.rows.map(mapRow) };
  };
  const parents = new Set(wbSnapshot.branches.map(branch => branch.parent_id));
  const matterRow = matter => ({
    id: matter.id, name: matter.name, path: wbPath(matter)?.text,
    priority: priorityLabels[wbPriority(matter.id)?.priority || 0],
    status: states[matter.status], progress: wbProgress(matter), watched: wbWatched(matter.id),
  });
  const done = filtered.filter(event => dailyReviewed(event.id)).length;
  return {
    actionCount: filtered.length, includeEnded: wbEnded, week: wbSnapshot.priorities.week,
    followDisabled: !!dailyDisabled(), watchDisabled: !!(wbBusy || wbPending || wbError || wbLoading),
    categories: Object.entries(wbActionCategories).map(([key, label]) => ({
      key, label, count: ready.filter(rules[key]).length, selected: wbFilter === key,
    })),
    daily: [
      { key: 'pending', count: filtered.length - done, selected: dailyFilter === 'pending' },
      { key: 'done', count: done, selected: dailyFilter === 'done' },
    ],
    events: mapPage('events', actions, event => {
      const status = statusOf(event);
      return {
        id: event.id, name: event.name, path: wbPath(event)?.text,
        status, statusLabel: states[status], end: event.planEnd,
        overdue: !!(event.planEnd && event.planEnd < wbSnapshot.today),
        parent: parents.has(event.id), followup: follows.has(event.id),
        predecessors: dependencies.edges.has(event.id), history: planCounts[event.id] || 0,
      };
    }),
    attention: mapPage('attention', watched, matterRow),
    reviews: mapPage('reviews', reviews, matterRow),
  };
}

function wbDrawReact(goals, message, matters, lists) {
  wbRenderReact({
    heading: { goals, scope: wbScope, loading: wbLoading, onScope: wbSetScope,
      onRefresh: loadWorkbench, onLocate: locateWorkbench, onOpenWork: () => showWorkbench('work') },
    overview: message ? [] : wbGoalSummary(goals, matters, wbItems()),
    warnings: { follow: !!dailyPending && !dailyBusy, retryFollow: dailyCanRetry, attention: !!wbPending },
    message,
    panels: lists && wbReactPanels(lists),
    actions: {
      category: wbSetActionFilter,
      daily(key) { dailyFilter = key; wbPages.events = 0; drawWorkbench(); },
      page(key, direction) {
        if (key === 'events') wbChangeActionPage(direction);
        else { wbPages[key] += direction; drawWorkbench(); }
      },
      includeEnded(value) { wbEnded = value; wbPages.attention = 0; drawWorkbench(); },
      edit: openWorkbenchEditor, plan: openPlanChange, follow: setDailyReview,
      detail: openWorkbenchDetail, attention: setAttention, review: id => locateWorkbench(id, true),
      recoverAttention, recoverFollow: recoverDailyReview, retryFollow: sendDailyReview,
    },
  });
}

function wbSetScope(id) {
  wbScope = id;
  wbPages = { events: 0, attention: 0, reviews: 0 };
  drawWorkbench();
}
