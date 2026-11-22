// Browser regression using synthetic records and a stubbed model endpoint.
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '../frontend-react/public');
const react = true;
const bundle = '/dist/workbench-react.js';
const output = path.resolve(__dirname, '../../runtime', `event-dependencies-ui${react ? '-react' : ''}`);
const base = 'http://127.0.0.1:18921';

async function assertReactRegion(page, selector) {
  const region = page.locator(selector);
  await region.waitFor();
  const inline = await region.evaluate(root => [root, ...root.querySelectorAll('*')].flatMap(node =>
    node.getAttributeNames().filter(name => /^on/i.test(name)).map(name => `${node.id || node.tagName}.${name}`)));
  assert.deepEqual(inline, [], `${selector} must not contain inline event handlers`);
}
async function assertPredecessorOwnership(panel) {
  await panel.waitFor();
  const actual = await panel.evaluate(root => {
    const nodes = [root, ...root.querySelectorAll('*')];
    const label = node => node.id || node.localName;
    const keys = node => Object.keys(node);
    const fiber = node => keys(node).some(key => key.startsWith('__reactFiber$') && node[key]?.stateNode === node);
    return {
      owned: nodes.filter(fiber).map(label),
      unowned: nodes.filter(node => !fiber(node)).map(label),
      nestedRoots: nodes.filter(node => keys(node).some(key => key.startsWith('__reactContainer$'))).map(label),
      inline: nodes.flatMap(node => node.getAttributeNames().filter(name => /^on/i.test(name)).map(name => `${label(node)}.${name}`)),
    };
  });
  assert.deepEqual(actual.nestedRoots, [], 'The predecessor panel is not a separate React root');
  if (react) {
    assert.ok(actual.owned.includes('eventDependencies'));
    assert.deepEqual(actual.unowned, [], 'React owns the entire predecessor panel, including dynamic rows');
    assert.deepEqual(actual.inline, []);
  } else assert.deepEqual(actual.owned, [], 'Default predecessor panel stays legacy');
}
const day = '2026-11-19';
const predecessorName = '原型评审 <b data-wait-probe="literal">&</b>';
const item = (id, type, parent, name, status = 'notStarted', planStart = '') =>
  ({ id, type, parent, name, status, planStart, planEnd: '', owner: '', description: '', version: 1 });

async function assertWaitingOwnership(layer, original, open) {
  const actual = await layer.evaluate((host, originalHost) => {
    const reactField = (el, prefix) => el[Object.getOwnPropertyNames(el).find(key => key.startsWith(prefix))];
    const root = reactField(host, '__reactContainer$')?.stateNode;
    const nodes = [...host.querySelectorAll('*')];
    return {
      original: host === originalHost,
      onBody: host.parentElement === document.body,
      marked: host.hasAttribute('data-react-owned'),
      root: root?.containerInfo === host,
      hostFiber: reactField(host, '__reactFiber$')?.stateNode === host,
      nodes: nodes.map(node => {
        const fiber = reactField(node, '__reactFiber$');
        let top = fiber;
        while (top?.return) top = top.return;
        return {
          tag: node.localName,
          fiber: fiber?.stateNode === node,
          inRoot: !!root && top?.stateNode === root,
          inline: node.getAttributeNames().filter(name => /^on/i.test(name)),
        };
      }),
    };
  }, original);
  const tags = open ? ['div', 'strong', 'ul', 'li'] : [];
  assert.deepEqual(actual, {
    original: true, onBody: true, marked: react, root: react, hostFiber: false,
    nodes: tags.map(tag => ({ tag, fiber: react, inRoot: react, inline: [] })),
  }, 'Waiting layer stays attached to body; every rendered child belongs to its own React root in preview');
}

