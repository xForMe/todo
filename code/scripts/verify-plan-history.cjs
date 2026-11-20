// TEST-019: isolated Chrome with all requests intercepted.
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

const react = true;
const bundle = '/dist/workbench-react.js';
const base = 'http://127.0.0.1:18889';
const root = path.resolve(__dirname, '../frontend-react/public');
const out = path.resolve(__dirname, '../../runtime', `plan-history-ui${react ? '-react' : ''}`);
const widths = [1440, 1024, 768, 375];

function deferred() {
 const result = {};
 result.promise = new Promise(resolve => { result.resolve = resolve; });
 return result;
}

async function assertReactRegion(page, selector) {
 const region = page.locator(selector);
 await region.waitFor();
 const inline = await region.evaluate(root => [root, ...root.querySelectorAll('*')].flatMap(node =>
  node.getAttributeNames().filter(name => /^on/i.test(name)).map(name => `${node.id || node.tagName}.${name}`)));
 assert.deepEqual(inline, [], `${selector} must not contain inline event handlers`);
}

async function assertPlanOwnership(drawer) {
 const actual = await drawer.evaluate(dialog => {
  const nodes = [...dialog.querySelectorAll('*')];
  // Shared icon tips are appended to the native shell, outside the React content.
  const content = nodes.filter(node => !node.matches('#planDrawer > .iconTip[role="tooltip"]'));
  const fiber = node => Object.keys(node).find(key => key.startsWith('__reactFiber$') && node[key]?.stateNode === node);
  const label = node => node.id || node.localName;
  return {
   nativeModal: dialog instanceof HTMLDialogElement && dialog.open && dialog.matches(':modal'),
   namedBy: dialog.getAttribute('aria-labelledby'),
   marked: dialog.hasAttribute('data-react-owned'),
   dialogFiber: Boolean(fiber(dialog)),
   owned: content.filter(fiber).map(label),
   unowned: content.filter(node => !fiber(node)).map(label),
   inline: [dialog, ...nodes].flatMap(node => node.getAttributeNames()
    .filter(name => /^on/i.test(name)).map(name => `${label(node)}.${name}`)),
  };
 });
 assert.equal(actual.nativeModal, true, 'The drawer remains a native modal dialog');
 assert.equal(actual.namedBy, 'planTitle');
 assert.equal(actual.marked, react);
 assert.equal(actual.dialogFiber, false, 'React must not replace the native shell');
 if (react) {
  assert.ok(actual.owned.includes('planTitle') && actual.owned.includes('planBody'));
  assert.deepEqual(actual.unowned, [], 'React must render the drawer content, not just mark a legacy wrapper');
  assert.deepEqual(actual.inline, [], 'React drawer must not contain inline event handlers');
 } else assert.deepEqual(actual.owned, [], 'The default drawer stays native');
}

