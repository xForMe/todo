// TEST-011 / SRC-UI-016 and SRC-UI-017. Run the real frontend with intercepted requests.
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const output = path.resolve(__dirname, '../../runtime/module-choices-ui');
const frontend = path.resolve(__dirname, '../frontend-react/public');
const origin = 'http://127.0.0.1:18886';
const bundle = '/dist/workbench-react.js';
const item = (id, type, parent, name) => ({ id, type, parent, name, status: 'notStarted', version: 1 });
const longName = '跨部门协调与长周期交付计划'.repeat(7);
const items = [
  item('g1', 'goal', null, '树立行业标杆'),
  item('g2', 'goal', null, '其他目标'),
  item('g3', 'goal', null, '待规划目标'),
  item('m1', 'module', 'g1', '品牌宣传'),
  item('m2', 'module', 'g1', '产品交付'),
  item('m3', 'module', 'g1', '团队协作'),
  item('m4', 'module', 'g1', longName),
  item('m5', 'module', 'g2', '服务保障'),
  item('t1', 'thing', 'm1', '宣传册制定'),
  item('t2', 'thing', 'm2', '交付清单'),
  item('e1', 'event', 't1', '准备宣传材料'),
  item('e2', 'event', 't2', '核对交付节点'),
];

async function verify() {
  fs.accessSync(path.join(frontend, bundle.slice(1)), fs.constants.R_OK);
  fs.mkdirSync(output, { recursive: true });
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage({ reducedMotion: 'reduce' });
    const errors = [], writes = [];
    let currentItems = items;
    let failItems = false;
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.origin !== origin) return route.abort();
      if (url.pathname.startsWith('/api/')) {
        if (route.request().method() !== 'GET') {
          writes.push(url.pathname);
          return route.abort();
        }
        if (failItems && url.pathname === '/api/items') {
          return route.fulfill({ status: 503, json: { detail: '模拟读取失败' } });
        }
        const priorities = { week: '2026-11-16', items: [] };
        const snapshot = { items: currentItems, priorities, attention: [], branches: [], links: [], today: '2026-11-19' };
        const data = { '/api/session': {}, '/api/items': currentItems, '/api/workbench': snapshot, '/api/priorities': priorities };
        const event = url.pathname.match(/^\/api\/events\/([^/]+)\/structure$/);
        if (event) {
          const parent = currentItems.find(item => item.id === event[1])?.parent;
          return route.fulfill({ json: { branches: [], links: [], events: currentItems.filter(item => item.type === 'event' && item.parent === parent) } });
        }
        return route.fulfill({ json: data[url.pathname] || [] });
      }
      const name = url.pathname === bundle ? bundle.slice(1) : path.basename(url.pathname === '/' ? 'index.html' : url.pathname);
      const file = path.join(frontend, name);
      if (!fs.existsSync(file)) return route.fulfill({ status: 404, body: '' });
      const types = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html' };
      return route.fulfill({ body: fs.readFileSync(file), contentType: types[path.extname(name)] });
    });

    await page.goto(`${origin}/`);
    await page.getByRole('button', { name: '目标与事情', exact: true }).click();
    await page.waitForFunction(() => wbSnapshot && !wbLoading);
    const work = page.locator('#workPage[data-selection-ui="react"]');
    const group = work.getByRole('group', { name: '模块', exact: true });
    const events = work.locator('#events[data-events-ui="react"]');
    const brand = group.getByRole('radio', { name: '品牌宣传' });
    const delivery = group.getByRole('radio', { name: '产品交付' });
    const goal = page.locator('#goalSelect');
    const edit = page.getByRole('button', { name: '编辑当前模块' });
    const create = page.getByRole('button', { name: '＋ 新建模块' });
    assert.ok(await brand.isChecked());
    assert.ok(await brand.evaluate(node => Object.keys(node)
      .some(key => key.startsWith('__reactFiber$') && node[key]?.stateNode === node)), 'React owns the module radio');
    assert.equal(await work.locator('.toolbar').locator('[onclick], [onchange]').count(), 0);

    const widths = [1440, 1024, 768, 601, 600, 375, 320];
    for (const width of widths) {
      await page.setViewportSize({ width, height: 900 });
      assert.equal(await group.getByRole('radio').count(), 4);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      const goalBounds = await page.locator('.toolbarGoal').boundingBox();
      const moduleBounds = await group.boundingBox();
      if (width > 600) {
        assert.ok(moduleBounds.x >= goalBounds.x + goalBounds.width, 'Modules sit to the right of the goal');
        assert.ok(Math.abs(moduleBounds.y - goalBounds.y) <= 4, 'Modules start on the same row as the goal');
      } else {
        assert.ok(moduleBounds.y >= goalBounds.y + goalBounds.height, 'Modules can wrap below the goal on mobile');
      }
      const rows = await group.locator('.moduleChoice').evaluateAll(labels => labels.map(label => {
        if (label.getBoundingClientRect().right > label.parentElement.getBoundingClientRect().right + 1) {
          throw new Error('Module choice overflows its container');
        }
        if (label.scrollWidth > label.clientWidth) throw new Error('Module name is clipped');
        if (getComputedStyle(label).borderTopWidth !== '0px') throw new Error('Module has a visible frame');
        if (getComputedStyle(label.querySelector('input')).opacity !== '0') throw new Error('Module has a visible radio control');
        return label.offsetTop;
      }));
      if (width <= 375) assert.ok(new Set(rows).size > 1, 'Module choices wrap on mobile');
      await page.locator('.toolbar').screenshot({ path: path.join(output, `toolbar-${width}.png`) });
    }

    await page.getByText('产品交付', { exact: true }).click();
    assert.ok(await delivery.isChecked());
    assert.match(await page.locator('#crumb').innerText(), /产品交付$/);
    assert.deepEqual(await page.locator('#things .thing strong').allTextContents(), ['交付清单']);
    await events.getByRole('button', { name: '核对交付节点', exact: true }).waitFor();
    await delivery.focus();
    const generation = await page.evaluate(() => wbGeneration);
    await page.keyboard.press('ArrowLeft');
    await page.waitForFunction(() => document.activeElement?.value === 'm1');
    assert.ok(await brand.isChecked());
    assert.equal(await brand.locator('..').evaluate(label => getComputedStyle(label).outlineStyle), 'solid');
    await page.waitForFunction(previous => !wbLoading && wbGeneration > previous, generation);
    await events.getByRole('button', { name: '准备宣传材料', exact: true }).waitFor();
    assert.ok(await brand.evaluate(input => input === document.activeElement));

    await edit.click();
    assert.equal(await page.locator('#name').inputValue(), '品牌宣传');
    await page.keyboard.press('Escape');
    await goal.selectOption('g2');
    assert.equal(await group.getByRole('radio').count(), 1);
    assert.ok(await group.getByRole('radio', { name: '服务保障' }).isChecked());
    await goal.selectOption('g3');
    assert.equal(await group.innerText(), '暂无模块');
    assert.ok(await edit.isDisabled());
    assert.ok(await create.isEnabled());
    await create.click();
    assert.match(await page.locator('#formContext').innerText(), /待规划目标/);
    await page.keyboard.press('Escape');

    failItems = true;
    await page.evaluate(() => connect());
    assert.equal(await page.locator('#notice').innerText(), '模拟读取失败');
    assert.equal(await group.innerText(), '暂无模块');
    failItems = false;
    currentItems = [];
    await page.evaluate(() => connect());
    assert.equal(await group.innerText(), '请先选择目标');
    assert.ok(await create.isDisabled());
    assert.deepEqual(writes, []);
    assert.deepEqual(errors, []);
    console.log(`Module choices passed at ${widths.join(', ')}px, including keyboard, edit/create entry points, empty and error states.`);
  } finally {
    await browser.close();
  }
}

verify().catch(error => { console.error(error); process.exitCode = 1; });
