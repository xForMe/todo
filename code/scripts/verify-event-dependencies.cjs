// Browser regression using synthetic records and a stubbed model endpoint.
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '../frontend');
const output = path.resolve(__dirname, '../../runtime/event-dependencies-ui');
const base = 'http://127.0.0.1:18921';
const day = '2026-11-19';
const item = (id, type, parent, name, status = 'notStarted', planStart = '') =>
  ({ id, type, parent, name, status, planStart, planEnd: '', owner: '', description: '', version: 1 });

async function checkWidth(browser, width) {
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  page.setDefaultTimeout(8000);
  const errors = [];
  const writes = [];
  let modelRequests = 0;
  let revision = 0;
  let rejectManual = true;
  const fingerprint = () => revision.toString(16).padStart(64, '0');
  const items = [
    item('g', 'goal', null, '产品交付'), item('m', 'module', 'g', '改造'),
    item('t', 'thing', 'm', '工作台'), item('pre', 'event', 't', '原型评审', 'cancelled'),
    item('blocked', 'event', 't', '技术评审', 'working'), item('ready', 'event', 't', '核对文案'),
    item('basis', 'event', 't', '确定验收口径', 'working'),
    item('future', 'event', 't', '下周验证', 'notStarted', '2026-11-23'),
  ];
  let dependencies = [{ event_id: 'blocked', predecessor_id: 'pre' }];
  const priorities = { week: '2026-11-16', items: [] };
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', async route => {
    const request = route.request();
    const { origin, pathname } = new URL(request.url());
    assert.equal(origin, base);
    if (!pathname.startsWith('/api/')) {
      const name = path.basename(pathname === '/' ? 'index.html' : pathname);
      const file = path.join(root, name);
      if (!fs.existsSync(file)) return route.fulfill({ status: 404 });
      const type = name.endsWith('.js') ? 'text/javascript' : name.endsWith('.css') ? 'text/css' : 'text/html';
      return route.fulfill({ path: file, contentType: type });
    }
    const snapshot = { items, today: day, priorities, dependencies, attention: [], branches: [], links: [], daily_reviews: [] };
    if (pathname.endsWith('/structure')) {
      return route.fulfill({ json: { ...snapshot, events: items.filter(row => row.type === 'event'), snapshot: fingerprint() } });
    }
    if (pathname.endsWith('/predecessor-recommendations')) {
      modelRequests++;
      assert.equal(pathname, '/api/events/ready/predecessor-recommendations');
      assert.equal(request.postDataJSON().consent, true);
      assert.equal(request.postDataJSON().snapshot, fingerprint());
      return route.fulfill({ json: [{ id: 'basis', reason: '文案依据验收口径。' }] });
    }
    if (pathname === '/api/events/ready/children') {
      const body = request.postDataJSON();
      assert.equal(body.action, 'predecessors');
      assert.equal(body.snapshot, fingerprint());
      assert.deepEqual(body.predecessor_ids, [['basis'], ['basis', 'future'], ['basis'], []][writes.length]);
      if (writes.length === 1 && rejectManual) {
        rejectManual = false;
        return route.fulfill({ status: 422, json: { detail: '模拟前置保存失败' } });
      }
      writes.push(body);
      revision++;
      dependencies = dependencies.filter(edge => edge.event_id !== 'ready').concat(
        body.predecessor_ids.map(id => ({ event_id: 'ready', predecessor_id: id })),
      );
      return route.fulfill({ json: { action: body.action, created: [] } });
    }
    const fixtures = {
      '/api/session': {}, '/api/items': items, '/api/workbench': snapshot,
      '/api/priorities': priorities, '/api/plan-history-counts': {},
    };
    return route.fulfill({ json: fixtures[pathname] || [] });
  });
  try {
    await page.goto(base);
    const rows = page.locator('#globalWorkbench .wbActionRow');
    await rows.filter({ hasText: '核对文案' }).waitFor();
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
    await working.focus();
    await page.keyboard.press('Enter');
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
    await eventRows.filter({ hasText: '下周验证' }).getByRole('button', { name: /等待，查看原因/ }).waitFor();
    assert.match(await blocked.innerText(), /进行中/);
    assert.doesNotMatch(await blocked.innerText(), /已取消/);
    const badge = blocked.getByRole('button', { name: /等待，查看原因/ });
    await badge.scrollIntoViewIfNeeded();
    await badge.click();
    const popover = page.getByRole('region', { name: '等待原因' });
    await popover.waitFor();
    assert.match(await popover.innerText(), /原型评审.*已取消/);
    const [anchor, tip] = await Promise.all([badge.boundingBox(), popover.boundingBox()]);
    assert.ok(tip.y + tip.height <= anchor.y && tip.x >= 0 && tip.x + tip.width <= width);
    await page.screenshot({ path: path.join(output, 'waiting-' + width + '.png') });
    await page.keyboard.press('Escape');
    await popover.waitFor({ state: 'hidden' });

    const drawer = page.locator('#eventDrawer');
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
    assert.equal(modelRequests, 0);
    assert.equal(writes.length, 0);
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
    assert.equal(modelRequests, 1);
    assert.equal(writes.length, 0);
    await page.screenshot({ path: path.join(output, 'recommendation-' + width + '.png') });
    await addition.click();
    const removeRecommended = drawer.getByRole('button', { name: '移除：确定验收口径', exact: true });
    await removeRecommended.waitFor();
    assert.equal(writes.length, 1);
    const manual = drawer.getByRole('button', { name: '添加前置', exact: true });
    await picker.selectOption('future');
    await manual.click();
    await drawer.getByText('模拟前置保存失败', { exact: true }).waitFor();
    assert.equal(writes.length, 1);
    assert.equal(await picker.inputValue(), 'future');
    await manual.click();
    const removeManual = drawer.getByRole('button', { name: '移除：下周验证', exact: true });
    await removeManual.waitFor();
    assert.equal(writes.length, 2);
    await removeManual.click();
    await removeManual.waitFor({ state: 'detached' });
    assert.equal(writes.length, 3);
    assert.equal(await drawer.isVisible(), true);
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
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), width);
    assert.deepEqual(errors, []);
  } finally {
    await page.close();
  }
}

async function main() {
  fs.mkdirSync(output, { recursive: true });
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
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
