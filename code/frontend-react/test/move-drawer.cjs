// TEST-012 / TEST-025. From repo root: node code/frontend-react/test/move-drawer.cjs
// Static assets and synthetic state only: no HTTP listener, real API, or database.
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require('playwright'); // Resolves from this file's frontend-react/node_modules.

const frontend = path.resolve(__dirname, '../public');
const output = path.resolve(__dirname, '../../../runtime/react-move-drawer');
const origin = 'https://event-move-fixture.invalid';
const bundle = '/dist/workbench-react.js';
const widths = [1440, 1024, 768, 375];
const rootName = '合成事件 <原型 & 评审>';
const childName = '确认评审意见';
const otherName = '不迁移的同级事件';
const targetName = '跨部门合同回款与项目交付资料核对'.repeat(6);
const localName = '整理合同 <初稿 & 存档>';
const targetPath = ['另一个目标', '商务管理', targetName];
const conflict = '内容已变化，请刷新影响范围后核对';
const authFailure = '会话已失效，请刷新页面';
const intentKey = 'todo.pendingEventMove';
const rows = [
  ['goal-a', 'goal', null, '合成目标'], ['goal-b', 'goal', null, targetPath[0]],
  ['module-a', 'module', 'goal-a', '智能输配'], ['module-empty', 'module', 'goal-a', '没有开放事情的模块'],
  ['module-b', 'module', 'goal-b', targetPath[1]],
  ['source', 'thing', 'module-a', '产品设计'], ['local', 'thing', 'module-a', localName, 'working'],
  ['closed', 'thing', 'module-a', '已经完成的事情', 'completed'],
  ['empty-closed', 'thing', 'module-empty', '已经取消的事情', 'cancelled'],
  ['target', 'thing', 'module-b', targetName],
  ['root', 'event', 'source', rootName, 'notStarted', { description: '此说明不会随表单草稿改变', owner: '合成负责人', planEnd: '2026-11-20' }],
  ['child', 'event', 'source', childName], ['other', 'event', 'source', otherName, 'completed'],
];
const movedIds = ['root', 'child'];
const branch = { parent_id: 'root', child_id: 'child' };
const link = { id: 'internal-link', source: 'child', target: 'root', kind: 'related' };
const fingerprint = (target, version) => createHash('sha256').update(`root:${target}:${version}`).digest('hex');
const item = ([id, type, parent, name, status = 'notStarted', extra = {}]) => ({
  id, type, parent, name, status, version: 1, description: '', owner: '', planStart: '', planEnd: '', ...extra,
});

