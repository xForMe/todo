// TEST-026 / SRC-DSH-DIRECT-001: DSH drafts are no longer exposed in the drawer.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require('playwright');
const origin = 'http://127.0.0.1:18883';
const root = path.resolve(__dirname, '../public');
const out = path.resolve(__dirname, '../../../runtime/dsh-capture-ui');
const make = (id, type, parent, name) => ({ id,type,parent,name,version:1,status:'notStarted',description:'',owner:'',planStart:'',planEnd:'' });
const items = [make('g','goal',null,'交付改进'),make('m','module','g','客户交付'),make('t','thing','m','接口验收')];
const priorities = { week:'2026-11-16', items:[] };
const byTab = [
  ['待确认 1','飞书待核对建议'],
  ['已关联进展 1','飞书已关联进展'],
  ['未找到建议 1','飞书未匹配消息'],
];
const longMessage = '长原文'.repeat(40);

async function test(browser, width) {
  const context = await browser.newContext({ viewport:{width,height:810}, serviceWorkers:'block', reducedMotion:'reduce' });
  try {
    const page = await context.newPage();
    page.setDefaultTimeout(8000);
    const unexpected = [], captureRequests = [];
    let unmatchedContent = byTab[2][1] + longMessage;
    page.on('pageerror', error => unexpected.push(error.message));
    // Even a previous session's unresolved capture must not re-open a draft or query its receipt.
    await page.addInitScript(() => {
      sessionStorage.setItem('todo.dsh-capture.confirm.v1', JSON.stringify({
        capture:'00000000-0000-4000-8000-000000000021', operation:'00000000-0000-4000-8000-000000000022',
      }));
    });
    await context.routeWebSocket('**/*', socket => { unexpected.push(socket.url()); return socket.close(); });
    await context.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url()), endpoint = url.pathname;
      const json = data => route.fulfill({json:data});
      const fail = () => { unexpected.push(`${request.method()} ${url.href}`); return route.abort(); };
      if (/^\/(?:api\/dsh-captures|mcp)(?:\/|$)/.test(endpoint)) {
        captureRequests.push(`${request.method()} ${url.href}`);
        return route.abort();
      }
      if (url.origin !== origin || request.method() !== 'GET') return fail();
      const suggestions = ['pending','linked'].map((state,i) => ({
        id:state, source_id:'chat', source_kind:'chat', thing_id:'t', state, action:'new',
        body:JSON.stringify({name:byTab[i][1],evidence:'飞书原文'}),
      }));
      const data = {'/api/session':{},'/api/items':items,'/api/workbench':{items,priorities,today:'2026-11-20',branches:[],links:[],attention:[],dependencies:[]},
        '/api/priorities':priorities,'/api/sources':[],'/api/sources/suggestions':suggestions,'/api/sources/follow':[],
        '/api/sources/unmatched':[{source_id:'chat',message_id:'message',version:1,content:unmatchedContent,processed:true,can_retry:true}],
        '/api/plan-history-counts':{},'/api/decomposition/types':[]};
      if (Object.hasOwn(data,endpoint)) return json(data[endpoint]);
      if (endpoint === '/favicon.ico') return route.fulfill({status:204});
      if (endpoint !== '/' && endpoint !== '/dist/workbench-react.js' && !/^\/[-\w]+\.(?:js|css)$/.test(endpoint)) return fail();
      const file = endpoint === '/' ? 'index.html' : endpoint.slice(1);
      const mime = {'.js':'text/javascript','.css':'text/css','.html':'text/html'};
      return route.fulfill({body:await fs.readFile(path.join(root,file)),contentType:mime[path.extname(file)]});
    });

    const entry = page.locator('#eventRecognitionTrigger');
    const drawer = page.getByRole('dialog',{name:'事件识别',exact:true});
    const tabs = drawer.locator('#chatResults .wbTabs');
    const button = name => drawer.getByRole('button',{name,exact:true});
    const close = button('关闭'), refresh = button('刷新结果');
    const focused = locator => locator.evaluate(node => node === document.activeElement);
    const fits = () => drawer.evaluate(node => node.scrollWidth <= node.clientWidth && document.documentElement.scrollWidth <= innerWidth);
    const assertTabs = async active => {
      assert.deepEqual((await tabs.getByRole('button').allTextContents()).map(text => text.trim()),byTab.map(([label]) => label));
      assert.equal(await drawer.getByText(/DSH\s*草稿/).count(),0);
      assert.equal(await drawer.locator('.dshCapturePanel, .dshCaptureForm').count(),0);
      assert.equal(await tabs.locator('button[aria-pressed="true"]').textContent(),active);
    };
    const open = async () => {
      await entry.press('Enter');
      await drawer.waitFor();
      assert.equal(await focused(close),true,'the drawer should open on its close button');
    };
    const assertClosed = async () => {
      await drawer.waitFor({state:'hidden'});
      await page.waitForFunction(() => document.getElementById('eventRecognitionTrigger')?.getAttribute('aria-expanded') === 'false');
      assert.equal(await focused(entry),true,'closing the drawer should return focus to its trigger');
    };

    await page.goto(origin);
    await page.getByRole('button',{name:'事件识别，2 待确认',exact:true}).waitFor();
    await open();
    await assertTabs(byTab[0][0]);
    for (const [label, content] of byTab) {
      await page.keyboard.press('Tab');
      assert.equal(await focused(button(label)),true,`${label} should remain in keyboard order`);
      await page.keyboard.press('Enter');
      await drawer.getByText(label === byTab[2][0] ? unmatchedContent : content,{exact:true}).waitFor();
      await assertTabs(label);
      assert.equal(await focused(button(label)),true);
      assert.ok(await fits(),`the drawer should fit at ${width}px`);
    }

    unmatchedContent = '刷新后的飞书未匹配消息' + longMessage;
    await Promise.all([
      ...['suggestions','unmatched'].map(name => page.waitForResponse(response =>
        response.url() === `${origin}/api/sources/${name}` && response.request().method() === 'GET' && response.ok())),
      refresh.press('Enter'),
    ]);
    await drawer.getByText(unmatchedContent,{exact:true}).waitFor();
    await assertTabs(byTab[2][0]);
    assert.equal(await focused(refresh),true,'refresh should not move focus');
    assert.ok(await fits(),`long text should fit at ${width}px after refresh`);
    if (process.env.TODO_DSH_UI_SCREENSHOTS === '1') await page.screenshot({path:path.join(out,`recognition-${width}.png`)});
    await page.keyboard.press('Escape');
    await assertClosed();
    await open();
    await assertTabs(byTab[2][0]);
    await close.press('Enter');
    await assertClosed();
    assert.deepEqual(captureRequests,[],'the browser must not call historical capture routes or MCP');
    assert.deepEqual(unexpected,[]);
  } finally { await context.close(); }
}

(async () => {
  if (process.env.TODO_DSH_UI_SCREENSHOTS === '1') await fs.mkdir(out,{recursive:true});
  const browser = await chromium.launch({channel:'chrome',headless:true});
  try { for (const width of [1440,1024,768,375]) await test(browser,width); }
  finally { await browser.close(); }
  console.log('Recognition drawer Chrome 1440/1024/768/375: only Feishu tabs, refresh and keyboard focus preserved, no capture requests.');
})().catch(error => { console.error(error); process.exitCode=1; });
