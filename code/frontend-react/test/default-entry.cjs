// TEST-025: React-only startup, old URL aliases, and non-interactive startup errors.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require('playwright');

const origin = 'http://127.0.0.1:18883';
const staticDir = path.resolve(__dirname, '../public');
const bundle = '/dist/workbench-react.js';
const item = (id, type, parent, name) => ({ id, type, parent, name, version: 1, status: 'notStarted' });
const items = [item('g', 'goal', null, '合成目标'), item('m', 'module', 'g', '合成模块'), item('t', 'thing', 'm', '合成事情')];
const priorities = { week: '2026-11-16', items: [] };
const snapshot = { today: '2026-11-19', items, priorities, branches: [], links: [], attention: [] };
const data = { '/api/session': {}, '/api/workbench': snapshot, '/api/items': items, '/api/priorities': priorities,
  '/api/plan-history-counts': {}, '/api/sources': [], '/api/sources/suggestions': [], '/api/sources/unmatched': [], '/api/sources/follow': [] };

async function exercise(browser, variant) {
  const { query, response, react } = variant;
  const context = await browser.newContext({ serviceWorkers: 'block', reducedMotion: 'reduce' });
  try {
    const page = await context.newPage();
    page.setDefaultTimeout(8000);
    const errors = [], unexpected = [], bundles = [];
    page.on('pageerror', error => errors.push(error.message));
    await context.routeWebSocket('**/*', socket => { unexpected.push(socket.url()); return socket.close(); });
    await context.route('**/*', async route => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.origin !== origin || request.method() !== 'GET' ||
          (url.pathname.startsWith('/api/') && !Object.hasOwn(data, url.pathname))) {
        unexpected.push(`${request.method()} ${url.href}`);
        return route.abort();
      }
      if (url.pathname.startsWith('/api/')) return route.fulfill({ json: data[url.pathname] });
      if (url.pathname === bundle) {
        bundles.push(url.href);
        if (response === 'missing') return route.fulfill({ status: 404, body: '' });
        if (response === 'stale' || response === 'incomplete') return route.fulfill({ contentType: 'text/javascript', body:
          `globalThis.TodoReactWorkbench={frontendContract:${response === 'stale' ? 0 : 1},mount(){throw new Error("invalid mount called")}}` });
        if (response === 'init-error') {
          const js = await fs.readFile(path.join(staticDir, bundle.slice(1)), 'utf8');
          return route.fulfill({ contentType: 'text/javascript', body: `${js}\n` +
            'globalThis.TodoReactWorkbench={...globalThis.TodoReactWorkbench,mountNotice(){throw new Error("fixture mount failure")}};' });
        }
      }
      const relative = url.pathname === bundle ? bundle.slice(1) : url.pathname === '/' ? 'index.html' : path.basename(url.pathname);
      const mime = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html' };
      return route.fulfill({ body: await fs.readFile(path.join(staticDir, relative)), contentType: mime[path.extname(relative)] });
    });
    await page.goto(`${origin}/${query}`);
    const startup = page.locator('#frontendStartup');
    if (react) {
      await page.locator('#globalWorkbench[data-goal-ui="react"]').waitFor({ state: 'visible' });
      assert.equal(await startup.isVisible(), false);
      assert.equal(await page.locator('body[data-ui-startup]').count(), 0);
      assert.ok(await page.locator('#notice').evaluate(host => Object.keys(host).some(key => key.startsWith('__reactContainer$'))),
        'React takes ownership of the existing status host');
      await page.getByRole('button', { name: '目标与事情', exact: true }).click();
      await page.locator('#things .thing').filter({ hasText: '合成事情' }).waitFor();
      await page.locator('#addThing').click();
      await page.locator('#editor[open] #name').fill('仅在浏览器中的草稿');
      await page.keyboard.press('Escape');
      await page.locator('#editor').waitFor({ state: 'hidden' });
    } else {
      await startup.getByText('界面未能加载。请先构建前端，再刷新页面。', { exact: true }).waitFor();
      assert.equal(await page.locator('[data-react-owned]').count(), 0, 'No React host was taken over');
      assert.equal(await page.locator('main').isVisible(), false);
      assert.equal(await page.getByRole('button', { name: '目标与事情', exact: true }).count(), 0, 'No native UI fallback is exposed');
      for (const selector of ['.topbar', '.workspaceBar']) {
        assert.equal(await page.locator(selector).evaluate(host => host.childNodes.length), 0,
          `${selector} remains an empty host when startup fails`);
      }
      const main = await page.locator('main').evaluate(host => ({
        workbench: host.querySelector('#globalWorkbench').childElementCount,
        toolbar: host.querySelector('.toolbar').childElementCount,
        things: host.querySelector('.workspace > .panel:first-child').childElementCount,
        events: host.querySelector('#events').childElementCount,
      }));
      assert.deepEqual(main, { workbench: 0, toolbar: 0, things: 0, events: 0 },
        'Unavailable bundle leaves only empty workbench and work-page hosts');
    }
    assert.deepEqual(bundles, [`${origin}${bundle}`]);
    assert.deepEqual(unexpected, []);
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
}

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    for (const variant of [
      { query: '', react: true },
      { query: '?ui=react', react: true },
      { query: '?ui=legacy', react: true },
      { query: '', response: 'missing', react: false },
      { query: '', response: 'stale', react: false },
      { query: '', response: 'incomplete', react: false },
      { query: '', response: 'init-error', react: false },
    ]) await exercise(browser, variant);
    console.log('React-only entry, old URL aliases, and missing or incompatible bundle errors passed; no business writes.');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
