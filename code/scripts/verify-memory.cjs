// TEST-016 / TEST-025: isolated Chrome against the built React UI.
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

const react = true;
const mode = react ? 'react' : 'native';
const origin = 'http://127.0.0.1:18881';
const root = path.resolve(__dirname, '../frontend-react/public');
const bundle = '/dist/workbench-react.js';
const output = path.resolve(__dirname, '../../runtime', `memory-ui${react ? '-react' : ''}`);
const widths = [1440, 1024, 768, 375];
const modulePath = '/api/memory/modules/m';
const indexPath = `${modulePath}/index`;
const operationsPath = '/api/memory/operations/';
const scopeVersion = 'a'.repeat(64);
const uuid = /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i;

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
      labelled: dialog.getAttribute('aria-labelledby') === 'memoryTitle',
      missing: ['#memoryTitle', '#memoryClose', '#memoryPath', '#memoryState[role="status"]', '#memoryForm',
        '#memoryDescription', '#memoryAliases', '#memorySave', '#memoryDisable', '#memoryIndex', '#memoryRefresh',
        '#memoryRecover', '#memoryError[role="alert"]'].filter(selector => !dialog.querySelector(selector)),
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
  }, 'retain the original native dialog; only its React descendants have actual DOM Fibers');
  assert.equal(await drawer.page().locator('dialog:modal').count(), 1);
  assert.equal(await drawer.page().locator('dialog[open]').count(), 1);
}