async function checkWaiting(page, width, badge, futureBadge, apiCalls) {
  const layer = page.locator('#dependencyWaitLayer');
  const originalLayer = await layer.elementHandle();
  assert.ok(originalLayer, 'Waiting layer must exist before opening');
  const popover = layer.getByRole('region', { name: '等待原因', exact: true });
  const assertExpanded = async (trigger, expanded) => {
    assert.equal(await trigger.getAttribute('aria-expanded'), String(expanded));
    assert.equal(await trigger.getAttribute('aria-controls'), expanded ? 'dependencyWaitReason' : null);
  };
  const assertOpen = async (trigger, other, reason) => {
    await popover.waitFor();
    assert.equal(await popover.getAttribute('id'), 'dependencyWaitReason');
    assert.equal(await popover.locator(':scope > strong').textContent(), '等待原因');
    assert.deepEqual(await popover.locator(':scope > ul > li').allTextContents(), [reason]);
    assert.equal(await popover.locator('li *').count(), 0, 'Markup in a predecessor name stays literal text');
    await assertExpanded(trigger, true);
    await assertExpanded(other, false);
    await assertWaitingOwnership(layer, originalLayer, true);
  };
  const assertClosed = async () => {
    await popover.waitFor({ state: 'hidden' });
    await assertExpanded(badge, false);
    await assertExpanded(futureBadge, false);
    await assertWaitingOwnership(layer, originalLayer, false);
  };
  const cancelled = `「${predecessorName}」已取消，请核对前置`;
  const planned = '未到计划开始日 2026-11-23';

  const settleScroll = () => page.evaluate(() => new Promise(resolve => {
    requestAnimationFrame(() => requestAnimationFrame(resolve));
  }));
  const reveal = async trigger => {
    await trigger.scrollIntoViewIfNeeded();
    await settleScroll();
  };
  await assertClosed();
  // Reveal both triggers before the first open; bringing the second into view mid-click
  // would make the real scroll listener close the replacement popover.
  await reveal(futureBadge);
  await reveal(badge);
  const beforeWaiting = apiCalls.length;
  await badge.press('Enter');
  await assertOpen(badge, futureBadge, cancelled);
  assert.match(await popover.innerText(), /原型评审.*已取消/);
  const [anchor, tip] = await Promise.all([badge.boundingBox(), popover.boundingBox()]);
  assert.ok(anchor && tip && tip.y + tip.height <= anchor.y && tip.x >= 0 && tip.x + tip.width <= width);
  assert.ok(tip.y >= 0, 'Waiting reason stays within the viewport above its trigger');
  assert.equal(await popover.evaluate(node => getComputedStyle(node).position), 'fixed');
  await page.screenshot({ path: path.join(output, 'waiting-' + width + '.png') });
  // Move focus first so a no-op focus restore would not pass the Escape assertion.
  await futureBadge.evaluate(node => node.focus({ preventScroll: true }));
  assert.equal(await futureBadge.evaluate(node => document.activeElement === node), true);
  await page.keyboard.press('Escape');
  await assertClosed();
  assert.equal(await badge.evaluate(node => document.activeElement === node), true, 'Escape restores focus to the opening trigger');

  await badge.click();
  await popover.waitFor();
  await futureBadge.click();
  await assertOpen(futureBadge, badge, planned);
  await popover.locator('li').click();
  await assertOpen(futureBadge, badge, planned);
  await futureBadge.click();
  await assertClosed();
  await futureBadge.click();
  await assertOpen(futureBadge, badge, planned);
  // Click a passive viewport point without auto-scrolling another locator into view first.
  assert.equal(await page.evaluate(() => !document.elementFromPoint(1, 1)?.closest('button, #dependencyWaitLayer')), true);
  await page.mouse.click(1, 1);
  await assertClosed();

  await badge.click();
  await popover.waitFor();
  await page.setViewportSize({ width, height: 600 });
  await assertClosed();
  await reveal(badge);
  await badge.click();
  await popover.waitFor();
  assert.equal(await page.evaluate(() => {
    const scroller = document.scrollingElement;
    const before = scroller.scrollTop;
    // Both the top and the bottom of a long work page allow one direction of scroll.
    scroller.scrollTop = before + (before > 0 ? -1 : 1);
    return scroller.scrollTop !== before;
  }), true, 'The work page actually scrolled');
  await assertClosed();
  await page.setViewportSize({ width, height: 900 });
  assert.deepEqual(apiCalls.slice(beforeWaiting), [], 'Opening and dismissing the waiting reason makes no API requests');

  await badge.click();
  await popover.waitFor();
  // Invoke the existing list reload directly so an outside click cannot hide a refresh regression.
  await page.evaluate(() => loadEventTree());
  await assertClosed();
  assert.deepEqual(apiCalls.slice(beforeWaiting), [
    'GET /api/events/pre/structure',
    ...(!react ? ['GET /api/sources/follow'] : []), // Legacy list paint also refreshes reminder rules.
  ], 'The explicit list reload makes only its existing reads');
}

