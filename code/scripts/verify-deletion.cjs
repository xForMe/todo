// TEST-014: disposable local database only; source reading must be disabled.
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const origin = process.env.TODO_DELETE_TEST_URL;
assert.ok(origin && new URL(origin).hostname === '127.0.0.1' && new URL(origin).port && new URL(origin).port !== '8000', 'Set TODO_DELETE_TEST_URL to an isolated local server');
const output = path.resolve(__dirname, '../../runtime/issue2-ui');
fs.mkdirSync(output, { recursive: true });
(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const errors = [], checks = [];
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(origin);
    await page.waitForFunction(() => wbSnapshot && !wbLoading);
    async function api(url, data, method = 'POST') {
      const res = await page.request.fetch(origin + '/api' + url, { method, ...(data ? { data } : {}) });
      assert.equal(res.status(), 200, await res.text());
      return res.json();
    }
    const create = (type, parent, name) => api('/items', { type, parent, name, operation_id: randomUUID() });
    const goal = await create('goal', null, '删除回归 ' + randomUUID().slice(0, 6));
    const module = await create('module', goal.id, '测试模块');
    const thing = await create('thing', module.id, '重复行动核对');
    const target = await create('thing', module.id, '接收事情');
    const first = await create('event', thing.id, '确定原型评审的时间节点');
    const second = await create('event', thing.id, first.name);
    await page.reload();
    await page.waitForFunction(() => wbSnapshot && !wbLoading);
    await page.evaluate(id => locateWorkbench(id), thing.id);
    const entry = id => page.locator(`#events button[onclick="openDeletion('${id}')"]`);
    await entry(first.id).click();
    await page.waitForFunction(() => deletionView?.impact);
    await page.locator('#closeDelete').click();
    assert.ok((await api('/items', null, 'GET')).some(x => x.id === first.id));
    checks.push('cancel does not delete');
    await entry(first.id).click();
    await page.waitForFunction(() => deletionView?.impact);
    for (const width of [1440, 1024, 768, 375]) {
      await page.setViewportSize({ width, height: width === 375 ? 812 : 960 });
      await page.evaluate(() => Promise.all(document.getAnimations().map(a => a.finished)));
      await page.locator('#submitDelete').focus();
      const layout = await page.evaluate(() => ({
        page: document.documentElement.scrollWidth, viewport: innerWidth,
        drawer: deleteDrawer.clientWidth, scroll: deleteDrawer.scrollWidth,
        focus: document.activeElement.id,
        centerX: deleteDrawer.getBoundingClientRect().x + deleteDrawer.getBoundingClientRect().width / 2,
        centerY: deleteDrawer.getBoundingClientRect().y + deleteDrawer.getBoundingClientRect().height / 2,
        height: innerHeight, animation: getComputedStyle(deleteDrawer).animationName,
      }));
      assert.ok(layout.page <= width && layout.scroll <= layout.drawer + 1, JSON.stringify(layout));
      assert.equal(layout.focus, 'submitDelete');
      assert.ok(Math.abs(layout.centerX - width / 2) < 2);
      assert.ok(Math.abs(layout.centerY - layout.height / 2) < 2);
      assert.equal(layout.animation, 'none');
      assert.equal(await page.locator('#submitDelete').innerText(), '确认删除');
      await page.screenshot({ path: path.join(output, `delete-${width}.png`) });
      checks.push(layout);
    }
    await page.setViewportSize({ width: 1440, height: 960 });
    // Commit but lose the response: no retry, recover after a full page reload.
    let posts = 0;
    await page.route('**/api/items/' + first.id + '/deletion', async route => {
      if (route.request().method() !== 'POST') return route.continue();
      posts++;
      await route.fetch();
      await route.abort('failed');
    });
    await page.locator('#submitDelete').click();
    await page.waitForFunction(() => deletionIntent && !deletionBusy);
    assert.equal(posts, 1);
    await page.reload();
    await page.waitForFunction(() => wbSnapshot && !wbLoading);
    await page.locator('.workspaceBar button[aria-label="核对待确认删除"]').click();
    await page.locator('#checkDelete').click();
    await page.waitForFunction(() => !deletionIntent && !deleteDrawer.open);
    const rows = await api('/items', null, 'GET');
    assert.ok(!rows.some(x => x.id === first.id) && rows.some(x => x.id === second.id));
    assert.equal(posts, 1);
    checks.push('lost response and reload recovery; only selected duplicate removed');
    // Details and editor provide the same deletion flow; unsaved fields stay unsaved.
    await page.evaluate(id => locateWorkbench(id), second.id);
    await page.locator('#eventContent button[aria-label="删除事件"]').click();
    await page.waitForFunction(() => deletionView?.impact);
    await page.locator('#closeDelete').click();
    await page.locator(`#events button[onclick="openForm('event','${second.id}')"]`).click();
    await page.locator('#name').fill('未保存草稿');
    await page.locator('#deleteEntry').click();
    await page.waitForFunction(() => deletionView?.impact);
    assert.match(await page.locator('#deleteName').innerText(), new RegExp(first.name));
    await page.locator('#closeDelete').click();
    // Parent protection, including visible rejection feedback.
    let view = await api('/events/' + second.id + '/structure', null, 'GET');
    const children = await api('/events/' + second.id + '/children', {
      operation_id: randomUUID(), snapshot: view.snapshot, action: 'children',
      children: [{ type: 'event', parent: thing.id, name: '子事件' }],
    });
    await page.evaluate(id => locateWorkbench(id), thing.id);
    await page.waitForSelector('#events .eventTitle');
    await entry(second.id).click();
    await page.waitForFunction(() => !deletionBusy);
    assert.match(await page.locator('#deleteError').innerText(), /子事件/);
    assert.ok(await page.locator('#submitDelete').isDisabled());
    await page.evaluate(() => Promise.all(document.getAnimations().map(a => a.finished)));
    await page.screenshot({ path: path.join(output, 'child-protection.png') });
    await page.locator('#closeDelete').click();
    checks.push('event detail/editor entries and parent protection');
    // Thing deletion preserves both events at the reviewed destination.
    await entry(thing.id).click();
    await page.waitForFunction(() => deletionView?.impact);
    assert.ok(await page.locator('#submitDelete').isDisabled());
    await page.locator('#deleteTarget').selectOption(target.id);
    await page.locator('#submitDelete').click();
    await page.waitForFunction(() => !deletionBusy && !deleteDrawer.open);
    const after = await api('/items', null, 'GET');
    assert.ok(!after.some(x => x.id === thing.id));
    assert.ok(after.filter(x => [second.id, ...children.created].includes(x.id)).every(x => x.parent === target.id));
    checks.push('thing direct delete transfers events and tree');
    // Empty thing can be removed directly with confirmation.
    const empty = await create('thing', module.id, '空事情');
    await page.evaluate(id => locateWorkbench(id), empty.id);
    await entry(empty.id).click();
    await page.waitForFunction(() => deletionView?.impact);
    await page.locator('#submitDelete').click();
    await page.waitForFunction(() => !deletionBusy && !deleteDrawer.open);
    assert.ok(!(await api('/items', null, 'GET')).some(x => x.id === empty.id));
    assert.deepEqual(errors, []);
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify({ checks, errors }, null, 2));
    process.stdout.write(JSON.stringify({ checks, errors }, null, 2));
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