(async () => {
  const bundleBody = react ? fs.readFileSync(path.join(root, bundle.slice(1))) : null;
  fs.mkdirSync(output, { recursive: true });
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const context = await browser.newContext({ serviceWorkers: 'block' });
    const errors = [], unexpected = [], calls = [], writes = [], indexes = [], receipts = new Map();
    let bundleRequests = 0, releaseBundle;
    const bundleReady = new Promise(resolve => { releaseBundle = resolve; });
    const items = [['g', 'goal', null, '年度目标'], ['m', 'module', 'g', '客户实施模块'], ['t', 'thing', 'm', '上线准备']]
      .map(([id, type, parent, name]) => ({
        id, type, parent, name, description: '', owner: '', planStart: '', planEnd: '', status: 'notStarted', version: 1,
      }));
    const priorities = { week: '2026-11-09', items: [] };
    const workbench = { items, priorities, attention: [], branches: [], links: [], dependencies: [], today: '2026-11-15' };
    const reads = {
      '/api/session': {}, '/api/items': items, '/api/workbench': workbench, '/api/priorities': priorities,
      '/api/sources/suggestions': [], '/api/sources': [], '/api/sources/unmatched': [], '/api/sources/follow': [],
      '/api/plan-history-counts': {},
    };
    let card = {
      module_id: 'm', path: '年度目标 / 客户实施模块', scope_version: scopeVersion,
      version: 0, description: '', aliases: [], enabled: true, usable: false, status: '未配置',
    };
    let failRead = false, writeMode = 'normal', indexState = 'not_indexed', embeddingConfigured = false;
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
        if (pathname === modulePath && !url.search) {
          if (method === 'GET') {
            calls.push(['GET card', failRead ? 503 : 200]);
            if (failRead) return route.fulfill({ status: 503, json: { detail: '存储暂不可用' } });
            return route.fulfill({ json: { card, index_state: indexState, embedding_configured: embeddingConfigured, enabled: true } });
          }
          if (method === 'PUT') {
            const data = request.postDataJSON();
            const status = writeMode === 'conflict' ? 409 : writeMode === 'unknown' ? 503 : 200;
            writes.push(data);
            calls.push(['PUT card', status]);
            if (status === 409) return route.fulfill({ status, json: { detail: '模块已变化，请刷新后核对' } });
            card = { ...card, description: data.description, aliases: data.aliases, enabled: data.enabled,
              version: card.version + 1, usable: data.enabled, status: data.enabled ? '已确认' : '已停用' };
            indexState = 'not_indexed';
            receipts.set(data.operation_id, card);
            if (status === 503) return route.fulfill({ status, json: { detail: '保存结果待核对' } });
            return route.fulfill({ json: card });
          }
        }
        if (method === 'GET' && pathname.startsWith(operationsPath) && !url.search) {
          const operationId = pathname.slice(operationsPath.length);
          if (!receipts.has(operationId)) return abort('Unexpected receipt operation');
          calls.push(['GET receipt', 200, operationId]);
          return route.fulfill({ json: receipts.get(operationId) });
        }
        if (method === 'POST' && pathname === indexPath && !url.search) {
          if (!embeddingConfigured || !card.usable) return abort('Index requested without configuration or a usable card');
          indexes.push(request.postDataJSON());
          calls.push(['POST index', 200]);
          indexState = 'ready';
          return route.fulfill({ json: { state: 'ready' } });
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
    const drawer = page.locator('#memoryDrawer'), entry = page.locator('#moduleMemoryEntry');
    const originalDrawer = await drawer.elementHandle();
    const originalForm = await page.locator('#editor > #form').elementHandle();
    assert.deepEqual(await originalDrawer.evaluate(node => ({
      native: node instanceof HTMLDialogElement, open: node.open,
      mounted: node.hasAttribute('data-react-owned'), children: node.childNodes.length,
    })), { native: true, open: false, mounted: false, children: 0 }, 'Module memory has no legacy content before React mounts');
    assert.deepEqual(await originalForm.evaluate(form => ({
      native: form instanceof HTMLFormElement,
      marked: form.hasAttribute('data-react-owned'),
      children: form.childNodes.length,
      entry: !!form.parentElement.querySelector('#moduleMemoryEntry'),
    })), { native: true, marked: false, children: 0, entry: false },
    'The original editor form is empty and has no module memory entry during startup');
    releaseBundle();
    await page.waitForFunction(() => db.items.length === 3);
    if (react) await page.locator('#memoryDrawer[data-react-owned] #memoryClose').waitFor({ state: 'attached' });
    assert.equal(bundleRequests, react ? 1 : 0);

    const description = drawer.locator('#memoryDescription'), aliases = drawer.locator('#memoryAliases');
    const save = drawer.locator('#memorySave'), disable = drawer.locator('#memoryDisable');
    const index = drawer.locator('#memoryIndex'), recover = drawer.locator('#memoryRecover');
    const recoveryEntry = page.locator('#memoryRecoveryEntry');
    const readIntent = () => page.evaluate(() => sessionStorage.getItem('todo.memoryWrite'));
    const waitForState = text => page.waitForFunction(text => document.querySelector('#memoryState').textContent === text, text);
    const waitForError = text => page.waitForFunction(text => document.querySelector('#memoryError').textContent.includes(text), text);
    const openMemory = async () => {
      await page.evaluate(() => openForm('module', 'm'));
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
      }, '#moduleMemoryEntry is rendered by React in the original #form');
      await entry.click();
    };
    await openMemory();
    await waitForState('未配置 · 未生成索引 · 向量服务未配置或未授权，精确匹配可用');
    await assertDrawer(drawer, originalDrawer);
    assert.equal(await drawer.locator('#memoryPath').textContent(), card.path);
    assert.equal(await index.isDisabled(), true);
    await description.fill('负责客户项目实施、联调和验收。');
    await aliases.fill('华东一期');
    await save.click();
    await waitForState('已确认');
    assert.equal(writes.length, 1);
    assert.equal(await readIntent(), null);
    assert.equal(await index.isDisabled(), true, 'saving a usable card cannot bypass missing embedding configuration');
    for (const width of widths) {
      await page.setViewportSize({ width, height: 960 });
      await page.evaluate(() => Promise.all(document.getAnimations().map(animation => animation.finished.catch(() => {}))));
      const bounds = await drawer.boundingBox();
      assert.ok(bounds && bounds.x >= 0 && bounds.x + bounds.width <= width + 1);
      assert.ok(await drawer.evaluate(node => node.scrollWidth <= node.clientWidth));
      await page.screenshot({ path: path.join(output, `memory-${width}.png`), fullPage: true });
    }

    writeMode = 'conflict';
    await description.fill('保留我的修改');
    await save.click();
    await waitForError('模块已变化');
    assert.equal(await description.inputValue(), '保留我的修改');
    assert.equal(await aliases.inputValue(), '华东一期');
    assert.equal(await readIntent(), null);
    writeMode = 'unknown';
    await save.click();
    await waitForError('待核对');
    assert.equal(await save.isDisabled(), true);
    const before = writes.length, operationId = writes.at(-1).operation_id;
    const pendingIntent = await readIntent();
    assert.deepEqual(JSON.parse(pendingIntent), { module_id: 'm', operation_id: operationId });
    assert.equal(await recoveryEntry.evaluate(node => node.hidden), false);

    failRead = true;
    await recover.click();
    await waitForError('存储暂不可用');
    assert.equal(await recover.isEnabled(), true);
    assert.equal(await recover.isVisible(), true);
    assert.equal(await readIntent(), pendingIntent, 'successful receipt plus failed card read must retain the exact intent');
    assert.equal(await recoveryEntry.evaluate(node => node.hidden), false);
    assert.equal(await save.isDisabled(), true);
    assert.equal(await disable.isDisabled(), true);
    assert.equal(await index.isDisabled(), true);
    assert.equal(await description.inputValue(), '保留我的修改');
    await assertDrawer(drawer, originalDrawer);
    const failedRecovery = [['GET receipt', 200, operationId], ['GET card', 503]];
    assert.deepEqual(calls.slice(-2), failedRecovery);
    await page.clock.runFor(11000);
    assert.deepEqual(calls.slice(-2), failedRecovery, 'no automatic recovery after a read failure');
    assert.equal(writes.length, before);

    failRead = false;
    embeddingConfigured = true;
    await recover.click();
    await waitForState('已确认 · 未生成索引');
    assert.equal(await recover.isHidden(), true);
    assert.equal(await recoveryEntry.evaluate(node => node.hidden), true);
    assert.equal(await readIntent(), null);
    assert.equal(await save.isEnabled(), true);
    assert.equal(await description.inputValue(), '保留我的修改');
    assert.equal(await aliases.inputValue(), '华东一期');
    assert.equal(await drawer.locator('#memoryError').textContent(), '');
    assert.equal(writes.length, before, 'neither receipt lookup may replay the original PUT');
    assert.deepEqual(calls.slice(-2), [['GET receipt', 200, operationId], ['GET card', 200]]);

    assert.equal(indexes.length, 0, 'opening, saving and recovering do not generate an index');
    assert.equal(await index.isEnabled(), true);
    await index.click();
    await waitForState('已确认 · 索引已生成');
    assert.equal(indexes.length, 1);
    assert.match(indexes[0].operation_id, uuid);
    assert.deepEqual(indexes[0], { operation_id: indexes[0].operation_id, expected_version: 2 });
    assert.equal(writes.some(write => write.operation_id === indexes[0].operation_id), false);
    assert.deepEqual(calls.slice(-2), [['POST index', 200], ['GET card', 200]]);
    await assertDrawer(drawer, originalDrawer);

    writeMode = 'normal';
    await disable.click();
    await waitForState('已停用');
    assert.equal(await index.isDisabled(), true);
    await page.keyboard.press('Escape');
    await drawer.waitFor({ state: 'hidden' });
    failRead = true;
    await openMemory();
    await waitForError('存储暂不可用');
    assert.equal(await save.isDisabled(), true);
    await assertDrawer(drawer, originalDrawer);

    assert.deepEqual(calls, [
      ['GET card', 200], ['PUT card', 200], ['PUT card', 409], ['PUT card', 503],
      ...failedRecovery, ['GET receipt', 200, operationId], ['GET card', 200],
      ['POST index', 200], ['GET card', 200], ['PUT card', 200], ['GET card', 503],
    ], 'only the expected fixture calls occurred, in order');
    assert.equal(new Set(writes.map(write => write.operation_id)).size, 4);
    for (const [i, [version, text, enabled]] of [
      [0, '负责客户项目实施、联调和验收。', true], [1, '保留我的修改', true],
      [1, '保留我的修改', true], [2, '保留我的修改', false],
    ].entries()) {
      assert.match(writes[i].operation_id, uuid);
      assert.deepEqual(writes[i], { operation_id: writes[i].operation_id, expected_version: version,
        scope_version: scopeVersion, description: text, aliases: ['华东一期'], enabled });
    }
    assert.deepEqual(unexpected, []);
    assert.deepEqual(errors, []);
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify({
      passed: true, mode, widths, bundleRequests, calls,
      checks: ['entry absent at startup and rendered by React in the original #form',
        'one original modal', 'DOM ownership', 'no inline event attributes', 'save',
        'disable', 'conflict preserves input', 'failed readback retains original intent and disables saving',
        'same receipt and successful readback clear intent without repeating PUT', 'configuration boundary',
        'explicit index POST and readback', 'read failure', 'keyboard Escape', 'responsive'],
      network: { http: 'fixture only', webSocket: 'blocked', serviceWorkers: 'blocked', unexpected },
      realWrites: 0, errors,
    }, null, 2));
    console.log(`Memory browser checks passed (${mode}; ${writes.length} fixture PUTs; ${indexes.length} fixture index POST; ${bundleRequests} bundle requests)`);
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
