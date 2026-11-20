// TECH-006 / TEST-005 / TEST-025. From the repository root:
// node code/frontend-react/test/source-drawer.cjs
// Browser traffic is fulfilled from disk or memory, or blocked; no live service is needed.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require('playwright');

const frontend = path.resolve(__dirname, '../public');
const origin = 'https://source-fixture.invalid';
const bundle = '/dist/workbench-react.js';
const ids = ['sourceTitle', 'sourceContext', 'sourceForm', 'sourceAddressLabel', 'sourceAddress',
  'sourceInterval', 'sourceConsent', 'aiConsent', 'sourceError', 'saveSource', 'sourceList'];
const uuid = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i;
const thing = '00000000-0000-4000-8000-000000000003';
const event = '00000000-0000-4000-8000-000000000004';
const otherThing = '00000000-0000-4000-8000-000000000007';
const thingName = '交付材料 <初稿 & 合订>';
const eventName = '核对会议 <记录 & 行动>';
const doc = name => `https://synthetic.feishu.cn/wiki/${name}`;
const addresses = {
  firstChat: 'oc_AccountFirst', secondChat: 'oc_AccountSecond', addedChat: 'oc_AddedChat',
  thing: doc('ThingSeed'), event: doc('EventSeed'), other: doc('OtherThingSeed'),
  addedThing: doc('NewThing'), addedEvent: doc('NewEvent'),
};
const items = [
  ['g1', 'goal', null, '目标甲'], ['m1', 'module', 'g1', '模块甲'],
  [thing, 'thing', 'm1', thingName], [event, 'event', thing, eventName],
  ['g2', 'goal', null, '目标乙'], ['m2', 'module', 'g2', '模块乙'],
  [otherThing, 'thing', 'm2', '对照事情'],
].map(([id, type, parent, name]) => ({
  id, type, parent, name, version: 1, status: 'working', description: '', owner: '', planStart: '', planEnd: '',
}));
const priorities = { week: '2026-11-16', items: [] };
const snapshot = { items, priorities, today: '2026-11-19', attention: [], branches: [], links: [], dependencies: [] };
const recordedAt = Date.parse('2026-11-19T02:30:00Z') / 1000;
const evidence = '合成原文 <b>不渲染标签</b> & 保留换行\n第二行';
const success = '来源设置已保存并读回';
const failureSuffix = '；操作结果待核对，请刷新来源列表，不会自动重试';

