// TEST-025 / TECH-011: static UI and synthetic, in-memory API only; no server or database.
// From the repository root: node code/frontend-react/test/priority-drawer.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require('playwright');

const frontend = path.resolve(__dirname, '../public');
const output = path.resolve(__dirname, '../../../runtime/react-priority');
const origin = 'https://priority-fixture.invalid'; // Intercepted virtual origin. No listener.
const bundle = '/dist/workbench-react.js';
const widths = [1440, 1024, 768, 375];
const firstWeek = '2026-11-16';
const nextWeek = '2026-11-23';
const thingId = 'fixture-thing';
const thingName = '合成事情 <优先级 & 评估>';
const levels = ['未评估', '重要且紧急', '重要不紧急', '不重要但紧急', '不重要不紧急'];
const hint = '每周一重新评估。保存调整不会自动完成本周评估。';
const versionConflict = '事情已变化，请刷新后重新核对';
const weekConflict = '评估周期已变化，请刷新后重新核对';
const retryName = '使用原操作标识重试保存';
const missingReceipt = '未找到操作回执';
const unavailableReceipt = '模拟回执暂不可用';
const item = (id, type, parent, name, status = 'notStarted') => ({
  id, type, parent, name, status, version: 1, description: '', owner: '', planStart: '', planEnd: '',
});