(async () => {
 if (react) fs.accessSync(path.join(root, bundle.slice(1)), fs.constants.R_OK);
 fs.mkdirSync(out, { recursive: true });
 const browser = await chromium.launch({ channel: 'chrome', headless: true });
 const lateRead = deferred();
 const lateWrite = deferred();
 const startupBundle = deferred();
 try {
  const page = await browser.newPage({ serviceWorkers: 'block' });
  page.setDefaultTimeout(8000);
  const errors = [], writes = [], historyReads = [], receiptReads = [], receipts = new Map();
  page.on('pageerror', error => errors.push(error.message));
  const item = (id, type, parent, name, extra = {}) =>
   ({ id, type, parent, name, description: '', owner: '', planStart: '', planEnd: '', status: 'working', version: 1, ...extra });
  const baseline = { start: '2026-11-16', end: '2026-11-20', scheduled: true, incomplete: false };
  const dates = { planStart: baseline.start, planEnd: baseline.end };
  const active = item('e', 'event', 't', '完成核心流程原型评审与长标题自适应检查', dates);
  const ended = item('ended', 'event', 't', '已完成的原型整理', { ...dates, status: 'completed' });
  const items = [item('g', 'goal', null, '示例目标'), item('m', 'module', 'g', '模块'),
   item('t', 'thing', 'm', '原型交付'), active, ended];
  const records = [], endedRecords = [{ account: '示例用户', changed_at: '2026-11-18T04:00:00Z',
   old_start: baseline.start, old_end: '2026-11-19', new_start: ended.planStart, new_end: ended.planEnd, reason: '整理评审材料' }];
  const snapshot = () => ({ items, priorities: { week: '2026-11-16', items: [] }, attention: [], branches: [], links: [],
   today: '2026-11-18', daily_reviews: [] });
  let lose = false, reject = false;
  let historyNext = 'fail';

  await page.addInitScript(() => {
   // Signal after the held body is consumed and its UI continuation has had a turn to render.
   const json = Response.prototype.json;
   Response.prototype.json = async function (...args) {
    const result = await json.apply(this, args);
    if (this.headers.get('x-test-late-history')) {
     requestAnimationFrame(() => requestAnimationFrame(() => { window.testLateHistoryConsumed = true; }));
    }
    return result;
   };
  });
  await page.context().routeWebSocket('**/*', socket => {
   errors.push(`Unexpected WebSocket: ${socket.url()}`);
   return socket.close();
  });
  // No request is ever continued to the network, including simulated writes and failures.
  await page.context().route('**/*', async route => {
   const req = route.request(), url = new URL(req.url()), method = req.method();
   const abort = reason => {
    errors.push(`${reason}: ${method} ${req.url()}`);
    return route.abort();
   };
   if (url.origin !== base) return abort('Unexpected origin');
   if (!url.pathname.startsWith('/api/')) {
    if (method !== 'GET') return abort('Unexpected static write');
    if (url.pathname === bundle) await startupBundle.promise;
     const name = url.pathname === bundle ? bundle.slice(1) : path.basename(url.pathname === '/' ? 'index.html' : url.pathname);
    const file = path.join(root, name), exists = fs.existsSync(file);
    return route.fulfill({ status: exists ? 200 : 404, body: exists ? fs.readFileSync(file) : '',
     contentType: name.endsWith('.js') ? 'text/javascript' : name.endsWith('.css') ? 'text/css' : 'text/html' });
   }
   if (method === 'PUT' && url.pathname === '/api/items/e') {
    const body = req.postDataJSON();
    writes.push(body);
    if (reject) {
     reject = false;
     return route.fulfill({ status: 409, json: { detail: '内容已变化，请刷新后编辑' } });
    }
    records.unshift({ account: '示例用户', changed_at: '2026-11-18T04:00:00Z', old_start: active.planStart,
     old_end: active.planEnd, new_start: body.planStart, new_end: body.planEnd, reason: body.plan_change_reason });
    active.planStart = body.planStart;
    active.planEnd = body.planEnd;
    active.version++;
    receipts.set(body.operation_id, { ...active });
    if (lose) { lose = false; await lateWrite.promise; return route.abort(); }
    return route.fulfill({ json: active });
   }
   if (method !== 'GET') return abort('Unexpected API write');
   const historyMatch = /^\/api\/items\/(e|ended)\/plan-history$/.exec(url.pathname);
   if (historyMatch) {
    const id = historyMatch[1];
    historyReads.push(id);
    if (id === ended.id) return route.fulfill({ json: { item: ended, baseline, records: endedRecords } });
    const mode = historyNext;
    historyNext = '';
    if (mode === 'fail') return route.fulfill({ status: 503, json: { detail: '模拟计划服务暂不可用' } });
    if (mode === 'hold') {
     await lateRead.promise;
     return route.fulfill({ headers: { 'x-test-late-history': '1' },
      json: { item: { ...active, name: '已经关闭的旧计划' }, baseline, records } });
    }
    return route.fulfill({ json: { item: active, baseline, records } });
   }
   if (url.pathname === '/api/plan-history-counts') {
    return route.fulfill({ json: { ...(records.length ? { e: records.length } : {}), ended: endedRecords.length } });
   }
   if (url.pathname.startsWith('/api/operations/')) {
    const id = url.pathname.split('/').pop();
    receiptReads.push(id);
    return route.fulfill({ json: receipts.get(id) ?? null });
   }
   if (url.pathname === '/api/events/e/structure') {
    return route.fulfill({ json: { ...snapshot(), events: [active, ended], dependencies: [], snapshot: '0'.repeat(64) } });
   }
   const data = { '/api/session': {}, '/api/items': items, '/api/workbench': snapshot(), '/api/priorities': snapshot().priorities };
   return route.fulfill({ json: data[url.pathname] || [] });
  });

  await Promise.all([
   page.waitForRequest(`${base}${bundle}`),
   page.goto(`${base}/`, { waitUntil: 'domcontentloaded' }),
  ]);
  const originalDrawer = await page.locator('#planDrawer').elementHandle();
  assert.deepEqual(await originalDrawer.evaluate(node => ({
   native: node instanceof HTMLDialogElement, open: node.open,
   children: node.childNodes.length, mounted: node.hasAttribute('data-react-owned'),
  })), { native: true, open: false, children: 0, mounted: false }, 'Startup leaves the native plan drawer empty');
  assert.deepEqual(historyReads, [], 'Startup does not read any item history');
  startupBundle.resolve();
  await page.locator('body:not([data-ui-startup])').waitFor({ state: 'attached' });
  assert.deepEqual(await originalDrawer.evaluate(node => ({
   original: node === document.querySelector('#planDrawer'), open: node.open,
   children: node.childNodes.length, mounted: node.hasAttribute('data-react-owned'),
  })), { original: true, open: false, children: 0, mounted: true }, 'React mounts the same empty dialog before user navigation');
  const workbench = page.locator('#globalWorkbench');
  const planDelay = workbench.locator('.planDelay');
  const drawer = page.locator('#planDrawer');
  const title = drawer.locator('#planTitle');
  const body = drawer.locator('#planBody');
  const start = drawer.locator('#newPlanStart'), end = drawer.locator('#newPlanEnd');
  const reason = drawer.locator('#planReason'), save = drawer.locator('#planSave'), verify = drawer.locator('#planVerify');
  const planError = drawer.locator('#planError');
  const openDrawer = drawer.locator('xpath=self::*[@open]');
  const close = async () => {
   await drawer.getByRole('button', { name: '关闭', exact: true }).click();
   await openDrawer.waitFor({ state: 'detached' });
  };
  const waitSaved = async () => {
   await openDrawer.waitFor({ state: 'detached' });
   await page.getByText('计划已更新，时间变更记录已保存', { exact: true }).waitFor();
  };
  const openDelay = async () => {
   await planDelay.click();
   await end.waitFor();
  };

  await planDelay.waitFor();
  if (react) await assertReactRegion(page, '#globalWorkbench[data-panels-ui="react"]');

  await planDelay.click();
  await body.getByText('读取失败：模拟计划服务暂不可用').waitFor();
  assert.equal(await drawer.locator('#planRecords, #planForm').count(), 0, 'Read failure is not empty history or editable data');
  assert.deepEqual(historyReads, ['e'], 'Failed read is not silently retried');
  await assertPlanOwnership(drawer);
  await body.getByRole('button', { name: '重新读取' }).click();
  await end.waitFor();
  assert.deepEqual(historyReads, ['e', 'e'], 'Manual retry reads the same object once');
  assert.equal(await title.textContent(), active.name);
  assert.equal(await end.inputValue(), dates.planEnd);
  assert.deepEqual(writes, []);
  await assertPlanOwnership(drawer);

  // Close a pending read without cancelling the HTTP fixture; a late body must not reopen or populate the drawer.
  await close();
  historyNext = 'hold';
  await Promise.all([page.waitForRequest(`${base}/api/items/e/plan-history`), planDelay.click()]);
  await body.getByText('正在读取最新计划…', { exact: true }).waitFor();
  await assertPlanOwnership(drawer);
  await close();
  lateRead.resolve();
  await page.waitForFunction(() => window.testLateHistoryConsumed === true);
  assert.equal(await openDrawer.count(), 0);
  assert.equal(await drawer.locator('#planForm, #planRecords').count(), 0, 'A closed drawer drops late content');
  assert.notEqual(await title.textContent(), '已经关闭的旧计划');
  await openDelay();
  assert.equal(await title.textContent(), active.name, 'Reopening uses the fresh response');
  assert.deepEqual(historyReads, ['e', 'e', 'e', 'e']);

  assert.equal(await reason.isVisible(), true);
  assert.equal(await save.isDisabled(), true, 'Unchanged dates cannot be saved');
  await end.fill('2026-11-15');
  await reason.fill('日期校验测试');
  await save.click();
  await planError.getByText('结束日期不能早于开始日期', { exact: true }).waitFor();
  assert.equal(await start.inputValue(), dates.planStart);
  assert.equal(await end.inputValue(), '2026-11-15');
  assert.equal(await reason.inputValue(), '日期校验测试');
  assert.equal(writes.length, 0, 'Invalid date range must not write');

  await end.fill('2026-11-24');
  await reason.fill('');
  await save.click();
  assert.equal(await reason.evaluate(node => node.validity.valueMissing), true);
  assert.equal(writes.length, 0, 'Reason required');
  await reason.fill('评审意见尚未收齐');
  await save.click();
  await waitSaved();
  assert.equal(records.length, 1);
  assert.equal(writes[0].plan_change_reason, '评审意见尚未收齐');
  assert.equal(writes[0].expected_version, 1);
  await workbench.locator('[data-plan="e"]').waitFor();
  await workbench.getByText('2026-11-24 截止', { exact: true }).waitFor();

  for (const width of widths) {
   await page.setViewportSize({ width, height: 950 });
   await page.screenshot({ animations: 'disabled', path: path.join(out, `workbench-${width}.png`) });
   assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `Overflow ${width}`);
   await openDelay();
   await page.screenshot({ animations: 'disabled', path: path.join(out, `drawer-${width}.png`) });
   assert(await drawer.evaluate(node => node.scrollWidth <= node.clientWidth), `Drawer overflow ${width}`);
   await close();
  }

  await openDelay();
  await end.fill('2026-11-25');
  await reason.fill('另一次调整');
  reject = true;
  await save.click();
  await planError.filter({ hasText: '内容已变化' }).waitFor();
  assert.equal(await reason.inputValue(), '另一次调整');
  assert.equal(await end.inputValue(), '2026-11-25');
  await close();

  await openDelay();
  assert.equal(await end.inputValue(), '2026-11-24', 'Conflict does not change the saved plan');
  await end.fill('2026-11-26');
  await reason.fill('延后一天');
  lose = true;
  await save.click();
  await close();
   lateWrite.resolve();
   await page.waitForFunction(() => planUnknown && !planBusy);
   await workbench.locator('.planDelay').click();
   await verify.waitFor();
  assert.equal(await save.isDisabled(), true);
  assert.deepEqual(receiptReads, [], 'Unknown result waits for explicit verification');
  await assertPlanOwnership(drawer);
  const before = writes.length;
  await verify.click();
  await waitSaved();
  assert.equal(writes.length, before, 'Receipt recovery must not resend');
  assert.deepEqual(receiptReads, [writes.at(-1).operation_id], 'Read back the exact unresolved operation');

  await page.getByRole('button', { name: '目标与事情', exact: true }).click();
  const eventSelector = react ? '#events[data-events-ui="react"]' : '#events';
  const events = page.locator(eventSelector);
  await events.locator('.eventTitle').first().waitFor();
  if (react) await assertReactRegion(page, eventSelector);
  const summary = drawer.locator('#planRecords summary');
  const focusHistory = async (id, count) => {
   const mark = events.locator(`[data-event="${id}"]`).getByRole('button', { name: `查看 ${count} 条时间变更记录`, exact: true });
   await mark.click();
   await summary.getByText(`时间变更记录 · ${count}`, { exact: true }).waitFor();
   await page.waitForFunction(() => document.activeElement === document.querySelector('#planRecords summary'));
   assert.equal(await summary.evaluate(node => node.parentElement.open), true);
   await assertPlanOwnership(drawer);
  };
  await focusHistory(active.id, records.length);
  const activeRecord = drawer.locator('#planRecords .planRecord').first();
  await activeRecord.getByText('调整原因：延后一天', { exact: true }).waitFor();
  await activeRecord.getByText('原：2026-11-16 → 2026-11-24', { exact: true }).waitFor();
  await activeRecord.getByText('现：2026-11-16 → 2026-11-26', { exact: true }).waitFor();
  await close();

  const beforeHistory = historyReads.length;
  await focusHistory(ended.id, endedRecords.length);
  assert.deepEqual(historyReads.slice(beforeHistory), [ended.id]);
  assert.equal(await title.textContent(), ended.name);
  await body.getByText('已结束，请先通过状态编辑保存重开，再调整日期。', { exact: true }).waitFor();
  await drawer.locator('#planRecords').getByText('调整原因：整理评审材料', { exact: true }).waitFor();
  for (const field of [start, end, reason, save]) assert.equal(await field.isDisabled(), true);
  await close();
  assert.equal(await drawer.evaluate((node, original) => node === original, originalDrawer), true,
    'The original plan dialog survives edit, recovery and history navigation');
   await originalDrawer.dispose();
   assert.equal(writes.length, before, 'Cancel, late reads, and viewing history cannot write');
  assert.equal(writes.length, 3, 'Only the explicit save attempts may write');
  assert.equal(records.length, 2);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, mode: react ? 'react' : 'legacy', widths, writes: writes.length,
   records: records.length, historyReads: historyReads.length, receiptReads: receiptReads.length, errors, output: out }));
 } finally {
  startupBundle.resolve();
  lateRead.resolve();
  lateWrite.resolve();
  await browser.close();
 }
})().catch(error => { console.error(error); process.exit(1); });