async function checkWidth(browser, width) {
  const page = await browser.newPage({ viewport: { width, height: 900 }, serviceWorkers: 'block' });
  page.setDefaultTimeout(8000);
  const errors = [];
  const writes = [], attempts = [], modelCalls = [], readbacks = [], apiCalls = [];
  const pendingApi = new Set();
  let lastApiChange = 0;
  page.on('request', request => {
    const { pathname } = new URL(request.url());
    if (!pathname.startsWith('/api/')) return;
    apiCalls.push(`${request.method()} ${pathname}`);
    pendingApi.add(request);
    lastApiChange = Date.now();
  });
  const finishApi = request => {
    if (pendingApi.delete(request)) lastApiChange = Date.now();
  };
  page.on('requestfinished', finishApi);
  page.on('requestfailed', finishApi);
  async function expectApiQuiet() {
    const deadline = Date.now() + 8000;
    while (pendingApi.size || Date.now() - lastApiChange < 300) {
      assert.ok(Date.now() < deadline, 'Fixture requests must settle before exercising the waiting layer');
      await new Promise(resolve => setTimeout(resolve, 30));
    }
  }
  let modelRequests = 0;
  let revision = 0;
  let pendingReadback;
  let releaseLateModel;
  const lateModel = new Promise(resolve => { releaseLateModel = resolve; });
  const expectedWrites = [
    { id: 'ready', predecessor_ids: ['basis'] },
    { id: 'ready', predecessor_ids: ['basis', 'future'], rejected: true },
    { id: 'ready', predecessor_ids: ['basis', 'future'] },
    { id: 'ready', predecessor_ids: ['basis'] },
    { id: 'ready', predecessor_ids: [] },
    { id: 'ended', predecessor_ids: [] },
  ];
  const recommendationPath = '/api/events/ready/predecessor-recommendations';
  const fingerprint = () => revision.toString(16).padStart(64, '0');
  const items = [
    item('g', 'goal', null, '产品交付'), item('m', 'module', 'g', '改造'),
    item('t', 'thing', 'm', '工作台'), item('pre', 'event', 't', predecessorName, 'cancelled'),
    item('blocked', 'event', 't', '技术评审', 'working'), item('ready', 'event', 't', '核对文案'),
    item('basis', 'event', 't', '确定验收口径', 'working'),
    item('future', 'event', 't', '下周验证', 'notStarted', '2026-11-23'),
    item('ended', 'event', 't', '完成的技术准备', 'completed'),
  ];
  let dependencies = [
    { event_id: 'blocked', predecessor_id: 'pre' },
    { event_id: 'ended', predecessor_id: 'pre' },
  ];
  const priorities = { week: '2026-11-16', items: [] };
  page.on('pageerror', error => errors.push(error.message));
  await page.context().routeWebSocket('**/*', socket => {
    errors.push(`Unexpected WebSocket: ${socket.url()}`);
    return socket.close();
  });
  await page.context().route('**/*', async route => {
    const request = route.request();
    const { origin, pathname } = new URL(request.url());
    const method = request.method();
    const reject = reason => {
      errors.push(`${reason}: ${method} ${request.url()}`);
      return route.abort();
    };
    // Every request is blocked or fulfilled from fixture data or local static files.
    if (origin !== base) return reject('Unexpected origin');
    try {
      if (!pathname.startsWith('/api/')) {
        if (method !== 'GET') return reject('Unexpected static request');
        if (pathname === '/favicon.ico') return route.fulfill({ status: 204 });
        if (pathname !== '/' && !(react && pathname === bundle) && !/^\/[-\w]+\.(?:js|css)$/.test(pathname)) {
          return reject('Unexpected static resource');
        }
        const name = pathname === '/' ? 'index.html' : pathname.slice(1);
        const type = name.endsWith('.js') ? 'text/javascript' : name.endsWith('.css') ? 'text/css' : 'text/html';
        return route.fulfill({ path: path.join(root, name), contentType: type });
      }
      const snapshot = { items, today: day, priorities, dependencies, attention: [], branches: [], links: [], daily_reviews: [] };
      const eventRequest = /^\/api\/events\/([\w-]+)\/(structure|children)$/.exec(pathname);
      const [, id, operation] = eventRequest || [];
      if (method === 'GET' && operation === 'structure' && items.some(row => row.type === 'event' && row.id === id)) {
        if (pendingReadback?.id === id) {
          assert.equal(pendingReadback.structure, false, 'Read the saved structure only once');
          pendingReadback.structure = true;
        }
        return route.fulfill({ json: { ...snapshot, events: items.filter(row => row.type === 'event'), snapshot: fingerprint() } });
      }
      if (method === 'POST' && pathname === recommendationPath) {
        modelRequests++;
        const body = request.postDataJSON();
        assert.deepEqual(body, { consent: true, snapshot: fingerprint() });
        modelCalls.push(body);
        if (modelRequests === 1) return route.fulfill({ json: [{ id: 'basis', reason: '文案依据验收口径。' }] });
        if (modelRequests === 2) return route.fulfill({ status: 503, json: { detail: '模拟前置推荐失败' } });
        if (modelRequests === 3) return route.fulfill(await lateModel);
        return reject('Unexpected repeat model request');
      }
      if (method === 'POST' && operation === 'children') {
        const expected = expectedWrites[attempts.length];
        assert.equal(id, expected?.id, 'Unexpected event write');
        const { operation_id, ...body } = request.postDataJSON();
        assert.match(operation_id, /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/);
        assert.ok(!attempts.includes(operation_id), 'Each explicit attempt uses a fresh operation ID');
        assert.deepEqual(body, { action: 'predecessors', snapshot: fingerprint(), predecessor_ids: expected.predecessor_ids });
        attempts.push(operation_id);
        if (expected.rejected) return route.fulfill({ status: 422, json: { detail: '模拟前置保存失败' } });
        assert.equal(pendingReadback, undefined, 'Finish the previous readback before another write');
        writes.push(body);
        revision++;
        dependencies = dependencies.filter(edge => edge.event_id !== id).concat(
          body.predecessor_ids.map(target => ({ event_id: id, predecessor_id: target })),
        );
        pendingReadback = { id, snapshot: fingerprint(), structure: false };
        return route.fulfill({ json: { action: body.action, created: [] } });
      }
      if (method !== 'GET') return reject('Unexpected API write');
      if (pathname === '/api/items' && pendingReadback) {
        assert.equal(pendingReadback.structure, true, 'Read the updated structure before refreshing items');
        readbacks.push({ id: pendingReadback.id, snapshot: pendingReadback.snapshot });
        pendingReadback = undefined;
      }
      const fixtures = {
        '/api/session': {}, '/api/items': items, '/api/workbench': snapshot,
        '/api/priorities': priorities, '/api/plan-history-counts': {},
        '/api/sources': [], '/api/sources/suggestions': [], '/api/sources/unmatched': [], '/api/sources/follow': [],
      };
      if (Object.hasOwn(fixtures, pathname)) return route.fulfill({ json: fixtures[pathname] });
      return reject('Unexpected API read');
    } catch (error) {
      return reject(error.message);
    }
  });
  try {
    await page.goto(`${base}/`);
    const rows = page.locator(`${react ? '#globalWorkbench[data-panels-ui="react"]' : '#globalWorkbench'} .wbActionRow`);
    await rows.filter({ hasText: '核对文案' }).waitFor();
    if (react) await assertReactRegion(page, '#globalWorkbench[data-panels-ui="react"]');
    assert.equal(await rows.filter({ hasText: '核对文案' }).locator('.dependencyShortcut').count(), 0);
    assert.equal(await rows.filter({ hasText: '技术评审' }).count(), 0);
    assert.equal(await rows.filter({ hasText: '下周验证' }).count(), 0);
    await page.screenshot({ path: path.join(output, 'current-' + width + '.png') });

    const categories = page.getByRole('group', { name: '行动分类' });
    assert.equal(await page.getByRole('combobox', { name: '行动范围' }).count(), 0);
    assert.equal(await page.locator('#globalWorkbench .wbActionScope').count(), 0);
    await page.locator('#wbScope').waitFor();
    assert.equal(await categories.getByRole('button').count(), 6);
    const working = categories.locator('[data-action-category=working]');
    // Earlier fixture reads can replace the legacy button; focus the current node as part of the key action.
    await working.press('Enter');
    assert.equal(await working.getAttribute('aria-pressed'), 'true');
    assert.equal(await working.evaluate(button => document.activeElement === button), true);
    assert.equal(await rows.filter({ hasText: '核对文案' }).count(), 0);
    assert.equal(await rows.count(), 1);
    assert.match(await rows.first().innerText(), /确定验收口径/);
    await categories.locator('[data-action-category=all]').click();
    await page.getByRole('button', { name: '目标与事情', exact: true }).click();
    await page.waitForFunction(() => !wbLoading && document.querySelector('#events .progressSummary')
      ?.textContent.includes('最末级完成'));
    const eventRows = page.locator('#events tbody tr');
    const blocked = eventRows.filter({ hasText: '技术评审' });
    await blocked.waitFor();
    const futureBadge = eventRows.filter({ hasText: '下周验证' }).getByRole('button', { name: /等待，查看原因/ });
    await futureBadge.waitFor();
    if (react) await assertReactRegion(page, '#events[data-events-ui="react"]');
    assert.match(await blocked.innerText(), /进行中/);
    assert.doesNotMatch(await blocked.innerText(), /已取消/);
    const badge = blocked.getByRole('button', { name: /等待，查看原因/ });
    // Let startup reads and their 100 ms workbench/120 ms plan-mark debounces settle.
    // A quiet window measured from the last completed request also covers chained reads.
    await expectApiQuiet();
    await checkWaiting(page, width, badge, futureBadge, apiCalls);

    const drawer = page.locator('#eventDrawer');
    const panel = drawer.locator('#eventDependencies');
    const shortcut = eventRows.filter({ hasText: '核对文案' }).getByRole('button', { name: '前置事件', exact: true });
    await shortcut.scrollIntoViewIfNeeded();
    assert.equal(await shortcut.locator('svg').count(), 1);
    assert.equal(await page.locator('#events tbody tr').filter({ hasText: '原型评审' })
      .getByRole('button', { name: '前置事件', exact: true }).count(), 0);
    await page.screenshot({ path: path.join(output, 'row-predecessor-' + width + '.png') });
    await shortcut.press('Enter');
    const picker = drawer.locator('#predecessorPicker');
    await picker.waitFor();
    assert.equal(await picker.evaluate(select => document.activeElement === select), true);
    await assertPredecessorOwnership(panel);
    assert.equal(modelRequests, 0);
    assert.equal(writes.length, 0);
    assert.equal(attempts.length, 0);
    await drawer.getByRole('button', { name: '收起前置设置', exact: true }).click();
    const edit = drawer.getByRole('button', { name: '设置前置', exact: true });
    await edit.waitFor();
    assert.equal((await edit.innerText()).trim(), '');
    assert.equal(await edit.getAttribute('title'), '设置前置');
    assert.equal(await edit.locator('svg').count(), 1);
    assert.equal(await edit.evaluate(button => getComputedStyle(button).borderTopWidth), '0px');
    assert.equal(await drawer.getByText('关联事件', { exact: true }).count(), 0);
    assert.equal(modelRequests, 0);
    await edit.click();
    const identify = drawer.getByRole('button', { name: 'AI 识别前置', exact: true });
    await identify.waitFor();
    assert.equal(modelRequests, 0);
    assert.equal(await drawer.getByText('保存前置', { exact: true }).count(), 0);
    await identify.click();
    const addition = drawer.getByRole('button', { name: '添加推荐：确定验收口径' });
    await addition.waitFor();
    await assertPredecessorOwnership(panel);
    assert.equal(modelRequests, 1);
    assert.equal(writes.length, 0);
    assert.equal(attempts.length, 0, 'Showing a recommendation never attempts a write');
    await page.screenshot({ path: path.join(output, 'recommendation-' + width + '.png') });
    await addition.click();
    const removeRecommended = drawer.getByRole('button', { name: '移除：确定验收口径', exact: true });
    await removeRecommended.waitFor();
    assert.equal(writes.length, 1);
    assert.equal(readbacks.length, 1);
    const manual = drawer.getByRole('button', { name: '添加前置', exact: true });
    await picker.selectOption('future');
    await manual.click();
    await panel.getByText('模拟前置保存失败', { exact: true }).waitFor();
    await assertPredecessorOwnership(panel);
    assert.equal(writes.length, 1);
    assert.equal(attempts.length, 2);
    assert.equal(readbacks.length, 1, 'Definitive failure neither retries nor reads back a write');
    assert.equal(await picker.inputValue(), 'future');
    await manual.click();
    const removeManual = drawer.getByRole('button', { name: '移除：下周验证', exact: true });
    await removeManual.waitFor();
    assert.equal(writes.length, 2);
    await removeManual.click();
    await removeManual.waitFor({ state: 'detached' });
    assert.equal(writes.length, 3);
    assert.equal(await drawer.isVisible(), true);
    assert.equal(await picker.evaluate(select => document.activeElement === select), true, 'Readback restores focus to the picker');

    await identify.click();
    const recommendationError = panel.getByRole('status').filter({ hasText: '模拟前置推荐失败' });
    await recommendationError.waitFor();
    assert.equal(modelRequests, 2, 'A failed recommendation is not retried automatically');
    assert.equal(attempts.length, 4, 'A failed recommendation cannot write');
    assert.equal(await manual.isVisible(), true, 'Manual selection remains available after a model error');
    assert.equal(await panel.getByRole('button', { name: /^添加推荐：/ }).count(), 0);

    // Synchronize after the browser reads the response and its awaiting controller runs,
    // not just after response headers arrive or an arbitrary sleep elapses.
    await page.evaluate(() => {
      const original = api;
      api = async (...args) => {
        try { return await original(...args); }
        finally {
          if (args[0] === '/events/ready/predecessor-recommendations') {
            api = original;
            setTimeout(() => { window.predecessorRecommendationSettled = true; }, 0);
          }
        }
      };
    });
    await identify.click();
    await panel.getByRole('status').filter({ hasText: '正在分析同一事情下的事件…' }).waitFor();
    assert.equal(await identify.isDisabled(), true);
    await page.keyboard.press('Escape');
    await drawer.waitFor({ state: 'hidden' });
    await shortcut.press('Enter');
    await picker.waitFor({ state: 'visible' });
    assert.equal(await identify.isEnabled(), true, 'Reopening does not carry an old model request into the new drawer');
    releaseLateModel({ json: [{ id: 'future', reason: '上一轮请求的迟到推荐' }] });
    await page.waitForFunction(() => window.predecessorRecommendationSettled === true);
    assert.equal(await panel.getByRole('button', { name: '添加推荐：下周验证', exact: true }).count(), 0);
    assert.equal(await panel.getByText('上一轮请求的迟到推荐', { exact: true }).count(), 0);
    assert.equal(modelRequests, 3, 'Reopening and receiving a late response do not submit a new request');
    assert.equal(attempts.length, 4, 'A late recommendation cannot write');
    await page.keyboard.press('Escape');
    await drawer.waitFor({ state: 'hidden' });
    await page.getByRole('button', { name: '工作台', exact: true }).click();
    const changed = rows.filter({ hasText: '核对文案' });
    await changed.waitFor({ state: 'hidden' });
    items.find(row => row.id === 'basis').status = 'completed';
    await page.getByRole('button', { name: '刷新工作台' }).click();
    await changed.getByRole('button', { name: '前置事件', exact: true }).click();
    await edit.click();
    await removeRecommended.click();
    await removeRecommended.waitFor({ state: 'detached' });
    await page.keyboard.press('Escape');
    await drawer.waitFor({ state: 'hidden' });
    await changed.waitFor();
    await changed.locator('.dependencyShortcut').waitFor({ state: 'detached' });
    assert.equal(writes.length, 4);

    await page.getByRole('button', { name: '目标与事情', exact: true }).click();
    const ended = eventRows.filter({ has: page.getByRole('button', { name: '完成的技术准备', exact: true }) });
    await ended.getByRole('button', { name: '前置事件', exact: true }).click();
    const removeEnded = panel.getByRole('button', { name: `移除：${predecessorName}`, exact: true });
    await removeEnded.waitFor();
    assert.equal(await picker.isVisible(), false, 'Ended events can remove but cannot add predecessors');
    assert.equal(await identify.isVisible(), false);
    await assertPredecessorOwnership(panel);
    await removeEnded.click();
    await removeEnded.waitFor({ state: 'detached' });
    await panel.getByText('暂无前置事件', { exact: true }).waitFor();
    assert.equal(await edit.isVisible(), false);
    assert.equal(await drawer.isVisible(), true);
    assert.deepEqual(dependencies, [{ event_id: 'blocked', predecessor_id: 'pre' }], 'Only the requested edges changed');
    assert.equal(items.find(row => row.id === 'ended').status, 'completed');
    assert.equal(writes.length, 5);
    assert.equal(attempts.length, expectedWrites.length);
    assert.deepEqual(readbacks, expectedWrites.filter(entry => !entry.rejected).map(({ id }, index) =>
      ({ id, snapshot: (index + 1).toString(16).padStart(64, '0') })));
    assert.deepEqual(modelCalls.map(call => call.snapshot), [0, 3, 3].map(value => value.toString(16).padStart(64, '0')));
    assert.equal(modelRequests, 3);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), width);
    assert.deepEqual(errors, []);
  } catch (error) {
    if (errors.length) error.message += `\nFixture problems: ${errors.join('; ')}`;
    throw error;
  } finally {
    releaseLateModel({ json: [] });
    await page.close();
  }
}

async function main() {
  if (react) fs.accessSync(path.join(root, bundle.slice(1)), fs.constants.R_OK);
  fs.mkdirSync(output, { recursive: true });
  const browser = await chromium.launch({ channel: 'chrome', headless: true,
    args: ['--disable-background-networking', '--host-resolver-rules=MAP * ~NOTFOUND'] });
  try {
    for (const width of [1440, 1024, 768, 375]) {
      await checkWidth(browser, width);
      console.log(width + 'px passed');
    }
  } finally {
    await browser.close();
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
