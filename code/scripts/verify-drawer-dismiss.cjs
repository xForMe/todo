// TEST-011 / SRC-UI-012. Usage: node code/scripts/verify-drawer-dismiss.cjs
// Exercises the default React URL. No live traffic.
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

const react = true;
const mode = react ? 'react' : 'legacy';
const origin = 'https://drawer-dismiss-fixture.invalid';
const bundle = '/dist/workbench-react.js';
const frontend = path.resolve(__dirname, '../frontend-react/public');
const output = path.resolve(__dirname, `../../runtime/drawer-dismiss-ui${react ? '-react' : ''}`);
const widths = [1440, 1024, 768, 375];
const expectedDrawers = ['editor', 'sourceDrawer', 'suggestionDrawer', 'followDrawer', 'pendingDrawer',
  'eventDrawer', 'moveDrawer', 'priorityDrawer', 'workbenchDrawer', 'eventRecognitionDrawer', 'dailyFollowDialog',
  'memoryDrawer', 'workingMemoryDrawer', 'memoryCandidatesDrawer', 'matterPlanningDrawer', 'planDrawer', 'imageDrawer', 'imageViewer'];
const day = '2026-11-19';
const items = [
  ['g', 'goal', null, '合成目标'], ['m', 'module', 'g', '合成模块'],
  ['t', 'thing', 'm', '合成事情'], ['e', 'event', 't', '合成行动'],
].map(([id, type, parent, name]) => ({
  id, type, parent, name, version: 1, status: 'working', description: '', owner: '', planStart: '', planEnd: '',
}));
const item = items.at(-1);
const imageList = '/api/events/e/images', imageAsset = '/fixture-image.png';
const imageName = '合成图片.png';
const imagePixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZ1sAAAAASUVORK5CYII=', 'base64');
const suggestion = { id: 's', source_kind: 'chat', thing_id: 't', state: 'pending', action: 'new',
  body: JSON.stringify({ name: '合成待核对建议', evidence: '仅用于验证抽屉关闭', thing_id: 't' }) };
const priorities = { week: '2026-11-16', items: [{ id: 't', priority: 1, due: true, version: 1 }] };
const snapshot = { items, priorities, attention: [{ item_id: 't', enabled: true }], branches: [], links: [],
  dependencies: [], daily_reviews: [], today: day };
const apiReads = {
  '/api/session': {}, '/api/items': items, '/api/workbench': snapshot, '/api/priorities': priorities,
  '/api/sources': [], '/api/sources/suggestions': [suggestion], '/api/sources/unmatched': [], '/api/sources/follow': [],
  '/api/memory/suggestions/s/basis': { items: [] },
  '/api/decomposition/types': [], '/api/plan-history-counts': {},
  '/api/events/e/structure': { ...snapshot, events: [item], snapshot: '0'.repeat(64) },
  [imageList]: { event: item, images: [{ id: 'fixture-image', name: imageName, state: 'ready',
    size: imagePixel.length, mime: 'image/png', revision: 1, created_at: `${day}T00:00:00Z`, url: `${origin}${imageAsset}` }] },
  '/api/items/e/daily-follow-ups': { item, day, records: [], revision: 0 },
  '/api/items/e/plan-history': { item, baseline: { scheduled: false, incomplete: false }, records: [] },
  '/api/items/e/deletion': { item, requires_target: false, documents: 0, suggestions: 0, reminders: 0, relations: [] },
};

