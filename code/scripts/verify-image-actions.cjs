// Isolated Chrome check for clipboard attachments and explicit candidate confirmation.
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '../frontend-react/public');
const react = true;
const bundle = '/dist/workbench-react.js';
const output = path.resolve(__dirname, '../../runtime', `image-actions-ui${react ? '-react' : ''}`);
const base = 'http://127.0.0.1:18920';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZ1sAAAAASUVORK5CYII=', 'base64');
const item = (id, type, parent) => ({
  id, type, parent, name: type, status: 'notStarted', description: '',
  owner: '', planStart: '', planEnd: '', version: 1,
});

async function main() {
  fs.accessSync(path.join(root, bundle.slice(1)), fs.constants.R_OK);
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  fs.mkdirSync(output, { recursive: true });
  try {
    const page = await browser.newPage({ serviceWorkers: 'block' });
    const errors = [];
    await page.context().routeWebSocket('**/*', socket => { errors.push(`Unexpected WebSocket: ${socket.url()}`); socket.close(); });
    const writes = [];
    const attachments = new Map();
    const items = [item('g', 'goal', null), item('m', 'module', 'g'), item('t', 'thing', 'm'), item('e', 'event', 't')];
    const day = '2026-11-19';
    const priorities = { week: '2026-11-16', items: [] };
    const records = [];
    let created;
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', async route => {
      const request = route.request();
      const { origin, pathname } = new URL(request.url());
      if (origin !== base) { errors.push(`Unexpected origin: ${request.url()}`); return route.abort(); }
      const method = request.method();
      if (pathname === '/image.png') return route.fulfill({ body: png, contentType: 'image/png' });
      if (!pathname.startsWith('/api/')) {
        const name = react && pathname === bundle ? bundle.slice(1) : path.basename(pathname === '/' ? 'index.html' : pathname);
        const file = path.join(root, name);
        if (!fs.existsSync(file)) return route.fulfill({ status: 404 });
        const contentType = name.endsWith('.js') ? 'text/javascript' : name.endsWith('.css') ? 'text/css' : 'text/html';
        return route.fulfill({ path: file, contentType });
      }
      if (method !== 'GET') writes.push(pathname);
      const picturePath = pathname.match(/^\/api\/(?:items|events)\/([^/]+)\/images$/);
      if (picturePath) {
        const id = picturePath[1];
        const list = attachments.get(id) || [];
        attachments.set(id, list);
        if (method === 'GET') return route.fulfill({ json: { event: items.find(value => value.id === id), images: list } });
        const raw = request.postDataBuffer().toString();
        const operationId = raw.match(/name="operation_id"\r\n\r\n([^\r]+)/)[1];
        const picture = {
          id: operationId, name: '截图.png', mime: 'image/png', size: png.length,
          state: 'ready', revision: 2, created_at: `${day}T08:00:00Z`, url: `${base}/image.png`,
        };
        list.push(picture);
        return route.fulfill({ json: picture });
      }
      if (pathname === '/api/items/t/image-actions') {
        const { image_ids } = request.postDataJSON();
        assert.equal(image_ids[0], attachments.get('t')[0].id);
        return route.fulfill({ json: {
          id: 'batch', image_ids, summary: '图片列出待核对问题', duplicates: [],
          candidates: [{ name: '核对问题', description: '', owner: '', planEnd: '', image_id: image_ids[0], evidence: '验收问题表' }],
        } });
      }
      if (pathname.endsWith('/batch/confirm')) {
        assert.equal(request.postDataJSON().candidates[0].name, '复核验收清单');
        items.push({ ...item('candidate', 'event', 't'), name: '复核验收清单' });
        created = { created: [{ id: 'candidate', name: '复核验收清单' }] };
        return route.abort();
      }
      if (pathname.endsWith('/batch/result')) return route.fulfill({ json: created });
      if (pathname === '/api/items/e/daily-follow-ups') {
        if (method === 'POST') {
          const body = request.postDataJSON();
          assert.equal(body.image_ids[0], attachments.get('e')[0].id);
          const saved = { id: body.operation_id, item_id: 'e', day, created_at: `${day}T16:00:00+08:00`, content: body.content, old_end: '', new_end: '', image_ids: body.image_ids };
          records.push(saved);
          return route.fulfill({ json: saved });
        }
        return route.fulfill({ json: { item: items[3], day, revision: records.length, records } });
      }
      if (pathname === '/api/items' && method === 'POST') {
        const body = request.postDataJSON();
        assert.ok(['event', 'thing'].includes(body.type));
        const saved = { ...item(`new-${body.type}`, body.type, body.parent), name: body.name };
        items.push(saved);
        return route.fulfill({ json: saved });
      }
      const snapshot = { items, day, today: day, priorities, attention: [], branches: [], links: [], daily_reviews: [] };
      const fixtures = {
        '/api/session': {}, '/api/items': items, '/api/workbench': snapshot,
        '/api/priorities': priorities, '/api/events/e/structure': { events: [items[3]], branches: [], links: [] },
        '/api/plan-history-counts': {},
      };
      return route.fulfill({ json: fixtures[pathname] || [] });
    });

    async function paste(selector) {
      await page.locator(selector).evaluate((element, bytes) => {
        const clipboardData = new DataTransfer();
        clipboardData.items.add(new File([Uint8Array.from(bytes)], '截图.png', { type: 'image/png' }));
        element.dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }));
      }, [...png]);
    }

    await page.goto(`${base}/`);
    if (react) await page.locator('#imageDrawer[data-react-owned]').waitFor({ state: 'attached' });
    await page.getByRole('button', { name: '目标与事情', exact: true }).click();
    await page.getByRole('button', { name: '事情图片', exact: true }).click();
    await page.waitForFunction(() => !document.querySelector('#imagePaste').disabled);
    await paste('#imagePaste');
    assert.equal(writes.length, 0);
    await page.locator('#imageAnalyze').click();
    await page.getByRole('textbox', { name: '事件名称' }).fill('复核验收清单');
    await page.screenshot({ path: path.join(output, 'candidate.png') });
    assert.equal(writes.filter(write => write.endsWith('/confirm')).length, 0);
    await page.locator('#imageConfirm').click();
    await page.locator('#imageConfirmCheck').click();
    await page.getByText('已确认创建 1 个事件', { exact: true }).waitFor();
    assert.equal(writes.filter(write => write.endsWith('/confirm')).length, 1);
    for (const width of [1440, 1024, 768, 646, 375]) {
      await page.setViewportSize({ width, height: 870 });
      const overflow = await page.locator('#imageDrawer').evaluate(dialog => dialog.scrollWidth > dialog.clientWidth + 1);
      assert.equal(overflow, false, `Picture drawer at ${width}px`);
      await page.screenshot({ path: path.join(output, `drawer-${width}.png`) });
    }
    await page.locator('#imageClose').click();
    await page.getByRole('button', { name: 'event', exact: true }).click();
    await page.locator('#eventDrawer').getByRole('button', { name: '事件图片', exact: true }).click();
    await page.getByRole('heading', { name: '事件图片', exact: true }).waitFor();
    await page.locator('#imageClose').click();
    await page.keyboard.press('Escape');

    await page.getByRole('button', { name: '工作台', exact: true }).click();
    await page.getByRole('button', { name: '当日跟进：event', exact: true }).click();
    await page.locator('#dailyContent').fill('已复核现场');
    await paste('#dailyFollowDialog .inlineImagePaste');
    await page.screenshot({ path: path.join(output, 'follow-up-375.png') });
    await page.locator('#dailySave').click();
    await page.getByRole('button', { name: '图片 1 张' }).waitFor();
    await page.locator('#dailyClose').click();

    await page.getByRole('button', { name: '目标与事情', exact: true }).click();
    await page.getByRole('button', { name: /新建事件/ }).click();
    await page.locator('#name').fill('带图事件');
    await paste('#editor .inlineImagePaste');
    assert.equal(attachments.has('new-event'), false);
    await page.locator('#save').click();
    await page.getByText('图片已上传并读回。', { exact: true }).waitFor();
    assert.equal(attachments.get('new-event').length, 1);
    await page.locator('#imageClose').click();
    await page.getByRole('button', { name: /新建事情/ }).click();
    await page.locator('#name').fill('带图事情');
    await paste('#editor .inlineImagePaste');
    await page.screenshot({ path: path.join(output, 'editor-375.png') });
    assert.equal(attachments.has('new-thing'), false);
    await page.locator('#save').click();
    await page.getByText('图片已上传并读回。', { exact: true }).waitFor();
    assert.equal(attachments.get('new-thing').length, 1);
    assert.deepEqual(errors, []);
    console.log('Image actions browser check passed: scoped paste, confirm receipt, event detail, follow-up, new event, five widths.');
  } finally {
    await browser.close();
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