async function intercept(context, page) {
  const items = rows.map(item);
  const byId = id => items.find(row => row.id === id);
  const root = byId('root');
  const receipts = new Map(), previews = [], attempts = [], lookups = [], reads = [], problems = [];
  const priorities = { week: '2026-11-16', items: [] };
  const snapshot = () => ({ items, priorities, today: '2026-11-19', attention: [], branches: [branch], links: [link], dependencies: [] });
  let nextPreview, nextWrite, nextLookup;
  const startup = Promise.withResolvers();
  page.once('close', startup.resolve);
  const take = (planned, actual, description) => {
    assert.equal(actual, planned?.target, `Unplanned ${description}`);
    return planned;
  };
  function preview(target) {
    const thing = byId(target), module = byId(thing.parent), goal = byId(module.parent);
    assert.notEqual(thing.id, root.parent);
    assert.ok(['notStarted', 'working'].includes(thing.status));
    return {
      event: { ...root }, target: { ...thing }, target_path: [goal.name, module.name, thing.name], moved_ids: movedIds,
      snapshot: fingerprint(target, root.version), detached_parent: null, documents: 1, reminders: 2, discarded_suggestions: 3,
    };
  }
  page.on('pageerror', error => problems.push(`Page error: ${error.message}`));
  await context.routeWebSocket('**/*', socket => {
    problems.push(`Unexpected WebSocket: ${socket.url()}`);
    return socket.close(); // Never connectToServer.
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
    // Fail closed: all browser requests are fulfilled from disk or memory, or aborted.
    if (url.origin !== origin) return reject('Unexpected origin');
    const failure = (status, detail) => route.fulfill({ status, json: { detail } });
    try {
      if (pathname === '/api/events/root/move' && method === 'POST') {
        const body = request.postDataJSON();
        attempts.push(body);
        const target = body.target_id;
        const plan = take(nextWrite, target, 'move write or automatic retry');
        nextWrite = null;
        assert.deepEqual(Object.keys(body).sort(), ['operation_id', 'snapshot', 'target_id']);
        assert.match(body.operation_id, /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i);
        assert.ok(!receipts.has(body.operation_id), 'Do not replay a committed move');
        if (body.snapshot !== fingerprint(target, root.version)) {
          assert.equal(plan.outcome, 'conflict', 'A stale preview may only reach the planned rejection');
          return failure(409, conflict);
        }
        assert.ok(['saved', 'lost'].includes(plan.outcome));
        const source = root.parent;
        for (const id of movedIds) {
          const event = byId(id);
          event.parent = target;
          event.version++;
        }
        const receipt = {
          action: 'move', event_id: root.id, target_id: target, source_id: source, moved_ids: movedIds, operation_id: body.operation_id,
        };
        receipts.set(body.operation_id, receipt);
        if (plan.outcome === 'lost') return route.abort('connectionreset');
        return route.fulfill({ json: receipt });
      }
      if (method !== 'GET') return reject('Unexpected request');
      if (pathname === '/api/events/root/move') {
        const target = url.searchParams.get('target_id');
        const plan = take(nextPreview, target, 'preview');
        nextPreview = null;
        const data = preview(target);
        previews.push({ target, snapshot: data.snapshot });
        plan.started?.();
        await plan.release;
        return route.fulfill({ json: data });
      }
      const operationId = /^\/api\/event-operations\/([^/]+)$/.exec(pathname)?.[1];
      if (operationId) {
        lookups.push(operationId);
        assert.equal(operationId, nextLookup?.operationId, 'Only explicit receipt reads for the original ID are allowed');
        const status = nextLookup.status;
        nextLookup = null;
        if (status === 401) return failure(status, authFailure);
        assert.ok(receipts.has(operationId));
        return route.fulfill({ json: receipts.get(operationId) });
      }
      const eventId = /^\/api\/events\/([^/]+)\/structure$/.exec(pathname)?.[1];
      if (byId(eventId)?.type === 'event') {
        const parent = byId(eventId).parent;
        const events = items.filter(row => row.type === 'event' && row.parent === parent);
        reads.push({ kind: 'structure', parent });
        return route.fulfill({ json: { ...snapshot(), events,
          branches: events.includes(root) ? [branch] : [], links: events.includes(root) ? [link] : [],
          snapshot: fingerprint(parent, root.version),
        } });
      }
      if (pathname === '/api/items') reads.push({ kind: 'items', parent: root.parent });
      if (pathname === '/api/workbench') reads.push({ kind: 'workbench', parent: root.parent });
      const responses = {
        '/api/session': {}, '/api/items': items, '/api/workbench': snapshot(), '/api/priorities': priorities,
        '/api/sources': [], '/api/sources/follow': [], '/api/sources/suggestions': [], '/api/sources/unmatched': [],
        '/api/plan-history-counts': {},
      };
      if (Object.hasOwn(responses, pathname)) return route.fulfill({ json: responses[pathname] });
      if (pathname === '/favicon.ico') return route.fulfill({ status: 204 });
      if (pathname !== '/' && pathname !== bundle && !/^\/[-\w]+\.(?:js|css)$/.test(pathname)) {
        return reject('Unexpected static resource or API');
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
    byId, previews, attempts, lookups, reads, problems,
    releaseBundle: startup.resolve,
    get committed() { return receipts.size; },
    compete() { root.version++; root.status = 'working'; },
    expectPreview(target, held = false) {
      assert.ok(!nextPreview, 'Previous preview plan must have been consumed');
      nextPreview = { target };
      if (!held) return;
      const started = new Promise(resolve => { nextPreview.started = resolve; });
      let release;
      nextPreview.release = new Promise(resolve => { release = resolve; });
      return { release, waitForStart: async () => {
        let deadline;
        try {
          await Promise.race([started, new Promise((_, reject) => {
            deadline = setTimeout(() => reject(Error(`Preview for ${target} never reached the fixture`)), 8000);
          })]);
        } finally { clearTimeout(deadline); }
      } };
    },
    expectWrite(target, outcome) { assert.ok(!nextWrite); nextWrite = { target, outcome }; },
    expectLookup(operationId, status) { assert.ok(!nextLookup); nextLookup = { operationId, status }; },
  };
}

async function ownership(drawer, original) {
  const tree = await drawer.evaluate((dialog, native) => {
    const all = [dialog, ...dialog.querySelectorAll('*')];
    const children = all.slice(1).filter(node => !(node.parentElement === dialog && node.matches('.iconTip[role="tooltip"]')));
    const fiber = node => Object.keys(node).some(key => key.startsWith('__reactFiber$') && node[key]?.stateNode === node);
    const label = node => node.id ? `#${node.id}` : node.localName;
    return {
      nativeShell: dialog === native && dialog instanceof HTMLDialogElement && dialog.matches(':modal') && !fiber(dialog),
      aria: dialog.getAttribute('aria-labelledby'), marked: dialog.hasAttribute('data-react-owned'),
      missing: children.filter(node => !fiber(node)).map(label), fibers: children.filter(fiber).map(label),
      inline: all.flatMap(node => node.getAttributeNames().filter(name => /^on/i.test(name)).map(name => `${label(node)}.${name}`)),
    };
  }, original);
  assert.equal(tree.nativeShell, true, 'Preserve the original native modal element');
  assert.equal(tree.aria, 'moveTitle');
  assert.equal(tree.marked, true);
  for (const id of ['moveTitle', 'moveName', 'moveFrom', 'moveGoal', 'moveModule', 'moveThing', 'moveImpact', 'moveError', 'submitMove']) {
    assert.ok(tree.fibers.includes(`#${id}`), `#${id} needs a React host Fiber`);
  }
  assert.deepEqual(tree.missing, [], 'Every drawer descendant is React-owned except the shared tooltip overlay');
  assert.deepEqual(tree.inline, [], 'React drawer uses no inline event attributes');
}

async function exercise(page, fixture) {
  const drawer = page.locator('#moveDrawer');
  const { attempts, previews, lookups, reads } = fixture;
  const events = page.locator('#events');
  const field = id => drawer.locator(`#${id}`);
  const [goal, module, thing, impact, error, cancel, refresh, submit, check, retry] = [
    'moveGoal', 'moveModule', 'moveThing', 'moveImpact', 'moveError', 'closeMove', 'refreshMove', 'submitMove', 'checkMove', 'retryMove',
  ].map(field);
  const recovery = page.locator('.workspaceBar').getByRole('button', { name: '核对待确认迁移', exact: true });
  const waitText = (host, value) => host.getByText(value, { exact: typeof value === 'string' }).waitFor();
  const options = locator => locator.locator('option').evaluateAll(nodes => nodes.map(x => [x.value, x.textContent]));
  const optionValues = async locator => (await options(locator)).map(([value]) => value);
  const title = name => events.getByRole('button', { name, exact: true });
  const row = name => events.locator('tbody tr').filter({ has: page.getByRole('button', { name, exact: true }) });
  const closed = () => drawer.waitFor({ state: 'hidden' });
  const persisted = () => page.evaluate(key => JSON.parse(sessionStorage.getItem(key) || 'null'), intentKey);
  const exactPath = path => `当前位置：${path.join(' / ')}`;
  const isPreview = target => response => {
    const url = new URL(response.url());
    return url.pathname === '/api/events/root/move' && url.searchParams.get('target_id') === target && response.ok();
  };
  const choose = async target => {
    fixture.expectPreview(target);
    await thing.selectOption(target);
    await waitText(impact, /将 2 个事件迁至/);
    assert.ok(await submit.isEnabled());
  };
  const waitReady = async () => {
    await page.locator('#moveDrawer[data-react-owned]').waitFor({ state: 'attached' });
    await page.locator('#globalWorkbench').getByRole('button', { name: rootName, exact: true }).waitFor();
  };
  const assertLocation = async (goalId, moduleId, thingName, readSince) => {
    await closed();
    await page.locator('#editor').waitFor({ state: 'hidden' });
    await page.locator('#eventDrawer').waitFor({ state: 'hidden' });
    await events.getByRole('heading', { name: thingName, exact: true }).waitFor();
    await waitText(events, /最末级完成 0 \/ 有效 1/);
    await waitText(row(childName), '第 2 层');
    await title(rootName).waitFor();
    assert.equal(await title(otherName).count(), 0, 'Unrelated source event does not appear at the destination');
    assert.equal(await page.locator('#goalSelect').inputValue(), goalId);
    assert.equal(await page.locator('#moduleChoices input:checked').inputValue(), moduleId);
    const target = thingName === targetName ? 'target' : 'local';
    assert.ok(reads.slice(readSince).some(read => read.kind === 'items' && read.parent === target), 'Read committed items back');
    assert.ok(reads.slice(readSince).some(read => read.kind === 'structure' && read.parent === target), 'Load the destination event tree');
    assert.deepEqual(movedIds.map(id => fixture.byId(id).parent), [target, target]);
    assert.equal(fixture.byId('other').parent, 'source');
    assert.equal(await persisted(), null, 'Clear the pending operation only after reading back the result');
    await recovery.waitFor({ state: 'hidden' });
    await waitText(page.locator('#notice'), '事件已迁移，相关来源与催办已暂停');
  };

  await Promise.all([
    page.waitForRequest(`${origin}${bundle}`),
    page.goto(`${origin}/`, { waitUntil: 'domcontentloaded' }),
  ]);
  const original = await drawer.elementHandle();
  try {
    const shellState = () => drawer.evaluate((node, before) => ({
      original: node === before, native: node instanceof HTMLDialogElement, open: node.open,
      children: node.childNodes.length, mounted: node.hasAttribute('data-react-owned'),
    }), original);
    assert.deepEqual(await shellState(), { original: true, native: true, open: false, children: 0, mounted: false },
      'The original move dialog has no legacy fields while the bundle is held');
    assert.deepEqual([previews.length, attempts.length, lookups.length], [0, 0, 0]);
    fixture.releaseBundle();
    await page.locator('body:not([data-ui-startup])').waitFor({ state: 'attached' });
    await waitReady();
    assert.deepEqual(await shellState(), { original: true, native: true, open: false, children: 0, mounted: true },
      'React owns the original empty dialog before user navigation');
    await page.getByRole('button', { name: '目标与事情', exact: true }).click();
    await title(rootName).click();
    await page.locator('#eventMoveEntry').click();
    await page.getByRole('dialog', { name: '迁移事件', exact: true }).waitFor();
    await waitText(field('moveName'), rootName);
    await waitText(field('moveFrom'), exactPath(['合成目标', '智能输配', '产品设计']));
    await waitText(impact, '请选择目标事情，核对迁移范围后确认。');
    for (const [id, name] of [['moveGoal', '目标'], ['moveModule', '模块'], ['moveThing', '事情']]) {
      assert.equal(await drawer.getByRole('combobox', { name, exact: true }).getAttribute('id'), id);
    }
    for (const [locator, name] of [[cancel, '取消'], [refresh, '刷新影响范围'], [submit, '确认迁移']]) {
      assert.equal(await drawer.getByRole('button', { name, exact: true }).getAttribute('id'), await locator.getAttribute('id'));
    }
    assert.equal(await goal.inputValue(), 'goal-a');
    assert.equal(await module.inputValue(), 'module-a');
    assert.deepEqual(await optionValues(goal), ['', 'goal-a', 'goal-b']);
    assert.deepEqual(await optionValues(module), ['', 'module-a', 'module-empty']);
    assert.deepEqual(await options(thing), [['', '请选择事情'], ['local', localName]], 'Exclude the source and closed things');
    assert.ok(await submit.isDisabled());
    assert.equal(attempts.length, 0);

    // Hold a valid preview; selecting another module must invalidate it before it arrives.
    let held = fixture.expectPreview('local', true);
    await thing.selectOption('local');
    await held.waitForStart();
    await waitText(impact, '正在核对迁移影响…');
    assert.ok(await submit.isDisabled());
    assert.equal(attempts.length, 0);
    await module.selectOption('module-empty');
    await waitText(impact, '此模块没有可接收的其他事情，请选择其他模块，或先新建、重开事情。');
    assert.deepEqual(await optionValues(thing), ['']);
    assert.ok(await submit.isDisabled(), 'A module without a receiver cannot be submitted');
    await goal.selectOption('goal-b');
    assert.equal(await module.inputValue(), '');
    assert.deepEqual(await optionValues(module), ['', 'module-b']);
    assert.deepEqual(await optionValues(thing), ['']);
    await module.selectOption('module-b');
    assert.equal(await thing.inputValue(), '');
    assert.deepEqual(await options(thing), [['', '请选择事情'], ['target', targetName]]);
    assert.ok(await submit.isDisabled());
    await choose('target');
    const expectedImpact = `将 2 个事件迁至 ${targetPath.join(' / ')}。保留内容、状态和内部关系；暂停 1 个文档来源、2 条催办，作废 3 条待确认建议。`;
    await waitText(impact, expectedImpact);
    async function deliver(target, pending) {
      const delivered = page.waitForResponse(isPreview(target));
      pending.release();
      await (await delivered).finished();
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    }
    await deliver('local', held);
    await ownership(drawer, original);
    assert.equal(await impact.innerText(), expectedImpact, 'Late preview must not overwrite the newer selection');

    await submit.hover();
    await waitText(drawer.locator('.iconTip[role="tooltip"]'), '确认迁移');
    await ownership(drawer, original);
    for (const width of widths) {
      await page.setViewportSize({ width, height: width === 375 ? 812 : 960 });
      await goal.focus();
      const size = await drawer.evaluate(dialog => ({
        viewport: innerWidth, page: document.documentElement.scrollWidth, scroll: dialog.scrollWidth,
        client: dialog.clientWidth, focus: document.activeElement.id,
      }));
      assert.equal(size.viewport, width);
      assert.ok(size.page <= width && size.scroll <= size.client + 1, JSON.stringify(size));
      assert.equal(size.focus, 'moveGoal');
      await page.screenshot({ path: path.join(output, `react-${width}.png`), animations: 'disabled' });
    }
    await page.setViewportSize({ width: widths[0], height: 960 });

    fixture.compete();
    fixture.expectWrite('target', 'conflict');
    await submit.click();
    await waitText(error, conflict);
    assert.equal(await persisted(), null);
    assert.ok(await submit.isDisabled());
    assert.ok(await refresh.isEnabled());
    assert.ok(await retry.isHidden());
    assert.equal(await thing.inputValue(), 'target');
    assert.deepEqual([attempts.length, previews.length, fixture.committed], [1, 2, 0], '409 must neither refresh automatically nor write');
    assert.deepEqual(movedIds.map(id => fixture.byId(id).parent), ['source', 'source']);
    assert.equal(attempts[0].snapshot, fingerprint('target', 1));
    fixture.expectPreview('target');
    await Promise.all([page.waitForResponse(isPreview('target')), refresh.click()]);
    await waitText(impact, expectedImpact);
    assert.equal(await error.textContent(), '');
    assert.equal(previews.at(-1).snapshot, fingerprint('target', 2));

    let readSince = reads.length;
    fixture.expectWrite('target', 'saved');
    await submit.click();
    await assertLocation('goal-b', 'module-b', targetName, readSince);
    assert.deepEqual([attempts.length, lookups.length, fixture.committed], [2, 0, 1]);
    assert.equal(attempts[1].snapshot, fingerprint('target', 2));

    await row(rootName).getByRole('button', { name: '编辑事件', exact: true }).click();
    await page.locator('#editor #name').fill('不应提交的编辑草稿');
    await page.locator('#editor #moveEntry').click();
    await waitText(field('moveFrom'), exactPath(targetPath) + '。迁移不保存编辑中的字段。');
    await goal.selectOption('goal-a');
    await module.selectOption('module-a');
    await choose('local');
    fixture.expectWrite('local', 'lost');
    await submit.click();
    await error.getByText(/\S/).waitFor();
    const pending = attempts[2];
    assert.deepEqual(await persisted(), { id: 'root', body: pending });
    assert.equal(pending.snapshot, fingerprint('local', 3));
    assert.deepEqual([attempts.length, lookups.length, fixture.committed], [3, 0, 2]);
    assert.ok(await submit.isDisabled());
    assert.ok(await refresh.isDisabled());
    assert.ok(await thing.isDisabled());
    await drawer.getByRole('button', { name: '手动重试原迁移', exact: true }).waitFor();
    await ownership(drawer, original);
    fixture.expectLookup(pending.operation_id, 401);
    await check.click();
    await waitText(error, authFailure);
    assert.deepEqual(await persisted(), { id: 'root', body: pending });
    assert.equal(attempts.length, 3);

    await page.reload();
    await waitReady();
    await recovery.click();
    await waitText(impact, '上次迁移结果待核对，目标：合成目标 / 智能输配 / ' + localName + '。请先查询结果；不会自动重试。');
    assert.deepEqual(await persisted(), { id: 'root', body: pending });
    assert.deepEqual(lookups, [pending.operation_id], 'Do not query or resend on reload until the user asks');
    assert.equal(attempts.length, 3);
    readSince = reads.length;
    fixture.expectLookup(pending.operation_id, 200);
    await drawer.getByRole('button', { name: '核对迁移结果', exact: true }).click();
    await assertLocation('goal-a', 'module-a', localName, readSince);
    assert.deepEqual(lookups, [pending.operation_id, pending.operation_id]);
    assert.equal(fixture.byId('root').name, rootName, 'Moving from the editor must not submit its draft');
    assert.equal(fixture.byId('root').status, 'working');
    assert.equal(fixture.byId('root').version, 4);
    assert.equal(fixture.byId('child').version, 3);
    assert.equal(new Set(attempts.map(body => body.operation_id)).size, 3);

    // The modal may close while a read is in-flight; delivery must not reopen it.
    await title(rootName).click();
    await page.locator('#eventMoveEntry').click();
    await waitText(field('moveFrom'), exactPath(['合成目标', '智能输配', localName]));
    held = fixture.expectPreview('source', true);
    await thing.selectOption('source');
    await held.waitForStart();
    await waitText(impact, '正在核对迁移影响…');
    await cancel.click();
    await closed();
    await deliver('source', held);
    assert.ok(await drawer.isHidden());
    assert.doesNotMatch(await impact.textContent(), /将 2 个事件迁至/);
    assert.deepEqual([attempts.length, previews.length, lookups.length, fixture.committed], [3, 5, 2, 2]);
  } finally {
    await original.dispose();
  }
}

async function verify() {
  await fs.access(path.join(frontend, bundle.slice(1)));
  await fs.mkdir(output, { recursive: true });
  const browser = await chromium.launch({ channel: 'chrome', headless: true,
    args: ['--disable-background-networking', '--host-resolver-rules=MAP * ~NOTFOUND', '--no-proxy-server'] });
  try {
    const context = await browser.newContext({ viewport: { width: widths[0], height: 960 }, serviceWorkers: 'block', reducedMotion: 'reduce' });
    try {
      const page = await context.newPage();
      page.setDefaultTimeout(8000);
      const fixture = await intercept(context, page);
      try {
        await exercise(page, fixture);
        assert.deepEqual(fixture.problems, []);
        console.log(`React move drawer passed (5 previews, 3 explicit writes, 2 commits, 2 receipt queries; ${widths.join('/')} px screenshots).`);
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
