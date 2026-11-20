// REQ-O-010 / TEST-005: isolated Chrome, no network forwarding.
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

const react = true;
const base = 'http://127.0.0.1:18883';
const root = path.resolve(__dirname, '../frontend-react/public');
const bundle = '/dist/workbench-react.js';
const out = path.resolve(__dirname, '../../runtime', `follow-people-ui${react ? '-react' : ''}`);
const widths = [1440, 1024, 768, 375];
const follow = '/api/sources/follow';
const structure = '/api/events/e/structure';

async function assertOwnership(drawer) {
  const actual = await drawer.evaluate(dialog => {
    const nodes = [...dialog.querySelectorAll('*')];
    const fiber = node => Object.keys(node).some(key => key.startsWith('__reactFiber$') && node[key]?.stateNode === node);
    const label = node => node.id || node.localName;
    const content = nodes.filter(node => !node.matches('#followDrawer > .iconTip[role="tooltip"]'));
    return {
      modal: dialog instanceof HTMLDialogElement && dialog.open && dialog.matches(':modal'),
      marked: dialog.hasAttribute('data-react-owned'),
      shellFiber: fiber(dialog),
      owned: content.filter(fiber).map(label),
      unowned: content.filter(node => !fiber(node)).map(label),
      inline: [dialog, ...nodes].flatMap(node => node.getAttributeNames()
        .filter(name => /^on/i.test(name)).map(name => `${label(node)}.${name}`)),
    };
  });
  assert.equal(actual.modal, true, '催办抽屉保留原生模态 dialog');
  assert.equal(actual.marked, react);
  assert.equal(actual.shellFiber, false, 'React 不替换原生外壳');
  if (!react) {
    assert.deepEqual(actual.owned, [], '默认入口保留原生视图');
    return;
  }
  for (const id of ['followContext', 'followPersonQuery', 'followSearch', 'followRecipient', 'followPeopleHint',
    'followAt', 'followCap', 'followContent', 'followError', 'followLogs']) {
    assert.ok(actual.owned.includes(id), `${id} 缺少 React Fiber`);
  }
  assert.deepEqual(actual.unowned, [], '只有公共 iconTip 可由 React 外部创建');
  assert.deepEqual(actual.inline, [], 'React 抽屉不使用内联事件');
}

