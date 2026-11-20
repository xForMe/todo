// TEST-016 / TEST-025: isolated Chrome against the built React UI.
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

const react = true;
const modeName = react ? 'react' : 'native';
const origin = 'http://127.0.0.1:18882';
const root = path.resolve(__dirname, '../frontend-react/public');
const bundle = '/dist/workbench-react.js';
const output = path.resolve(__dirname, '../../runtime', `working-memory-ui${react ? '-react' : ''}`);
const widths = [1440, 1024, 768, 375];
const longName = '资料核对 <img src=x onerror=alert(1)> ' + 'LongUnbrokenText'.repeat(5);
const refreshPath = id => `/api/memory/working/${id}/refresh`;

async function assertDrawer(drawer, original) {
  const actual = await drawer.evaluate((dialog, original) => {
    const hasFiber = node => Object.getOwnPropertyNames(node)
      .some(key => key.startsWith('__reactFiber$') && node[key]?.stateNode === node);
    const label = node => node.id || node.localName;
    const nodes = [...dialog.querySelectorAll('*')];
    const marked = dialog.hasAttribute('data-react-owned');
    return {
      original: dialog === original,
      modal: dialog instanceof HTMLDialogElement && dialog.matches(':modal'),
      marked, shellFiber: hasFiber(dialog),
      labelled: dialog.getAttribute('aria-labelledby') === 'workingMemoryTitle',
      missing: ['#workingMemoryTitle', '#workingMemoryClose', '#workingMemoryState[role="status"]',
        '#workingMemoryBody', '#workingMemoryError[role="alert"]', '#workingMemoryRefresh']
        .filter(selector => !dialog.querySelector(selector)),
      mismatched: nodes.filter(node => hasFiber(node) !== marked).map(label),
      looseText: [...dialog.childNodes].filter(node => node.nodeType === Node.TEXT_NODE && node.textContent.trim())
        .map(node => node.textContent),
      inline: [dialog, ...nodes].flatMap(node => node.getAttributeNames()
        .filter(name => /^on/i.test(name)).map(name => `${label(node)}.${name}`)),
    };
  }, original);
  assert.deepEqual(actual, {
    original: true, modal: true, marked: react, shellFiber: false, labelled: true,
    missing: [], mismatched: [], looseText: [], inline: [],
  }, 'keep the original native modal and use real DOM Fibers only for React content');
  assert.equal(await drawer.page().locator('dialog:modal').count(), 1);
  assert.equal(await drawer.page().locator('dialog[open]').count(), 1);
}

