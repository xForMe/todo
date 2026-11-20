// TEST-025: local static files and in-memory fixtures only. No server, model or database.
// From the repo root: node code/frontend-react/test/event-drawer.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require('playwright');

const frontend = path.resolve(__dirname, '../public');
const output = path.resolve(__dirname, '../../../runtime/react-event-drawer');
const widths = [1440, 1024, 768, 375];
const origin = 'http://127.0.0.1:18889'; // Intercepted virtual origin; no listener.
const bundle = '/dist/workbench-react.js';
const currentName = '样稿评审 <原样 & 保留>';
const closedName = '已完成的历史会议';
const predecessorName = '准备评审材料';
const description = '合成事件说明 <不解析为 HTML>';
const suggestions = [
  { name: '模型候选 <拟定>', description: '建议说明 & 资料', reason: '第一项合成理由' },
  { name: '模型候选二', description: '不应写入', reason: '第二项合成理由' },
];
const aiChild = {
  name: '  人工修改 <最终>  ', description: '更新说明 & 资料', owner: '测试负责人',
  planStart: '2026-11-20', planEnd: '2026-11-22',
};
const manualChild = { name: '手动子事件', description: '模型失败后的备用路径', owner: '', planStart: '', planEnd: '' };
const followup = { name: '复核历史会议反馈', description: '跟进独立于历史完成状态', owner: '跟进者', planStart: '', planEnd: '' };
const fingerprint = revision => revision.toString(16).padStart(64, '0');
const item = (id, type, parent, name, extra = {}) => ({
  id, type, parent, name, description: '', owner: '', planStart: '', planEnd: '',
  status: 'notStarted', version: 1, ...extra,
});

