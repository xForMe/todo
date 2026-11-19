/* Explicit event dependencies and the shared waiting indicator. */
const todoDependencies = (() => {
  const linkIcon = '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="m10 13 4-4m-5 6-2 2a3 3 0 0 1-4-4l4-4a3 3 0 0 1 4 0m2 0 2-2a3 3 0 0 1 4 4l-4 4a3 3 0 0 1-4 0"/></svg>';
  const clockIcon = '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8"/><path d="M12 7v5l3 2"/></svg>';
  let waitButton;
  let waitPopover;

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

  function badge(event, waiting) {
    if (!waiting.length) return '';
    return `<button type="button" class="dependencyWait" aria-label="${esc(event.name)}：等待，查看原因"
      data-wait-reasons="${esc(JSON.stringify(waiting))}" aria-expanded="false">${clockIcon}等待</button>`;
  }

  function closeWaiting(restoreFocus = false) {
    if (!waitPopover) return;
    waitPopover.remove();
    waitButton.setAttribute('aria-expanded', 'false');
    waitButton.removeAttribute('aria-controls');
    if (restoreFocus) waitButton.focus();
    waitPopover = null;
    waitButton = null;
  }

  document.addEventListener('click', event => {
    const shortcut = event.target.closest?.('.dependencyShortcut');
    if (shortcut) {
      closeWaiting();
      void openEvent(shortcut.dataset.dependencyEvent, 'detail', shortcut.hasAttribute('data-dependency-settings'));
      return;
    }
    const trigger = event.target.closest?.('.dependencyWait');
    if (!trigger && waitPopover?.contains(event.target)) return;
    const wasOpen = trigger && trigger === waitButton;
    closeWaiting();
    if (!trigger || wasOpen) return;
    const popover = document.createElement('div');
    popover.id = 'dependencyWaitReason';
    popover.className = 'dependencyWaitPopover';
    popover.setAttribute('role', 'region');
    popover.setAttribute('aria-label', '等待原因');
    popover.innerHTML = '<strong>等待原因</strong><ul>' +
      JSON.parse(trigger.dataset.waitReasons).map(reason => '<li>' + esc(reason) + '</li>').join('') + '</ul>';
    document.body.append(popover);
    const rect = trigger.getBoundingClientRect();
    const left = Math.max(8, Math.min(rect.right - popover.offsetWidth, window.innerWidth - popover.offsetWidth - 8));
    popover.style.left = left + 'px';
    popover.style.top = Math.max(8, rect.top - popover.offsetHeight - 6) + 'px';
    trigger.setAttribute('aria-expanded', 'true');
    trigger.setAttribute('aria-controls', popover.id);
    waitPopover = popover;
    waitButton = trigger;
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && waitPopover) closeWaiting(true);
  });
  window.addEventListener('resize', () => closeWaiting());
  window.addEventListener('scroll', () => closeWaiting(), true);

  function detailShortcut(id, showSettings = false) {
    return `<button type="button" class="dependencyShortcut" title="前置事件"
      aria-label="前置事件" data-dependency-event="${esc(id)}" ${showSettings ? 'data-dependency-settings' : ''}>${linkIcon}</button>`;
  }

  function mount(host, event, initialView, showSettings = false) {
    if (!Array.isArray(initialView.dependencies)) return false;
    let view = initialView;
    let context = index(view, view.events);
    let saved = context.edges.get(event.id) || [];
    let editing = showSettings && (pending(event) || saved.length > 0);
    let generation = 0;
    let recommendation = {loading: false, message: '', items: []};

    const active = () => pending(context.byId.get(event.id) || event);
    const candidates = () => view.events.filter(item =>
      item.id !== event.id && statusOf(item) !== 'cancelled' && !saved.includes(item.id));
    function iconButton(action, label, icon, attributes = '') {
      return `<button type="button" class="iconButton" data-dependency="${action}" title="${esc(label)}"
        aria-label="${esc(label)}" ${attributes}>
        <svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="${actionIconPaths[icon]}"/></svg>
      </button>`;
    }

    host.innerHTML = `<section class="dependencyPanel">
      <div class="dependencyHeading"><h3>前置事件</h3>
        ${iconButton('edit', '设置前置', 'link', 'aria-expanded="false" aria-controls="dependencyOptions"')}
      </div>
      <div data-dependency-list></div>
      <div class="dependencyOptions" id="dependencyOptions" hidden>
        <div class="dependencyAI">
          <div class="dependencyHeading"><strong>AI 推荐</strong>${iconButton('recommend', 'AI 识别前置', 'ai')}</div>
          <p class="muted" role="status" data-recommendation-status></p>
          <div data-recommendation-list></div>
        </div>
        <div class="dependencyManual">
          <label for="predecessorPicker">等待所选事件完成</label>
          <div class="dependencyHeading"><select id="predecessorPicker"></select>${iconButton('add', '添加前置', 'add')}</div>
        </div>
      </div>
      <p class="error" role="alert" data-dependency-error></p>
    </section>`;
    const part = selector => host.querySelector(selector);
    const control = name => part('button[data-dependency="' + name + '"]');
    const picker = part('select');
    const error = part('[data-dependency-error]');
    const suggestions = part('[data-recommendation-list]');

    function renderSuggestions() {
      control('recommend').disabled = recommendation.loading;
      part('[data-recommendation-status]').textContent = recommendation.message;
      const available = new Set(candidates().map(item => item.id));
      suggestions.innerHTML = recommendation.items.filter(item => available.has(item.id)).map(item => {
        const name = context.byId.get(item.id).name;
        return `<div class="dependencyLine"><div><strong>${esc(name)}</strong><small>${esc(item.reason)}</small></div>
          ${iconButton('suggested', '添加推荐：' + name, 'add', 'value="' + esc(item.id) + '"')}</div>`;
      }).join('');
    }

    function renderEditor() {
      part('#dependencyOptions').hidden = !editing || !active();
      control('edit').hidden = !active() && !saved.length;
      control('edit').setAttribute('aria-expanded', String(editing));
      control('edit').title = editing ? '收起前置设置' : '设置前置';
      control('edit').setAttribute('aria-label', control('edit').title);
      part('[data-dependency-list]').innerHTML = saved.map(id => {
        const target = context.byId.get(id);
        const name = target?.name || '前置事件已失效';
        const value = 'value="' + esc(id) + '"';
        return `<div class="dependencyLine"><div>
          ${target ? `<button type="button" class="dependencyName" data-dependency="open" ${value}>${esc(name)}</button>` : `<strong>${esc(name)}</strong>`}
          <small>${target ? states[statusOf(target)] : '请替换或移除'}</small></div>
          ${editing ? iconButton('remove', '移除：' + name, 'unlink', value) : ''}</div>`;
      }).join('') || '<p class="muted">暂无前置事件</p>';
      picker.replaceChildren(new Option('选择同一事情下的事件', ''),
        ...candidates().map(item => new Option(item.name + ' · ' + states[statusOf(item)], item.id)));
      control('add').disabled = true;
      renderSuggestions();
    }

    async function recommend() {
      const run = ++generation;
      recommendation = {loading: true, message: '正在分析同一事情下的事件…', items: []};
      renderSuggestions();
      try {
        const items = await api('/events/' + event.id + '/predecessor-recommendations', 'POST',
          {consent: true, snapshot: view.snapshot});
        if (run !== generation || !host.isConnected || !eventDialog.open || !editing) return;
        const allowed = new Set(candidates().map(item => item.id));
        const eligible = items.filter(item => allowed.has(item.id));
        recommendation = {loading: false, items: eligible,
          message: eligible.length ? '' : '未找到可添加的前置，可以手动选择。'};
      } catch (failure) {
        if (run !== generation || !host.isConnected || !eventDialog.open || !editing) return;
        recommendation = {loading: false, message: failure.message || '推荐失败，可以手动选择。', items: []};
      }
      renderSuggestions();
    }

    function save(next) {
      error.textContent = '';
      if (recommendation.loading) {
        generation++;
        recommendation = {loading: false, message: '', items: []};
        renderSuggestions();
      }
      void writeEvent({action: 'predecessors', predecessor_ids: next}, view.snapshot, event.id, latest => {
        if (!host.isConnected || !eventDialog.open) return;
        view = latest;
        context = index(view, view.events);
        saved = context.edges.get(event.id) || [];
        error.textContent = '';
        if (!active() && !saved.length) editing = false;
        renderEditor();
        (active() ? picker : control('edit')).focus();
      });
    }

    function add(id) {
      if (!candidates().some(item => item.id === id)) return;
      if (saved.length >= 50) { error.textContent = '最多选择 50 个前置事件。'; return; }
      save([...saved, id]);
    }

    host.addEventListener('click', event => {
      const button = event.target.closest('button[data-dependency]');
      if (!button || eventBusy || eventPending) return;
      switch (button.dataset.dependency) {
        case 'open': openEvent(button.value); break;
        case 'edit':
          editing = !editing;
          generation++;
          recommendation = {loading: false, message: '', items: []};
          error.textContent = '';
          renderEditor();
          break;
        case 'recommend': void recommend(); break;
        case 'add': add(picker.value); break;
        case 'suggested': add(button.value); break;
        case 'remove': save(saved.filter(id => id !== button.value)); break;
      }
    });
    picker.addEventListener('change', () => { control('add').disabled = !picker.value; });
    renderEditor();
    if (editing) (active() ? picker : control('edit')).focus();
    return editing;
  }

  return {index, reasons, badge, closeWaiting, mount, detailShortcut};
})();
