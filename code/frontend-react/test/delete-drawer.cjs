// TEST-006 / TEST-014 / TEST-025. From the repo root:
// node code/frontend-react/test/delete-drawer.cjs [--screenshots]
// No listener, real service, or database: browser traffic is fulfilled from disk/memory or aborted.
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require('playwright');

const frontend = path.resolve(__dirname, '../public');
const output = path.resolve(__dirname, '../../../runtime/react-delete-drawer');
const origin = 'https://delete-fixture.invalid';
const bundle = '/dist/workbench-react.js';
const widths = [1440, 1024, 768, 375];
const intentKey = 'todo.pendingDeletion';
const names = {
  source: '材料整理 <初稿 & 留痕>', nearby: '本地接收事情', target: '跨目标接收 <完整 & 保留>',
  parent: '保留的父事件', child: '保留子事件', added: '并发新增事件',
  retry: '待手工重试的事件', lost: '已提交但回执丢失的事件',
};
const targetPath = '接收目标 / 商务模块 / ' + names.target;
const localPath = '原目标 / 原模块 / ' + names.nearby;
const conflict = '内容已变化，请刷新影响范围后重新确认';
const missing = '未找到已提交删除，请核对后手动提交原操作';
const unavailable = '模拟回执暂不可用';
const childProtection = '存在子事件，请先迁移或处理子事件，再删除当前事件';
const success = '已删除，历史记录已保留';
const summarize = count => `下级内容 ${count} 项（直接下级 ${count} 项） · 文档来源 1 条 · AI 建议 2 条 · 催办规则 3 条。`;
const ids = ['deleteTitle', 'deleteName', 'deleteImpact', 'deleteTargetGroup', 'deleteTarget', 'deleteDestination',
  'deleteHint', 'deleteError', 'reloadDelete', 'checkDelete', 'closeDelete', 'submitDelete'];
const rows = [
  ['g1', 'goal', null, '原目标'], ['g2', 'goal', null, '接收目标'],
  ['m1', 'module', 'g1', '原模块'], ['m2', 'module', 'g2', '商务模块'],
  ['source', 'thing', 'm1', names.source], ['nearby', 'thing', 'm1', names.nearby], ['target', 'thing', 'm2', names.target],
  ['parent', 'event', 'source', names.parent], ['child', 'event', 'source', names.child],
  ['retry', 'event', 'target', names.retry], ['lost', 'event', 'target', names.lost],
];
const makeRow = ([id, type, parent, name]) => ({
  id, type, parent, name, status: 'notStarted', version: 1, description: '', owner: '', planStart: '', planEnd: '',
});

