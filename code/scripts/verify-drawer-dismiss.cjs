// TEST-011 / SRC-UI-012. All network requests are intercepted; no business writes.
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const output = path.resolve(__dirname, '../../runtime/drawer-dismiss-ui');
fs.mkdirSync(output, { recursive: true });
(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const errors = [], writes = [], checks = [];
  try {
    const page = await browser.newPage({ reducedMotion: 'reduce' });
    page.on('pageerror', e => errors.push(e.message));
    await page.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.pathname.startsWith('/api/')) {
        if (route.request().method() !== 'GET') { writes.push(url.pathname); return route.abort(); }
        const snapshot = { items: [], priorities: { week: '2026-11-16', items: [] }, attention: [], branches: [], links: [], today: '2026-11-16' };
        return route.fulfill({ json: { '/api/session': {}, '/api/items': [], '/api/workbench': snapshot, '/api/priorities': snapshot.priorities }[url.pathname] || [] });
      }
      const name = path.basename(url.pathname === '/' ? 'index.html' : url.pathname);
      const file = path.resolve(__dirname, '../frontend', name);
      if (!fs.existsSync(file)) return route.fulfill({ status: 404, body: '' });
      return route.fulfill({ body: fs.readFileSync(file), contentType: name.endsWith('.js') ? 'text/javascript' : name.endsWith('.css') ? 'text/css' : 'text/html' });
    });
    await page.goto('http://127.0.0.1:18884/');
    await page.waitForFunction(() => typeof wbLoading !== 'undefined' && !wbLoading);
    const ids = await page.locator('dialog:not(#deleteDrawer)').evaluateAll(nodes => nodes.map(n => n.id));
    for (const width of [1440, 1024, 768, 375]) {
      await page.setViewportSize({ width, height: 960 });
      for (const id of ids) {
        const drawer = page.locator('#' + id);
        await drawer.evaluate(d => d.showModal());
        const rect = await drawer.boundingBox();
        await page.mouse.click(rect.x + 4, rect.y + 4); // Inner padding targets dialog too.
        assert.equal(await drawer.evaluate(d => d.open), true, `${id}: inner padding`);
        if (id === 'sourceDrawer') await page.screenshot({ path: path.join(output, `drawer-${width}.png`) });
        if (rect.x > 5) {
          await page.mouse.move(rect.x + 10, 100); await page.mouse.down();
          await page.mouse.move(rect.x - 5, 100); await page.mouse.up();
          assert.equal(await drawer.evaluate(d => d.open), true, `${id}: drag out`);
          await page.mouse.click(rect.x - 5, 100);
          assert.equal(await drawer.evaluate(d => d.open), false, `${id}: backdrop`);
        } else {
          await page.keyboard.press('Escape');
          assert.equal(await drawer.evaluate(d => d.open), false, `${id}: full width Escape`);
        }
        // Existing close handlers can return to a parent drawer.
        await page.evaluate(() => document.querySelectorAll('dialog[open]').forEach(d => d.close()));
      }
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      checks.push({ width, drawers: ids.length });
    }
    await page.setViewportSize({ width: 1440, height: 960 });
    await page.getByRole('button', { name: '设置', exact: true }).click();
    await page.locator('#mpSource').click();
    await page.locator('#sourceAddress').fill('示例未保存内容');
    assert.equal(await page.locator('#sourceDrawer').evaluate(d => d.open), true);
    await page.mouse.click(50, 100);
    assert.equal(await page.locator('#sourceDrawer').evaluate(d => d.open), false);
    assert.equal(await page.getByRole('button', { name: '设置', exact: true }).evaluate(d => d === document.activeElement), true);
    // A backdrop click dismisses only the top drawer, leaving the underlying one open.
    await page.evaluate(() => { document.querySelector('#sourceDrawer').showModal(); document.querySelector('#editor').showModal(); });
    await page.mouse.click(50, 100);
    assert.equal(await page.locator('#editor').evaluate(d => d.open), false);
    assert.equal(await page.locator('#sourceDrawer').evaluate(d => d.open), true);
    await page.keyboard.press('Escape');
    await page.locator('#deleteDrawer').evaluate(d => d.showModal());
    await page.mouse.click(5, 5);
    assert.equal(await page.locator('#deleteDrawer').evaluate(d => d.open), true);
    await page.keyboard.press('Escape');
    assert.deepEqual(errors, []); assert.deepEqual(writes, []);
    fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify({ checks, ids, errors, writes, result: 'passed' }, null, 2));
    console.log(JSON.stringify({ checks, drawers: ids.length, errors, writes }));
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exit(1); });