async function intercept(context, { errors, writes, sockets, reads, assets }) {
  await context.routeWebSocket('**/*', socket => {
    sockets.push(socket.url());
    return socket.close(); // Never call connectToServer().
  });
  await context.route('**/*', async route => {
    const req = route.request();
    const { origin: requestOrigin, pathname } = new URL(req.url());
    const method = req.method();
    const reject = message => {
      errors.push(`${message}: ${method} ${req.url()}`);
      return route.abort();
    };
    if (method !== 'GET') {
      writes.push(`${method} ${req.url()}`);
      return reject('Unexpected non-GET request');
    }
    if (requestOrigin !== origin) return reject('Unexpected origin');
    if (Object.hasOwn(apiReads, pathname)) {
      reads.push(pathname);
      return route.fulfill({ json: apiReads[pathname] });
    }
    if (pathname === imageAsset) {
      assets.push(pathname);
      return route.fulfill({ body: imagePixel, contentType: 'image/png' });
    }
    if (pathname === '/favicon.ico') return route.fulfill({ status: 204 });
    if (pathname !== '/' && !(react && pathname === bundle) && !/^\/[\w-]+\.(?:css|js)$/.test(pathname)) {
      return reject('Unexpected resource or API');
    }
    const file = pathname === '/' ? 'index.html' : pathname.slice(1);
    const mime = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html' };
    try {
      const body = await fs.readFile(path.join(frontend, file));
      assets.push(pathname);
      return route.fulfill({ body, contentType: `${mime[path.extname(file)]}; charset=utf-8` });
    } catch (error) {
      return reject(error.message);
    }
  });
}

async function assertOwner(locator, label) {
  const hasFiber = await locator.evaluate(node => Object.getOwnPropertyNames(node)
    .some(key => key.startsWith('__reactFiber$') && node[key]?.stateNode === node));
  assert.equal(hasFiber, react, `${label}: ${mode} DOM ownership`);
}

function settingsButton(page) {
  return page.getByRole('button', { name: '设置', exact: true });
}

async function openSettings(page) {
  await settingsButton(page).click();
  const settings = page.locator('#matterPlanningDrawer');
  const tab = settings.getByRole('tab', { name: '数据渠道', selected: true });
  await tab.waitFor();
  await assertOwner(tab, '数据渠道');
}

async function openSource(page) {
  await openSettings(page);
  const manage = page.getByRole('tabpanel', { name: '数据渠道' }).getByRole('button', { name: '管理', exact: true });
  await assertOwner(manage, '管理飞书聊天来源');
  await manage.click();
  await assertOpen(page.locator('#matterPlanningDrawer'), false, 'settings yields to source');
  const source = page.locator('#sourceDrawer');
  await source.getByRole('heading', { name: '设置 · 聊天来源', exact: true }).waitFor();
  await assertOwner(source.locator('#sourceAddress'), 'source field');
}

async function openRecognition(page) {
  const entry = page.locator('#eventRecognitionTrigger');
  await entry.getByText('1 待确认', { exact: true }).waitFor();
  await entry.click();
  const drawer = page.locator('#eventRecognitionDrawer');
  const heading = drawer.getByRole('heading', { name: '事件识别', exact: true });
  await heading.waitFor();
  await assertOwner(heading, 'recognition heading');
  return drawer;
}

async function openImages(page) {
  await page.getByRole('button', { name: '目标与事情', exact: true }).click();
  await page.locator('#events').getByRole('button', { name: `事件图片：${item.name}`, exact: true }).click();
  const drawer = page.locator('#imageDrawer');
  const preview = drawer.getByRole('button', { name: `预览：${imageName}`, exact: true });
  await preview.waitFor();
  await assertOpen(drawer, true, 'event row opens the image drawer');
  await assertOwner(preview, 'saved image preview button');
  return { drawer, preview };
}