async function intercept(context, page) {
  const items = new Map(rows.map(row => [row[0], makeRow(row)]));
  const get = id => items.get(id);
  const branch = { parent_id: 'parent', child_id: 'child' };
  const priorities = { week: '2026-11-16', items: [] };
  const all = () => [...items.values()];
  const tree = id => all().filter(row => row.type === 'event' && row.parent === get(id)?.parent);
  const branches = events => events.some(row => row.id === branch.child_id) ? [branch] : [];
  const fingerprint = (id, children) => createHash('sha256').update(JSON.stringify([get(id), children])).digest('hex');
  const snapshot = () => ({ items: all(), priorities, today: '2026-11-19', attention: [], branches: [branch], links: [], dependencies: [] });
  const previews = [], attempts = [], lookups = [], itemReads = [], problems = [], receipts = new Map();
  let nextWrite = null, nextLookup = null;
  const startup = Promise.withResolvers();
  page.once('close', startup.resolve);
  const impact = id => {
    const children = all().filter(row => row.parent === id);
    return { item: get(id), snapshot: fingerprint(id, children), children: children.length, descendants: children.length,
      requires_target: id === 'source', documents: Number(id === 'source' || id === 'lost'),
      suggestions: id === 'source' ? 2 : 0, reminders: id === 'source' ? 3 : 0, relations: [] };
  };
  page.on('pageerror', error => problems.push(`Page error: ${error.message}`));
  await context.routeWebSocket('**/*', socket => {
    problems.push(`Unexpected WebSocket: ${socket.url()}`);
    return socket.close(); // Never connect to an upstream server.
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
    // Fail closed: no route.continue/fetch, even on unexpected requests.
    if (url.origin !== origin) return reject('Unexpected origin');
    const json = data => route.fulfill({ json: data });
    const failure = (status, detail) => route.fulfill({ status, json: { detail } });
    try {
      const id = /^\/api\/items\/([^/]+)\/deletion$/.exec(pathname)?.[1];
      if (id && method === 'POST') {
        const body = request.postDataJSON();
        const prior = attempts.filter(entry => entry.body.operation_id === body.operation_id);
        attempts.push({ id, body });
        const plan = nextWrite;
        nextWrite = null;
        assert.equal(id, plan?.id, 'Unexpected write or automatic retry');
        assert.deepEqual(Object.keys(body).sort(), ['operation_id', 'snapshot', 'target_id']);
        assert.match(body.operation_id, /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i);
        assert.equal(body.target_id, plan.target);
        assert.ok(get(id) && id !== 'parent');
        assert.ok(!receipts.has(body.operation_id), 'Do not resend a committed operation');
        if (plan.original) assert.deepEqual(prior, [{ id, body: plan.original }]);
        else assert.equal(prior.length, 0, 'Only an explicit retry may reuse the operation ID');
        const preview = impact(id);
        if (plan.outcome === 'conflict') {
          assert.notEqual(body.snapshot, preview.snapshot);
          return failure(409, conflict);
        }
        assert.equal(body.snapshot, preview.snapshot);
        assert.equal(preview.requires_target, Boolean(body.target_id));
        if (plan.outcome === 'lostBeforeCommit') return route.abort('connectionreset');
        if (body.target_id) {
          assert.equal(get(body.target_id)?.type, get(id).type);
          assert.notEqual(body.target_id, id);
          for (const child of all().filter(row => row.parent === id)) {
            child.parent = body.target_id;
            child.version++;
          }
        }
        items.delete(id);
        const receipt = { deleted_id: id, target_id: body.target_id, operation_id: body.operation_id,
          moved_children: preview.children, relations: preview.relations };
        receipts.set(body.operation_id, receipt);
        if (plan.outcome === 'lostAfterCommit') return route.abort('connectionreset');
        assert.equal(plan.outcome, 'saved');
        return json(receipt);
      }
      if (method !== 'GET') return reject('Unexpected request');
      if (id && get(id)) {
        const data = impact(id);
        previews.push({ id, snapshot: data.snapshot });
        if (id === 'parent') return failure(409, childProtection);
        return json(data);
      }
      const operationId = /^\/api\/deletions\/([^/]+)$/.exec(pathname)?.[1];
      if (operationId) {
        lookups.push(operationId);
        const plan = nextLookup;
        nextLookup = null;
        assert.equal(operationId, plan?.operationId, 'Receipts are read only on explicit request for the original ID');
        const receipt = receipts.get(operationId);
        if (plan.status === 503) return failure(503, unavailable);
        if (plan.status === 404) {
          assert.equal(receipt, undefined);
          return failure(404, missing);
        }
        assert.equal(plan.status, 200);
        assert.ok(receipt);
        return json(receipt);
      }
      const event = /^\/api\/events\/([^/]+)\/structure$/.exec(pathname)?.[1];
      if (get(event)?.type === 'event') {
        const events = tree(event);
        return json({ ...snapshot(), events, branches: branches(events), snapshot: fingerprint(event, events) });
      }
      if (pathname === '/api/items') itemReads.push(Object.fromEntries(all().map(row => [row.id, row.parent])));
      const responses = {
        '/api/session': {}, '/api/items': all(), '/api/workbench': snapshot(), '/api/priorities': priorities,
        '/api/sources': [], '/api/sources/follow': [], '/api/sources/suggestions': [], '/api/sources/unmatched': [],
        '/api/plan-history-counts': {},
      };
      if (Object.hasOwn(responses, pathname)) return json(responses[pathname]);
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
    get, previews, attempts, lookups, itemReads, problems,
    releaseBundle: startup.resolve,
    get committed() { return receipts.size; },
    compete() { items.set('added', makeRow(['added', 'event', 'source', names.added])); },
    expectWrite(id, target, outcome, original) {
      assert.equal(nextWrite, null);
      nextWrite = { id, target, outcome, original };
    },
    expectLookup(operationId, status) {
      assert.equal(nextLookup, null);
      nextLookup = { operationId, status };
    },
  };
}

async function assertOwnership(drawer) {
  const actual = await drawer.evaluate(dialog => {
    const elements = [...dialog.querySelectorAll('*')];
    // The shared tooltip may be appended to the native shell by icons.js.
    const content = elements.filter(node => !(node.parentElement === dialog && node.matches('.iconTip[role="tooltip"]')));
    const fiber = node => Object.keys(node).some(key => key.startsWith('__reactFiber$') && node[key]?.stateNode === node);
    const label = node => node.id ? `#${node.id}` : node.localName;
    return {
      native: dialog === window.__deleteFixtureOriginal && dialog instanceof HTMLDialogElement && dialog.matches(':modal') && !fiber(dialog),
      aria: dialog.getAttribute('aria-labelledby'), marked: dialog.hasAttribute('data-react-owned'),
      ids: content.filter(node => node.id).map(node => node.id),
      fibers: content.filter(fiber).map(label), unowned: content.filter(node => !fiber(node)).map(label),
      inline: [dialog, ...elements].flatMap(node => node.getAttributeNames().filter(name => /^on/i.test(name)).map(name => `${label(node)}.${name}`)),
    };
  });
  assert.ok(actual.native, 'Preserve the original native modal shell');
  assert.equal(actual.aria, 'deleteTitle');
  assert.equal(actual.marked, true);
  for (const id of ids) assert.equal(actual.ids.filter(value => value === id).length, 1, `Preserve #${id}`);
  for (const id of ids) assert.ok(actual.fibers.includes(`#${id}`), `#${id} needs a React host Fiber`);
  assert.deepEqual(actual.unowned, [], 'React owns the drawer content, including generated options and recovery controls');
  assert.deepEqual(actual.inline, [], 'The React drawer uses no inline event attributes');
}

async function exercise(page, fixture, screenshots) {
  const drawer = page.locator('#deleteDrawer');
  const field = id => drawer.locator(`#${id}`);
  const [title, name, impact, group, target, destination, hint, error, refresh, check, cancel, submit] = ids.map(field);
  const events = page.locator('#events');
  const workbench = page.locator('#globalWorkbench');
  const workspace = page.getByRole('button', { name: '目标与事情', exact: true });
  const event = text => events.getByRole('button', { name: text, exact: true });
  const byId = (id, text) => events.locator('tbody tr').filter({ has: page.locator(`[data-event="${id}"]`) })
    .getByRole('button', { name: text, exact: true });
  const recovery = page.locator('.workspaceBar').getByRole('button', { name: '核对待确认删除', exact: true });
  const text = (locator, value) => locator.getByText(value, { exact: typeof value === 'string' }).waitFor();
  const closed = () => drawer.waitFor({ state: 'hidden' });
  const persisted = () => page.evaluate(key => JSON.parse(sessionStorage.getItem(key) || 'null'), intentKey);
  const waitReady = async eventName => {
    await page.locator('#deleteDrawer[data-react-owned]').waitFor({ state: 'attached' });
    await workbench.getByRole('button', { name: eventName, exact: true }).waitFor();
  };
  const confirmName = rowName => '确定删除“' + rowName + '”？';
  const choose = async (id, expectedPath) => {
    await target.selectOption(id);
    await text(destination, expectedPath);
    assert.ok(await submit.isEnabled());
  };
  const assertReadback = async (id, from) => {
    await closed();
    await text(page.locator('#notice'), success);
    assert.ok(fixture.itemReads.slice(from).some(items => !Object.hasOwn(items, id)), 'Read the committed item list back');
    assert.equal(await persisted(), null);
    await recovery.waitFor({ state: 'hidden' });
  };

  // Capture the parser-created dialog in each document, including receipt recovery after reload.
  await page.addInitScript(() => {
    const observer = new MutationObserver(() => {
      const dialog = document.getElementById('deleteDrawer');
      if (!dialog) return;
      window.__deleteFixtureOriginal = dialog;
      observer.disconnect();
    });
    observer.observe(document, { childList: true, subtree: true });
  });
  await Promise.all([
    page.waitForRequest(`${origin}${bundle}`),
    page.goto(`${origin}/`, { waitUntil: 'domcontentloaded' }),
  ]);
  const shellState = () => drawer.evaluate(node => ({
    original: node === window.__deleteFixtureOriginal,
    native: node instanceof HTMLDialogElement, open: node.open,
    children: node.childNodes.length, mounted: node.hasAttribute('data-react-owned'),
  }));
  try {
    assert.deepEqual(await shellState(), { original: true, native: true, open: false, children: 0, mounted: false },
      'The original deletion dialog has no legacy controls while the bundle is held');
    assert.deepEqual([fixture.previews.length, fixture.attempts.length, fixture.lookups.length], [0, 0, 0],
      'Startup does not preview, submit or look up a deletion');
  } finally {
    fixture.releaseBundle();
  }
  await page.locator('body:not([data-ui-startup])').waitFor({ state: 'attached' });
  assert.deepEqual(await shellState(), { original: true, native: true, open: false, children: 0, mounted: true },
    'React mounts the original empty confirmation dialog without opening it');
  await waitReady(names.parent);
  await workspace.click();
  await events.getByRole('heading', { name: names.source, exact: true }).waitFor();
  const openThing = () => events.getByRole('button', { name: '删除事情', exact: true }).click();
  await openThing();
  await drawer.getByRole('heading', { name: '删除事情', exact: true }).waitFor();
  await text(name, confirmName(names.source));
  await text(impact, summarize(2));
  await text(hint, '下级内容会完整保留，受影响来源和催办暂停。');
  await text(submit, '换绑并删除');
  await text(cancel, '取消');
  assert.equal(await drawer.getByRole('combobox', { name: '将全部内容换绑到', exact: true }).getAttribute('id'), 'deleteTarget');
  assert.deepEqual(await target.locator('option').evaluateAll(nodes => nodes.map(node => [node.value, node.textContent])), [
    ['', '请选择接收位置'], ['nearby', localPath], ['target', targetPath],
  ]);
  assert.equal(await target.inputValue(), '');
  assert.ok(await submit.isDisabled());
  assert.ok(await refresh.isHidden());
  assert.ok(await check.isHidden());
  await assertOwnership(drawer);
  await choose('nearby', localPath);
  await choose('target', targetPath);
  await target.selectOption('');
  assert.equal(await destination.textContent(), '');
  assert.ok(await submit.isDisabled(), 'Clearing the receiver removes permission to submit');
  await choose('target', targetPath);
  await cancel.click();
  await closed();
  assert.deepEqual([fixture.attempts.length, fixture.lookups.length, fixture.committed, await persisted()], [0, 0, 0, null]);
  assert.equal(fixture.get('parent').parent, 'source');

  await openThing();
  await text(impact, summarize(2));
  assert.equal(await target.inputValue(), '', 'Reopening requires a fresh explicit selection');
  await choose('target', targetPath);
  for (const width of widths) {
    await page.setViewportSize({ width, height: width === 375 ? 812 : 960 });
    await target.focus();
    const layout = await drawer.evaluate(dialog => {
      const bounds = dialog.getBoundingClientRect();
      return { viewport: innerWidth, page: document.documentElement.scrollWidth, scroll: dialog.scrollWidth, client: dialog.clientWidth,
        dx: Math.abs(bounds.x + bounds.width / 2 - innerWidth / 2), dy: Math.abs(bounds.y + bounds.height / 2 - innerHeight / 2),
        focus: document.activeElement.id, animation: getComputedStyle(dialog).animationName };
    });
    assert.equal(layout.viewport, width);
    assert.ok(layout.page <= width && layout.scroll <= layout.client + 1 && layout.dx < 2 && layout.dy < 2, JSON.stringify(layout));
    assert.equal(layout.focus, 'deleteTarget');
    assert.equal(layout.animation, 'none');
    if (screenshots) await page.screenshot({ path: path.join(output, `react-${width}.png`), animations: 'disabled' });
  }
  await page.setViewportSize({ width: widths[0], height: 960 });

  fixture.compete();
  fixture.expectWrite('source', 'target', 'conflict');
  await submit.click();
  await text(error, conflict + '；请刷新影响范围。');
  await text(refresh, '刷新影响范围');
  assert.ok(await submit.isDisabled());
  assert.ok(await check.isHidden());
  assert.equal(await persisted(), null);
  assert.deepEqual([fixture.attempts.length, fixture.previews.length, fixture.committed], [1, 2, 0], 'A conflict must not refresh or resend by itself');
  assert.equal(fixture.attempts[0].body.snapshot, fixture.previews[1].snapshot);
  assert.equal(fixture.get('parent').parent, 'source');
  await refresh.click();
  await text(impact, summarize(3));
  assert.equal(await error.textContent(), '');
  assert.equal(await target.inputValue(), '');
  assert.ok(await submit.isDisabled(), 'Refresh requires choosing the receiver again');
  await choose('target', targetPath);
  let readSince = fixture.itemReads.length;
  fixture.expectWrite('source', 'target', 'saved');
  await submit.click();
  await assertReadback('source', readSince);
  assert.equal(fixture.attempts[1].body.snapshot, fixture.previews[2].snapshot);
  assert.notEqual(fixture.attempts[1].body.operation_id, fixture.attempts[0].body.operation_id);
  assert.ok(fixture.itemReads.slice(readSince).some(items => ['parent', 'child', 'added'].every(id => items[id] === 'target')));
  await events.getByRole('heading', { name: names.target, exact: true }).waitFor();
  assert.equal(await page.locator('#goalSelect').inputValue(), 'g2');
  assert.equal(await page.locator('#moduleChoices input:checked').inputValue(), 'm2');
  await event(names.child).waitFor();
  await event(names.added).waitFor();

  // A parent is protected. The same row-level entry for a leaf offers direct deletion.
  await byId('parent', '删除事件').click();
  await text(error, childProtection);
  await text(title, '删除事件');
  await text(impact, '尚未获取到有效影响范围。');
  assert.ok(await submit.isDisabled());
  await cancel.click();
  await closed();
  await byId('retry', '删除事件').click();
  await text(name, confirmName(names.retry));
  await text(submit, '确认删除');
  assert.ok(await group.isHidden());
  assert.equal(await impact.textContent(), '');
  assert.ok(await submit.isEnabled());
  await assertOwnership(drawer);

  // Lost before commit: no automatic lookup/retry. A transient error must not grant retry;
  // an explicit missing-receipt response unlocks retry using exactly the original request.
  fixture.expectWrite('retry', null, 'lostBeforeCommit');
  await submit.click();
  await text(error, /请点击核对删除结果。/);
  const original = fixture.attempts[2].body;
  assert.deepEqual(await persisted(), { id: 'retry', name: names.retry, body: original });
  assert.deepEqual([fixture.attempts.length, fixture.lookups.length, fixture.committed], [3, 0, 1]);
  assert.ok(await submit.isDisabled());
  assert.ok(await refresh.isHidden());
  await text(check, '核对删除结果');
  fixture.expectLookup(original.operation_id, 503);
  await check.click();
  await text(error, unavailable);
  assert.ok(await submit.isDisabled());
  fixture.expectLookup(original.operation_id, 404);
  await check.click();
  await text(error, missing + '；可手动再次提交原操作，相同标识不会重复执行。');
  await text(submit, '再次提交原操作');
  assert.ok(await submit.isEnabled());
  assert.equal(fixture.attempts.length, 3);
  await assertOwnership(drawer);
  readSince = fixture.itemReads.length;
  fixture.expectWrite('retry', null, 'saved', original);
  await submit.click();
  await assertReadback('retry', readSince);
  assert.deepEqual(fixture.attempts[3].body, original);
  await event(names.retry).waitFor({ state: 'detached' });
  await event(names.lost).waitFor();

  // An event with a reference still deletes directly and explains how references are preserved.
  await byId('lost', '删除事件').click();
  await text(name, confirmName(names.lost));
  await text(hint, '关联解除；文档保留到所属事情，读取与催办暂停，待处理建议作废。历史记录保留，不改变其他事件。');
  assert.ok(await group.isHidden());
  await text(submit, '确认删除');
  fixture.expectWrite('lost', null, 'lostAfterCommit');
  await submit.click();
  await text(error, /请点击核对删除结果。/);
  const committed = fixture.attempts[4].body;
  assert.deepEqual([fixture.attempts.length, fixture.lookups.length, fixture.committed], [5, 2, 3]);
  assert.deepEqual(await persisted(), { id: 'lost', name: names.lost, body: committed });
  assert.ok(await submit.isDisabled());
  await page.reload();
  await waitReady(names.parent);
  await recovery.click();
  await text(title, '核对删除结果');
  await text(name, names.lost);
  await text(impact, '上次删除结果待核对；保留原操作，不会自动重新提交。');
  await text(check, '核对删除结果');
  assert.ok(await submit.isDisabled());
  assert.ok(await target.isDisabled());
  assert.ok(await refresh.isHidden());
  assert.deepEqual(fixture.lookups, [original.operation_id, original.operation_id], 'Reload/open does not query or replay an operation');
  await assertOwnership(drawer);
  readSince = fixture.itemReads.length;
  fixture.expectLookup(committed.operation_id, 200);
  await check.click();
  await assertReadback('lost', readSince);
  assert.deepEqual([fixture.attempts.length, fixture.lookups.length, fixture.committed], [5, 3, 3]);
  assert.deepEqual(fixture.lookups, [original.operation_id, original.operation_id, committed.operation_id]);
  assert.deepEqual(fixture.previews.map(entry => entry.id), ['source', 'source', 'source', 'parent', 'retry', 'lost']);
  assert.deepEqual(['parent', 'child', 'added'].map(id => fixture.get(id).parent), ['target', 'target', 'target']);
}

async function verify() {
  const args = process.argv.slice(2);
  assert.ok(args.every(arg => arg === '--screenshots'), 'Usage: delete-drawer.cjs [--screenshots]');
  const screenshots = args.includes('--screenshots');
  await fs.access(path.join(frontend, bundle.slice(1)));
  if (screenshots) await fs.mkdir(output, { recursive: true });
  const browser = await chromium.launch({ channel: 'chrome', headless: true,
    args: ['--disable-background-networking', '--host-resolver-rules=MAP * ~NOTFOUND', '--no-proxy-server'] });
  try {
    const context = await browser.newContext({ viewport: { width: widths[0], height: 960 }, serviceWorkers: 'block', reducedMotion: 'reduce' });
    try {
      const page = await context.newPage();
      page.setDefaultTimeout(8000);
      const fixture = await intercept(context, page);
      try {
        await exercise(page, fixture, screenshots);
        assert.deepEqual(fixture.problems, []);
        console.log(`React delete drawer passed: 6 previews, 5 explicit writes, 3 commits, 3 receipt queries; ${widths.join('/')} px${screenshots ? ' screenshots' : ''}.`);
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
