// TEST-025: synthetic snapshots and static assets only; no requests leave Playwright.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require('playwright');

const staticDir = path.resolve(__dirname, '../public');
const output = path.resolve(__dirname, '../../../runtime/react-parity');
const bundle = '/dist/workbench-react.js';
const origin = 'http://127.0.0.1:18883';
const today = '2026-11-19';
const week = '2026-11-16';
const goalName = '长目标 «<&>» '.repeat(8).trim();
const item = (id, type, parent, name, status = 'notStarted') => ({
  id, type, parent, name, status, version: 1, description: '', owner: '', planStart: '', planEnd: '',
});
const baseItems = [
  item('g1', 'goal', null, goalName), item('g2', 'goal', null, '第二目标'),
  item('m1', 'module', 'g1', '一级模块'), item('m2', 'module', 'g2', '二级模块'),
  item('t1', 'thing', 'm1', '第一事情'), item('t2', 'thing', 'm2', '第二事情', 'completed'),
  ...Array.from({ length: 12 }, (_, index) => item(`e${index}`, 'event', 't1', `行动 ${index}`)),
];
const widths = [1440, 1024, 768, 375];
const attentionPath = '/api/items/t1/attention';
const snapshotPath = '/api/workbench';
const operationsPath = '/api/operations/';
const matterDescription = '合成说明 <测试> & “核对”';
const extraMatters = Array.from({ length: 20 }, (_, index) =>
  item(`side${index}`, 'thing', 'm1', `侧栏事项 ${index + 1}`));
const panelItems = [
  ...baseItems.map(record => record.id === 'e0' ? { ...record, status: 'working', planEnd: '2026-11-18' }
    : record.id === 'e1' ? { ...record, status: 'working', planEnd: today }
      : record.id === 't1' ? { ...record, description: matterDescription, owner: '测试账号' } : record),
  ...extraMatters,
  item('cross', 'thing', 'm2', '另一目标事项'),
  item('cross-event', 'event', 'cross', '另一目标行动', 'working'),
  item('pre', 'event', 't1', '已完成前置', 'completed'),
  item('blocked', 'event', 't1', '等待前置的行动', 'working'),
  { ...item('future', 'event', 't1', '尚未到计划开始的行动'), planStart: '2026-11-23' },
  ...Array.from({ length: 10 }, (_, index) => item(`extra${index}`, 'event', 't1', `追加行动 ${index}`)),
];