async function intercept(context, page) {
  const thing = item(thingId, 'thing', 'fixture-module', thingName, 'working');
  const items = [item('fixture-goal', 'goal', null, '合成目标'), item('fixture-module', 'module', 'fixture-goal', '合成模块'), thing];
  const receipts = new Map(), attempts = [], lookups = [], problems = [];
  let week = firstWeek, priority = 0, reviewWeek = '', priorityReads = 0, nextWrite = null, nextLookup = null;
  const startup = Promise.withResolvers();
  const priorities = () => ({ week, items: [{
    id: thing.id, status: thing.status, version: thing.version, priority,
    review_week: reviewWeek || null, due: reviewWeek !== week,
  }] });
  const snapshot = () => ({
    items, priorities: priorities(), today: week === firstWeek ? '2026-11-19' : nextWeek,
    attention: [], branches: [], links: [], dependencies: [],
  });
  page.on('pageerror', error => problems.push(error.message));
  await context.routeWebSocket('**/*', socket => {
    problems.push(`Unexpected WebSocket: ${socket.url()}`);
    return socket.close(); // No connectToServer: never forwards traffic.
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
    // Fail closed: fulfill from disk / memory or abort; never continue/fetch.
    if (url.origin !== origin) return reject('Unexpected origin');
    const failure = (status, detail) => route.fulfill({ status, json: { detail } });
    try {
      if (method === 'POST' && pathname === `/api/items/${thingId}/priority`) {
        const body = request.postDataJSON();
        attempts.push(body);
        if (!nextWrite) return reject('Unplanned priority write or automatic retry');
        const outcome = nextWrite;
        nextWrite = null;
        const { operation_id: id, expected_version, week: submittedWeek, review } = body;
        assert.match(id, /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i);
        assert.ok(!receipts.has(id), 'A committed operation must only be looked up');
        assert.equal(typeof review, 'boolean');
        assert.ok(Number.isInteger(body.priority) && body.priority >= 0 && body.priority < levels.length);
        assert.ok(!review || body.priority !== 0, 'Do not submit a zero classification as a review');
        if (submittedWeek !== week) {
          assert.equal(outcome, 'weekConflict');
          return failure(409, weekConflict);
        }
        if (expected_version !== thing.version) {
          assert.equal(outcome, 'versionConflict');
          return failure(409, versionConflict);
        }
        assert.ok(['save', 'lostAfterCommit', 'lostBeforeCommit'].includes(outcome), 'Fixture expected a conflict');
        if (outcome === 'lostBeforeCommit') return route.abort('connectionreset');
        priority = body.priority;
        if (review) reviewWeek = week;
        thing.version++;
        const saved = { ...thing };
        receipts.set(id, saved);
        if (outcome === 'lostAfterCommit') return route.abort('connectionreset');
        return route.fulfill({ json: saved });
      }
      if (method !== 'GET') return reject('Unexpected request');
      const operation = /^\/api\/operations\/([^/]+)$/.exec(pathname)?.[1];
      if (operation) {
        lookups.push(operation);
        if (!nextLookup) return reject('Unplanned receipt query');
        const outcome = nextLookup;
        nextLookup = null;
        if (outcome === 'unavailable') return failure(503, unavailableReceipt);
        const receipt = receipts.get(operation);
        if (outcome === 'missing') {
          assert.equal(receipt, undefined);
          return failure(404, missingReceipt);
        }
        assert.equal(outcome, 'found');
        assert.ok(receipt, 'Lookup must use the committed operation ID');
        return route.fulfill({ json: receipt });
      }
      if (pathname === '/api/priorities') {
        priorityReads++;
        return route.fulfill({ json: priorities() });
      }
      const responses = {
        '/api/session': {}, '/api/items': items, '/api/workbench': snapshot(), '/api/plan-history-counts': {},
        '/api/sources': [], '/api/sources/suggestions': [], '/api/sources/unmatched': [], '/api/sources/follow': [],
      };
      if (Object.hasOwn(responses, pathname)) return route.fulfill({ json: responses[pathname] });
      if (pathname === '/favicon.ico') return route.fulfill({ status: 204 });
      if (pathname !== '/' && pathname !== bundle && !/^\/[-\w]+\.(?:js|css)$/.test(pathname)) {
        return reject('Unexpected static resource');
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
    attempts, lookups, problems,
    get priorityReads() { return priorityReads; },
    get committed() { return receipts.size; },
    releaseBundle: startup.resolve,
    bumpVersion() { thing.version++; },
    rollWeek() { week = nextWeek; },
    expectWrite(outcome) { assert.equal(nextWrite, null); nextWrite = outcome; },
    expectLookup(outcome) { assert.equal(nextLookup ?? null, null); nextLookup = outcome; },
  };
}

async function assertOwnership(drawer, original) {
  const actual = await drawer.evaluate((dialog, initial) => {
    const elements = [...dialog.querySelectorAll('*')];
    // The app-wide icon tooltip is a transient native overlay, not drawer content.
    const children = elements.filter(node => !(node.parentElement === dialog && node.matches('.iconTip[role="tooltip"]')));
    const fiber = element => Object.keys(element).some(key => key.startsWith('__reactFiber$') && element[key]?.stateNode === element);
    const label = node => node.id ? `#${node.id}` : node.localName;
    return {
      modal: dialog === initial && dialog instanceof HTMLDialogElement && dialog.open && dialog.matches(':modal'),
      title: dialog.getAttribute('aria-labelledby'),
      nativeShell: !fiber(dialog),
      marked: dialog.hasAttribute('data-react-owned'),
      fibers: children.filter(fiber).map(label),
      unowned: children.filter(node => !fiber(node)).map(label),
      inline: [dialog, ...elements].flatMap(node => node.getAttributeNames().filter(name => /^on/i.test(name)).map(name => `${label(node)}.${name}`)),
    };
  }, original);
  assert.ok(actual.modal && actual.nativeShell, 'Keep the original native modal host');
  assert.equal(actual.title, 'priorityTitle');
  assert.equal(actual.marked, true);
  for (const id of ['priorityTitle', 'priorityName', 'priorityValue', 'priorityError']) assert.ok(actual.fibers.includes(`#${id}`));
  assert.deepEqual(actual.unowned, [], 'Every drawer child, including recovery controls, belongs to React');
  assert.deepEqual(actual.inline, [], 'The React drawer does not use inline handlers');
}

async function exercise(page, fixture) {
  const name = '事情优先级';
  const drawer = page.locator('#priorityDrawer');
  const value = drawer.getByRole('combobox', { name: '优先级', exact: true });
  const error = drawer.getByRole('alert', { includeHidden: true });
  const action = name => drawer.getByRole('button', { name, exact: true });
  const save = action('保存调整');
  const confirm = action('保存并确认本周评估');
  const recover = action('核对保存结果');
  const refresh = action('刷新后核对');
  const retry = action(retryName);
  const work = page.locator('#workPage');
  const home = page.locator('#globalWorkbench');
  const row = home.locator('.wbRow').filter({ has: page.getByRole('button', { name: thingName, exact: true }) });
  const tags = work.locator('#things > .priorityTags');
  const goHome = page.getByRole('button', { name: '工作台', exact: true });
  const text = (host, string) => host.getByText(string, { exact: true }).waitFor();
  const closed = () => drawer.waitFor({ state: 'hidden' });
  const verifyValue = async expected => assert.equal(await value.inputValue(), String(expected), 'Priority selection/draft');
  const verifyError = expected => text(error, expected);
  const assertCounts = (writes, queries, committed) => {
    assert.equal(fixture.attempts.length, writes, 'Only explicit write attempts are allowed');
    assert.equal(fixture.lookups.length, queries, 'Only explicit receipt queries are allowed');
    assert.equal(fixture.committed, committed, 'Each successful operation commits once');
  };
  const payload = (index, fields) => {
    const { operation_id, ...actual } = fixture.attempts[index];
    assert.deepEqual(actual, fields);
    return operation_id;
  };
  const fieldState = (expected_version, week, priority, review) => ({ expected_version, week, priority, review });
  const badge = async (priority, due) => {
    await tags.getByRole('button', { name: levels[priority], exact: true }).waitFor();
    await text(tags, due ? '本周待评估' : '本周已评估');
  };
  const openCard = priority => tags.getByRole('button', { name: levels[priority], exact: true }).click();
  const openReview = () => row.getByRole('button', { name: '去评估', exact: true }).click();
  const refreshConflict = async () => {
    await Promise.all([page.waitForResponse(response => new URL(response.url()).pathname === '/api/items' && response.ok()), refresh.click()]);
    await page.waitForFunction(() => {
      const dialog = document.querySelector('#priorityDrawer');
      return dialog.open && dialog.querySelector('#priorityValue')?.value === '2' && !dialog.querySelector('#priorityError')?.textContent;
    });
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
      'The original priority dialog has no legacy content while the bundle is held');
    assertCounts(0, 0, 0);
    fixture.releaseBundle();
    await page.locator('body:not([data-ui-startup])').waitFor({ state: 'attached' });
    assert.deepEqual(await shellState(), { original: true, native: true, open: false, children: 0, mounted: true },
      'React mounts the original empty dialog without opening it');
    await openReview();
    await page.getByRole('dialog', { name, exact: true }).waitFor();
    await text(drawer.locator('#priorityName'), thingName);
    await text(drawer, hint);
    await drawer.getByRole('heading', { name, exact: true }).waitFor();
    assert.equal(await value.getAttribute('id'), 'priorityValue');
    assert.equal(await error.getAttribute('id'), 'priorityError');
    assert.deepEqual(await value.locator('option').evaluateAll(options => options.map(option => [option.value, option.textContent])),
      levels.map((level, i) => [String(i), level]));
    for (const control of [save, confirm, recover, refresh, action('关闭')]) await control.waitFor();
    await verifyValue(0);
    await assertOwnership(drawer, original);

    for (const width of widths) {
      await page.setViewportSize({ width, height: 900 });
      assert.ok(await drawer.evaluate(node => {
        const { left, right } = node.getBoundingClientRect();
        return left >= -1 && right <= innerWidth + 1 && node.scrollWidth <= node.clientWidth + 1;
      }), `Priority drawer does not overflow at ${width}px`);
      await page.screenshot({ path: path.join(output, `react-${width}.png`), animations: 'disabled' });
    }
    await page.setViewportSize({ width: widths[0], height: 900 });
    await page.keyboard.press('Escape');
    await closed();
    await openCard(0);
    await confirm.click();
    await verifyError('请先选择优先级');
    await verifyValue(0);
    assertCounts(0, 0, 0);

    await value.selectOption('2');
    let reads = fixture.priorityReads;
    fixture.expectWrite('save');
    await save.click();
    await closed();
    await badge(2, true);
    assert.ok(fixture.priorityReads > reads, 'Save must read priority back');
    assertCounts(1, 0, 1);
    payload(0, fieldState(1, firstWeek, 2, false));
    await goHome.click();
    await text(row, levels[2]);
    await text(row, '本周待评估');

    await openReview();
    await verifyValue(2);
    reads = fixture.priorityReads;
    fixture.expectWrite('save');
    await confirm.click();
    await closed();
    await badge(2, false);
    assert.ok(fixture.priorityReads > reads, 'Confirmation must read priority back');
    assertCounts(2, 0, 2);
    payload(1, fieldState(2, firstWeek, 2, true));
    await goHome.click();
    await text(home, '暂无待评估事情');
    await row.waitFor({ state: 'hidden' });
    await page.getByRole('button', { name: '目标与事情', exact: true }).click();
    await openCard(2);

    await value.selectOption('3');
    fixture.bumpVersion();
    fixture.expectWrite('versionConflict');
    await save.click();
    await verifyError(`${versionConflict}；输入已保留`);
    await verifyValue(3);
    assert.equal(await retry.count(), 0);
    assertCounts(3, 0, 2);
    payload(2, fieldState(3, firstWeek, 3, false));
    await refreshConflict();
    assertCounts(3, 0, 2);

    await value.selectOption('4');
    fixture.rollWeek();
    fixture.expectWrite('weekConflict');
    await confirm.click();
    await verifyError(`${weekConflict}；输入已保留`);
    await verifyValue(4);
    assert.equal(await retry.count(), 0);
    assertCounts(4, 0, 2);
    payload(3, fieldState(4, firstWeek, 4, true));
    await refreshConflict();
    assertCounts(4, 0, 2);

    await value.selectOption('3');
    fixture.expectWrite('lostAfterCommit');
    await confirm.click();
    await error.getByText(/输入已保留/).waitFor();
    await verifyValue(3);
    assert.equal(await retry.count(), 0);
    assertCounts(5, 0, 3);
    const committedId = payload(4, fieldState(4, nextWeek, 3, true));
    // If the original save action is still enabled, attempting it must not send again.
    if (await confirm.isEnabled()) await confirm.click();
    assertCounts(5, 0, 3);
    reads = fixture.priorityReads;
    fixture.expectLookup('found');
    await recover.click();
    await closed();
    await badge(3, false);
    assert.ok(fixture.priorityReads > reads, 'Recovery must read the committed priority back');
    assertCounts(5, 1, 3);
    assert.deepEqual(fixture.lookups, [committedId]);

    await openCard(3);
    await value.selectOption('4');
    fixture.expectWrite('lostBeforeCommit');
    await save.click();
    await error.getByText(/输入已保留/).waitFor();
    const missingId = payload(5, fieldState(5, nextWeek, 4, false));
    assertCounts(6, 1, 3);
    assert.equal(await retry.count(), 0, 'A lost response alone must not offer retry');
    fixture.expectLookup('unavailable');
    await recover.click();
    await verifyError(`${unavailableReceipt}；未自动重试`);
    await verifyValue(4);
    assert.equal(await retry.count(), 0, 'A transient lookup failure is not a missing receipt');
    assertCounts(6, 2, 3);
    fixture.expectLookup('missing');
    await recover.click();
    await error.getByText(`${missingReceipt}；未自动重试`, { exact: false }).waitFor();
    await retry.waitFor();
    await verifyValue(4);
    await assertOwnership(drawer, original);
    assertCounts(6, 3, 3);
    assert.deepEqual(fixture.lookups, [committedId, missingId, missingId]);

    // Change the live selection; the explicit retry must still send the original intent.
    if (await value.isEnabled()) await value.selectOption('1');
    reads = fixture.priorityReads;
    fixture.expectWrite('save');
    await retry.click();
    await closed();
    await badge(4, false);
    assert.ok(fixture.priorityReads > reads, 'Retry must read saved priority back');
    assertCounts(7, 3, 4);
    assert.deepEqual(fixture.attempts[6], fixture.attempts[5], 'Retry sends the same ID and complete original body');
    assert.equal(new Set(fixture.attempts.map(({ operation_id }) => operation_id)).size, 6, 'Only the explicit retry reuses an ID');
    await openCard(4);
    await action('关闭').click();
    await closed();
  } finally {
    fixture.releaseBundle();
    await original.dispose();
  }
}

async function verify() {
  await fs.access(path.join(frontend, bundle.slice(1)));
  await fs.mkdir(output, { recursive: true });
  const browser = await chromium.launch({ channel: 'chrome', headless: true,
    args: ['--disable-background-networking', '--host-resolver-rules=MAP * ~NOTFOUND', '--no-proxy-server'] });
  try {
    const context = await browser.newContext({
      viewport: { width: widths[0], height: 900 }, serviceWorkers: 'block', reducedMotion: 'reduce',
    });
    try {
      const page = await context.newPage();
      page.setDefaultTimeout(8000);
      const fixture = await intercept(context, page);
      try {
        await exercise(page, fixture);
        assert.deepEqual(fixture.problems, []);
        console.log(`React priority drawer passed (7 writes, 4 commits, 3 receipt queries; ${widths.join('/')} px screenshots).`);
      } catch (error) {
        error.message = `React: ${error.message}`;
        if (fixture.problems.length) error.message += `\nFixture problems: ${fixture.problems.join('; ')}`;
        throw error;
      }
    } finally {
      await context.close();
    }
  } finally {
    await browser.close();
  }
}

verify().catch(error => { console.error(error); process.exitCode = 1; });