async function openDrawer(page, drawer, id) {
  if (id === 'matterPlanningDrawer') return openSettings(page);
  if (id === 'sourceDrawer') return openSource(page);
  if (id === 'eventRecognitionDrawer') return openRecognition(page);
  if (id === 'suggestionDrawer') {
    const recognition = await openRecognition(page);
    await recognition.getByRole('button', { name: '核对建议', exact: true }).click();
    const field = drawer.locator('#suggestionName');
    await field.waitFor();
    await assertOwner(field, 'suggestion review field');
    assert.equal(await field.inputValue(), '合成待核对建议');
    await assertOpen(recognition, false, 'recognition yields to suggestion review');
  } else if (id === 'dailyFollowDialog') {
    await page.getByRole('button', { name: `当日跟进：${item.name}`, exact: true }).click();
    await drawer.locator('#dailyContext').getByText(item.name, { exact: true }).waitFor();
    await assertOwner(drawer.locator('#dailyContent'), 'daily follow-up field');
  } else if (id === 'planDrawer') {
    await page.getByRole('button', { name: `延期变更：${item.name}`, exact: true }).click();
    await drawer.locator('#newPlanEnd').waitFor();
  } else if (id === 'followDrawer') {
    await page.getByRole('button', { name: '目标与事情', exact: true }).click();
    await page.locator('#events .followBell[data-event="e"]').click();
    await drawer.locator('#followContext').getByText(/合成行动 · 责任人/).waitFor();
    await assertOwner(drawer.locator('#followContent'), 'follow configuration content');
  } else if (id === 'moveDrawer') {
    await page.getByRole('button', { name: '目标与事情', exact: true }).click();
    await page.locator('#events').getByRole('button', { name: item.name, exact: true }).click();
    await page.locator('#eventDrawer').getByRole('button', { name: '迁移事件', exact: true }).click();
    const select = drawer.getByRole('combobox', { name: '目标', exact: true });
    await select.waitFor();
    await assertOwner(select, 'move destination selector');
  } else if (id === 'priorityDrawer') {
    await page.getByRole('button', { name: '去评估', exact: true }).click();
    const select = drawer.getByRole('combobox', { name: '优先级', exact: true });
    await select.waitFor();
    await assertOwner(select, 'priority selector');
  } else if (id === 'workbenchDrawer') {
    const attention = page.locator('#globalWorkbench .wbPanel').filter({ has: page.getByRole('heading', { name: /^持续关注/ }) });
    await attention.getByRole('button', { name: '合成事情', exact: true }).click();
    await drawer.getByRole('heading', { name: '合成事情', exact: true }).waitFor();
  } else if (id === 'imageDrawer' || id === 'imageViewer') {
    const { drawer: imageDrawer, preview } = await openImages(page);
    if (id === 'imageViewer') {
      await preview.click();
      const image = drawer.getByRole('img', { name: imageName, exact: true });
      await image.waitFor();
      assert.equal(await image.evaluate(async node => { await node.decode(); return node.naturalWidth; }), 1,
        'the real viewer must decode the synthetic PNG');
      await assertOwner(image, 'image viewer content');
      await assertOpen(imageDrawer, true, 'preview is stacked on the open image drawer');
    }
  } else {
    // These hosts already have a hit-testable interior; their business entry flows are not under test here.
    await drawer.evaluate(node => node.showModal());
  }
}

async function assertOpen(drawer, open, label) {
  assert.deepEqual(await drawer.evaluate(node => ({ native: node instanceof HTMLDialogElement,
    open: node.open, modal: node.matches(':modal') })), { native: true, open, modal: open }, label);
}

