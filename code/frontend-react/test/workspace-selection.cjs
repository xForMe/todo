// TEST-025 / TEST-011: run against static assets and synthetic GET responses only.
// From the repo root: node code/frontend-react/test/workspace-selection.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require('playwright');

const frontend = path.resolve(__dirname, '../public');
const bundle = '/dist/workbench-react.js';
const origin = 'http://127.0.0.1:18886'; // Virtual origin; no server is started or contacted.
const output = path.resolve(__dirname, '../../../runtime/react-workspace-selection');
const widths = [1440, 1024, 768, 601, 600, 375, 320];
const screenshotWidths = new Set([1440, 1024, 768, 375]);
const longModuleName = '跨部门协调与长周期交付计划'.repeat(7);
const bothName = '宣传册制定 <样稿 & 审校>';
const item = (id, type, parent, name, fields = {}) => ({
  id, type, parent, name, status: 'notStarted', version: 1, ...fields,
});
const fixtureItems = [
  item('g1', 'goal', null, '树立行业标杆'),
  item('g2', 'goal', null, '其他目标'),
  item('g3', 'goal', null, '待规划目标'),
  item('m1', 'module', 'g1', '品牌宣传'),
  item('m2', 'module', 'g1', '产品交付'),
  item('m3', 'module', 'g1', '团队协作'),
  item('m4', 'module', 'g1', longModuleName),
  item('m5', 'module', 'g2', '服务保障'),
  item('t1', 'thing', 'm1', bothName, {
    status: 'working', description: '合成说明 <仅用于测试>', owner: '测试负责人',
    planStart: '2026-11-18', planEnd: '2026-11-20',
  }),
  item('t2', 'thing', 'm2', '交付清单'),
  item('t3', 'thing', 'm1', '联络合作方'),
  item('t4', 'thing', 'm1', '存档视觉素材'),
  item('t5', 'thing', 'm1', '整理参考资料'),
  item('e1', 'event', 't1', '准备宣传材料'),
  item('e2', 'event', 't2', '核对交付节点'),
  item('e3', 'event', 't3', '确认合作窗口'),
];
const priorityStates = [
  { id: 't1', priority: 1, due: true, version: 1 },
  { id: 't2', priority: 0, due: false, version: 1 },
  { id: 't3', priority: 2, due: true, version: 1 },
  { id: 't4', priority: 3, due: false, version: 1 },
  { id: 't5', priority: 4, due: false, version: 1 },
];
const attentionStates = ['t1', 't4'].map(item_id => ({ item_id, enabled: true }));
const sourceSuggestions = [{
  id: 'syn-source', thing_id: 't1', state: 'pending', action: 'new', source_kind: 'document',
  body: JSON.stringify({ name: '合成候选 <核对>', evidence: '来自合成来源 & 不落库',
    owner: '', plan_end: '', status: 'notStarted' }),
}];