async function intercept(context, page) {
  const records = new Map([
    ['chat-1', 'chat', '', addresses.firstChat], ['chat-2', 'chat', '', addresses.secondChat],
    ['thing-1', 'document', thing, addresses.thing], ['event-1', 'document', event, addresses.event],
    ['other-1', 'document', otherThing, addresses.other],
  ].map(([id, kind, context, address]) => [id, {
    id, kind, context, address, version: 1, interval: 900, enabled: true, removed: false,
    ai_consent: false, status: '等待读取', content: '', last_run: 0,
  }]));
  const problems = [], traffic = [], writes = [];
  let nextWrite = null, rejectReadback = false;
  const startup = Promise.withResolvers();
  page.once('close', startup.resolve);
  const visibleRecords = () => [...records.values()].filter(row => !row.removed).map(row => ({ ...row }));
  page.on('pageerror', error => problems.push(`Page error: ${error.message}`));
  await context.routeWebSocket('**/*', socket => {
    problems.push(`Unexpected WebSocket: ${socket.url()}`);
    return socket.close(); // No connectToServer().
  });
  await context.route('**/*', async route => {
    const request = route.request();
    const url = new URL(request.url());
    const { pathname } = url;
    const method = request.method();
    const reject = reason => {
      problems.push(`${reason}: ${method} ${url.href}`);
      return route.abort();
    };
    // Fail closed for all origins, methods, endpoints and static paths not served below.
    if (url.origin !== origin) return reject('Unexpected origin');
    const json = data => route.fulfill({ json: data });
    try {
      if (pathname === '/api/sources') {
        assert.equal(url.search, '', 'Source listing remains account-wide, not a target query');
        assert.equal(request.headers()['x-todo-client'], 'web');
        if (method === 'GET') {
          if (rejectReadback) {
            rejectReadback = false;
            return route.fulfill({ status: 503, json: { detail: '模拟来源列表暂不可用' } });
          }
          const rows = visibleRecords();
          traffic.push({ method, rows });
          return json(rows);
        }
        if (method === 'POST') {
          const body = request.postDataJSON();
          writes.push(body);
          traffic.push({ method, body });
          const plan = nextWrite;
          nextWrite = null;
          assert.ok(plan, 'Unexpected source write or automatic retry');
          assert.match(body.id, uuid);
          const { id, ...fields } = body;
          assert.deepEqual(fields, plan.fields);
          if (plan.id) assert.equal(id, plan.id, 'Manual retry and edits use the original source ID');
          const existing = records.get(id);
          assert.equal(fields.expected_version, existing?.version);
          assert.equal(fields.consent, fields.enabled, 'An enabled source requires independent reading consent');
          if (plan.outcome === 'denied') {
            return route.fulfill({ status: 403, json: { detail: '模拟拒绝：当前账号无操作权限' } });
          }
          if (plan.outcome === 'lostBeforeCommit') return route.abort('connectionreset');
          const { consent, expected_version, ...saved } = fields;
          const row = {
            ...existing, ...saved, id, address: fields.kind === 'document' ? fields.address.split(/[?#]/, 1)[0] : fields.address,
            context: fields.context ?? '', version: (existing?.version || 0) + 1,
            status: fields.enabled ? '等待读取' : '已暂停', content: existing?.content || '', last_run: existing?.last_run || 0,
          };
          records.set(id, row);
          if (plan.outcome === 'lostAfterCommit') return route.abort('connectionreset');
          assert.ok(['saved', 'readbackFailed'].includes(plan.outcome));
          rejectReadback = plan.outcome === 'readbackFailed';
          return json(row.removed ? { id, removed: true } : row);
        }
      }
      if (method !== 'GET') return reject('Unexpected write');
      if (pathname === `/api/events/${event}/structure`) return json({ ...snapshot, events: items.filter(row => row.parent === thing), snapshot: '0'.repeat(64) });
      const responses = {
        '/api/session': {}, '/api/items': items, '/api/workbench': snapshot, '/api/priorities': priorities,
        '/api/sources/follow': [], '/api/sources/suggestions': [], '/api/sources/unmatched': [],
        '/api/plan-history-counts': {}, '/api/decomposition/types': [],
      };
      if (Object.hasOwn(responses, pathname)) return json(responses[pathname]);
      if (pathname === '/favicon.ico') return route.fulfill({ status: 204 });
      if (pathname !== '/' && pathname !== bundle && !/^\/[-\w]+\.(?:js|css)$/.test(pathname)) {
        return reject('Unexpected resource or API');
      }
      if (pathname === bundle) await startup.promise;
      const file = pathname === '/' ? 'index.html' : pathname.slice(1);
      const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
      return route.fulfill({ body: await fs.readFile(path.join(frontend, file)), contentType: `${mime[path.extname(file)]}; charset=utf-8` });
    } catch (error) {
      return reject(error.message);
    }
  });
  return {
    problems, traffic, writes,
    releaseBundle: startup.resolve,
    expectWrite(fields, outcome = 'saved', id) {
      assert.equal(nextWrite, null, 'Previous expected write must already have been sent');
      nextWrite = { fields, outcome, id };
    },
    update(id, values) { Object.assign(records.get(id), values); },
    assertReadBack(body, version) {
      const post = traffic.findLastIndex(entry => entry.method === 'POST' && entry.body === body);
      assert.notEqual(post, -1);
      const reads = traffic.slice(post + 1).filter(entry => entry.method === 'GET');
      assert.ok(reads.some(({ rows }) => body.removed ? !rows.some(row => row.id === body.id)
        : rows.some(row => row.id === body.id && row.version === version && row.enabled === body.enabled && row.ai_consent === body.ai_consent)),
      `Expected GET readback after ${body.kind} POST, version ${version}`);
    },
  };
}

async function assertOwnership(drawer) {
  const ownership = await drawer.evaluate(dialog => {
    const fiber = node => Object.keys(node).some(key => key.startsWith('__reactFiber$') && node[key]?.stateNode === node);
    const elements = [...dialog.querySelectorAll('*')];
    const contents = elements.filter(node => !(node.parentElement === dialog && node.matches('.iconTip[role="tooltip"]')));
    const name = node => node.id || node.localName;
    return {
      native: dialog === window.__sourceFixtureOriginal && dialog instanceof HTMLDialogElement && dialog.matches(':modal') && !fiber(dialog),
      marked: dialog.hasAttribute('data-react-owned'), ids: contents.filter(node => node.id).map(node => node.id),
      unowned: contents.filter(node => !fiber(node)).map(name),
      inline: [dialog, ...elements].flatMap(node => node.getAttributeNames().filter(key => /^on/i.test(key)).map(key => `${name(node)}.${key}`)),
    };
  });
  assert.ok(ownership.native, 'Keep the original native dialog in the modal top layer');
  assert.equal(ownership.marked, true);
  for (const id of ids) assert.equal(ownership.ids.filter(value => value === id).length, 1, `Preserve #${id}`);
  assert.deepEqual(ownership.unowned, [], 'React owns every descendant except the shared iconTip');
  assert.deepEqual(ownership.inline, [], 'No legacy inline handlers inside the React drawer');
}

async function exercise(page, fixture) {
  const drawer = page.locator('#sourceDrawer');
  const contextLine = drawer.locator('#sourceContext');
  const list = drawer.locator('#sourceList');
  const error = drawer.locator('#sourceError');
  const notice = page.locator('#notice');
  const text = (locator, value) => locator.getByText(value, { exact: typeof value === 'string' }).waitFor();
  const button = (locator, name) => locator.getByRole('button', { name, exact: true });
  const save = button(drawer, '关联并启用读取');
  const refresh = button(drawer, '刷新 / 核对结果');
  const close = button(drawer, '关闭');
  const settings = button(page, '设置');
  const read = drawer.getByRole('checkbox', { name: '允许按以上范围周期读取（不包含外部发送）', exact: true });
  const ai = drawer.getByRole('checkbox', { name: '允许将此来源及范围内工作标题提交 UAIAPI，自动识别行动与进展', exact: true });
  const interval = drawer.getByRole('combobox', { name: '读取周期', exact: true });
  const address = label => drawer.getByRole('textbox', { name: label, exact: true });
  const chatInput = address('群聊会话 ID');
  const documentInput = address('飞书云文档链接');
  const events = page.locator('#events');
  const goal = page.locator('#goalSelect');
  const card = value => list.locator('.sourceCard').filter({ has: page.getByText(value, { exact: true }) });
  const assertCards = async (...expected) => {
    for (const value of expected) await card(value).waitFor();
    assert.deepEqual(await list.locator('.sourceCard > strong').allTextContents(), expected, 'Only records in the current drawer scope are shown');
  };
  const assertFreshForm = async input => {
    assert.equal(await input.inputValue(), '');
    assert.ok(await input.getAttribute('required') !== null);
    assert.equal(await read.isChecked(), false);
    assert.equal(await ai.isChecked(), false);
    assert.ok(await read.getAttribute('required') !== null, 'Reading consent is mandatory');
    assert.equal(await ai.getAttribute('required'), null, 'AI consent is optional');
  };
  const formFields = (kind, context, address, interval, ai_consent) => ({
    kind, context, address, interval, enabled: true, removed: false, consent: true, ai_consent,
  });
  const advancePoll = () => page.clock.fastForward(10_000);
  const didSave = async (count, version = 1) => {
    await text(notice, success);
    assert.equal(fixture.writes.length, count);
    fixture.assertReadBack(fixture.writes.at(-1), version);
  };

  // Retain the exact shell parsed from the static document, before the bundle can mount.
  await page.addInitScript(() => {
    const observer = new MutationObserver(() => {
      const original = document.getElementById('sourceDrawer');
      if (!original) return;
      window.__sourceFixtureOriginal = original;
      observer.disconnect();
    });
    observer.observe(document, { childList: true, subtree: true });
  });
  await page.clock.install({ time: new Date('2026-11-19T03:00:00Z') });
  await page.clock.pauseAt(new Date('2026-11-19T03:01:00Z'));
  await Promise.all([
    page.waitForRequest(`${origin}${bundle}`),
    page.goto(`${origin}/`, { waitUntil: 'domcontentloaded' }),
  ]);
  const shellState = () => drawer.evaluate(node => ({
    original: node === window.__sourceFixtureOriginal, native: node instanceof HTMLDialogElement,
    open: node.open, children: node.childNodes.length, mounted: node.hasAttribute('data-react-owned'),
  }));
  try {
    assert.deepEqual(await shellState(), { original: true, native: true, open: false, children: 0, mounted: false },
      'The original source dialog has no legacy controls while the bundle is held');
    assert.equal(fixture.writes.length, 0, 'Startup does not write source settings');
  } finally {
    fixture.releaseBundle();
  }
  await page.locator('body:not([data-ui-startup])').waitFor({ state: 'attached' });
  assert.deepEqual(await shellState(), { original: true, native: true, open: false, children: 0, mounted: true },
    'React mounts the original empty source dialog without opening it');
  await button(page, '目标与事情').click();
  await events.getByRole('heading', { name: thingName, exact: true }).waitFor();
  await goal.selectOption('g2');
  await events.getByRole('heading', { name: '对照事情', exact: true }).waitFor();

  await settings.click();
  const channels = page.getByRole('tabpanel', { name: '数据渠道', exact: true });
  await text(channels, '飞书聊天');
  await button(channels, '管理').click();
  await drawer.getByRole('heading', { name: '设置 · 聊天来源', exact: true }).waitFor();
  assert.ok(await contextLine.isHidden(), 'Settings chat is not bound to the selected target, module, thing, or event');
  assert.equal(await chatInput.getAttribute('placeholder'), 'oc_…');
  await assertCards(addresses.firstChat, addresses.secondChat);
  await assertFreshForm(chatInput);
  assert.deepEqual(await interval.locator('option').evaluateAll(nodes => nodes.map(node => [node.value, node.textContent])),
    [['900', '15 分钟'], ['1800', '30 分钟'], ['3600', '1 小时']]);
  await refresh.hover();
  await text(drawer.getByRole('tooltip'), '刷新 / 核对结果');
  await assertOwnership(drawer);

  await chatInput.fill(` ${addresses.addedChat} `);
  await ai.check();
  await save.click();
  assert.equal(fixture.writes.length, 0, 'AI-only consent must not submit');
  assert.ok(await read.evaluate(input => input.validity.valueMissing));
  await read.check();
  await ai.uncheck();
  await interval.selectOption('1800');
  const chatFields = formFields('chat', null, addresses.addedChat, 1800, false);
  fixture.expectWrite(chatFields, 'denied');
  await save.click();
  await text(error, '模拟拒绝：当前账号无操作权限' + failureSuffix);
  assert.notEqual(await notice.textContent(), success);
  fixture.update('chat-1', { status: '部分结果：仅最新消息', last_run: recordedAt, content: evidence });
  await advancePoll();
  const chatCard = card(addresses.firstChat);
  await text(chatCard, '运行中 · 部分结果：仅最新消息');
  await text(chatCard, /^上次读取：/);
  await text(chatCard.locator('summary'), '查看读取内容（原文依据）');
  await chatCard.locator('summary').click();
  await chatCard.locator('pre').waitFor();
  assert.equal(await chatCard.locator('pre').textContent(), evidence);
  assert.equal(await chatCard.locator('pre b').count(), 0, 'Source evidence is rendered as text');
  assert.equal(fixture.writes.length, 1, 'A poll must not retry the rejected write');
  const rejected = fixture.writes[0];
  assert.equal(await chatInput.inputValue(), ` ${addresses.addedChat} `);
  fixture.expectWrite(chatFields);
  await save.click();
  await assertCards(addresses.firstChat, addresses.secondChat, addresses.addedChat);
  await didSave(2);
  assert.notEqual(fixture.writes[1].id, rejected.id, 'A rejected create does not retain a pending ID');
  await page.keyboard.press('Escape');
  await drawer.waitFor({ state: 'hidden' });
  await settings.and(page.locator(':focus')).waitFor();

  await goal.selectOption('g1');
  await events.getByRole('heading', { name: thingName, exact: true }).waitFor();
  await button(events, '关联云文档').click();
  await drawer.getByRole('heading', { name: '云文档与跟进依据', exact: true }).waitFor();
  await text(contextLine, `所属事情：${thingName}`);
  assert.equal(await documentInput.getAttribute('placeholder'), 'https://…feishu.cn/wiki/…');
  await assertCards(addresses.thing);
  await assertFreshForm(documentInput);
  assert.equal(await interval.inputValue(), '1800', 'Retain the existing interval selection across opens');
  const sharedLink = `${addresses.addedThing}?token=synthetic#fragment`;
  await documentInput.fill(sharedLink);
  await interval.selectOption('3600');
  await read.check();
  await ai.check();
  fixture.expectWrite(formFields('document', thing, sharedLink, 3600, true));
  await save.click();
  await assertCards(addresses.thing, addresses.addedThing); // Canonical link comes from GET, not the form value.
  await didSave(3);
  await assertOwnership(drawer);
  await close.click();
  await drawer.waitFor({ state: 'hidden' });
  await advancePoll(); // Clear the previous save notice before the independent unknown-write scenario.
  await notice.getByText(success, { exact: true }).waitFor({ state: 'hidden' });

  const eventRow = events.locator('tbody tr').filter({ has: page.locator(`[data-event="${event}"]`) });
  await button(eventRow, '云文档').click();
  await text(contextLine, `所属事件：${eventName}`);
  await assertCards(addresses.event);
  await assertFreshForm(documentInput);
  assert.equal(await interval.inputValue(), '3600');
  await documentInput.fill(addresses.addedEvent);
  await read.check();
  await ai.check();
  const eventFields = formFields('document', event, addresses.addedEvent, 3600, true);
  fixture.expectWrite(eventFields, 'lostBeforeCommit');
  await save.click();
  await text(error, /操作结果待核对.*不会自动重试/);
  const original = fixture.writes.at(-1);
  assert.equal(fixture.writes.length, 4);
  assert.notEqual(await notice.textContent(), success);
  await close.click();
  await drawer.waitFor({ state: 'hidden' });
  await button(eventRow, '云文档').click();
  await drawer.waitFor();
  assert.equal(await documentInput.inputValue(), addresses.addedEvent, 'Reopening the pending source preserves its draft');
  await refresh.click();
  await text(error, '上次操作仍需核对；原操作标识保留，可手动再次提交');
  await assertCards(addresses.event);
  await advancePoll();
  assert.equal(fixture.writes.length, 4, 'Neither manual readback nor polling resends an unknown write');

  // Only another explicit click sends the unchanged original operation; the reply is lost after commit.
  fixture.expectWrite(eventFields, 'lostAfterCommit', original.id);
  await save.click();
  await text(error, /操作结果待核对.*不会自动重试/);
  assert.deepEqual(fixture.writes.at(-1), original);
  await advancePoll();
  await text(error, '上次操作已读回确认');
  await assertCards(addresses.event, addresses.addedEvent);
  fixture.assertReadBack(fixture.writes.at(-1), 1);
  assert.equal(fixture.writes.length, 5, 'A successful polling readback must not resend the write');

  const added = card(addresses.addedEvent);
  const paused = { ...eventFields, enabled: false, consent: false, expected_version: 1 };
  fixture.expectWrite(paused, 'readbackFailed', original.id);
  await button(added, '暂停').click();
  await text(error, '来源已提交，列表读回失败；请刷新来源列表核对，不会自动重试');
  assert.notEqual(await notice.textContent(), success);
  await text(added, '运行中 · 等待读取');
  assert.ok(await save.isDisabled(), 'An acknowledged write awaiting readback cannot be submitted again');
  assert.equal(fixture.writes.length, 6);
  await refresh.click();
  await text(error, '上次操作已读回确认');
  await text(added, '已暂停 · 已暂停');
  fixture.assertReadBack(fixture.writes.at(-1), 2);

  const change = async (label, enabled, removed, version, count) => {
    const fields = { ...eventFields, enabled, removed, consent: enabled, expected_version: version };
    fixture.expectWrite(fields, 'saved', original.id);
    await button(added, label).click();
    if (removed) await added.waitFor({ state: 'detached' });
    else await text(added, enabled ? '运行中 · 等待读取' : '已暂停 · 已暂停');
    await didSave(count, version + 1);
  };
  await change('恢复读取', true, false, 2, 7);
  await change('移除关联', false, true, 3, 8);
  await assertCards(addresses.event);
  await advancePoll();
  await assertCards(addresses.event);
  assert.equal(fixture.writes.length, 8, 'No write after the final read-only poll');
  await assertOwnership(drawer);
  await close.click();
  await drawer.waitFor({ state: 'hidden' });
}

async function verify() {
  await fs.access(path.join(frontend, bundle.slice(1)));
  const browser = await chromium.launch({ channel: 'chrome', headless: true,
    args: ['--disable-background-networking', '--host-resolver-rules=MAP * ~NOTFOUND', '--no-proxy-server'] });
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, timezoneId: 'Asia/Shanghai',
      serviceWorkers: 'block', reducedMotion: 'reduce' });
    try {
      const page = await context.newPage();
      page.setDefaultTimeout(8000);
      const fixture = await intercept(context, page);
      try {
        await exercise(page, fixture);
        assert.deepEqual(fixture.problems, []);
        console.log(`React source drawer passed: 3 scopes, 8 explicit writes, 6 simulated commits, GET readback and polling; no external requests or page errors.`);
      } catch (error) {
        if (fixture.problems.length) console.error(`React fixture problems: ${fixture.problems.join('; ')}`);
        throw new Error(`React: ${error.message}`, { cause: error });
      }
    } finally {
      await context.close();
    }
  } finally {
    await browser.close();
  }
}

verify().catch(error => { console.error(error); process.exitCode = 1; });