async function intercept(context, page) {
  const items = [
    item('g', 'goal', null, '合成目标'), item('m', 'module', 'g', '合成模块'), item('t', 'thing', 'm', '合成事情'),
    item('active', 'event', 't', currentName, { status: 'working', description, owner: '原负责人', planStart: '2026-11-19' }),
    item('past', 'event', 't', closedName, { status: 'completed' }),
    item('pre', 'event', 't', predecessorName, { status: 'completed' }),
  ];
  const dependencies = [{ event_id: 'active', predecessor_id: 'pre' }];
  const branches = [], links = [], writes = [], models = [], receiptReads = [], imageReads = [], problems = [];
  const recoveryRequests = [], apiRequests = [];
  const receipts = new Map();
  const priorities = { week: '2026-11-16', items: [] };
  const snapshot = () => ({ items, priorities, today: '2026-11-19', attention: [], branches, links, dependencies });
  const preview = gate();
  let revision = 0, itemReads = 0, nextModel, nextWrite, nextReceipt, failItems = false;
  page.on('pageerror', error => problems.push(error.message));
  page.on('request', request => {
    const { pathname } = new URL(request.url());
    if (pathname.startsWith('/api/')) apiRequests.push(`${request.method()} ${pathname}`);
  });
  await context.routeWebSocket('**/*', socket => {
    problems.push(`Unexpected WebSocket: ${socket.url()}`);
    return socket.close();
  });
  await context.route('**/*', async route => {
    const request = route.request();
    const url = new URL(request.url());
    const { pathname } = url;
    const method = request.method();
    const reject = reason => {
      problems.push(`${reason}: ${method} ${request.url()}`);
      return route.abort();
    };
    // This handler never continues or fetches, even for unknown same-origin paths.
    if (url.origin !== origin) return reject('Unexpected origin');
    const endpoint = /^\/api\/events\/(active|past|pre|fixture-\d+)\/(structure|decomposition|children)$/.exec(pathname);
    const [, id, action] = endpoint || [];
    try {
      if (method === 'POST' && action === 'decomposition' && id === 'active') {
        models.push({ id, body: request.postDataJSON() });
        if (!nextModel) return reject('Unplanned model request');
        const response = nextModel;
        nextModel = null;
        return route.fulfill(await response);
      }
      if (method === 'POST' && action === 'children') {
        const body = request.postDataJSON();
        writes.push({ id, body });
        recoveryRequests.push(`${method} ${pathname}`);
        if (!nextWrite) return reject('Unplanned event write');
        const response = nextWrite;
        nextWrite = null;
        const outcome = await response;
        assert.equal(body.snapshot, fingerprint(revision));
        assert.ok(!receipts.has(body.operation_id), 'Never commit the same operation twice');
        if (outcome === 'conflict') return route.fulfill({ status: 409, json: { detail: '模拟冲突：请核对当前事件' } });
        if (outcome === 'lostBeforeCommit') return route.abort('connectionreset');
        const created = body.children.map(fields => {
          const saved = item(`fixture-${items.length}`, fields.type, fields.parent, fields.name, fields);
          items.push(saved);
          if (body.action === 'children') branches.push({ parent_id: id, child_id: saved.id });
          else if (body.action === 'followup') links.push({ id: 'fixture-followup', source: saved.id, target: id, kind: 'followup' });
          else throw Error(`Unexpected event action ${body.action}`);
          return saved.id;
        });
        const receipt = { action: body.action, created };
        receipts.set(body.operation_id, receipt);
        revision++;
        if (outcome === 'lost') return route.abort('connectionreset');
        return route.fulfill({ json: receipt });
      }
      if (method !== 'GET') return reject('Unexpected request');
      if (action === 'structure' && items.some(row => row.type === 'event' && row.id === id)) {
        return route.fulfill({ json: { ...snapshot(), events: items.filter(row => row.type === 'event'), snapshot: fingerprint(revision) } });
      }
      const operation = /^\/api\/event-operations\/([^/]+)$/.exec(pathname)?.[1];
      if (operation) {
        receiptReads.push(operation);
        recoveryRequests.push(`${method} ${pathname}`);
        if (nextReceipt?.id !== operation) return reject('Unplanned operation receipt lookup');
        const { status, detail } = nextReceipt;
        nextReceipt = null;
        if (status !== 200) return route.fulfill({ status, json: { detail } });
        if (!receipts.has(operation)) return reject('Missing fixture receipt');
        return route.fulfill({ json: receipts.get(operation) });
      }
      if (pathname === '/api/items') {
        itemReads++;
        recoveryRequests.push(`${method} ${pathname}`);
        if (failItems) {
          failItems = false;
          return route.fulfill({ status: 503, json: { detail: '模拟事件清单读回失败' } });
        }
      }
      if (pathname === '/api/events/active/images') {
        imageReads.push(`${method} ${pathname}`);
        return route.fulfill({ json: { event: items.find(row => row.id === 'active'), images: [], source: null } });
      }
      const responses = {
        '/api/session': {}, '/api/items': items, '/api/workbench': snapshot(), '/api/priorities': priorities,
        '/api/sources': [], '/api/sources/suggestions': [], '/api/sources/unmatched': [], '/api/sources/follow': [],
        '/api/plan-history-counts': {},
      };
      if (Object.hasOwn(responses, pathname)) return route.fulfill({ json: responses[pathname] });
      if (pathname === '/favicon.ico') return route.fulfill({ status: 204 });
      if (pathname !== '/' && pathname !== bundle && !/^\/[-\w]+\.(?:js|css)$/.test(pathname)) {
        return reject('Unexpected static resource');
      }
      if (pathname === bundle) await preview.response;
      const file = pathname === '/' ? 'index.html' : pathname.slice(1);
      const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
      return route.fulfill({ body: await fs.readFile(path.join(frontend, file)), contentType: `${mime[path.extname(file)]}; charset=utf-8` });
    } catch (error) {
      return reject(error.message);
    }
  });
  function gate() {
    let release;
    const response = new Promise(resolve => { release = resolve; });
    return { response, release };
  }
  return {
    models, writes, receiptReads, imageReads, recoveryRequests, apiRequests, items, branches, links, problems,
    releasePreview: preview.release,
    get itemReads() { return itemReads; },
    failNextItems() { failItems = true; },
    expectReceipt(id, status = 200, detail) { nextReceipt = { id, status, detail }; },
    pauseModel() { const { response, release } = gate(); nextModel = response; return release; },
    modelFailure() { nextModel = Promise.resolve({ status: 503, json: { detail: '模拟模型不可用' } }); },
    writeOutcome(outcome) { nextWrite = Promise.resolve(outcome); },
    pauseWrite() { const { response, release } = gate(); nextWrite = response; return release; },
  };
}