async function intercept(context, page) {
  const fixture = { items: fixtureItems, failItems: false, failStructure: null };
  const problems = [];
  page.on('pageerror', error => problems.push(error.message));
  await context.routeWebSocket('**/*', socket => {
    problems.push(`Unexpected WebSocket: ${socket.url()}`);
    return socket.close();
  });
  await context.route('**/*', async route => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();
    const reject = () => {
      problems.push(`Unexpected request: ${method} ${url.href}`);
      return route.abort();
    };
    // Block wrong origins, writes, unknown endpoints and unlisted static paths; never continue a route.
    if (url.origin !== origin || method !== 'GET') return reject();
    if (url.pathname.startsWith('/api/')) {
      const { items, failItems } = fixture;
      if (failItems && url.pathname === '/api/items') {
        return route.fulfill({ status: 503, json: { detail: '模拟读取失败' } });
      }
      const priorities = { week: '2026-11-16', items: priorityStates.filter(row => items.some(x => x.id === row.id)) };
      const snapshot = {
        items, priorities, attention: attentionStates.filter(row => items.some(x => x.id === row.item_id)),
        branches: [], links: [], dependencies: [], today: '2026-11-19',
      };
      const reads = {
        '/api/session': {}, '/api/items': items, '/api/workbench': snapshot, '/api/priorities': priorities,
        '/api/sources': [], '/api/sources/suggestions': sourceSuggestions, '/api/sources/unmatched': [], '/api/sources/follow': [],
        '/api/plan-history-counts': {}, '/api/memory/suggestions/syn-source/basis': { items: [] },
      };
      if (Object.hasOwn(reads, url.pathname)) return route.fulfill({ json: reads[url.pathname] });
      const id = /^\/api\/events\/([^/]+)\/structure$/.exec(url.pathname)?.[1];
      const event = items.find(row => row.type === 'event' && row.id === id);
      if (event && id === fixture.failStructure) {
        return route.fulfill({ status: 503, json: { detail: '模拟事件结构读取失败' } });
      }
      if (event) return route.fulfill({ json: {
        ...snapshot, events: items.filter(row => row.type === 'event' && row.parent === event.parent),
        snapshot: '0'.repeat(64),
      } });
      return reject();
    }
    if (url.pathname === '/favicon.ico') return route.fulfill({ status: 204 });
    const file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    if (url.pathname !== bundle && !/^[-\w]+\.(?:js|css|html)$/.test(file)) return reject();
    const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
    try {
      const body = await fs.readFile(path.join(frontend, file));
      return route.fulfill({ body, contentType: `${types[path.extname(file)]}; charset=utf-8` });
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      return reject();
    }
  });
  return { fixture, problems };
}

async function assertOwnership(page) {
  const work = page.locator('#workPage');
  await page.locator('#workPage[data-selection-ui="react"]').waitFor();
  await work.locator('#events[data-events-ui="react"]').waitFor();
  // A marker alone does not prove ownership. Check React 19 root containers and rendered host nodes.
  const ownership = await work.evaluate(root => {
    const owned = node => !!node && Object.getOwnPropertyNames(node).some(key =>
      /^__react(?:Fiber|Container)\$/.test(key));
    return ['.toolbar', '#goalSelect', '.moduleChoice', '.workspace > .panel:first-child',
      '#addThing', '#things .thing', '#crumb', '#events', '#events .eventTitle']
      .map(selector => owned(root.querySelector(selector)));
  });
  assert.deepEqual(ownership, Array(ownership.length).fill(true),
    'React must own the selection and event DOM');
  const inline = await work.evaluate(root => [
    root.querySelector('.toolbar'), root.querySelector('.workspace > .panel:first-child'), root.querySelector('#crumb'),
    root.querySelector('#events'),
  ].flatMap(region => [region, ...region.querySelectorAll('*')].flatMap(node => node.getAttributeNames()
    .filter(name => /^on/i.test(name)).map(name => `${node.id || node.tagName}.${name}`))));
  assert.deepEqual(inline, [], 'Migrated regions must not retain inline handlers');
}

async function verifyLayout(page, work, modules) {
  for (const width of widths) {
    await page.setViewportSize({ width, height: 900 });
    assert.equal(await modules.getByRole('radio').count(), 4);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `page overflows at ${width}px`);
    const goal = await work.locator('.toolbarGoal').boundingBox();
    const group = await modules.boundingBox();
    if (width > 600) {
      assert.ok(group.x >= goal.x + goal.width, `modules sit to the right of the goal at ${width}px`);
      assert.ok(Math.abs(group.y - goal.y) <= 4, `modules start on the goal row at ${width}px`);
    } else {
      assert.ok(group.y >= goal.y + goal.height, `modules wrap below the goal at ${width}px`);
    }
    const rows = await modules.locator('.moduleChoice').evaluateAll(labels => labels.map(label => ({
      overflows: label.getBoundingClientRect().right > label.parentElement.getBoundingClientRect().right + 1,
      clipped: label.scrollWidth > label.clientWidth,
      frame: getComputedStyle(label).borderTopWidth,
      radioOpacity: getComputedStyle(label.querySelector('input')).opacity,
      top: label.offsetTop,
    })));
    for (const row of rows) {
      assert.deepEqual([row.overflows, row.clipped, row.frame, row.radioOpacity], [false, false, '0px', '0'], `module style at ${width}px`);
    }
    if (width <= 375) assert.ok(new Set(rows.map(row => row.top)).size > 1, `module choices wrap at ${width}px`);
    const fits = await work.evaluate(root => ['#crumb', '.toolbar', '.workspace > .panel:first-child', '#events'].every(selector => {
      const { left, right, width, height } = root.querySelector(selector).getBoundingClientRect();
      return left >= 0 && right <= innerWidth + 1 && width > 0 && height > 0;
    }));
    assert.ok(fits, `workspace regions fit the viewport at ${width}px`);
    if (screenshotWidths.has(width)) {
      await page.screenshot({ path: path.join(output, `react-${width}.png`), fullPage: true });
    }
  }
}

