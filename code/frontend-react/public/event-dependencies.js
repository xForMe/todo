/* Explicit event dependencies and the shared waiting indicator. */
const todoDependencies = (() => {
  const waitLayer = document.createElement('div');
  waitLayer.id = 'dependencyWaitLayer';
  document.body.append(waitLayer);
  let waitButton = null, waitReact = null;

  function enableReactWaiting(mount) {
    closeWaiting();
    waitReact = mount(waitLayer);
  }

  function index(view, items) {
    const byId = new Map(items.map(item => [item.id, item]));
    const edges = new Map();
    for (const edge of view.dependencies || []) {
      if (!edges.has(edge.event_id)) edges.set(edge.event_id, []);
      edges.get(edge.event_id).push(edge.predecessor_id);
    }
    return {byId, edges, today: view.today};
  }

  function reasons(event, context) {
    if (!pending(event)) return [];
    const waiting = [];
    for (const id of context.edges.get(event.id) || []) {
      const predecessor = context.byId.get(id);
      if (!predecessor || predecessor.parent !== event.parent) waiting.push('前置事件已失效，请核对');
      else if (statusOf(predecessor) === 'cancelled') waiting.push('「' + predecessor.name + '」已取消，请核对前置');
      else if (statusOf(predecessor) !== 'completed') waiting.push('等待「' + predecessor.name + '」完成');
    }
    if (statusOf(event) === 'notStarted' && event.planStart && event.planStart > context.today) {
      waiting.push('未到计划开始日 ' + event.planStart);
    }
    return waiting;
  }

  function closeWaiting(restoreFocus = false) {
    if (!waitButton) return;
    const button = waitButton;
    waitButton = null;
    waitReact(null);
    button.setAttribute('aria-expanded', 'false');
    button.removeAttribute('aria-controls');
    if (restoreFocus && button.isConnected) button.focus({preventScroll:true});
  }

  function openWaiting(trigger) {
    if (!waitReact) return;
    let details;
    try { details = JSON.parse(trigger.dataset.waitReasons); }
    catch { return; }
    if (!Array.isArray(details) || !details.length || details.some(reason => typeof reason !== 'string')) return;
    waitReact(details);
    const popover = waitLayer.firstElementChild;
    const rect = trigger.getBoundingClientRect();
    const left = Math.max(8, Math.min(rect.right - popover.offsetWidth, window.innerWidth - popover.offsetWidth - 8));
    popover.style.left = left + 'px';
    popover.style.top = Math.max(8, rect.top - popover.offsetHeight - 6) + 'px';
    trigger.setAttribute('aria-expanded', 'true');
    trigger.setAttribute('aria-controls', popover.id);
    waitButton = trigger;
  }

  document.addEventListener('click', event => {
    // Both React lists delegate their predecessor shortcut here.
    const shortcut = event.target.closest?.('.dependencyShortcut');
    if (shortcut) {
      closeWaiting();
      void openEvent(shortcut.dataset.dependencyEvent, 'detail', shortcut.hasAttribute('data-dependency-settings'));
      return;
    }
    if (waitLayer.contains(event.target)) return;
    const trigger = event.target.closest?.('.dependencyWait');
    const wasOpen = trigger === waitButton;
    closeWaiting();
    if (trigger && !wasOpen) openWaiting(trigger);
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && waitButton) closeWaiting(true);
  });
  window.addEventListener('resize', () => closeWaiting());
  window.addEventListener('scroll', () => closeWaiting(), true);

  const errorHandlers = new WeakMap();

  function reportError(host, message) {
    const report = host && errorHandlers.get(host);
    if (!report) return false;
    report(message);
    return true;
  }

  function mount(host, event, initialView, showSettings = false, renderReact) {
    if (!Array.isArray(initialView.dependencies)) return false;
    let view = initialView;
    let context = index(view, view.events);
    let saved = context.edges.get(event.id) || [];
    let editing = showSettings && (pending(event) || saved.length > 0);
    let generation = 0;
    let recommendation = {loading: false, message: '', items: []};
    let selected = '', message = '';
    const current = () => host.isConnected && eventDialog.open && eventContext === event.id;

    const active = () => pending(context.byId.get(event.id) || event);
    const candidates = () => view.events.filter(item =>
      item.id !== event.id && statusOf(item) !== 'cancelled' && !saved.includes(item.id));
    function focusEditor() {
      host.querySelector(active() ? 'select' : 'button[data-dependency="edit"]')?.focus();
    }

    const reactActions = {
      open: id => runAction(() => openEvent(id)),
      toggle: () => runAction(toggleEditing),
      recommend: () => runAction(recommend),
      add: id => runAction(() => add(id)),
      remove: id => runAction(() => save(saved.filter(value => value !== id))),
      select: id => runAction(() => { selected = id; drawReact(); }),
    };

    function runAction(action) {
      if (!current() || eventBusy || eventPending) return;
      return action();
    }

    function drawReact() {
      const eligible = candidates();
      const idSet = new Set(eligible.map(item => item.id));
      renderReact({
        active: active(), editing, selected, error: message, actions: reactActions, paths: actionIconPaths,
        saved: saved.map(id => {
          const target = context.byId.get(id);
          return { id, available: !!target, name: target?.name || '前置事件已失效',
            status: target ? states[statusOf(target)] : '请替换或移除' };
        }),
        candidates: eligible.map(item => ({ id: item.id, label: item.name + ' · ' + states[statusOf(item)] })),
        recommendation: { loading: recommendation.loading, message: recommendation.message,
          rows: recommendation.items.filter(item => idSet.has(item.id)).map(item => ({
            id: item.id, reason: item.reason, name: context.byId.get(item.id).name,
          })) },
      });
      if (eventDialog.dataset.busy === 'true') setEventDisabled(true);
    }

    function editError(value) {
      message = value;
      drawReact();
    }
    errorHandlers.set(host, editError);

    function renderEditor() {
      selected = '';
      drawReact();
    }

    async function recommend() {
      const run = ++generation;
      const opening = aiGeneration;
      recommendation = {loading: true, message: '正在分析同一事情下的事件…', items: []};
      drawReact();
      try {
        const items = await api('/events/' + event.id + '/predecessor-recommendations', 'POST',
          {consent: true, snapshot: view.snapshot});
        if (run !== generation || opening !== aiGeneration || !current() || !editing) return;
        const allowed = new Set(candidates().map(item => item.id));
        const eligible = items.filter(item => allowed.has(item.id));
        recommendation = {loading: false, items: eligible,
          message: eligible.length ? '' : '未找到可添加的前置，可以手动选择。'};
      } catch (failure) {
        if (run !== generation || opening !== aiGeneration || !current() || !editing) return;
        recommendation = {loading: false, message: failure.message || '推荐失败，可以手动选择。', items: []};
      }
      drawReact();
    }

    function save(next) {
      editError('');
      if (recommendation.loading) {
        generation++;
        recommendation = {loading: false, message: '', items: []};
        drawReact();
      }
      void writeEvent({action: 'predecessors', predecessor_ids: next}, view.snapshot, event.id, latest => {
        if (!current()) return;
        view = latest;
        context = index(view, view.events);
        saved = context.edges.get(event.id) || [];
        message = '';
        if (!active() && !saved.length) editing = false;
        renderEditor();
        focusEditor();
      });
    }

    function add(id) {
      if (!candidates().some(item => item.id === id)) return;
      if (saved.length >= 50) { editError('最多选择 50 个前置事件。'); return; }
      save([...saved, id]);
    }

    function toggleEditing() {
      editing = !editing;
      generation++;
      recommendation = {loading: false, message: '', items: []};
      message = '';
      renderEditor();
    }

    renderEditor();
    if (editing) focusEditor();
    return editing;
  }

  return {index, reasons, closeWaiting, enableReactWaiting, mount, reportError};
})();