async function pointsFor(drawer, label) {
  const points = await drawer.evaluate(dialog => {
    const { left, top, right, bottom } = dialog.getBoundingClientRect();
    const rect = { left, top, right, bottom };
    const viewport = { width: document.documentElement.clientWidth, height: document.documentElement.clientHeight };
    const visible = { left: Math.max(left, 0), top: Math.max(top, 0),
      right: Math.min(right, viewport.width), bottom: Math.min(bottom, viewport.height) };
    const xAt = fraction => Math.floor(visible.left + (visible.right - visible.left) * fraction);
    const yAt = fraction => Math.floor(visible.top + (visible.bottom - visible.top) * fraction);
    const inView = ({ x, y }) => x >= 0 && y >= 0 && x < viewport.width && y < viewport.height;
    const inside = ({ x, y }) => x > left && x < right && y > top && y < bottom;
    const hit = ({ x, y }) => document.elementFromPoint(x, y);
    const css = getComputedStyle(dialog);
    const px = name => parseFloat(css[name]);
    // Outer CSS padding is the strongest check: a click there is retargeted to the
    // dialog itself, just like on the backdrop. Some hosts have zero outer padding.
    const padding = [
      ['paddingLeft', left + px('borderLeftWidth'), 1, true],
      ['paddingRight', right - px('borderRightWidth'), -1, true],
      ['paddingTop', top + px('borderTopWidth'), 1, false],
      ['paddingBottom', bottom - px('borderBottomWidth'), -1, false],
    ].flatMap(([name, edge, sign, horizontal]) => {
      const size = px(name);
      if (size < 2) return [];
      const at = Math.round(edge + sign * size / 2);
      return [0.5, 0.25, 0.75].map(fraction => horizontal ? { x: at, y: yAt(fraction) } : { x: xAt(fraction), y: at });
    }).find(point => inView(point) && inside(point) && hit(point) === dialog);
    const inner = padding || [0.05, 0.95, 0.25, 0.75, 0.5].flatMap(x =>
      [0.25, 0.5, 0.75, 0.05, 0.95].map(y => ({ x: xAt(x), y: yAt(y) }))).find(point => {
      if (!inView(point) || !inside(point)) return false;
      const node = hit(point);
      // An image starts native drag-and-drop instead of the pointer gesture under test.
      return node && dialog.contains(node) &&
        !node.closest('button,input,textarea,select,a,label,summary,[role="button"],img,[draggable="true"]');
    });
    const candidates = [
      { x: Math.max(0, Math.ceil(left) - 6), y: yAt(0.5) },
      { x: Math.min(viewport.width - 1, Math.ceil(right) + 5), y: yAt(0.5) },
      { x: xAt(0.5), y: Math.max(0, Math.ceil(top) - 6) },
      { x: xAt(0.5), y: Math.min(viewport.height - 1, Math.ceil(bottom) + 5) },
    ].filter(point => inView(point) && (point.x < left || point.x >= right || point.y < top || point.y >= bottom));
    return { rect, viewport, inner, padding: !!padding, hasOutside: candidates.length > 0,
      outer: candidates.find(point => hit(point) === dialog) };
  });
  assert.ok(points.inner, `${label}: no real non-control interior point (${JSON.stringify(points.rect)})`);
  if (points.hasOutside) assert.ok(points.outer, `${label}: outside exists but does not target this modal`);
  else assert.ok(points.rect.left <= 0 && points.rect.top <= 0 &&
    points.rect.right >= points.viewport.width && points.rect.bottom >= points.viewport.height,
  `${label}: Escape is reserved for dialogs covering the viewport`);
  return points;
}

// Observe the browser's trusted events before the production document handlers; do not synthesize or cancel any.
function installPointerProbe() {
  window.drawerPointerEvents = [];
  for (const type of ['pointerdown', 'pointerup', 'click']) window.addEventListener(type, event => {
    const target = event.target;
    const dialog = target instanceof Element ? target.closest('dialog') : null;
    const rect = dialog?.getBoundingClientRect();
    const { clientX: x, clientY: y } = event;
    const inside = !!rect && x >= rect.left && x < rect.right && y >= rect.top && y < rect.bottom;
    window.drawerPointerEvents.push({ type, x, y, inside, target: target.id || target.localName,
      drawer: dialog?.id, modal: !!dialog?.matches(':modal'), host: dialog === target, trusted: event.isTrusted });
  }, true);
}

async function gesture(page, id, from, to, { fromInside, toInside, innerPadding = false }, label) {
  await page.evaluate(() => { window.drawerPointerEvents.length = 0; });
  if (from === to) await page.mouse.click(to.x, to.y);
  else {
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(to.x, to.y);
    await page.mouse.up();
  }
  const observed = await page.evaluate(() => window.drawerPointerEvents);
  assert.deepEqual(observed.map(event => event.type), ['pointerdown', 'pointerup', 'click'], label);
  for (const [i, event] of observed.entries()) {
    const point = i === 0 ? from : to;
    const inside = i === 0 ? fromInside : toInside;
    assert.deepEqual({ x: event.x, y: event.y, inside: event.inside, drawer: event.drawer,
      modal: event.modal, trusted: event.trusted }, { ...point, inside, drawer: id, modal: true, trusted: true },
    `${label}: ${event.type} hit ${JSON.stringify(event)}`);
    if (!inside || innerPadding) assert.equal(event.host, true, `${label}: ${event.type} must target the dialog itself`);
  }
  return observed;
}