async function openFixture(browser, panels = false, { noticeClock = false, bundleGate } = {}) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 980 }, serviceWorkers: 'block', reducedMotion: 'reduce',
  });
  const failures = [];
  await context.routeWebSocket('**/*', socket => {
    failures.push(`Unexpected WebSocket: ${socket.url()}`);
    return socket.close();
  });
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  // Keep the workbench's Beijing day check aligned with the synthetic snapshot day.
  const fixtureTime = new Date(`${today}T12:00:00+08:00`);
  if (noticeClock) {
    await page.clock.install({ time: fixtureTime });
    await page.clock.pauseAt(new Date(fixtureTime.getTime() + 60_000));
  } else await page.clock.setFixedTime(fixtureTime);
  const requests = [];
  const writes = [];
  const receipts = new Map();
  let items = panels ? panelItems : baseItems;
  let planCount = 1;
  let readError = false;
  let attentionMode = 'success';
  let hideReceipt = false;
  let readback = null;
  const sideIds = extraMatters.map(record => record.id);
  const priorities = {
    week: panels ? week : today,
    items: panels ? [...sideIds, 'cross', 't1'].map(id =>
      ({ id, priority: id === 'cross' ? 2 : 1, due: true, version: 1 })) : [],
  };
  const attention = new Map(panels ? ['t1', ...sideIds, 't2', 'cross'].map(id => [id, true]) : []);
  const dependencies = panels ? [
    { event_id: 'e0', predecessor_id: 'pre' }, { event_id: 'blocked', predecessor_id: 'e0' },
  ] : [];
  page.on('pageerror', error => failures.push(error.message));
  const missingReceipts = new Set();
  page.on('console', message => {
    if (message.type() !== 'error') return;
    const text = message.text();
    if (/Failed to load resource.*\b(?:503|409)\b/.test(text)) return;
    if (/Failed to load resource.*\b404\b/.test(text) && missingReceipts.has(message.location().url)) return;
    failures.push(text);
  });
  await context.route('**/*', async route => {
    const request = route.request();
    const { origin: requestOrigin, pathname } = new URL(request.url());
    const method = request.method();
    const unexpected = () => {
      failures.push(`Unexpected request: ${method} ${requestOrigin}${pathname}`);
      return route.abort();
    };
    if (requestOrigin !== origin) return unexpected();
    requests.push(`${method} ${pathname}`);
    if (panels && method === 'POST' && pathname === attentionPath) {
      const body = request.postDataJSON();
      writes.push(body);
      if (attentionMode === 'reject') return route.fulfill({ status: 409, json: { detail: '模拟关注版本冲突' } });
      if (attentionMode === 'uncommitted') {
        return route.fulfill({ status: 503, json: { detail: '模拟关注提交前中断' } });
      }
      const current = items.find(record => record.id === 't1' && record.type === 'thing');
      if (!current || body.expected_version !== current.version) return unexpected();
      // Both POST and operations GET return ItemOutput, not an attention flag or envelope.
      const receipt = { ...current, version: current.version + 1 };
      attention.set(receipt.id, body.enabled);
      items = items.map(record => record.id === receipt.id ? receipt : record);
      receipts.set(body.operation_id, receipt);
      if (attentionMode === 'read-failed') readError = true;
      if (attentionMode === 'unknown') {
        return route.fulfill({ status: 503, json: { detail: '模拟关注回执丢失' } });
      }
      return route.fulfill({ json: receipt });
    }
    if (method !== 'GET') return unexpected();
    if (pathname.startsWith('/api/')) {
      if (panels && pathname.startsWith(operationsPath)) {
        const operation = pathname.slice(operationsPath.length);
        if (!writes.some(body => body.operation_id === operation)) return unexpected();
        const receipt = !hideReceipt && receipts.get(operation);
        if (receipt) return route.fulfill({ json: receipt });
        missingReceipts.add(request.url());
        return route.fulfill({ status: 404, json: { detail: '模拟未找到关注回执' } });
      }
      if (pathname === snapshotPath && readError) {
        return route.fulfill({ status: 503, json: { detail: '模拟读取失败' } });
      }
      const snapshot = {
        today, items, priorities, dependencies,
        attention: [...attention].map(([item_id, enabled]) => ({ item_id, enabled })),
        links: panels ? [{ kind: 'followup', source: 'e0', target: 'pre' }] : [],
        branches: [],
        daily_reviews: panels ? [{ item_id: 'e1', day: today, reviewed_at: `${today}T09:00:00+08:00` }] : [],
      };
      const values = {
        '/api/session': {}, '/api/items': items, '/api/priorities': priorities,
        [snapshotPath]: readback ? readback(snapshot) : snapshot,
        '/api/plan-history-counts': panels && planCount ? { e0: planCount } : {},
        '/api/sources': [], '/api/sources/suggestions': [], '/api/sources/unmatched': [], '/api/sources/follow': [],
      };
      if (Object.hasOwn(values, pathname)) return route.fulfill({ json: values[pathname] });
      const structure = /^\/api\/events\/([^/]+)\/structure$/.exec(pathname);
      const event = structure && items.find(record => record.id === structure[1] && record.type === 'event');
      if (event) return route.fulfill({ json: {
        ...snapshot, events: items.filter(record => record.type === 'event' && record.parent === event.parent),
        snapshot: '0'.repeat(64),
      } });
      if (panels && pathname === '/api/items/e0/daily-follow-ups') return route.fulfill({ json: {
        item: items.find(record => record.id === 'e0'), day: today, records: [], revision: 0,
      } });
      if (panels && pathname === '/api/items/e0/plan-history') return route.fulfill({ json: {
        item: items.find(record => record.id === 'e0'), baseline: { scheduled: true, end: '2026-11-17' },
        records: [{ old_end: '2026-11-17', new_end: '2026-11-18', reason: '合成延期记录',
          changed_at: `${today}T10:00:00+08:00`, account: '测试账号' }],
      } });
      return unexpected();
    }
    if (pathname === bundle && bundleGate) await bundleGate;
    const file = pathname === bundle ? bundle.slice(1) : pathname === '/' ? 'index.html' : path.basename(pathname);
    const contentType = file.endsWith('.js') ? 'text/javascript' :
      file.endsWith('.css') ? 'text/css' : 'text/html';
    try {
      return await route.fulfill({ body: await fs.readFile(path.join(staticDir, file)), contentType });
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      return route.fulfill({ status: 404, body: '' });
    }
  });
  // Keep the native hosts from before any React takeover.
  await page.addInitScript(() => {
    const observer = new MutationObserver(() => {
      window.__workbenchFixtureNotice ??= document.getElementById('notice');
      window.__workbenchFixtureDrawer ??= document.getElementById('workbenchDrawer');
      if (window.__workbenchFixtureNotice && window.__workbenchFixtureDrawer) observer.disconnect();
    });
    observer.observe(document, { childList: true, subtree: true });
  });
  try {
    // Wait for the initial home read and connect()'s debounced read before using
    // controls. A late full redraw can detach the focused goal button between keypresses.
    const url = `${origin}/`;
    let startupReads = 0;
    const ready = page.waitForResponse(response => new URL(response.url()).pathname === snapshotPath &&
      response.ok() && ++startupReads === 2);
    if (noticeClock) {
      await Promise.all([ready, (async () => {
        await page.goto(url, { waitUntil: 'domcontentloaded' });
        await page.waitForFunction(() => noticeMessage === '工作空间已更新');
        await page.clock.runFor(100);
      })()]);
    } else await Promise.all([ready, page.goto(url)]);
    if (!bundleGate) {
      await page.locator('body:not([data-ui-startup])').waitFor({ state: 'attached' });
      await page.locator('#globalWorkbench[data-goal-ui="react"] .wbGoal').first().waitFor();
      await page.waitForFunction(() => !document.querySelector('.wbControls button:disabled'));
    }
  } catch (error) {
    if (failures.length) error.message += `\nFixture failures: ${failures.join('; ')}`;
    throw error;
  }
  return {
    page, context, failures, requests, writes,
    setItems(next) { items = next; },
    setError(next) { readError = next; },
    setAttentionMode(next) { attentionMode = next; },
    setReceiptMissing(next) { hideReceipt = next; },
    setReadback(next) { readback = next; },
    setPlanCount(next) { planCount = next; },
  };
}

