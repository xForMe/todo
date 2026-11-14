// Browser regression for REQ-O-003. Live phase is read-only; mutations are intercepted fixtures.
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const output = path.resolve(process.env.TODO_UI_OUTPUT || path.resolve(__dirname, '../../runtime/ui-redesign'));
const origin = process.env.TODO_UI_URL || 'http://127.0.0.1:8000';
const checks = [], errors = [];
fs.mkdirSync(output, { recursive: true });

async function layout(page, label) {
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await page.evaluate(() => Promise.all(document.getAnimations().map(a => a.finished.catch(() => {}))));
  const result = await page.evaluate(() => ({
    viewport: innerWidth, width: document.documentElement.scrollWidth,
    dialog: [...document.querySelectorAll('dialog[open]')].map(el => ({
      width: el.clientWidth, scroll: el.scrollWidth, right: el.getBoundingClientRect().right, top: el.getBoundingClientRect().top,
    })),
  }));
  assert.ok(result.width <= result.viewport, `${label}: page overflow ${JSON.stringify(result)}`);
  for (const d of result.dialog) assert.ok(d.scroll <= d.width + 1 && d.right <= result.viewport + 1 && Math.abs(d.top) <= 1, `${label}: drawer overflow ${JSON.stringify(d)}`);
  checks.push({ label, ...result });
  await page.screenshot({ path: path.join(output, label + '.png'), fullPage: result.dialog.length === 0 });
}

