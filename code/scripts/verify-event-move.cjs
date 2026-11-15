// TEST-012: run only against a disposable local database with source reading disabled.
// TODO_MOVE_TEST_URL must explicitly point to that server; the normal app port is forbidden.
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const origin = process.env.TODO_MOVE_TEST_URL;
assert.ok(origin && new URL(origin).hostname === '127.0.0.1' && new URL(origin).port !== '8000', 'Set TODO_MOVE_TEST_URL to an isolated local server (not port 8000)');
const output = path.resolve(__dirname, '../../runtime/issue1-ui');
fs.mkdirSync(output, { recursive: true });

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const checks = [], errors = [];
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(origin);
    await page.waitForFunction(() => typeof wbSnapshot !== 'undefined' && wbSnapshot && !wbLoading);
    async function api(url, data, method = 'POST') {
      const response = await page.request.fetch(origin + '/api' + url, { method, ...(data ? { data } : {}) });
      assert.equal(response.status(), 200, await response.text());
      return response.json();
    }
    async function create(type, parent, name) {
      return api('/items', { type, parent, name, operation_id: randomUUID() });
    }
    const goal = await create('goal', null, '迁移测试目标 ' + randomUUID().slice(0, 6));
    const module = await create('module', goal.id, '智能输配');
    const thing = await create('thing', module.id, '产品设计');
    const local = await create('thing', module.id, '合同回款');
    const emptyModule = await create('module', goal.id, '暂无事情模块');
    const targetGoal = await create('goal', null, '另一个目标');
    const targetModule = await create('module', targetGoal.id, '商务管理');
    const target = await create('thing', targetModule.id, '合同回款与项目交付资料核对'.repeat(6));
    const root = await create('event', thing.id, '原型评审');
    const view = await api('/events/' + root.id + '/structure', null, 'GET');
    const child = (await api('/events/' + root.id + '/children', {
      action: 'children', snapshot: view.snapshot, operation_id: randomUUID(),
      children: [{ type: 'event', parent: thing.id, name: '确认评审意见' }],
    })).created[0];
    await page.reload();
    await page.waitForFunction(() => wbSnapshot && !wbLoading);
    await page.evaluate(id => locateWorkbench(id), root.id);
    await page.locator('#eventMoveEntry').click();
    await page.locator('#moveThing').selectOption(local.id);
    await page.waitForFunction(() => !!movePreview);
    assert.match(await page.locator('#moveImpact').innerText(), /2 个事件/);
    await page.locator('#submitMove').hover();
    assert.equal(await page.locator('#moveDrawer .iconTip').innerText(), '确认迁移');
    for (const width of [1440, 1024, 768, 375]) {
      await page.setViewportSize({ width, height: width === 375 ? 812 : 960 });
      await page.evaluate(() => Promise.all(document.getAnimations().map(a => a.finished)));
      await page.locator('#moveGoal').focus();
      const layout = await page.evaluate(() => {
        const d = document.querySelector('#moveDrawer');
        return { page: document.documentElement.scrollWidth, viewport: innerWidth, drawer: d.clientWidth, scroll: d.scrollWidth, focus: document.activeElement.id };
      });
      assert.ok(layout.page <= width && layout.scroll <= layout.drawer + 1, JSON.stringify(layout));
      assert.equal(layout.focus, 'moveGoal');
      checks.push({ width, ...layout });
      await page.screenshot({ path: path.join(output, `move-${width}.png`) });
    }
    await page.locator('#moveModule').selectOption(emptyModule.id);
    assert.match(await page.locator('#moveImpact').innerText(), /没有可接收/);
    assert.ok(await page.locator('#submitMove').isDisabled());
    await page.screenshot({ path: path.join(output, 'empty-375.png') });
    await page.locator('#moveGoal').selectOption(targetGoal.id);
    assert.equal(await page.locator('#moveModule').inputValue(), '');
    await page.locator('#moveModule').selectOption(targetModule.id);
    await page.locator('#moveThing').selectOption(target.id);
    await page.waitForFunction(() => !!movePreview);
    await page.screenshot({ path: path.join(output, 'long-target-375.png') });
    // A real competing edit invalidates the reviewed preview.
    await api('/items/' + root.id, { ...root, id: undefined, version: undefined, expected_version: root.version, status: 'working', operation_id: randomUUID() }, 'PUT');
    await page.locator('#submitMove').click();
    await page.waitForFunction(() => !moveBusy && !moveIntent && !!document.querySelector('#moveError').textContent);
    assert.match(await page.locator('#moveError').innerText(), /内容已变化/);
    await page.screenshot({ path: path.join(output, 'conflict-375.png') });
    await page.locator('#refreshMove').click();
    await page.waitForFunction(() => !!movePreview);
    await page.locator('#submitMove').click();
    await page.waitForFunction(id => !moveBusy && !moveIntent && selection.thing === id, target.id);
    const after = await api('/items', null, 'GET');
    assert.ok(after.filter(r => [root.id, child].includes(r.id)).every(r => r.parent === target.id));
    await page.waitForSelector('#events .eventTitle');
    assert.match(await page.locator('#events').innerText(), /最末级完成 0 \/ 有效 1/);
    checks.push({ flow: 'real subtree migration, conflict rejection, leaf count and destination navigation', passed: true });
    // Editor entry must not save draft fields. Drop the POST response after the real commit.
    await page.locator(`#events button[onclick="openForm('event','${root.id}')"]`).click();
    await page.locator('#name').fill('未保存的名称');
    await page.locator('#moveEntry').click();
    await page.waitForFunction(() => document.querySelector('#moveGoal').options.length > 1);
    assert.match(await page.locator('#moveFrom').innerText(), /不保存编辑中的字段/);
    await page.locator('#moveGoal').selectOption(goal.id);
    await page.locator('#moveModule').selectOption(module.id);
    await page.locator('#moveThing').selectOption(local.id);
    await page.waitForFunction(() => !!movePreview);
    let dropped = 0;
    await page.route('**/api/events/*/move', async route => {
      if (route.request().method() !== 'POST') return route.continue();
      dropped++;
      const response = await route.fetch();
      assert.equal(response.status(), 200);
      await route.abort('failed');
    });
    await page.locator('#submitMove').click();
    await page.waitForFunction(() => !moveBusy && !!moveIntent);
    assert.equal(dropped, 1);
    await page.unroute('**/api/events/*/move');
    await page.route('**/api/events/*/move', route => route.fulfill({
      status: 401, contentType: 'application/json', body: JSON.stringify({ detail: '会话已失效，请刷新页面' }),
    }));
    await page.locator('#retryMove').click();
    await page.waitForFunction(() => !moveBusy && document.querySelector('#moveError').textContent.includes('会话已失效'));
    assert.ok(await page.evaluate(() => !!moveIntent));
    await page.unroute('**/api/events/*/move');
    await page.reload();
    await page.waitForFunction(() => wbSnapshot && !wbLoading);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.screenshot({ path: path.join(output, 'recovery-home-375.png') });
    await page.getByRole('button', { name: '核对待确认迁移', exact: true }).click();
    await page.locator('#checkMove').click();
    await page.waitForFunction(id => !moveBusy && !moveIntent && selection.thing === id, local.id);
    const recovered = (await api('/items', null, 'GET')).find(r => r.id === root.id);
    assert.equal(recovered.name, '原型评审');
    assert.equal(recovered.version, 4); // edit + two moves, no replay mutation
    assert.equal(dropped, 1);
    checks.push({ flow: 'lost response, reload recovery, no automatic retry, unsaved draft never submitted', passed: true });
    // Closing a pending preview prevents a stale response from rendering in another drawer.
    await page.evaluate(id => openEventMove(id), root.id);
    let release, started;
    const gate = new Promise(resolve => { release = resolve; });
    const requested = new Promise(resolve => { started = resolve; });
    await page.route('**/api/events/*/move?*', async route => {
      const response = await route.fetch();
      started();
      await gate;
      await route.fulfill({ response });
    });
    await page.locator('#moveThing').selectOption(thing.id);
    await requested;
    await page.locator('#closeMove').click();
    const delivered = page.waitForResponse(r => r.url().includes('/move?'));
    release();
    await delivered;
    await page.unroute('**/api/events/*/move?*');
    assert.ok(await page.locator('#moveDrawer').isHidden());
    assert.equal(await page.evaluate(() => movePreview), null);
    checks.push({ flow: 'closed drawer ignores late preview response', passed: true });
    assert.deepEqual(errors, []);
    fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify({ checks, errors }, null, 2));
    console.log(JSON.stringify({ checks: checks.length, errors, output }));
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