async function backdrop(page, drawer, id, point, label) {
  assert.ok(point, `${label}: expected an actual backdrop`);
  const events = await gesture(page, id, point, point, { fromInside: false, toInside: false }, label);
  await assertOpen(drawer, false, label);
  return events;
}

(async () => {
  await fs.mkdir(output, { recursive: true });
  if (react) await fs.access(path.join(frontend, bundle.slice(1)));
  const browser = await chromium.launch({ channel: 'chrome', headless: true,
    args: ['--disable-background-networking', '--host-resolver-rules=MAP * ~NOTFOUND'] });
  const errors = [], writes = [], sockets = [], reads = [], assets = [], checks = [];
  try {
    const context = await browser.newContext({ reducedMotion: 'reduce', serviceWorkers: 'block' });
    await intercept(context, { errors, writes, sockets, reads, assets });
    await context.addInitScript(installPointerProbe);
    const page = await context.newPage();
    page.setDefaultTimeout(8000);
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${origin}/`);
    await page.waitForFunction(expectReact => !!wbSnapshot && !wbLoading && (expectReact ? !!wbRenderReact : !wbRenderReact), react);
    await assertOwner(page.getByRole('button', { name: `当日跟进：${item.name}`, exact: true }), 'workbench action');
    assert.equal(assets.includes(bundle), react, `${mode}: bundle loading`);

    const ids = await page.locator('dialog:not(#deleteDrawer)').evaluateAll(nodes => nodes.map(node => node.id));
    assert.deepEqual([...ids].sort(), [...expectedDrawers].sort(), 'Keep every static and dynamic dialog in the matrix');
    for (const width of widths) {
      await page.setViewportSize({ width, height: 960 });
      const drawers = [];
      for (const id of ids) {
        const drawer = page.locator(`#${id}`);
        const label = `${mode} ${width}px #${id}`;
        await openDrawer(page, drawer, id);
        await assertOpen(drawer, true, `${label}: opened`);
        const points = await pointsFor(drawer, label);
        const inner = await gesture(page, id, points.inner, points.inner,
          { fromInside: true, toInside: true, innerPadding: points.padding }, `${label}: inside`);
        await assertOpen(drawer, true, `${label}: inside click must not close`);
        const record = { id, ...points, innerEvents: inner };
        const screenshot = id === 'sourceDrawer' ? `drawer-${width}.png` : id === 'dailyFollowDialog' ? `daily-${width}.png` : null;
        if (screenshot) {
          await page.screenshot({ path: path.join(output, screenshot) });
          record.screenshot = screenshot;
        }
        if (points.outer) {
          record.drag = await gesture(page, id, points.inner, points.outer,
            { fromInside: true, toInside: false }, `${label}: drag out`);
          await assertOpen(drawer, true, `${label}: drag out must not close`);
          record.backdrop = await backdrop(page, drawer, id, points.outer, `${label}: backdrop click closes`);
        } else {
          await page.keyboard.press('Escape');
          await assertOpen(drawer, false, `${label}: full viewport Escape`);
          record.escape = true;
        }
        if (id === 'suggestionDrawer') {
          // Native close dispatch is asynchronous; wait for recognition to return before closing it.
          const recognition = page.locator('#eventRecognitionDrawer');
          await recognition.waitFor();
          await assertOpen(recognition, true, `${label}: close returns to recognition`);
          assert.equal(await page.locator('dialog[open]').count(), 1);
          record.returnsToRecognition = true;
          await recognition.getByRole('button', { name: '关闭', exact: true }).click();
          await assertOpen(recognition, false, `${label}: recognition closes through its button`);
        } else if (id === 'imageViewer') {
          const imageDrawer = page.locator('#imageDrawer');
          await assertOpen(imageDrawer, true, `${label}: only the viewer closes`);
          assert.equal(await page.locator('dialog[open]').count(), 1);
          record.returnsToImages = true;
          await imageDrawer.getByRole('button', { name: '关闭图片', exact: true }).click();
          await assertOpen(imageDrawer, false, `${label}: image drawer closes through its button`);
        } else {
          await page.evaluate(() => document.querySelectorAll('dialog[open]').forEach(node => node.close()));
        }
        if (id === 'suggestionDrawer' || id === 'eventRecognitionDrawer') {
          await page.locator('#eventRecognitionTrigger[aria-expanded="false"]').waitFor();
        }
        // These entries navigate to the work page. Restore the workbench
        // so later cases can still use their real entry buttons.
        if (['priorityDrawer', 'moveDrawer', 'followDrawer', 'imageDrawer', 'imageViewer'].includes(id)) {
          await page.getByRole('button', { name: '工作台', exact: true }).click();
          await page.locator('#globalWorkbench').waitFor();
        }
        drawers.push(record);
      }
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${width}px: no page overflow`);
      checks.push({ width, drawers });
    }

    await page.setViewportSize({ width: 1440, height: 960 });
    const source = page.locator('#sourceDrawer');
    await openSource(page);
    await source.locator('#sourceAddress').fill('示例未保存内容');
    assert.equal(await source.locator('#sourceAddress').inputValue(), '示例未保存内容');
    await assertOpen(source, true, 'source open with unsaved text');
    const sourcePoints = await pointsFor(source, 'source with unsaved text');
    const unsavedSource = await backdrop(page, source, 'sourceDrawer', sourcePoints.outer, 'unsaved source backdrop');
    await page.waitForFunction(() => document.activeElement?.id === 'workspaceSettings');
    assert.equal(await settingsButton(page).evaluate(node => node === document.activeElement), true, 'focus restores to Settings');

    // Stack two real hosts deliberately: the underlying page is inert, so the top editor cannot be opened via a page click.
    await openSource(page);
    await page.evaluate(() => openForm('event', 'e'));
    const editor = page.locator('#editor');
    await assertOpen(editor, true, 'stacked editor');
    await assertOpen(source, true, 'stacked source');
    const editorPoints = await pointsFor(editor, 'stacked editor');
    const topOnly = await backdrop(page, editor, 'editor', editorPoints.outer, 'stacked backdrop closes only the editor');
    await assertOpen(source, true, 'stacked source remains open');
    await page.keyboard.press('Escape');
    await assertOpen(source, false, 'Escape closes remaining source');

    await page.getByRole('button', { name: item.name, exact: true }).click();
    await editor.locator('#deleteEntry').click();
    const deletion = page.locator('#deleteDrawer');
    await deletion.locator('#submitDelete:enabled').waitFor();
    await assertOpen(deletion, true, 'delete confirmation opened and loaded');
    const deletePoints = await pointsFor(deletion, 'delete confirmation');
    assert.ok(deletePoints.outer, 'delete confirmation has a real backdrop');
    const deleteIgnored = await gesture(page, 'deleteDrawer', deletePoints.outer, deletePoints.outer,
      { fromInside: false, toInside: false }, 'delete backdrop');
    await assertOpen(deletion, true, 'backdrop must not dismiss delete confirmation');
    await page.keyboard.press('Escape');
    await assertOpen(deletion, false, 'Escape dismisses delete confirmation without submitting');

    assert.deepEqual(errors, []);
    assert.deepEqual(writes, []);
    assert.deepEqual(sockets, []);
    assert.equal(reads.filter(read => read === imageList).length, 2 * widths.length,
      'each image drawer and viewer case reads the event images through its real entry');
    assert.ok(assets.includes(imageAsset), 'the synthetic image must be requested');
    const result = { mode, checks, ids, extra: { unsavedSource, focusRestored: true, topOnly, deleteIgnored },
      reads, assets, errors, writes, sockets, result: 'passed' };
    await fs.writeFile(path.join(output, 'results.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify({ mode, checks: checks.map(({ width, drawers }) => ({ width, drawers: drawers.length,
      backdrop: drawers.filter(drawer => drawer.backdrop).length, escape: drawers.filter(drawer => drawer.escape).length })),
    drawers: ids.length, errors, writes, sockets, output }));
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