async function assertOwnership(drawer, detail) {
  await drawer.locator('#eventContent[data-react-owned]').waitFor();
  const actual = await drawer.evaluate(dialog => {
    const header = dialog.querySelector(':scope > .drawerHead');
    const content = dialog.querySelector(':scope > #eventContent');
    const feedback = dialog.querySelector(':scope > [data-event-feedback]');
    const privateKey = (node, prefix) => Object.keys(node).find(key => key.startsWith(prefix));
    const fiberOf = node => {
      const fiber = node[privateKey(node, '__reactFiber$')];
      return fiber?.stateNode === node ? fiber : null;
    };
    const rootKey = node => privateKey(node, '__reactContainer$');
    const contentRoot = content[rootKey(content)]?.stateNode;
    const label = node => node.id ? `#${node.id}` : node.localName;
    const nodes = [dialog, ...dialog.querySelectorAll('*')];
    // The direct-child tooltip is checked separately: it belongs to the shared hint root, not to this drawer.
    const rendered = nodes.filter(node => ![dialog, header, content, feedback].includes(node) &&
      !(node.parentElement === dialog && node.matches('div.iconTip[role="tooltip"]')));
    const misowned = rendered.filter(node => {
      const destination = content.contains(node) ? null : header.contains(node) ? header : feedback;
      const fiber = fiberOf(node);
      if (!fiber || !contentRoot) return true;
      let portal = null, root = null;
      // Walk the actual React 19 host fiber, not merely a DOM marker or a delegated listener.
      for (let parent = fiber.return; parent; parent = parent.return) {
        if (parent.tag === 4) portal ??= parent.stateNode.containerInfo; // HostPortal
        if (parent.tag === 3) root = parent.stateNode; // HostRoot
      }
      return root !== contentRoot || portal !== destination;
    }).map(node => `${label(node.parentElement)} > ${node.outerHTML.slice(0, 160)}`);
    return {
      modal: dialog instanceof HTMLDialogElement && dialog.open && dialog.matches(':modal'),
      labelledByTitle: dialog.getAttribute('aria-labelledby') === 'eventTitle',
      nativeHosts: [dialog, header, content, feedback].filter(Boolean).every(node => !fiberOf(node)),
      roots: nodes.filter(rootKey).map(label),
      marked: content.hasAttribute('data-react-owned'),
      headerChildren: [header.querySelector('#eventTitle')?.localName, header.querySelectorAll('button').length],
      feedback: feedback && [...feedback.children].map(label),
      predecessor: content.querySelector('#eventDependencies') !== null,
      misowned,
      fibers: nodes.filter(fiberOf).map(label),
      inlineHandlers: nodes.flatMap(node => node.getAttributeNames()
        .filter(name => /^on/i.test(name)).map(name => `${label(node)}.${name}`)),
    };
  });
  assert.ok(actual.modal && actual.labelledByTitle && actual.nativeHosts, 'The labelled modal and its mount elements stay native');
  assert.equal(actual.marked, true);
  assert.deepEqual(actual.headerChildren, ['h2', detail ? 2 : 1], 'The header shows the image entry only in detail mode');
  assert.equal(actual.predecessor, detail);
  assert.deepEqual(actual.feedback, ['#eventError', '#eventRecovery']);
  assert.deepEqual(actual.roots, ['#eventContent'], 'Only the native content host carries a React root');
  assert.ok(actual.fibers.includes('h3'), 'Content needs a real host fiber, not just an ownership marker');
  assert.deepEqual(actual.misowned, [], 'All rendered nodes share the drawer root; header and feedback use their original portal hosts');
  assert.deepEqual(actual.inlineHandlers, [], 'The React drawer contains no inline event attributes');
}

async function assertIconHint(page, anchor, label, dialogId) {
  const hints = page.locator('.iconTip');
  await hints.first().waitFor();
  assert.equal(await hints.count(), 1, 'Only one shared icon hint may be mounted');
  const actual = await anchor.evaluate((button, dialogId) => {
    const tip = document.querySelector('.iconTip');
    const target = dialogId ? document.getElementById(dialogId) : document.body;
    const layer = document.getElementById('iconHintLayer');
    const reactKey = (node, prefix) => node && Object.keys(node).find(key => key.startsWith(prefix));
    const fiber = tip[reactKey(tip, '__reactFiber$')];
    const mountedRoot = layer?.[reactKey(layer, '__reactContainer$')]?.stateNode;
    let portal, root;
    for (let parent = fiber?.return; parent; parent = parent.return) {
      if (parent.tag === 4) portal ??= parent.stateNode.containerInfo; // HostPortal
      if (parent.tag === 3) root = parent.stateNode; // HostRoot
    }
    const box = tip.getBoundingClientRect();
    const trigger = button.getBoundingClientRect();
    return {
      label: tip.textContent,
      plainText: tip.childElementCount === 0 && tip.getAttribute('role') === 'tooltip',
      directChild: tip.parentElement === target && (!dialogId || target.matches(':modal')),
      layerExists: layer !== null,
      smallBodyRoot: layer?.parentElement === document.body && layer.childElementCount === 0 && mountedRoot?.containerInfo === layer,
      hasFiber: fiber?.stateNode === tip,
      correctPortal: portal === target && root === mountedRoot,
      fixed: getComputedStyle(tip).position === 'fixed',
      inViewport: box.left >= 0 && box.right <= innerWidth && box.top >= 0 && box.bottom <= innerHeight,
      anchored: Math.abs(box.left - Math.max(8, Math.min(trigger.left, innerWidth - box.width - 8))) <= 1 &&
        (Math.abs(box.top - trigger.bottom - 6) <= 1 || Math.abs(trigger.top - box.bottom - 6) <= 1),
    };
  }, dialogId);
  assert.equal(actual.label, label);
  assert.ok(actual.plainText && actual.directChild, 'The tooltip text is literal and directly mounted on body or its active modal');
  assert.ok(actual.fixed && actual.inViewport && actual.anchored, 'The fixed tooltip is positioned next to its trigger inside the viewport');
  assert.equal(actual.layerExists, true, 'The shared hint root exists');
  assert.equal(actual.hasFiber, true);
  assert.ok(actual.smallBodyRoot && actual.correctPortal, 'The icon hint is a real portal from the small body root into the original destination');
}