async function ready(page) {
  await page.waitForFunction(() => typeof wbSnapshot !== 'undefined' && wbSnapshot && !wbLoading);
  await page.waitForTimeout(250);
}

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage();
    page.on('pageerror', e => errors.push(e.message));
    const unexpectedWrites = [];
    await page.route('**/api/**', route => {
      if (route.request().method() !== 'GET') {
        unexpectedWrites.push(route.request().url());
        return route.abort();
      }
      return route.continue();
    });
    await page.goto(origin);
    await ready(page);
    const snapshot = await page.evaluate(() => wbSnapshot);
    for (const width of [1440, 1024, 887, 768, 375]) {
      await page.setViewportSize({ width, height: width === 375 ? 812 : 960 });
      await page.getByRole('button', { name: '工作台', exact: true }).click();
      await ready(page);
      assert.equal(await page.locator('.wbHeading p, .wbSectionTitle small, .wbSectionTitle .wbCount, .wbFooter').count(), 0);
      assert.doesNotMatch(await page.locator('#workspaceDate').innerText(), /北京时间/);
      await page.evaluate(() => { document.getElementById('notice').textContent = ''; });
      await layout(page, `home-${width}`);
      await page.getByRole('button', { name: '目标与事情', exact: true }).click();
      await ready(page);
      assert.doesNotMatch(await page.locator('#priorityNotice').innerText(), /每周评估|全部事情还有/);
      assert.equal(await page.locator('#priorityNotice input[type=checkbox]').count(), 2);
      const group = await page.locator('.toolbarActions').evaluate(el => {
        const [a,b] = [...el.querySelectorAll('button')].map(b => b.getBoundingClientRect());
        return {deltaY:Math.abs(a.top-b.top),gap:b.left-a.right};
      });
      assert.ok(group.deltaY < 1 && group.gap >= 0 && group.gap <= 12, 'New goal/module controls stay together');
      await page.waitForSelector('.eventName .eventTitle');
      const alignment = await page.locator('.eventName:has(.eventTitle)').first().evaluate(el => {
        const check = el.querySelector('.check').getBoundingClientRect();
        const title = el.querySelector('.eventTitle'), range = document.createRange();
        range.selectNodeContents(title);
        const line = range.getClientRects()[0];
        return Math.abs((check.top+check.bottom)/2-(line.top+line.bottom)/2);
      });
      assert.ok(alignment < 3, `Checkbox/title baseline at ${width}: ${alignment}`);
      const tag = await page.locator('.priorityLabel').first().evaluate(el => ({border:getComputedStyle(el).borderTopWidth,radius:getComputedStyle(el).borderRadius,height:el.getBoundingClientRect().height}));
      assert.equal(tag.border, '0px');
      assert.ok(tag.height <= 28, 'Priority appears as a compact label');
      if (width === 375) {
        const table = await page.locator('.tableWrap').evaluate(el => ({ scroll: el.scrollWidth, width: el.clientWidth, row: el.querySelector('tbody tr')?.getBoundingClientRect().height }));
        assert.ok(table.scroll > table.width, 'Mobile table scrolls inside its panel');
        assert.ok(table.row < 180, 'Mobile action cells must not make rows excessively tall');
      }
      await layout(page, `work-${width}`);
      await page.locator('.priorityLabel:not(:disabled)').first().click();
      await page.waitForSelector('#priorityDrawer[open]');
      await page.keyboard.press('Escape');
      await page.getByRole('button', { name: '编辑当前目标', exact: true }).click();
      assert.equal(await page.locator('#name').evaluate(el => el === document.activeElement), true);
      assert.equal(await page.locator('#deleteEntry svg path').getAttribute('d'), 'M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7');
      await layout(page, `editor-${width}`);
      await page.keyboard.press('Escape');
      assert.equal(await page.locator('dialog[open]').count(), 0);
      await page.getByRole('button', { name: '来源设置', exact: true }).click();
      await layout(page, `sources-${width}`);
      await page.keyboard.press('Escape');
    }
    await page.setViewportSize({ width: 1440, height: 960 });
    await page.getByRole('button', { name: '工作台', exact: true }).click();
    await ready(page);
    await page.locator('.wbGoal').last().click();
    assert.equal(await page.locator('.wbGoal').count(), 1);
    await page.selectOption('#wbScope', '');
    await page.locator('.wbTabs button').filter({ hasText: '已逾期' }).click();
    assert.equal(await page.locator('.wbTabs button[aria-pressed=true]').count(), 1);
    await page.locator('.wbTabs button').filter({ hasText: '全部未结束' }).click();
    await page.locator('.wbLayout > .wbPanel .wbTitle').first().click();
    await page.waitForSelector('#workbenchDrawer[open]');
    await layout(page, 'detail-desktop');
    await page.getByRole('button', { name: '定位到工作页', exact: true }).click();
    await page.waitForSelector('#eventDrawer[open]');
    await layout(page, 'event-detail-desktop');
    await page.keyboard.press('Escape');
    await page.setViewportSize({ width: 375, height: 812 });
    await page.getByRole('button', { name: '工作台', exact: true }).click();
    await ready(page);
    await page.locator('.wbLayout > .wbPanel .wbTitle').first().click();
    await page.waitForSelector('#workbenchDrawer[open]');
    await layout(page, 'detail-mobile');
    await page.getByRole('button', { name: '定位到工作页', exact: true }).click();
    await page.waitForSelector('#eventDrawer[open]');
    await layout(page, 'event-detail-mobile');
    await page.keyboard.press('Escape');
    checks.push({ label: 'live-filter-detail-location', passed: true });
    const sweep = [];
    for (const width of [320, 360, 414, 600, 601, 800, 801, 1000, 1001, 1100, 1101, 1280, 1281, 1920]) {
      await page.setViewportSize({ width, height: 900 });
      for (const name of ['工作台', '目标与事情']) {
        await page.getByRole('button', { name, exact: true }).click();
        await ready(page);
        const rendered = await page.evaluate(() => document.documentElement.scrollWidth);
        assert.ok(rendered <= width, `Breakpoint ${width} ${name}: overflow ${rendered}`);
        sweep.push({ width, view: name, rendered });
      }
    }
    checks.push({ label: 'responsive-breakpoint-sweep', measurements: sweep });
    assert.deepEqual(unexpectedWrites, []);
    await page.close();

    // Fixture scope: override browser responses, never write the real database.
    const mock = await browser.newPage({ viewport: { width: 375, height: 812 } });
    mock.on('pageerror', e => errors.push(e.message));
    let state = structuredClone(snapshot), mode = 'normal', writes = 0;
    const baseEvent = state.items.find(x => x.type === 'event' && ['working','notStarted'].includes(x.status));
    assert.ok(baseEvent, 'Need one event to exercise layout fixtures');
    state.items.find(x => x.id === baseEvent.id).name = '长标题验证：' + '明确责任边界与交付验收条件'.repeat(8);
    for (const item of state.items.filter(x => ['goal', 'module', 'thing'].includes(x.type))) item.name += ' / ' + '长路径验证'.repeat(8);
    state.items.filter(x => x.type === 'thing').forEach((x, i) => { x.status = ['notStarted', 'working', 'completed', 'cancelled'][i % 4]; });
    for (let i = 0; i < 24; i++) state.items.push({ ...baseEvent, id: `fixture-${i}`, name: `分页测试 ${i}`, status: 'notStarted' });
    await mock.route('**/api/**', async route => {
      const url = new URL(route.request().url()), method = route.request().method();
      const send = (json, status = 200) => route.fulfill({ status, json });
      if (method !== 'GET') {
        writes++;
        return send({ detail: '模拟保存失败，输入已保留' }, 409);
      }
      if (url.pathname === '/api/workbench') {
        if (mode === 'error') return send({ detail: '模拟网络不可用' }, 503);
        if (mode === 'empty') return send({ ...state, items: [], attention: [], priorities: { ...state.priorities, items: [] } });
        return send(state);
      }
      if (url.pathname === '/api/items') return send(mode === 'empty' ? [] : state.items);
      if (url.pathname === '/api/priorities') return send(state.priorities);
      // Other existing read endpoints may use the live read-only service.
      return route.continue();
    });
    await mock.goto(origin);
    await ready(mock);
    await layout(mock, 'long-home-375');
    await mock.locator('.wbLayout > .wbPanel .wbPager button').filter({ hasText: '下一页' }).click();
    assert.match(await mock.locator('.wbLayout > .wbPanel .wbPager').innerText(), /第 2\//);
    await mock.getByRole('button', { name: '目标与事情', exact: true }).click();
    await ready(mock);
    await layout(mock, 'long-work-375');
    await mock.getByRole('button', { name: '编辑当前目标', exact: true }).click();
    await mock.locator('#name').fill('');
    await mock.locator('#save').click();
    assert.equal(writes, 0, 'Invalid form must not send writes');
    assert.ok((await mock.locator('#formError').innerText()).length > 0);
    await mock.locator('#name').fill('隔离校验用标题');
    await mock.locator('#save').click();
    await mock.waitForFunction(() => document.getElementById('formError').textContent.includes('模拟保存失败'));
    assert.equal(writes, 1, 'No silent write retry');
    assert.equal(await mock.locator('#name').inputValue(), '隔离校验用标题');
    await layout(mock, 'save-error-375');
    await mock.keyboard.press('Escape');
    await mock.getByRole('button', { name: '工作台', exact: true }).click();
    await ready(mock);
    mode = 'error';
    await mock.getByRole('button', { name: '刷新工作台', exact: true }).click();
    await mock.waitForSelector('.wbWarning');
    assert.equal(await mock.locator('.wbGoal').count(), 0, 'No false statistics after failure');
    await layout(mock, 'read-error-375');
    mode = 'empty';
    await mock.getByRole('button', { name: '刷新工作台', exact: true }).click();
    await mock.waitForSelector('.wbOverview .empty');
    await layout(mock, 'empty-375');
    mode = 'normal';
    await mock.getByRole('button', { name: '刷新工作台', exact: true }).click();
    await ready(mock);
    await mock.emulateMedia({ reducedMotion: 'reduce' });
    await mock.getByRole('button', { name: '目标与事情', exact: true }).click();
    await ready(mock);
    await mock.getByRole('button', { name: '编辑当前目标', exact: true }).click();
    assert.equal(await mock.locator('#editor').evaluate(el => getComputedStyle(el).animationName), 'none');
    await mock.keyboard.press('Tab');
    assert.equal(await mock.evaluate(() => !!document.activeElement.closest('dialog')), true);
    checks.push({ label: 'fixtures-pagination-validation-error-empty-keyboard-reduced-motion', passed: true });
    assert.deepEqual(errors, []);
    fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify({ checks, errors, realWrites: 0, fixtureWrites: writes }, null, 2));
    console.log(JSON.stringify({ checks: checks.length, errors, realWrites: 0, fixtureWrites: writes, output }));
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