(async () => {
  const bundleBody = react ? fs.readFileSync(path.join(root, bundle.slice(1))) : null;
  fs.mkdirSync(output, { recursive: true });
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const context = await browser.newContext({ serviceWorkers: 'block' });
    const errors = [], unexpected = [], calls = [];
    let mode = 'normal', bundleRequests = 0, lateHeld = false, releaseBundle, releaseLate;
    const bundleReady = new Promise(resolve => { releaseBundle = resolve; });
    const lateReady = new Promise(resolve => { releaseLate = resolve; });
    const items = [['g', 'goal', null, '年度目标'], ['m', 'module', 'g', '客户交付'], ['t', 'thing', 'm', '上线准备'],
      ['other', 'thing', 'm', '另外一件事情'], ['e', 'event', 't', '接口联调']].map(([id, type, parent, name]) => ({
      id, type, parent, name, description: '', owner: '', planStart: '', planEnd: '', status: 'notStarted', version: 1,
    }));
    const priorities = { week: '2026-11-09', items: [] };
    const workbench = { items, priorities, attention: [], branches: [], links: [], dependencies: [], today: '2026-11-15' };
    const reads = {
      '/api/session': {}, '/api/items': items, '/api/workbench': workbench, '/api/priorities': priorities,
      '/api/sources/suggestions': [], '/api/sources': [], '/api/sources/unmatched': [], '/api/sources/follow': [],
      '/api/plan-history-counts': {}, '/api/events/e/structure': { ...workbench, events: items.filter(item => item.type === 'event') },
    };
    const summary = id => ({
      thing_id: id, thing_version: 1, path: `年度目标 / 客户交付 / ${id === 't' ? '上线准备' : '另外一件事情'}`,
      status: 'working', counts: { notStarted: 2, working: 1, completed: 4, cancelled: 0 },
      actions: [{ id: 'e', version: 1, name: '接口联调', status: 'working', owner: '李工', plan_end: '2026-11-18' },
        { id: 'e2', version: 1, name: longName, status: 'notStarted', owner: '', plan_end: '' }],
      omitted: 1, partial: true,
    });
    await context.routeWebSocket('**/*', socket => {
      unexpected.push(`Unexpected WebSocket: ${socket.url()}`);
      return socket.close();
    });
    await context.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url()), method = request.method(), pathname = url.pathname;
      const abort = reason => {
        unexpected.push(`${reason}: ${method} ${request.url()}`);
        return route.abort();
      };
      if (url.origin !== origin) return abort('Unexpected origin');
      if (pathname.startsWith('/api/')) {
        const id = ['t', 'other'].find(candidate => pathname === refreshPath(candidate));
        if (id) {
          if (method !== 'POST' || request.postData() !== null || url.search) return abort('Unexpected summary request');
          const state = mode;
          calls.push({ id, state });
          if (state === 'failed') return route.fulfill({ status: 503, json: { detail: '摘要存储暂不可用' } });
          if (state === 'disabled') return route.fulfill({ status: 409, json: { detail: '模块记忆尚未启用' } });
          const data = summary(id);
          if (state === 'empty') Object.assign(data, {
            actions: [], omitted: 0, partial: false, counts: { notStarted: 0, working: 0, completed: 0, cancelled: 0 },
          });
          const result = {
            thing_id: id, state: state === 'inactive' ? 'inactive' : state === 'capacity' ? 'capacity_uncached' : 'cached',
            fingerprint: 'test', generated_at: 1794700000, summary: state === 'inactive' ? null : data,
          };
          if (state === 'delayed') {
            lateHeld = true;
            await lateReady;
          }
          return route.fulfill({ json: result });
        }
        if (method === 'GET' && Object.hasOwn(reads, pathname)) return route.fulfill({ json: reads[pathname] });
        return abort('Unexpected API request');
      }
      if (method !== 'GET') return abort('Unexpected static request');
      if (pathname === bundle) {
        if (!react) return abort('Unexpected React bundle in native mode');
        bundleRequests++;
        // Keep the original dialog and editor form unmounted until startup assertions finish.
        await bundleReady;
        return route.fulfill({ body: bundleBody, contentType: 'text/javascript' });
      }
      if (pathname === '/favicon.ico') return route.fulfill({ status: 404, body: '' });
      const filename = pathname === '/' ? 'index.html' : pathname.slice(1);
      if (!/^[\w-]+\.(?:js|css|html)$/.test(filename)) return abort('Unexpected asset path');
      const file = path.join(root, filename);
      if (!fs.existsSync(file)) return abort('Missing fixture asset');
      return route.fulfill({ body: fs.readFileSync(file), contentType: filename.endsWith('.js') ? 'text/javascript'
        : filename.endsWith('.css') ? 'text/css' : 'text/html' });
    });
    const page = await context.newPage();
    page.setDefaultTimeout(8000);
    page.on('pageerror', error => errors.push(error.message));
    await page.clock.install();
    await Promise.all([
      page.waitForRequest(request => request.url() === `${origin}${bundle}`),
      page.goto(`${origin}/`, { waitUntil: 'domcontentloaded' }),
    ]);
    const drawer = page.locator('#workingMemoryDrawer'), entry = page.locator('#workingMemoryEntry');
    const originalDrawer = await drawer.elementHandle();
    const originalForm = await page.locator('#editor > #form').elementHandle();
    assert.deepEqual(await originalDrawer.evaluate(node => ({
      native: node instanceof HTMLDialogElement, open: node.open,
      mounted: node.hasAttribute('data-react-owned'), children: node.childNodes.length,
    })), { native: true, open: false, mounted: false, children: 0 }, 'Working memory has no legacy content before React mounts');
    assert.deepEqual(await originalForm.evaluate(form => ({
      native: form instanceof HTMLFormElement,
      marked: form.hasAttribute('data-react-owned'),
      children: form.childNodes.length,
      entry: !!form.parentElement.querySelector('#workingMemoryEntry'),
    })), { native: true, marked: false, children: 0, entry: false },
    'The original editor form is empty and has no working memory entry during startup');
    releaseBundle();
    await page.waitForFunction(() => db.items.length === 5);
    if (react) await page.locator('#workingMemoryDrawer[data-react-owned] #workingMemoryClose').waitFor({ state: 'attached' });
    assert.equal(bundleRequests, react ? 1 : 0);

    const body = drawer.locator('#workingMemoryBody'), refresh = drawer.locator('#workingMemoryRefresh');
    const close = drawer.locator('#workingMemoryClose'), error = drawer.locator('#workingMemoryError');
    const openSummary = async id => {
      await page.evaluate(id => openForm('thing', id), id);
      const actual = await entry.evaluate((node, original) => {
        const form = node.closest('#form');
        const fiberKey = Object.getOwnPropertyNames(node)
          .find(key => key.startsWith('__reactFiber$') && node[key]?.stateNode === node);
        const containerKey = form && Object.getOwnPropertyNames(form)
          .find(key => key.startsWith('__reactContainer$') && form[key]?.stateNode?.containerInfo === form);
        let root = fiberKey ? node[fiberKey] : null;
        while (root?.return) root = root.return;
        return {
          button: node instanceof HTMLButtonElement, modal: node.closest('#editor')?.matches(':modal'),
          originalForm: form === original,
          fiber: !!fiberKey, formRoot: !!containerKey && root?.stateNode === form[containerKey].stateNode,
        };
      }, originalForm);
      assert.deepEqual(actual, {
        button: true, modal: true, originalForm: true, fiber: true, formRoot: true,
      }, '#workingMemoryEntry is rendered by React in the original #form');
      await entry.click();
    };
    const waitForSummary = name => page.waitForFunction(name => {
      const path = document.querySelector('.workingMemoryPath');
      return path?.textContent.endsWith(name) && !document.querySelector('#workingMemoryRefresh').disabled;
    }, name);
    await openSummary('t');
    await waitForSummary('上线准备');
    await assertDrawer(drawer, originalDrawer);
    assert.deepEqual(await body.locator('.workingMemoryCounts span').allTextContents(), ['未开始 2', '进行中 1', '已完成 4', '已取消 0']);
    assert.equal(await body.locator('img').count(), 0);
    assert.deepEqual(await body.locator('.workingMemoryActions li strong').allTextContents(), ['接口联调', longName]);
    assert.equal(await body.locator('.workingMemoryActions button').count(), 2);
    assert.ok((await body.textContent()).includes('另有 1 项未列出'));
    assert.equal(calls.length, 1);
    assert.equal(await close.evaluate(node => node === document.activeElement), true);
    for (const width of widths) {
      await page.setViewportSize({ width, height: 960 });
      await page.evaluate(() => Promise.all(document.getAnimations().map(animation => animation.finished.catch(() => {}))));
      const bounds = await drawer.boundingBox();
      assert.ok(bounds && bounds.x >= 0 && bounds.x + bounds.width <= width + 1);
      assert.ok(await drawer.evaluate(node => node.scrollWidth <= node.clientWidth));
      assert.ok(await refresh.evaluate(node => node.getBoundingClientRect().height >= 44));
      await page.screenshot({ path: path.join(output, `working-${width}.png`), fullPage: true });
    }

    mode = 'failed';
    const prior = calls.length;
    await refresh.click();
    await page.waitForFunction(() => document.querySelector('#workingMemoryError').textContent.includes('未自动重试') &&
      !document.querySelector('#workingMemoryRefresh').disabled);
    assert.equal(await body.textContent(), '');
    await page.clock.runFor(10000);
    assert.equal(calls.length, prior + 1, '503 must not schedule a retry');
    await assertDrawer(drawer, originalDrawer);
    for (const [state, message] of [['empty', '没有未结束'], ['inactive', '事情已结束'], ['capacity', '容量已满'], ['disabled', '尚未启用']]) {
      mode = state;
      await refresh.click();
      await page.waitForFunction(expected => document.querySelector('#workingMemoryDrawer').textContent.includes(expected) &&
        !document.querySelector('#workingMemoryRefresh').disabled, message);
      await assertDrawer(drawer, originalDrawer);
      await page.screenshot({ path: path.join(output, `working-${state}.png`), fullPage: true });
    }

    mode = 'delayed';
    const pending = page.waitForRequest(request => new URL(request.url()).pathname === refreshPath('t'));
    await refresh.click();
    await pending;
    await page.waitForFunction(() => document.querySelector('#workingMemoryRefresh').disabled);
    assert.equal(await body.textContent(), '');
    await assertDrawer(drawer, originalDrawer);
    await page.keyboard.press('Escape');
    await drawer.waitFor({ state: 'hidden' });
    mode = 'normal';
    await openSummary('other');
    await waitForSummary('另外一件事情');
    assert.equal(lateHeld, true, 'the original refresh must still be held by the fixture');
    const beforeLate = await body.textContent();
    const lateResponse = page.waitForResponse(response => new URL(response.url()).pathname === refreshPath('t'));
    releaseLate();
    assert.equal(await (await lateResponse).finished(), null);
    // Let the browser process the response body and any scheduled React commit before checking it.
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await body.textContent(), beforeLate, 'late response must not overwrite the newly opened summary');
    assert.equal(await error.textContent(), '');
    assert.equal(await refresh.isEnabled(), true);
    assert.equal(await close.evaluate(node => node === document.activeElement), true);
    await assertDrawer(drawer, originalDrawer);
    await page.evaluate(() => { locateWorkbench = async id => { document.body.dataset.located = id; }; });
    await drawer.getByRole('button', { name: '查看事件：接口联调', exact: true }).click();
    await drawer.waitFor({ state: 'hidden' });
    assert.equal(await page.locator('body').getAttribute('data-located'), 'e');
    assert.deepEqual(calls, [
      { id: 't', state: 'normal' }, { id: 't', state: 'failed' }, { id: 't', state: 'empty' },
      { id: 't', state: 'inactive' }, { id: 't', state: 'capacity' }, { id: 't', state: 'disabled' },
      { id: 't', state: 'delayed' }, { id: 'other', state: 'normal' },
    ], 'each explicit open or refresh sends exactly one request');
    assert.deepEqual(unexpected, []);
    assert.deepEqual(errors, []);
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify({
      passed: true, mode: modeName, widths, bundleRequests, refreshRequests: calls,
      checks: ['entry absent at startup and rendered by React in the original #form',
        'original native modal', 'DOM ownership', 'no inline event attributes', 'factual counts',
        'escaped text', 'long text', 'read failure clears stale content', 'no automatic retry', 'inactive', 'empty', 'capacity',
        'disabled', 'late response ignored', 'navigation delegation', 'keyboard focus and Escape'],
      network: { http: 'fixture only', webSocket: 'blocked', serviceWorkers: 'blocked', unexpected },
      realBusinessWrites: 0, errors,
    }, null, 2));
    console.log(`Working memory browser checks passed (${modeName}; ${calls.length} fixture refreshes; ${bundleRequests} bundle requests)`);
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