async function exercise(page, fixture) {
  await page.goto(`${origin}/`);
  await page.locator('body:not([data-ui-startup])').waitFor({ state: 'attached' });
  await page.getByRole('button', { name: '目标与事情', exact: true }).click();
  const work = page.locator('#workPage');
  const toolbar = work.locator('.toolbar');
  const crumb = work.locator('#crumb');
  const modules = toolbar.getByRole('group', { name: '模块', exact: true });
  const brand = modules.getByRole('radio', { name: '品牌宣传', exact: true });
  const delivery = modules.getByRole('radio', { name: '产品交付', exact: true });
  const goal = toolbar.locator('#goalSelect');
  const editModule = toolbar.getByRole('button', { name: '编辑当前模块', exact: true });
  const newModule = toolbar.getByRole('button', { name: '＋ 新建模块', exact: true });
  const panel = work.locator('.workspace > .panel:first-child');
  const things = panel.locator('#things');
  const allNames = () => things.locator('.thing strong').allTextContents();
  const visibleNames = () => things.locator('.thing:visible strong').allTextContents();
  const thing = name => things.locator('.thing').filter({ has: page.getByText(name, { exact: true }) });
  const tags = name => thing(name).locator('xpath=preceding-sibling::*[1][contains(@class, "priorityTags")]');
  const due = panel.getByRole('checkbox', { name: '仅本周待评估', exact: true });
  const watched = panel.getByRole('checkbox', { name: '仅关注', exact: true });
  const events = work.locator('.workspace > #events.panel');
  const refresh = work.getByRole('button', { name: '刷新数据', exact: true });
  const notice = page.locator('#notice');

  const settle = () => page.waitForFunction(() => wbSnapshot && !wbLoading);
  const assertEvents = async (name, action) => {
    // A background snapshot may replace the list while its event structure is being read.
    // Observe the heading, settled tree, and exact row in the same DOM sample.
    const state = await page.waitForFunction(({ name, action }) => {
      const host = document.querySelector('#events');
      if (host.getAttribute('data-events-ui') !== 'react') return false;
      const rows = [...host.querySelectorAll('.eventTitle')];
      if (host.querySelector('.detailTitle h1')?.textContent !== name ||
          !host.querySelector('.progressSummary')?.textContent.includes('最末级完成') ||
          rows.length !== 1 || rows[0].textContent !== action) return false;
      return { handler: rows[0].getAttribute('onclick') };
    }, { name, action });
    try {
      const { handler } = await state.jsonValue();
      assert.equal(handler, null, 'React event titles must not have an inline onclick');
    } finally {
      await state.dispose();
    }
  };
  const assertEmpty = async label => {
    await things.getByText(label, { exact: true }).waitFor();
    await events.getByText('未选择事情', { exact: true }).waitFor();
    assert.equal(await panel.locator('#thingCount').innerText(), '0');
    assert.equal(await panel.locator('#addThing').isDisabled(), label !== '暂无事情');
  };
  const closeWithEscape = async dialog => {
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'hidden' });
  };
  const openEditor = async (trigger, title, name, parent) => {
    await trigger.click();
    const dialog = page.locator('#editor');
    await dialog.getByRole('heading', { name: title, exact: true }).waitFor();
    assert.equal(await dialog.locator('#name').inputValue(), name);
    assert.equal(await dialog.locator('#formContext').innerText(), parent);
    await closeWithEscape(dialog);
  };

  await settle();
  await assertEvents(bothName, '准备宣传材料');
  const suggestion = events.locator('.aiSuggestions');
  await suggestion.getByText('待确认 · 合成候选 <核对>', { exact: true }).waitFor();
  await suggestion.getByRole('button', { name: '确认新增事件' }).click();
  const suggestionDrawer = page.locator('#suggestionDrawer');
  await suggestionDrawer.waitFor();
  assert.equal(await suggestionDrawer.locator('#suggestionName').inputValue(), '合成候选 <核对>');
  await suggestionDrawer.getByText('本条建议未记录经核对的记忆引用。').waitFor();
  await closeWithEscape(suggestionDrawer);
  await notice.waitFor({ state: 'hidden' });
  assert.ok(await brand.isChecked());
  assert.equal(await goal.inputValue(), 'g1');
  assert.match(await crumb.innerText(), /工作空间\s*\/\s*目标与事情\s*\/\s*树立行业标杆\s*\/\s*品牌宣传$/);
  assert.deepEqual(await allNames(), [bothName, '联络合作方', '存档视觉素材', '整理参考资料']);
  assert.deepEqual(await visibleNames(), await allNames());
  assert.equal(await panel.locator('#thingCount').innerText(), '4');
  assert.equal(await things.locator('.thing.active strong').innerText(), bothName);
  const selected = thing(bothName);
  assert.equal(await selected.locator('.status.working').innerText(), '进行中');
  assert.equal(await selected.locator('p').innerText(), '合成说明 <仅用于测试>');
  assert.deepEqual(await selected.locator('.cardMeta b').allTextContents(), ['测试负责人', '2026-11-18', '2026-11-20']);
  assert.match(await tags(bothName).innerText(), /重要且紧急.*本周待评估/s);
  assert.match(await tags('存档视觉素材').innerText(), /不重要但紧急.*本周已评估/s);
  assert.equal(await tags(bothName).locator('.wbWatch').getAttribute('aria-pressed'), 'true');
  assert.equal(await tags('联络合作方').locator('.wbWatch').getAttribute('aria-pressed'), 'false');
  await assertOwnership(page);
  await verifyLayout(page, work, modules);

  await modules.getByText('产品交付', { exact: true }).click();
  assert.ok(await delivery.isChecked());
  assert.match(await crumb.innerText(), /产品交付$/);
  assert.deepEqual(await allNames(), ['交付清单']);
  await assertEvents('交付清单', '核对交付节点');
  await delivery.focus();
  const generationBeforeArrow = await page.evaluate(() => wbGeneration);
  await page.keyboard.press('ArrowLeft');
  await page.waitForFunction(() => document.activeElement?.value === 'm1');
  assert.ok(await brand.isChecked());
  assert.equal(await brand.locator('..').evaluate(label => getComputedStyle(label).outlineStyle), 'solid');
  assert.match(await crumb.innerText(), /品牌宣传$/);
  // Wait for the selection-triggered refresh as well as the synchronous keyboard update.
  await page.waitForFunction(previous => !wbLoading && wbGeneration > previous, generationBeforeArrow);
  await assertEvents(bothName, '准备宣传材料');
  assert.ok(await brand.evaluate(input => input === document.activeElement));

  await thing('联络合作方').press('Enter');
  await assertEvents('联络合作方', '确认合作窗口');
  assert.equal(await things.locator('.thing.active strong').innerText(), '联络合作方');
  await tags('联络合作方').getByRole('button', { name: '重要不紧急', exact: true }).click();
  const priority = page.locator('#priorityDrawer');
  await priority.waitFor();
  assert.equal(await priority.locator('#priorityName').innerText(), '联络合作方');
  assert.equal(await priority.locator('#priorityValue').inputValue(), '2');
  await closeWithEscape(priority);

  // Fixture has all four combinations (due/attention), so checking one filter cannot pass for both.
  await due.check();
  assert.deepEqual(await visibleNames(), [bothName, '联络合作方']);
  await watched.check();
  assert.deepEqual(await visibleNames(), [bothName]);
  assert.equal(await things.locator('.priorityTags:visible').count(), 1);
  assert.equal(await panel.locator('#thingCount').innerText(), '4', 'Count still includes things hidden by filters');
  await selected.click();
  await assertEvents(bothName, '准备宣传材料');
  await due.uncheck();
  assert.deepEqual(await visibleNames(), [bothName, '存档视觉素材']);
  await watched.uncheck();
  assert.deepEqual(await visibleNames(), await allNames());
  await assertOwnership(page);

  fixture.failStructure = 'e1';
  await refresh.click();
  await events.getByText('事件层级加载失败：模拟事件结构读取失败', { exact: true }).waitFor();
  assert.equal(await events.locator('.detailTitle h1').innerText(), bothName);
  await assertOwnership(page); // React retains the last verified rows for the same matter.
  fixture.failStructure = null;
  await refresh.click();
  await assertEvents(bothName, '准备宣传材料');

  await openEditor(toolbar.getByRole('button', { name: '编辑当前目标', exact: true }), '编辑目标', '树立行业标杆', '');
  await openEditor(editModule, '编辑模块', '品牌宣传', '所属目标：树立行业标杆');
  await openEditor(panel.locator('#addThing'), '新建事情', '', '所属模块：品牌宣传');
  await goal.selectOption('g2');
  assert.equal(await modules.getByRole('radio').count(), 1);
  assert.ok(await modules.getByRole('radio', { name: '服务保障', exact: true }).isChecked());
  assert.match(await crumb.innerText(), /其他目标\s*\/\s*服务保障$/);
  await assertEmpty('暂无事情');
  await openEditor(things.getByRole('button', { name: '新建事情', exact: true }), '新建事情', '', '所属模块：服务保障');
  await goal.selectOption('g3');
  assert.equal(await modules.innerText(), '暂无模块');
  assert.ok(await editModule.isDisabled());
  assert.ok(await newModule.isEnabled());
  await assertEmpty('暂无模块');
  await openEditor(newModule, '新建模块', '', '所属目标：待规划目标');

  fixture.failItems = true;
  await refresh.click();
  await notice.getByText('模拟读取失败', { exact: true }).waitFor();
  assert.equal(await modules.innerText(), '暂无模块');
  assert.equal(await goal.inputValue(), 'g3');
  fixture.failItems = false;
  fixture.items = [];
  await refresh.click();
  await modules.getByText('请先选择目标', { exact: true }).waitFor();
  assert.ok(await newModule.isDisabled());
  assert.equal(await goal.inputValue(), '');
  assert.equal(await crumb.innerText(), '工作空间 / 目标与事情');
  await assertEmpty('暂无目标');
  await openEditor(things.getByRole('button', { name: '新建目标', exact: true }), '新建目标', '', '');
}

async function verify() {
  await fs.access(path.join(frontend, bundle.slice(1)));
  await fs.mkdir(output, { recursive: true });
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: 'block', reducedMotion: 'reduce' });
    try {
      const page = await context.newPage();
      page.setDefaultTimeout(8000);
      const { fixture, problems } = await intercept(context, page);
      try {
        await exercise(page, fixture);
        assert.deepEqual(problems, []);
      } catch (error) {
        if (problems.length) error.message += `\nFixture problems: ${problems.join('; ')}`;
        throw error;
      }
    } finally {
      await context.close();
    }
    console.log(`React workspace selection passed at ${widths.join(', ')}px (navigation, keyboard focus, matters, combined filters, events, and error/empty states).`);
  } finally {
    await browser.close();
  }
}

verify().catch(error => { console.error(error); process.exitCode = 1; });