(async () => {
  if (react) fs.accessSync(path.join(root, bundle.slice(1)), fs.constants.R_OK);
  fs.mkdirSync(out, { recursive: true });
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  let releaseLate;
  const startup = Promise.withResolvers();
  try {
    const context = await browser.newContext({ serviceWorkers: 'block' });
    const errors = [], writes = [], followTraffic = [];
    let rule = null, fail = false, queries = 0, unique = false, partial = false, contextFail = false;
    let holdStructure, failReadbackAfterPost = false, readbackFail = false, bundleRequests = 0;
    const item = (id, type, parent) => ({ id, type, parent, name: type, description: '',
      owner: type === 'event' ? '张三' : '', planStart: '', planEnd: '2026-11-20', status: 'notStarted', version: 1 });
    const items = [item('g', 'goal', null), item('m', 'module', 'g'), item('t', 'thing', 'm'),
      item('e', 'event', 't'), item('parent', 'event', 't'), item('root', 'event', 't')];
    items.find(x => x.id === 't').description = '确保原型可评审';
    const event = items.find(x => x.id === 'e');
    event.description = '整理功能与演示流程';
    items.find(x => x.id === 'parent').name = '下周汇报';
    items.find(x => x.id === 'root').name = '原型交付';
    const branches = [{ child_id: 'e', parent_id: 'parent' }, { child_id: 'parent', parent_id: 'root' }];
    const people = [
      { id: 'ou_one', name: '张三', department: '研发', enterprise_email: 'a@example.com' },
      { id: 'ou_two', name: '张三', department: '交付', enterprise_email: 'b@example.com' },
    ];
    const priorities = { week: '2026-11-16', items: [] };
    const workbench = { items, priorities, attention: [], branches, links: [], dependencies: [], today: '2026-11-17' };
    await context.routeWebSocket('**/*', socket => {
      errors.push(`Unexpected WebSocket: ${socket.url()}`);
      return socket.close();
    });
    await context.route('**/*', async route => {
      const req = route.request(), url = new URL(req.url()), method = req.method(), p = url.pathname;
      const abort = reason => {
        errors.push(`${reason}: ${method} ${req.url()}`);
        return route.abort();
      };
      if (url.origin !== base) return abort('Unexpected origin');
      if (method === 'POST' && p === `${follow}/e`) {
        const body = req.postDataJSON();
        writes.push(body);
        if (body.expected_version !== (rule?.version || 0) || body.event_version !== event.version) {
          followTraffic.push('POST 409');
          return route.fulfill({ status: 409, json: { detail: '模拟版本冲突' } });
        }
        const { expected_version, ...fields } = body;
        rule = { ...fields, event_id: event.id, version: expected_version + 1, count: 0,
          status: body.enabled ? '已开启' : '已暂停', next_run: body.enabled ? 1795213200 : 0, logs: rule?.logs || [] };
        followTraffic.push('POST 200');
        if (failReadbackAfterPost) {
          failReadbackAfterPost = false;
          readbackFail = true;
        }
        return route.fulfill({ json: rule });
      }
      if (method !== 'GET') return abort('Unexpected write');
      if (p === follow) {
        followTraffic.push(readbackFail ? 'GET 503' : 'GET 200');
        return readbackFail ? route.fulfill({ status: 503, json: { detail: '模拟催办规则读回失败' } })
          : route.fulfill({ json: rule ? [rule] : [] });
      }
      if (p === '/api/sources/follow-people') {
        if (url.searchParams.get('event_id') !== event.id) return abort('Unexpected people query event');
        queries++;
        if (fail) return route.fulfill({ status: 503, json: { detail: '模拟查询失败' } });
        const saved = url.searchParams.get('saved') === 'true';
        const candidates = saved ? people.filter(person => person.id === rule?.recipient)
          : url.searchParams.get('query') === '无人' ? [] : unique ? people.slice(0, 1) : people;
        return route.fulfill({ json: { people: candidates, has_more: !saved && partial } });
      }
      if (p === structure) {
        if (holdStructure) {
          const gate = holdStructure;
          holdStructure = null;
          await gate;
        }
        return contextFail ? route.fulfill({ status: 503, json: { detail: '模拟上下文失败' } })
          : route.fulfill({ json: { ...workbench, events: items.filter(x => x.type === 'event') } });
      }
      if (p.startsWith('/api/')) {
        const data = { '/api/session': {}, '/api/items': items, '/api/workbench': workbench, '/api/priorities': priorities };
        return route.fulfill({ json: data[p] || [] });
      }
      if (p === bundle) {
        if (!react) return abort('Unexpected React bundle in native mode');
        bundleRequests++;
        await startup.promise;
      }
      const name = p === bundle ? bundle.slice(1) : p === '/' ? 'index.html' : path.basename(p);
      const file = path.join(root, name), exists = fs.existsSync(file) && fs.statSync(file).isFile();
      return route.fulfill({ status: exists ? 200 : 404, body: exists ? fs.readFileSync(file) : '',
        contentType: name.endsWith('.js') ? 'text/javascript' : name.endsWith('.css') ? 'text/css' : 'text/html' });
    });
    const page = await context.newPage();
    page.setDefaultTimeout(8000);
    page.on('pageerror', error => errors.push(error.message));
    await Promise.all([
      page.waitForRequest(`${base}${bundle}`),
      page.goto(`${base}/`, { waitUntil: 'domcontentloaded' }),
    ]);
    const originalDrawer = await page.locator('#followDrawer').elementHandle();
    const shellState = () => page.locator('#followDrawer').evaluate((node, original) => ({
      original: node === original, native: node instanceof HTMLDialogElement, open: node.open,
      children: node.childNodes.length, mounted: node.hasAttribute('data-react-owned'),
    }), originalDrawer);
    assert.deepEqual(await shellState(), { original: true, native: true, open: false, children: 0, mounted: false });
    assert.deepEqual([queries, writes.length], [0, 0], 'Startup must not look up people or save a follow rule');
    startup.resolve();
    await page.locator('body:not([data-ui-startup])').waitFor({ state: 'attached' });
    await page.waitForFunction(() => typeof get === 'function' && get('e'));
    assert.deepEqual(await shellState(), { original: true, native: true, open: false, children: 0, mounted: true });
    assert.equal(bundleRequests, 1);
    await page.getByRole('button', { name: '目标与事情', exact: true }).click();

    const bell = page.locator('#events .followBell[data-event="e"]');
    const drawer = page.locator('#followDrawer');
    const query = drawer.locator('#followPersonQuery'), recipient = drawer.locator('#followRecipient');
    const search = drawer.locator('#followSearch'), content = drawer.locator('#followContent');
    const save = drawer.getByRole('button', { name: '保存催办配置', exact: true });
    const open = () => page.evaluate(() => openFollowRule('e'));
    const close = async () => {
      await drawer.getByRole('button', { name: '关闭', exact: true }).click();
      await drawer.waitFor({ state: 'hidden' });
    };
    const waitValue = (selector, value) => page.waitForFunction(([selector, value]) =>
      document.querySelector(selector)?.value === value, [selector, value]);

    await bell.click();
    await drawer.getByText(/请选择人员；同名/).waitFor();
    assert.equal(await query.inputValue(), '张三');
    assert.equal(queries, 1);
    const draft = await content.inputValue();
    assert.match(draft, /事情「thing」/);
    assert.match(draft, /确保原型可评审/);
    assert.match(draft, /原型交付 → 下周汇报/);
    assert.match(draft, /整理功能与演示流程/);
    assert.match(draft, /2026-11-20/);
    await search.click();
    await page.waitForFunction(() => document.querySelector('#followRecipient').options.length === 3);
    assert.equal(await recipient.inputValue(), '');
    await page.evaluate(() => saveFollowRule(true));
    assert.equal(writes.length, 0);
    await recipient.selectOption('ou_two');
    await recipient.selectOption('ou_one');
    assert.equal(await drawer.locator('#followVerified').count(), 0);
    await search.focus();
    await assertOwnership(drawer);
    for (const width of widths) {
      await page.setViewportSize({ width, height: 1000 });
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      await drawer.evaluate(node => node.scrollTop = 0);
      await page.screenshot({ path: path.join(out, `people-${width}.png`) });
    }

    await content.fill('已批准的人工正文');
    await save.click();
    await page.getByText('规则已保存并读回', { exact: true }).waitFor();
    await waitValue('#followRecipient', 'ou_one');
    assert.equal(await content.inputValue(), '已批准的人工正文');
    assert.equal(writes[0].recipient, 'ou_one');
    assert.equal(await recipient.inputValue(), 'ou_one');
    assert.equal(await drawer.locator('#followVerified').count(), 0);

    fail = true;
    await search.click();
    await drawer.getByText(/模拟查询失败；请重新查询/).waitFor();
    await page.evaluate(() => saveFollowRule(false));
    assert.equal(writes.at(-1).recipient, 'ou_one');
    assert.equal(writes.at(-1).enabled, false);
    fail = false;
    await query.fill('无人');
    await search.click();
    await drawer.getByText(/未找到可识别的人员/).waitFor();
    assert.equal(await recipient.inputValue(), '');

    rule = null;
    unique = true;
    await open();
    await waitValue('#followRecipient', 'ou_one');
    assert.equal(await drawer.locator('#followVerified').count(), 0);
    assert.equal(writes.length, 2);
    await page.evaluate(() => saveFollowRule(true));
    assert.equal(writes.length, 3);
    assert.equal(writes.at(-1).enabled, true);
    assert.equal('verified' in writes.at(-1), false);
    await content.fill('人工编辑');
    await drawer.getByRole('button', { name: '按当前上下文重新整理', exact: true }).click();
    await waitValue('#followContent', draft);

    rule = null;
    partial = true;
    await open();
    await drawer.getByText(/仅显示部分人员/).waitFor();
    assert.equal(await recipient.inputValue(), '');
    partial = false;
    contextFail = true;
    await open();
    await drawer.getByText(/模拟上下文失败/).waitFor();
    assert.equal(await content.inputValue(), '');
    await page.evaluate(() => saveFollowRule(true));
    assert.equal(writes.length, 3);
    contextFail = false;
    await page.evaluate(() => {
      const event = get('e'), items = db.items;
      if (makeFollowDraft(event, items, []).includes('上级事件')) throw Error('top level context');
      try {
        makeFollowDraft(event, items, [{ child_id: 'e', parent_id: 'e' }]);
        throw Error('accepted cycle');
      } catch (error) {
        if (error.message === 'accepted cycle') throw error;
      }
    });

    // Hold only the first structure response. Wait for that exact opening to finish after releasing it.
    holdStructure = new Promise(resolve => { releaseLate = resolve; });
    const requested = page.waitForRequest(`${base}${structure}`);
    await page.evaluate(() => { window.testLateFollowOpen = openFollowRule('e'); });
    await requested;
    await drawer.getByText(/正在读取事件与上级上下文/).waitFor();
    await close();
    await bell.click();
    await drawer.getByText(/已按事件负责人自动匹配/).waitFor();
    await content.fill('新抽屉编辑');
    releaseLate();
    await page.evaluate(() => window.testLateFollowOpen);
    assert.equal(await content.inputValue(), '新抽屉编辑', '迟到的旧抽屉响应不能覆盖新草稿');

    // The mock persists the POST, then fails subsequent follow-list GETs until the explicit reopen.
    const before = followTraffic.length, beforeWrites = writes.length;
    await page.evaluate(() => {
      const notice = document.querySelector('#notice');
      window.testFollowNotices = [];
      new MutationObserver(() => window.testFollowNotices.push(notice.textContent))
        .observe(notice, { childList: true, characterData: true, subtree: true });
    });
    const post = page.waitForResponse(response => response.url() === `${base}${follow}/e` && response.request().method() === 'POST');
    failReadbackAfterPost = true;
    await save.click();
    assert.equal((await post).status(), 200);
    await drawer.locator('#followError').getByText(/读回失败.*重新打开核对结果.*不会自动重试/).waitFor();
    const traffic = followTraffic.slice(before);
    assert.ok(traffic.indexOf('POST 200') >= 0 && traffic.lastIndexOf('GET 503') > traffic.indexOf('POST 200'),
      `需要 POST 成功后实发模拟 GET 并失败：${traffic.join(', ')}`);
    assert.equal(writes.length, beforeWrites + 1);
    assert.equal(rule.content, '新抽屉编辑');
    assert.equal(await content.inputValue(), rule.content);
    await close();
    readbackFail = false;
    await bell.click();
    await waitValue('#followRecipient', 'ou_one');
    assert.equal(await content.inputValue(), '新抽屉编辑');
    assert.equal(await drawer.locator('#followError').textContent(), '');
    assert.equal(writes.length, beforeWrites + 1, '读回失败后重新打开只能查询，不能重发');
    assert.ok(!(await page.evaluate(() => window.testFollowNotices)).includes('规则已保存并读回'),
      '读回失败时不得报告已保存并读回');
    await assertOwnership(drawer);
    assert.equal((await shellState()).original, true, 'Follow configuration keeps the original native dialog');
    await originalDrawer.dispose();

    assert.deepEqual(errors, []);
    fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify({ passed: true, mode: react ? 'react' : 'native',
      widths, queries, mockedWrites: writes.length, readbackFailure: { post: 200, get: 503, writes: 1 } }, null, 2));
    console.log(`PASS (${react ? 'react' : 'native'}): people selection, contextual draft, single-save activation, pause, late response, failed readback without retry, four widths`);
  } finally {
    startup.resolve();
    releaseLate?.();
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