async function exercise(page, fixture) {
  const { models, writes, receiptReads, imageReads, recoveryRequests, apiRequests } = fixture;
  const drawer = page.locator('#eventDrawer');
  const content = drawer.locator('#eventContent');
  const error = drawer.locator('#eventError');
  const recovery = drawer.locator('#eventRecovery');
  const heading = name => drawer.getByRole('heading', { name, exact: true });
  const button = name => drawer.getByRole('button', { name, exact: true });
  const row = name => page.locator('#events tbody tr').filter({ has: page.getByRole('button', { name, exact: true }) });
  const rowAction = (name, action) => row(name).getByRole('button', { name: action, exact: true });
  const text = (host, value) => host.getByText(value, { exact: true }).waitFor();
  const hidden = locator => locator.waitFor({ state: 'hidden' });
  const noIconHint = () => page.locator('.iconTip').first().waitFor({ state: 'detached' });
  const readback = async name => {
    await row(name).waitFor();
    await text(page.locator('#notice'), '已保存并读回事件结果');
  };
  const payload = (index, id, action, revision, fields) => {
    const { body, id: actualId } = writes[index];
    const { operation_id, ...rest } = body;
    assert.equal(actualId, id);
    assert.match(operation_id, /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/);
    assert.deepEqual(rest, { action, snapshot: fingerprint(revision), children: [{
      ...fields, name: fields.name.trim(), parent: 't', type: 'event', status: 'notStarted',
    }] });
    return operation_id;
  };
  const form = drawer.locator('#childForm');
  const childFields = { name: 'childName', description: 'childDescription', owner: 'childOwner', planStart: 'childStart', planEnd: 'childEnd' };
  const fill = async (values, fields, host = drawer) => {
    for (const [key, value] of Object.entries(values)) await host.locator(fields[key]).fill(value);
  };
  const verifyValues = async (values, fields, host = drawer) => {
    for (const [key, value] of Object.entries(values)) assert.equal(await host.locator(fields[key]).inputValue(), value, key);
  };
  const manualFields = Object.fromEntries(Object.entries(childFields).map(([key, id]) => [key, `#${id}`]));

  await Promise.all([
    page.waitForRequest(`${origin}${bundle}`),
    page.goto(`${origin}/`, { waitUntil: 'domcontentloaded' }),
  ]);
  // The fixture holds the bundle response until the native shell has been inspected.
  const hostSelectors = [':scope > .drawerHead', ':scope > #eventContent', ':scope > [data-event-feedback]'];
  const originalShell = await drawer.evaluateHandle((dialog, selectors) =>
    [dialog, ...selectors.map(selector => dialog.querySelector(selector))], hostSelectors);
  assert.deepEqual(await originalShell.evaluate(([dialog, ...hosts]) => ({
    startingUp: document.body.hasAttribute('data-ui-startup'),
    closedNativeDialog: dialog instanceof HTMLDialogElement && !dialog.open,
    directChildren: dialog.childNodes.length,
    hostChildNodes: hosts.map(host => host?.childNodes.length),
    legacyNodes: dialog.querySelectorAll('#eventTitle, #eventError, #eventRecovery, button').length,
  })), {
    startingUp: true, closedNativeDialog: true, directChildren: 3, hostChildNodes: [0, 0, 0], legacyNodes: 0,
  }, 'Before React loads, the native dialog contains only the empty header, content and feedback hosts');
  const assertShellIdentity = async () => {
    assert.deepEqual(await drawer.evaluate((dialog, { originals, selectors }) =>
      [dialog, ...selectors.map(selector => dialog.querySelector(selector))].map((node, index) => node === originals[index]),
    { originals: originalShell, selectors: hostSelectors }), [true, true, true, true],
    'The native dialog and all three direct hosts retain their identity');
  };
  fixture.releasePreview();
  await page.locator('body:not([data-ui-startup])').waitFor({ state: 'attached' });
  await page.locator('#events[data-events-ui="react"]').waitFor({ state: 'attached' });
  await assertShellIdentity();
  await page.getByRole('button', { name: '目标与事情', exact: true }).click();
  await page.locator('#events .progressSummary').filter({ hasText: '最末级完成' }).waitFor();
  const pageHintLabel = `完成：${currentName}`;
  const pageHintAnchor = rowAction(currentName, pageHintLabel);
  await pageHintAnchor.scrollIntoViewIfNeeded();
  await page.waitForLoadState('networkidle'); // Let unrelated startup reads finish first.
  const pageHintStart = apiRequests.length;
  await pageHintAnchor.focus();
  await assertIconHint(page, pageHintAnchor, pageHintLabel);
  await page.keyboard.press('Escape');
  await noIconHint();
  assert.ok(await pageHintAnchor.evaluate(button => document.activeElement === button), 'Escape dismisses the page hint without blurring its trigger');
  await pageHintAnchor.evaluate(button => button.blur());
  await pageHintAnchor.hover();
  await assertIconHint(page, pageHintAnchor, pageHintLabel);
  await page.screenshot({ path: path.join(output, `react-icon-hint-body.png`) });
  await page.mouse.move(1, 1);
  await noIconHint();
  assert.deepEqual(apiRequests.slice(pageHintStart), [], 'Focusing, hovering and dismissing a page hint must not call the API');

  await rowAction(currentName, '详情').click();
  await heading('事件详情').waitFor();
  await heading(currentName).waitFor();
  await text(content, description);
  await text(content, '所属事情：合成事情');
  await text(content, '责任人 · 原负责人');
  await text(content, '计划开始 · 2026-11-19');
  for (const action of ['编辑事件', '延期变更', '当日跟进', '删除事件', '拆分', '新建后续跟进', '事件图片']) await button(action).waitFor();
  const predecessorHost = content.locator('#eventDependencies');
  await predecessorHost.getByRole('button', { name: predecessorName, exact: true }).waitFor();
  await assertOwnership(drawer, true);
  assert.deepEqual(imageReads, [], 'Displaying the image entry does not read images');
  await button('事件图片').click();
  const imageDrawer = page.locator('#imageDrawer');
  await imageDrawer.locator('#imageContext').filter({ hasText: currentName }).waitFor();
  assert.deepEqual(imageReads, ['GET /api/events/active/images'], 'The detail header opens images for the current event');
  await imageDrawer.getByRole('button', { name: '关闭图片', exact: true }).click();
  await hidden(imageDrawer);
  await heading(currentName).waitFor();
  await button('设置前置').click();
  const picker = predecessorHost.locator('#predecessorPicker');
  await picker.waitFor();
  assert.equal(await button('添加前置').isDisabled(), true);
  await picker.selectOption('past');
  assert.equal(await picker.inputValue(), 'past');
  assert.equal(await button('添加前置').isEnabled(), true, 'Selecting a predecessor enables explicit addition');
  await assertOwnership(drawer, true);
  await button('收起前置设置').click();
  assert.deepEqual([models.length, writes.length], [0, 0], 'Opening predecessor settings and selecting a candidate do not generate or save');

  const releaseModel = fixture.pauseModel();
  try {
    await Promise.all([
      page.waitForRequest(request => request.url() === `${origin}/api/events/active/decomposition` && request.method() === 'POST'),
      button('拆分').click(),
    ]);
    await heading('拆分事件').waitFor();
    await text(content, '正在自动生成拆分建议…');
    assert.deepEqual(models, [{ id: 'active', body: { consent: true, instructions: '', snapshot: fingerprint(0) } }]);
    assert.equal(await button('重新生成建议').isDisabled(), true);
    assert.equal(await button('确认创建所选子事件').count(), 0);
    assert.equal(writes.length, 0);
  } finally {
    releaseModel({ json: { suggestions } });
  }
  const candidates = content.locator('.splitCandidate');
  const accept = button('确认创建所选子事件');
  await accept.waitFor();
  assert.equal(await candidates.count(), 2);
  const first = candidates.nth(0), second = candidates.nth(1);
  assert.equal(await first.locator('.splitName').inputValue(), suggestions[0].name);
  assert.equal(await first.locator('.splitDescription').inputValue(), suggestions[0].description);
  await text(second, '建议理由：第二项合成理由');
  assert.equal(await first.locator('.splitPick').isChecked(), true);
  assert.equal(await second.locator('.splitPick').isChecked(), true);
  assert.equal(await form.isVisible(), false, 'Manual fallback starts collapsed');
  await assertOwnership(drawer, false);
  for (const width of widths) {
    await page.setViewportSize({ width, height: 900 });
    assert.ok(await drawer.evaluate(node => node.scrollWidth <= node.clientWidth + 1), `Drawer overflow at ${width}px`);
    await page.screenshot({ path: path.join(output, `react-${width}.png`) });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  assert.equal(writes.length, 0, 'Displaying model candidates cannot create events');
  assert.equal(fixture.items.length, 6);

  await first.locator('.splitPick').uncheck();
  await second.locator('.splitPick').uncheck();
  await accept.click();
  await text(drawer, '至少选择一个子事件');
  await first.locator('.splitPick').check();
  const candidateFields = { name: '.splitName', description: '.splitDescription', owner: '.splitOwner', planStart: '.splitStart', planEnd: '.splitEnd' };
  await first.locator('.splitName').fill('   ');
  await accept.click();
  await text(drawer, '名称不能为空，结束日期不能早于开始');
  await fill({ ...aiChild, planEnd: '2026-11-18' }, candidateFields, first);
  const receiptBaseline = fixture.itemReads;
  const releaseWrite = fixture.pauseWrite();
  try {
    await accept.click();
    await text(drawer, '名称不能为空，结束日期不能早于开始');
    assert.equal(await accept.isEnabled(), true);
    assert.equal(writes.length, 0, 'Empty selection, blank name and inverted dates are not sent');
    await fill(aiChild, candidateFields, first);
    await accept.click();
    await drawer.locator('#eventContent .splitName:disabled').first().waitFor();
    assert.equal(await accept.isDisabled(), true);
    await page.keyboard.press('Escape');
    assert.equal(await drawer.evaluate(node => node.open), true, 'The original native cancel listener blocks Escape during a write');
  } finally {
    releaseWrite('conflict');
  }
  await error.filter({ hasText: '模拟冲突：请核对当前事件' }).waitFor();
  await hidden(recovery);
  assert.equal(writes.length, 1);
  const conflictId = payload(0, 'active', 'children', 0, aiChild);
  assert.deepEqual([fixture.items.length, fixture.branches.length], [6, 0], 'A rejected write creates nothing');
  assert.deepEqual(receiptReads, [], 'A definite rejection does not query a receipt');
  await verifyValues(aiChild, candidateFields, first);
  assert.equal(await first.locator('.splitPick').isChecked(), true);
  assert.equal(await second.locator('.splitPick').isChecked(), false);
  fixture.writeOutcome('lost'); // The fixture commits, then drops the response.
  await accept.click();
  await recovery.waitFor();
  await hidden(button('手动重试原操作'));
  await assertOwnership(drawer, false);
  assert.ok((await error.textContent()).trim(), 'Unknown result must be shown');
  assert.equal(writes.length, 2);
  const lostId = payload(1, 'active', 'children', 0, aiChild);
  assert.notEqual(lostId, conflictId, 'Explicit resubmission after conflict gets a fresh operation ID');
  await accept.click();
  assert.equal(writes.length, 2, 'Further confirmation while the result is unknown must not write');
  assert.deepEqual(receiptReads, [], 'No automatic receipt lookup');
  assert.equal(fixture.itemReads, receiptBaseline, 'No automatic item readback before the explicit lookup');
  await page.keyboard.press('Escape');
  await hidden(drawer);
  await rowAction(currentName, '详情').click();
  await text(drawer, '请先核对上次操作');
  await recovery.waitFor();
  fixture.expectReceipt(lostId);
  await button('核对操作结果').click();
  await hidden(drawer);
  await readback(aiChild.name.trim());
  assert.deepEqual(receiptReads, [lostId]);
  assert.equal(fixture.itemReads, receiptBaseline + 1, 'Explicit lookup reads back the committed items once');
  assert.equal(writes.length, 2, 'Receipt lookup is read-only');
  assert.ok((await row(aiChild.name.trim()).innerText()).includes('第 2 层'));
  assert.equal(await row(suggestions[1].name).count(), 0);
  await rowAction(aiChild.name.trim(), '详情').click();
  await text(drawer, `父事件：${currentName}`);
  await text(drawer, aiChild.description);
  await button('关闭').click();
  await hidden(drawer);

  fixture.modelFailure();
  await rowAction(currentName, '拆分').click();
  await text(drawer, '模拟模型不可用');
  await text(drawer, '生成失败，可点击重新生成或手动添加。');
  assert.deepEqual(models[1], { id: 'active', body: { consent: true, instructions: '', snapshot: fingerprint(1) } });
  assert.equal(await candidates.count(), 0);
  await content.locator('summary').filter({ hasText: /^手动添加子事件$/ }).click();
  await form.waitFor();
  await assertOwnership(drawer, false);
  await fill({ ...manualChild, name: '  ' }, manualFields);
  await button('确认创建').click();
  await text(drawer, '名称不能为空，结束日期不能早于开始');
  assert.equal(writes.length, 2);
  assert.equal(models.length, 2, 'A failed generation does not silently retry');
  await fill(manualChild, manualFields);
  fixture.writeOutcome('ok');
  await button('确认创建').click();
  await hidden(drawer);
  await readback(manualChild.name);
  const manualId = payload(2, 'active', 'children', 1, manualChild);

  await rowAction(closedName, '详情').click();
  await heading(closedName).waitFor();
  await text(content, '已完成');
  assert.equal(await button('当日跟进').count(), 0);
  await button('拆分').click();
  await text(content, '请先通过编辑手动重开当前事件，再拆分。');
  assert.equal(await form.count(), 0);
  assert.equal(await button('重新生成建议').count(), 0);
  assert.deepEqual([models.length, writes.length], [2, 3], 'An ended event cannot be split or sent to the model');
  await button('关闭').click();
  await hidden(drawer);
  await rowAction(closedName, '详情').click();
  await heading(closedName).waitFor();
  await button('新建后续跟进').click();
  await heading('新建后续跟进').waitFor();
  await heading('手动创建跟进').waitFor();
  await assertOwnership(drawer, false);
  await fill(followup, manualFields);
  const dialogHintLabel = '确认创建';
  const dialogHintAnchor = button(dialogHintLabel);
  await dialogHintAnchor.scrollIntoViewIfNeeded();
  const dialogHintStart = apiRequests.length;
  await dialogHintAnchor.focus();
  await assertIconHint(page, dialogHintAnchor, dialogHintLabel, 'eventDrawer');
  const originalDialogHint = await drawer.locator(':scope > .iconTip').elementHandle();
  await page.screenshot({ path: path.join(output, `react-icon-hint-dialog.png`) });
  await page.keyboard.press('Escape');
  await hidden(drawer);
  // Native close can refocus the row's Details button and legitimately show a new body hint.
  await page.waitForFunction(hint => !hint.isConnected, originalDialogHint);
  await originalDialogHint.dispose();
  assert.deepEqual(apiRequests.slice(dialogHintStart), [], 'Focusing the dialog hint and dismissing the draft must not call the API');
  assert.equal(writes.length, 3, 'Closing the follow-up draft does not create an event');
  await rowAction(closedName, '详情').click();
  await heading(closedName).waitFor();
  await button('新建后续跟进').click();
  await heading('手动创建跟进').waitFor();
  await verifyValues({ name: '', description: '', owner: '', planStart: '', planEnd: '' }, manualFields);
  await fill(followup, manualFields);
  fixture.writeOutcome('ok');
  await drawer.locator('#childName').press('Enter');
  await hidden(drawer);
  await readback(followup.name);
  const followId = payload(3, 'past', 'followup', 2, followup);
  assert.ok((await row(closedName).innerText()).includes('已完成'), 'Follow-up cannot reopen the original event');
  assert.ok(!(await row(followup.name).innerText()).includes('第 2 层'), 'Follow-up is an independent event, not a child');
  assert.deepEqual(fixture.links, [{ id: 'fixture-followup', source: fixture.items.find(item => item.name === followup.name).id,
    target: 'past', kind: 'followup' }]);
  assert.equal(fixture.branches.length, 2);
  assert.equal(fixture.items.length, 9);
  assert.equal(new Set([conflictId, lostId, manualId, followId]).size, 4);
  assert.equal(writes.length, 4);
  assert.equal(models.length, 2);
  assert.deepEqual(receiptReads, [lostId]);
  const acknowledged = { ...followup, name: '有提交响应但事件清单读回失败' };
  const unsent = { ...followup, name: '明确查无回执后手动续送' };
  const save = button('确认创建'), recover = button('核对操作结果'), retry = button('手动重试原操作');
  const startFollowup = async fields => {
    await rowAction(closedName, '详情').click();
    await heading(closedName).waitFor();
    await button('新建后续跟进').click();
    await heading('手动创建跟进').waitFor();
    await fill(fields, manualFields);
  };
  const checkStart = recoveryRequests.length;
  const expected = [];
  const checkRequests = message => assert.deepEqual(recoveryRequests.slice(checkStart), expected, message);
  const postFollowup = 'POST /api/events/past/children';
  const getReceipt = id => `GET /api/event-operations/${id}`;
  const getItems = 'GET /api/items';
  const missingReceipt = '模拟未找到原操作回执';
  const clickIfEnabled = async locator => { if (await locator.isEnabled()) await locator.click(); };

  await startFollowup(acknowledged);
  fixture.writeOutcome('ok');
  fixture.failNextItems();
  await save.click();
  await text(error, '操作已提交，读回失败，请核对结果。');
  await recovery.waitFor();
  await hidden(retry);
  await hidden(row(acknowledged.name));
  const confirmedId = payload(4, 'past', 'followup', 3, acknowledged);
  expected.push(postFollowup, getItems);
  await clickIfEnabled(save);
  checkRequests('A successful submission with failed list readback must not resubmit or automatically look up a receipt');
  assert.equal(fixture.items.filter(item => item.name === acknowledged.name).length, 1);
  await page.keyboard.press('Escape');
  await hidden(drawer);
  await rowAction(closedName, '详情').click();
  await text(error, '请先核对上次操作');
  await verifyValues(acknowledged, manualFields);
  await hidden(retry);

  fixture.expectReceipt(confirmedId, 404, missingReceipt);
  await recover.click();
  await text(error, '已收到提交响应，但暂未能核对回执；请继续核对，不要重试原操作。');
  await recover.waitFor();
  await hidden(retry);
  await clickIfEnabled(save);
  expected.push(getReceipt(confirmedId));
  checkRequests('Even a missing receipt may not permit resending an acknowledged operation');
  fixture.expectReceipt(confirmedId);
  await recover.click();
  await hidden(drawer);
  await readback(acknowledged.name);
  expected.push(getReceipt(confirmedId), getItems);
  checkRequests('Recovery reads the original receipt and then the actual items');

  await startFollowup(unsent);
  fixture.writeOutcome('lostBeforeCommit');
  await save.click();
  await recovery.waitFor();
  await hidden(retry);
  const unknownId = payload(5, 'past', 'followup', 4, unsent);
  assert.equal(fixture.items.some(item => item.name === unsent.name), false);
  expected.push(postFollowup);
  checkRequests('No automatic read or resend for an operation whose response was lost before commit');
  const unavailableReceipt = '模拟原操作回执暂不可用';
  fixture.expectReceipt(unknownId, 503, unavailableReceipt);
  await recover.click();
  await error.filter({ hasText: unavailableReceipt }).waitFor();
  await hidden(retry);
  expected.push(getReceipt(unknownId));
  checkRequests('A temporary failure is not proof of a missing receipt');

  fixture.expectReceipt(unknownId, 404, missingReceipt);
  await recover.click();
  await retry.waitFor();
  await assertOwnership(drawer, false);
  await verifyValues(unsent, manualFields);
  const newerDraft = '重新编辑的草稿不得改变原请求';
  const pendingName = drawer.locator(manualFields.name);
  if (await pendingName.isEditable()) await pendingName.fill(newerDraft);
  await clickIfEnabled(save);
  expected.push(getReceipt(unknownId));
  checkRequests('A confirmed missing receipt requires the dedicated retry action, not the ordinary save');
  fixture.writeOutcome('ok');
  await retry.click();
  await hidden(drawer);
  await readback(unsent.name);
  expected.push(postFollowup, getItems);
  checkRequests('Clicking the explicit retry sends exactly one POST and then reads back');
  assert.deepEqual(writes[6], writes[5], 'The retry sends the same operation key, snapshot, event and original draft');
  assert.equal(fixture.items.filter(item => item.name === unsent.name).length, 1);
  assert.equal(await row(newerDraft).count(), 0);
  assert.equal(writes.length, 7);
  assert.equal(fixture.items.length, 11);
  assert.equal(new Set(writes.map(({ body }) => body.operation_id)).size, 6, 'Only the explicit retry reuses an operation ID');
  assert.deepEqual(receiptReads, [lostId, confirmedId, confirmedId, unknownId, unknownId]);
  await assertShellIdentity();
  await originalShell.dispose();
}

async function verify() {
  await fs.access(path.join(frontend, bundle.slice(1)));
  await fs.mkdir(output, { recursive: true });
  const browser = await chromium.launch({ channel: 'chrome', headless: true,
    args: ['--disable-background-networking', '--host-resolver-rules=MAP * ~NOTFOUND'] });
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: 'block', reducedMotion: 'reduce' });
    try {
      const page = await context.newPage();
      page.setDefaultTimeout(8000);
      const fixture = await intercept(context, page);
      try {
        await exercise(page, fixture);
        assert.deepEqual(fixture.problems, []);
      } catch (error) {
        error.message = `React: ${error.message}`;
        if (fixture.problems.length) error.message += `\nFixture problems: ${fixture.problems.join('; ')}`;
        throw error;
      }
    } finally {
      await context.close();
    }
    console.log(`React event drawer passed at ${widths.join('/')}: shared icon hints, detail and images, native cancel, AI/manual split, validation, conflict, follow-up, and explicit recovery (7 write attempts, 5 commits, 5 receipt GETs).`);
  } finally {
    await browser.close();
  }
}

verify().catch(error => { console.error(error); process.exitCode = 1; });