async function exercise({ page, failures, setItems, setError }) {
  const cards = page.locator('.wbGoal');
  const names = cards.locator('.wbGoalTitle');
  const stats = cards.locator('.wbGoalStats');
  const scope = page.locator('#wbScope');
  const filter = page.locator('#wbGoalFilter-g1');
  const jump = page.locator('.wbGoalLink[value="g2"]');
  const rows = page.locator('.wbActionRow');
  const refresh = page.getByRole('button', { name: '刷新工作台' });
  const pager = page.getByRole('navigation', { name: '行动清单分页' });
  const reload = async () => {
    await refresh.click();
    await page.waitForFunction(() => !document.querySelector('.wbControls button:disabled'));
  };
  assert.deepEqual(await names.allTextContents(), [goalName, '第二目标']);
  assert.equal(await stats.nth(1).textContent(), '1 模块1 事情1 已完成事情');
  await pager.getByRole('button', { name: '下一页' }).click();
  assert.equal(await rows.count(), 2);
  await filter.focus();
  await page.keyboard.press('Enter');
  assert.equal(await filter.getAttribute('aria-pressed'), 'true');
  assert.equal(await filter.evaluate(element => element === document.activeElement), true);
  assert.equal(await scope.inputValue(), 'g1');
  assert.equal(await rows.count(), 10);
  await page.keyboard.press('Enter');
  assert.equal(await scope.inputValue(), '');
  await scope.selectOption('g2');
  assert.equal(await page.locator('#wbGoalFilter-g2').getAttribute('aria-pressed'), 'true');
  assert.equal(await rows.count(), 0);
  assert.equal(await cards.count(), 2);

  // Navigate through the independent arrow, then return to the same scope.
  await jump.click();
  await page.locator('#workPage').waitFor();
  assert.equal(await page.locator('#goalSelect').inputValue(), 'g2');
  await page.getByRole('button', { name: '工作台', exact: true }).click();
  await cards.first().waitFor();
  assert.equal(await scope.inputValue(), 'g2');
  await scope.selectOption('');

  for (const width of widths) {
    await page.setViewportSize({ width, height: 980 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `workbench does not overflow at ${width}px`);
    assert.ok(await page.evaluate(() => ['.wbHeading', '.wbOverview', '.wbLayout'].every(selector => {
      const { left, right, width, height } = document.querySelector(selector).getBoundingClientRect();
      return left >= 0 && right <= innerWidth + 1 && width > 0 && height > 0;
    })), `workbench regions fit the viewport at ${width}px`);
    await page.screenshot({ path: path.join(output, `react-${width}.png`), fullPage: true });
  }

  setError(true);
  await reload();
  await page.getByText('工作台读取失败：模拟读取失败', { exact: false }).waitFor();
  assert.equal(await cards.count(), 0);
  setError(false);
  await reload();
  assert.equal(await cards.count(), 2);
  await scope.selectOption('g2');
  setItems(baseItems.filter(record => !['g2', 'm2', 't2'].includes(record.id)));
  await reload();
  await page.getByText('所选目标已不可用，请切换到全部目标。', { exact: true }).waitFor();
  await scope.selectOption('');
  assert.equal(await cards.count(), 1);
  setItems([]);
  await reload();
  await page.locator('#globalWorkbench').getByText('暂无目标', { exact: true }).waitFor();
  assert.deepEqual(failures, []);
}

async function assertDrawer(drawer) {
  const ownership = await drawer.evaluate(dialog => {
    const fiber = node => Object.keys(node).some(key => key.startsWith('__reactFiber$') && node[key]?.stateNode === node);
    const descendants = [...dialog.querySelectorAll('*')];
    const content = descendants.filter(node => !(node.parentElement === dialog && node.matches('.iconTip[role="tooltip"]')));
    const label = node => node.id || node.localName;
    return {
      native: dialog === window.__workbenchFixtureDrawer && dialog instanceof HTMLDialogElement &&
        dialog.open && dialog.matches(':modal') && !fiber(dialog),
      labelledBy: dialog.getAttribute('aria-labelledby'),
      owned: content.filter(fiber).map(label),
      unowned: content.filter(node => !fiber(node)).map(label),
      inline: [dialog, ...descendants].flatMap(node => node.getAttributeNames().filter(name => /^on/i.test(name))),
    };
  });
  assert.ok(ownership.native, 'Keep the original native dialog in the modal top layer');
  assert.equal(ownership.labelledBy, 'wbDetailTitle');
  assert.ok(ownership.owned.includes('wbDetailTitle'), 'React really renders the drawer heading');
  assert.ok(ownership.owned.includes('button'), 'React really renders the drawer controls');
  assert.deepEqual(ownership.unowned, [], 'Every drawer descendant belongs to React (except the shared tooltip)');
  assert.deepEqual(ownership.inline, [], 'No legacy inline handlers in the React drawer');
}

async function captureDrawerWidths(page, drawer, state) {
  const originalSize = page.viewportSize();
  for (const width of widths) {
    await page.setViewportSize({ width, height: 980 });
    assert.ok(await drawer.evaluate(dialog => {
      const { left, right } = dialog.getBoundingClientRect();
      return left >= -1 && right <= innerWidth + 1 && dialog.scrollWidth <= dialog.clientWidth &&
        document.documentElement.scrollWidth <= innerWidth;
    }), `${state} drawer does not overflow horizontally at ${width}px`);
    await page.screenshot({ path: path.join(output, `react-${state}-drawer-${width}.png`) });
  }
  await page.setViewportSize(originalSize);
}

async function exercisePanels({ page, failures, requests, writes, setItems, setAttentionMode, setPlanCount }) {
  const workbench = page.locator('#globalWorkbench');
  const layout = workbench.locator('.wbLayout');
  const panel = (name) => layout.locator('section.wbPanel').filter({ has: page.getByRole('heading', { name }) });
  const actions = panel(/^行动清单/);
  const attention = panel(/^持续关注/);
  const reviews = panel(/^本周待评估/);
  const rows = actions.locator('article.wbActionRow');
  const actionTitles = () => rows.locator('.wbTitle').allTextContents();
  const row = name => rows.filter({ has: page.getByRole('button', { name, exact: true }) });
  const sideRows = section => section.locator('article.wbRow');
  const sideRow = (section, name) => sideRows(section).filter({ has: page.getByRole('button', { name, exact: true }) });
  const category = key => actions.locator(`[data-action-category="${key}"]`);
  const daily = key => actions.locator(`[data-daily-filter="${key}"]`);
  const pager = actions.getByRole('navigation', { name: '行动清单分页' });
  const prev = pager.getByRole('button', { name: '上一页' });
  const next = pager.getByRole('button', { name: '下一页' });
  const scope = workbench.locator('#wbScope');
  const focusIs = target => target.evaluate(element => element === document.activeElement);
  const requestCount = key => requests.filter(value => value === key).length;
  const settle = () => page.waitForFunction(() => !document.querySelector('.wbControls button:disabled'));
  const refresh = async () => {
    await workbench.getByRole('button', { name: '刷新工作台' }).click();
    await settle();
  };
  const close = async (dialog, name = '关闭') => {
    await dialog.getByRole('button', { name, exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
  };
  await layout.waitFor();
  await page.locator('#globalWorkbench[data-panels-ui="react"]').waitFor();
  assert.equal(await layout.locator('[onclick], [onchange]').count(), 0, 'React panels must not keep legacy inline handlers');
  assert.equal(await layout.count(), 1);
  assert.deepEqual(await layout.locator('h2').allTextContents(), [
    '行动清单 23', '持续关注 22', '本周待评估 22',
  ]);
  assert.equal(await actions.getByRole('group', { name: '行动分类' }).getByRole('button').count(), 6);
  assert.equal(await daily('pending').getAttribute('aria-label'), '当日未跟进 22 项');
  assert.equal(await daily('done').getAttribute('aria-label'), '当日已跟进 1 项');
  assert.equal(await prev.isDisabled(), true);
  assert.match(await pager.innerText(), /共 22 条 · 第 1–10 条 · 第 1\/3 页/);
  const first = await actionTitles();
  assert.equal(first[0], '行动 0');
  await next.focus();
  await page.keyboard.press('Enter');
  assert.equal(await focusIs(next), true);
  assert.match(await pager.innerText(), /第 11–20 条 · 第 2\/3 页/);
  const second = await actionTitles();
  await page.keyboard.press('Enter');
  assert.equal(await next.isDisabled(), true);
  assert.equal(await focusIs(prev), true);
  assert.match(await pager.innerText(), /第 21–22 条 · 第 3\/3 页/);
  const allActions = [...first, ...second, ...await actionTitles()];
  assert.equal(new Set(allActions).size, 22);
  for (const name of ['等待前置的行动', '尚未到计划开始的行动', '已完成前置', '行动 1']) {
    assert.ok(!allActions.includes(name), `Unexpected action: ${name}`);
  }
  await refresh();
  assert.match(await pager.innerText(), /第 3\/3 页/);
  setItems(panelItems.filter(record => !record.id.startsWith('extra')));
  await refresh();
  assert.match(await pager.innerText(), /第 11–12 条 · 第 2\/2 页/);
  setItems(panelItems);
  await refresh();
  await prev.focus();
  await page.keyboard.press('Enter');
  assert.equal(await focusIs(next), true);

  for (const section of [attention, reviews]) {
    assert.equal(await sideRows(section).count(), 20);
    await section.getByRole('button', { name: '下一页' }).click();
    assert.equal(await sideRows(section).count(), 2);
    assert.equal(await section.getByRole('button', { name: '下一页' }).isDisabled(), true);
  }
  await next.click();
  await category('working').focus();
  await page.keyboard.press('Enter');
  assert.equal(await category('working').getAttribute('aria-pressed'), 'true');
  assert.equal(await focusIs(category('working')), true);
  assert.deepEqual(await actionTitles(), ['行动 0', '另一目标行动']);
  assert.match(await pager.innerText(), /第 1\/1 页/);
  await daily('done').click();
  assert.equal(await daily('done').getAttribute('aria-pressed'), 'true');
  assert.deepEqual(await actionTitles(), ['行动 1']);
  const goal = workbench.locator('#wbGoalFilter-g2');
  await goal.click();
  assert.equal(await scope.inputValue(), 'g2');
  await actions.getByText('暂无符合条件的行动', { exact: true }).waitFor();
  assert.equal(await category('working').getAttribute('aria-pressed'), 'true');
  assert.equal(await daily('done').getAttribute('aria-pressed'), 'true');
  assert.deepEqual(await attention.locator('.wbTitle').allTextContents(), ['另一目标事项']);
  assert.deepEqual(await reviews.locator('.wbTitle').allTextContents(), ['另一目标事项']);
  const ended = attention.getByRole('checkbox', { name: '含已结束' });
  await ended.check();
  assert.deepEqual(await attention.locator('.wbTitle').allTextContents(), ['第二事情', '另一目标事项']);
  await ended.uncheck();

  await sideRow(reviews, '另一目标事项').getByRole('button', { name: '去评估' }).click();
  const priority = page.locator('#priorityDrawer');
  await priority.waitFor();
  assert.equal(await page.locator('#goalSelect').inputValue(), 'g2');
  assert.equal(await page.locator('#moduleChoices input:checked').inputValue(), 'm2');
  assert.equal(await page.locator('#events .detailTitle h1').innerText(), '另一目标事项');
  assert.equal(await priority.locator('#priorityName').innerText(), '另一目标事项');
  assert.equal(await priority.locator('#priorityValue').inputValue(), '2');
  await close(priority);
  await page.getByRole('button', { name: '工作台', exact: true }).click();
  await workbench.waitFor();
  await settle();
  assert.equal(await scope.inputValue(), 'g2');
  await scope.selectOption('g1');
  await daily('pending').click();
  for (const [key, names] of [['today', []], ['overdue', ['行动 0']], ['follow', ['行动 0']]]) {
    await category(key).click();
    assert.deepEqual(await actionTitles(), names);
  }
  await category('undated').click();
  assert.match(await pager.innerText(), /共 20 条/);
  await category('overdue').click();
  const target = row('行动 0');
  assert.match(await target.innerText(), /2026-11-18 截止.*后续跟进/s);
  assert.equal(await target.locator('.wbOverdue').count(), 1);
  assert.equal(await target.locator('.wbLocate').count(), 0);

  const withOneRead = async (key, interact) => {
    const before = requestCount(key);
    await interact();
    assert.equal(requestCount(key), before + 1, key);
  };
  const event = page.locator('#eventDrawer');
  await withOneRead('GET /api/events/e0/structure', async () => {
    await target.locator('[data-dependency-event="e0"]').press('Enter');
    assert.equal(await event.isVisible(), true);
    await event.getByRole('button', { name: '已完成前置', exact: true }).waitFor();
    assert.equal(await event.locator('#predecessorPicker').isVisible(), false);
  });
  await close(event);
  const editor = page.locator('#editor');
  await target.getByRole('button', { name: '行动 0', exact: true }).press('Enter');
  await editor.waitFor();
  assert.equal(await editor.locator('#name').inputValue(), '行动 0');
  await close(editor, '取消');
  assert.equal(await category('overdue').getAttribute('aria-pressed'), 'true');

  const plan = page.locator('#planDrawer');
  await withOneRead('GET /api/items/e0/plan-history', async () => {
    await target.getByRole('button', { name: '延期变更：行动 0' }).click();
    await plan.locator('#newPlanEnd').waitFor();
    assert.equal(await plan.locator('#newPlanEnd').inputValue(), '2026-11-18');
  });
  await close(plan);
  const mark = target.locator('[data-plan="e0"]');
  await mark.waitFor();
  assert.equal(await mark.textContent(), '1');
  setPlanCount(2);
  await refresh();
  await target.getByRole('button', { name: '查看 2 条时间变更记录' }).waitFor();
  assert.equal(await mark.count(), 1);
  await withOneRead('GET /api/items/e0/plan-history', async () => {
    await mark.press('Enter');
    const history = plan.locator('#planRecords summary');
    await history.waitFor();
    assert.equal(await focusIs(history), true);
    await plan.getByText('调整原因：合成延期记录', { exact: true }).waitFor();
  });
  await close(plan);
  setPlanCount(0);
  await refresh();
  await mark.waitFor({ state: 'detached' });

  const follow = page.locator('#dailyFollowDialog');
  await withOneRead('GET /api/items/e0/daily-follow-ups', async () => {
    await target.getByRole('button', { name: '当日跟进：行动 0' }).click();
    await follow.locator('#dailyContext').getByText('行动 0', { exact: true }).waitFor();
    assert.equal(await follow.getByRole('textbox', { name: '本次跟进' }).inputValue(), '');
  });
  await close(follow, '关闭当日跟进');
  assert.deepEqual(writes, []);

  const attentionRow = sideRow(attention, '第一事情');
  const unwatch = attentionRow.getByRole('button', { name: '取消持续关注：第一事情' });
  const drawer = page.locator('#workbenchDrawer');
  const notice = page.locator('#notice');
  setAttentionMode('unknown');
  await unwatch.click();
  await drawer.getByRole('alert').getByText(/模拟关注回执丢失.*未自动重试/).waitFor();
  await assertDrawer(drawer);
  await close(drawer);
  const recovery = workbench.getByRole('button', { name: '核对关注结果' });
  await recovery.waitFor();
  assert.equal(await unwatch.isDisabled(), true);
  assert.equal(writes.length, 1);
  const receipt = `GET /api/operations/${writes[0].operation_id}`;
  assert.equal(requestCount(receipt), 0, 'Receipt lookup must be explicit');
  const beforeRecovery = requests.length;
  await recovery.click();
  await notice.getByText('已核对关注保存结果', { exact: true }).waitFor();
  await attentionRow.waitFor({ state: 'detached' });
  assert.deepEqual(requests.slice(beforeRecovery).filter(key => key === receipt || key === 'GET /api/workbench'), [
    receipt, 'GET /api/workbench',
  ]);
  assert.equal(writes.length, 1);
  assert.equal(await recovery.count(), 0);

  await sideRow(reviews, '第一事情').getByRole('button', { name: '第一事情', exact: true }).click();
  const watch = drawer.getByRole('button', { name: '持续关注：第一事情', exact: true });
  await watch.waitFor();
  assert.equal(await watch.getAttribute('aria-pressed'), 'false');
  await assertDrawer(drawer);
  for (const content of [`${goalName} / 一级模块 / 第一事情`, matterDescription, '责任人 · 测试账号',
    '计划开始 · 未设置', '计划结束 · 未设置', '事件完成率 4% · 1/25', '事情优先级：重要且紧急']) {
    await drawer.getByText(content, { exact: true }).waitFor();
  }
  await captureDrawerWidths(page, drawer, 'detail');
  setAttentionMode('success');
  const beforeSave = requests.length;
  await watch.click();
  await drawer.getByRole('button', { name: '取消持续关注：第一事情', exact: true }).waitFor();
  await notice.getByText('关注状态已保存并读回', { exact: true }).waitFor();
  assert.deepEqual(requests.slice(beforeSave).filter(key => key === `POST ${attentionPath}` || key === 'GET /api/workbench').slice(0, 2), [
    `POST ${attentionPath}`, 'GET /api/workbench',
  ]);
  await close(drawer);
  assert.equal(await unwatch.getAttribute('aria-pressed'), 'true');

  setAttentionMode('reject');
  await unwatch.click();
  await notice.getByText('模拟关注版本冲突；未自动重试', { exact: true }).waitFor();
  assert.equal(await drawer.isVisible(), false);
  assert.equal(await recovery.count(), 0);
  assert.equal(await unwatch.getAttribute('aria-pressed'), 'true');
  assert.equal(await unwatch.isEnabled(), true);
  assert.deepEqual(writes.map(({ enabled, expected_version }) => [enabled, expected_version]), [
    [false, 1], [true, 2], [false, 3],
  ]);
  assert.equal(new Set(writes.map(body => body.operation_id)).size, writes.length);
  for (const { operation_id } of writes) assert.match(operation_id, /^[\da-f-]{36}$/i);
  assert.deepEqual(failures, []);
}

async function exerciseAttentionRecovery(browser, acknowledged) {
  const fixture = await openFixture(browser, true);
  const { page, requests, writes, failures, setAttentionMode, setError, setReceiptMissing, setReadback } = fixture;
  const drawer = page.locator('#workbenchDrawer');
  const workbench = page.locator('#globalWorkbench');
  const row = workbench.locator('.wbRow').filter({
    has: page.getByRole('button', { name: '取消持续关注：第一事情', exact: true }),
  });
  const unwatch = row.getByRole('button', { name: '取消持续关注：第一事情', exact: true });
  const notice = page.locator('#notice');
  const alert = drawer.getByRole('alert');
  const query = drawer.getByRole('button', { name: '查询保存结果', exact: true });
  const retry = drawer.getByRole('button', { name: '使用原操作标识重试', exact: true, includeHidden: true });
  const pending = workbench.getByRole('button', { name: '核对关注结果', exact: true });
  const post = `POST ${attentionPath}`;
  const read = `GET ${snapshotPath}`;
  const saved = '关注状态已保存并读回';
  const recovered = '已核对关注保存结果';
  const mismatch = /当前版本或关注状态与回执不一致/;
  const tracked = from => requests.slice(from).filter(key => key === post || key === read || key.startsWith(`GET ${operationsPath}`));
  const checkPending = async (message, retryAllowed = false) => {
    await alert.getByText(message).waitFor();
    // The previous attempt may carry the same mismatch text during a new lookup.
    await drawer.locator('button:not(:disabled)').and(query).waitFor();
    await assertDrawer(drawer);
    assert.equal(await query.isEnabled(), true);
    assert.equal(await retry.count(), Number(retryAllowed), 'Only an unknown write with a 404 may be replayed');
    assert.doesNotMatch(await notice.textContent(), new RegExp(`${saved}|${recovered}`));
    assert.equal(writes.length, 1, 'No save or lookup may trigger an automatic POST');
  };
  try {
    await unwatch.waitFor();
    // Toggle the read failure only after the POST is intercepted, not on an ambient refresh.
    setAttentionMode(acknowledged ? 'read-failed' : 'uncommitted');
    const start = requests.length;
    const responsePromise = page.waitForResponse(response => new URL(response.url()).pathname === attentionPath &&
      response.request().method() === 'POST');
    await unwatch.click();
    const response = await responsePromise;
    assert.equal(response.status(), acknowledged ? 200 : 503);
    if (acknowledged) {
      const { id, type, version } = await response.json();
      assert.deepEqual([id, type, version], ['t1', 'thing', 2]);
    }
    await checkPending(acknowledged ? /回执存在，但关注状态读取失败/ : /模拟关注提交前中断/);
    assert.deepEqual(tracked(start), acknowledged ? [post, read] : [post]);
    const operation = `GET ${operationsPath}${writes[0].operation_id}`;
    assert.deepEqual(writes[0], { operation_id: writes[0].operation_id, enabled: false, expected_version: 1 });
    assert.match(writes[0].operation_id, /^[\da-f-]{36}$/i);

    // A 404 is read-only. It permits an explicit retry only if no POST receipt was ever known.
    setError(false);
    if (acknowledged) {
      setReceiptMissing(true);
      await drawer.getByRole('button', { name: '关闭', exact: true }).click();
      await drawer.waitFor({ state: 'hidden' });
      await pending.waitFor();
    }
    const before404 = requests.length;
    await (acknowledged ? pending : query).click();
    await checkPending(/模拟未找到关注回执/, !acknowledged);
    assert.deepEqual(tracked(before404), [operation]);

    if (!acknowledged) {
      await captureDrawerWidths(page, drawer, 'recovery');
      setAttentionMode('success');
      const beforeRetry = requests.length;
      await retry.click();
      await notice.getByText(saved, { exact: true }).waitFor();
      await row.waitFor({ state: 'detached' });
      assert.deepEqual(tracked(beforeRetry), [post, read]);
      assert.deepEqual(writes, [writes[0], writes[0]], 'Manual retry reuses the complete original payload and key');
      assert.equal(await pending.count(), 0);
      assert.equal(await retry.count(), 0);
      assert.deepEqual(failures, []);
      return;
    }

    // Keep all responses realistic: the stored ItemOutput receipt remains v2, while the
    // snapshot independently varies its current ItemOutput version, hierarchy, or flag.
    setReceiptMissing(false);
    const withItem = (snapshot, patch) => ({ ...snapshot,
      items: snapshot.items.map(record => record.id === 't1' ? { ...record, ...patch } : record),
    });
    const withFlag = (snapshot, enabled) => ({ ...snapshot,
      attention: snapshot.attention.map(flag => flag.item_id === 't1' ? { ...flag, enabled } : flag),
    });
    for (const inconsistent of [
      snapshot => withItem(snapshot, { version: 1 }), // Correct flag, stale snapshot.
      snapshot => withFlag(snapshot, true), // Enough version, wrong flag.
      snapshot => ({ ...snapshot, attention: snapshot.attention.filter(flag => flag.item_id !== 't1') }), // Not false.
      snapshot => withItem(snapshot, { parent: 'missing-module' }),
    ]) {
      setReadback(inconsistent);
      const beforeQuery = requests.length;
      await query.click();
      await checkPending(mismatch);
      assert.deepEqual(tracked(beforeQuery), [operation, read]);
    }
    setReadback(snapshot => withItem(snapshot, { version: 3 })); // A newer, matching snapshot is also valid.
    const beforeConsistent = requests.length;
    await query.click();
    await notice.getByText(recovered, { exact: true }).waitFor();
    await drawer.waitFor({ state: 'hidden' });
    await row.waitFor({ state: 'detached' });
    assert.deepEqual(tracked(beforeConsistent), [operation, read]);
    assert.equal(writes.length, 1, 'The acknowledged operation was sent exactly once');
    assert.equal(await pending.count(), 0);
    assert.deepEqual(failures, []);
  } finally {
    await fixture.context.close();
  }
}

async function assertNotice(page, message, { starting = false } = {}) {
  const notice = page.locator('#notice');
  assert.equal(await notice.count(), 1, 'Keep a single global status host');
  const state = await notice.evaluate(host => {
    const privateValue = (node, prefix) => node?.[Object.keys(node).find(key => key.startsWith(prefix))];
    const root = privateValue(host, '__reactContainer$')?.stateNode;
    const child = host.firstElementChild;
    const fiber = privateValue(child, '__reactFiber$');
    let owner = fiber;
    while (owner?.return) owner = owner.return;
    return {
      original: host === window.__workbenchFixtureNotice && !privateValue(host, '__reactFiber$'),
      role: host.getAttribute('role'), live: host.getAttribute('aria-live'),
      root: root?.containerInfo === host,
      ownsTextSpan: !!child && child.localName === 'span' && fiber?.stateNode === child &&
        !!root && owner?.stateNode === root,
      message: noticeMessage,
      text: host.textContent,
      nodes: [...host.childNodes].map(node => node.nodeName),
      spanNodes: child ? [...child.childNodes].map(node => node.nodeName) : [],
    };
  });
  const visible = Boolean(message) && !starting;
  assert.deepEqual(state, {
    original: true, role: 'status', live: 'polite', root: !starting,
    ownsTextSpan: visible, message, text: starting ? '' : message,
    nodes: visible ? ['SPAN'] : [],
    spanNodes: visible ? ['#text'] : [],
  });
  assert.equal(await notice.isVisible(), visible);
  if (visible) {
    assert.equal(await page.getByText(message, { exact: true }).count(), 1, 'A notice must not be rendered twice');
    assert.equal(await page.getByRole('status').filter({ hasText: message }).count(), 1);
  }
}

async function exerciseNotice(browser) {
  let releaseBundle;
  const bundleGate = new Promise(resolve => { releaseBundle = resolve; });
  let fixture;
  try {
    fixture = await openFixture(browser, false, { noticeClock: true, bundleGate });
    const { page, failures, writes } = fixture;
    const first = '接管前的合成提示';
    const second = '将被覆盖的合成提示';
    const literal = '新提示：<em data-notice-probe>纯文本</em> & "引号"';
    // Exercise the shared notice producer directly without changing data or using an API.
    const notify = message => page.evaluate(value => window.notify(value), message);
    const tick = milliseconds => page.clock.runFor(milliseconds);
    await assertNotice(page, '工作空间已更新', { starting: true });
    const drawer = page.locator('#workbenchDrawer');
    assert.deepEqual(await drawer.evaluate(node => ({
      original: node === window.__workbenchFixtureDrawer,
      native: node instanceof HTMLDialogElement, open: node.open,
      children: node.childNodes.length, mounted: node.hasAttribute('data-react-owned'),
    })), { original: true, native: true, open: false, children: 0, mounted: false },
    'The original native workbench drawer stays empty while React is loading');
    await notify(first);
    await assertNotice(page, first, { starting: true });
    await tick(2000);
    releaseBundle();
    await page.locator('body:not([data-ui-startup])').waitFor({ state: 'attached' });
    await page.locator('#globalWorkbench[data-goal-ui="react"]').waitFor();
    assert.deepEqual(await drawer.evaluate(node => ({
      original: node === window.__workbenchFixtureDrawer,
      native: node instanceof HTMLDialogElement, open: node.open,
      children: node.childNodes.length, mounted: node.hasAttribute('data-react-owned'),
    })), { original: true, native: true, open: false, children: 0, mounted: true },
    'React owns the original drawer and waits for a user action before rendering its contents');
    await assertNotice(page, first);
    const focus = page.locator('#wbScope');
    const assertFocus = async () => assert.ok(await focus.evaluate(node => node === document.activeElement),
      'Showing, replacing and clearing a status must not move focus');
    await focus.focus();
    await tick(2499);
    await assertNotice(page, first);
    await tick(1);
    await assertNotice(page, ''); // 4500ms from notify(), not from React's mount.
    await assertFocus();

    await notify(second);
    await assertNotice(page, second);
    await assertFocus();
    await tick(750);
    await notify(literal);
    await assertNotice(page, literal);
    assert.equal(await page.getByText(second, { exact: true }).count(), 0);
    await assertFocus();
    await tick(3750);
    await assertNotice(page, literal); // The previous message's deadline must not clear its replacement.

    for (const width of widths) {
      await page.setViewportSize({ width, height: 980 });
      assert.ok(await page.locator('#notice').evaluate(host => {
        const { x, y, right, bottom } = host.getBoundingClientRect();
        return x >= 0 && y >= 0 && right <= innerWidth && bottom <= innerHeight &&
          host.scrollWidth <= host.clientWidth && document.documentElement.scrollWidth <= innerWidth;
      }), `notice fits at ${width}px without horizontal overflow`);
      await page.screenshot({ path: path.join(output, `react-notice-${width}.png`) });
    }
    await tick(749);
    await assertNotice(page, literal);
    await tick(1);
    await assertNotice(page, '');
    await assertFocus();
    assert.deepEqual(writes, []);
    assert.deepEqual(failures, []);
  } finally {
    releaseBundle?.();
    await fixture?.context.close();
  }
}

(async () => {
  await fs.access(path.join(staticDir, bundle.slice(1)));
  await fs.mkdir(output, { recursive: true });
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const workbench = await openFixture(browser);
    try { await exercise(workbench); } finally { await workbench.context.close(); }
    const panels = await openFixture(browser, true);
    try { await exercisePanels(panels); } finally { await panels.context.close(); }
    await exerciseAttentionRecovery(browser, true);
    await exerciseAttentionRecovery(browser, false);
    await exerciseNotice(browser);
    console.log(`React workbench passed: overview, panels, attention recovery, and status notice at ${widths.join('/')}px.`);
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
