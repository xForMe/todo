// TEST-026: Chrome tests for the DSH inbox; all traffic is isolated.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require('playwright');
const origin = 'http://127.0.0.1:18883';
const root = path.resolve(__dirname, '../public');
const out = path.resolve(__dirname, '../../../runtime/dsh-capture-ui');
const id = '00000000-0000-4000-8000-000000000021';
const make = (id, type, parent, name) => ({ id,type,parent,name,version:1,status:'notStarted',description:'',owner:'',planStart:'',planEnd:'' });
const tree = [make('g','goal',null,'交付改进'),make('m','module','g','客户交付'),make('t','thing','m','接口验收')];
const priorities = { week:'2026-11-16', items:[] };
const title = '整理接口验收清单 ' + '长标题'.repeat(10);
const draft = { operation_id:id,revision:1,source:'dsh_capture',candidate:{ title,owner:null,planned_date:null,
  evidence:'整理清单 <b>保留原文</b>。', reason:'示例材料未提供唯一归属。',path:{kind:'unresolved'} } };

async function test(browser, width) {
  const context = await browser.newContext({ viewport:{width,height:810}, serviceWorkers:'block', reducedMotion:'reduce' });
  try {
    const page = await context.newPage();
    const events = []; let writes = 0, reads = 0, saved, lose = width === 375, unavailable = true;
    page.on('pageerror', error => events.push(error.message));
    await context.routeWebSocket('**/*', socket => { events.push(socket.url()); return socket.close(); });
    const items = [...tree];
    await context.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url()), endpoint = url.pathname;
      const json = (data,status=200) => route.fulfill({json:data,status});
      const fail = () => { events.push(`${request.method()} ${url.href}`); return route.abort(); };
      if (url.origin !== origin) return fail();
      if (endpoint === `/api/dsh-captures/${id}/confirm` && request.method() === 'POST') {
        const data = request.postDataJSON(); writes++;
        const {operation_id,...fields} = data;
        assert.match(operation_id,/^[0-9a-f-]{36}$/);
        assert.deepEqual(fields,{expected_revision:1,title,owner:'',planned_date:'', placement:width === 768 ?
          {goal_id:'g',module_id:'',thing_id:'',new_module_name:'采购',new_thing_name:'对接',versions:{g:1}} :
          {goal_id:'g',module_id:'m',thing_id:'t',new_module_name:'',new_thing_name:'',versions:{g:1,m:1,t:1}}});
        const event = make('e','event','t',title);
        if (writes !== 1) return fail();
        items.push(event); saved = { operation_id,event };
        if (lose) return route.abort('connectionreset');
        return json({event});
      }
      if (request.method() !== 'GET') return fail();
      if (endpoint === '/api/dsh-captures') {
        assert.equal(url.search,'?offset=0&limit=10');
        if (unavailable) { unavailable=false; return json({detail:'暂不可用'},503); }
        return json({drafts:saved ? [] : [draft],total:saved ? 0 : 1});
      }
      if (endpoint === `/api/dsh-captures/${id}`) return json(draft);
      if (saved && endpoint === `/api/dsh-captures/${id}/operations/${saved.operation_id}`) {
        reads++; return json({event:saved.event});
      }
      if (endpoint === '/api/events/e/structure') return json({events:items.filter(row=>row.type==='event'),branches:[],links:[],dependencies:[],snapshot:'0'.repeat(64)});
      const data = {'/api/session':{},'/api/items':items,'/api/workbench':{items,priorities,today:'2026-11-20',branches:[],links:[],attention:[],dependencies:[]},'/api/priorities':priorities,'/api/sources':[],'/api/sources/suggestions':[],'/api/sources/unmatched':[],'/api/sources/follow':[],'/api/plan-history-counts':{},'/api/decomposition/types':[]};
      if (Object.hasOwn(data,endpoint)) return json(data[endpoint]);
      if (endpoint === '/favicon.ico') return route.fulfill({status:204});
      if (endpoint !== '/' && endpoint !== '/dist/workbench-react.js' && !/^\/[-\w]+\.(?:js|css)$/.test(endpoint)) return fail();
      const file = endpoint === '/' ? 'index.html' : endpoint.slice(1);
      const mime = {'.js':'text/javascript','.css':'text/css','.html':'text/html'};
      return route.fulfill({body:await fs.readFile(path.join(root,file)),contentType:mime[path.extname(file)]});
    });
    const drawer = page.locator('#eventRecognitionDrawer');
    async function enter() {
      await page.locator('#eventRecognitionTrigger').click();
      const tab = drawer.getByRole('button',{name:'DSH 草稿',exact:true});
      if (await tab.getAttribute('aria-pressed') !== 'true') await tab.click();
    }
    const button = name => drawer.getByRole('button',{name,exact:true});
    const fits = () => drawer.evaluate(node => node.scrollWidth <= node.clientWidth && document.documentElement.scrollWidth <= innerWidth);
    await page.goto(origin);
    await enter();
    await drawer.getByText('DSH 草稿暂不可用，请刷新重试。').waitFor();
    await button('刷新结果').click();
    await button('核对草稿').click();
    const heading = drawer.getByRole('heading',{name:'核对 DSH 草稿'});
    await heading.waitFor();
    assert.equal(await heading.evaluate(node => node === document.activeElement),true);
    assert.equal(await button('核对并准备确认').isDisabled(),true);
    assert.equal(await fits(),true);
    await drawer.getByText('原文依据',{exact:true}).click();
    await drawer.getByText('整理清单 <b>保留原文</b>。',{exact:true}).waitFor();
    await drawer.getByLabel('目标',{exact:true}).selectOption('g');
    if (width === 768) {
      await drawer.getByLabel('模块',{exact:true}).selectOption('new');
      await drawer.getByLabel('新模块名称').fill('采购');
      await drawer.getByLabel('新事情名称').fill('对接');
    } else {
      await drawer.getByLabel('模块',{exact:true}).selectOption('m');
      await drawer.getByLabel('事情',{exact:true}).selectOption('t');
    }
    await button('核对并准备确认').click();
    await drawer.getByRole('heading',{name:'确认创建事件'}).waitFor();
    assert.equal(writes,0);
    assert.equal(await fits(),true);
    if (process.env.TODO_DSH_UI_SCREENSHOTS === '1') await page.screenshot({path:path.join(out,`dsh-confirm-${width}.png`)});
    await button('确认创建').click();
    if (lose) {
      await button('核对原操作').waitFor();
      assert.equal(reads,0);
      await page.reload(); await enter();
      await button('核对原操作').click();
    }
    await drawer.getByText(`已创建并核对：${title}`, {exact:true}).waitFor();
    await drawer.getByText('暂无待确认的 DSH 草稿',{exact:true}).waitFor();
    assert.equal(writes,1); assert.equal(reads,1);
    await page.keyboard.press('Escape');
    await drawer.waitFor({state:'hidden'});
    assert.equal(await page.locator('#eventRecognitionTrigger').evaluate(node=>node===document.activeElement),true);
    assert.deepEqual(events,[]);
  } finally { await context.close(); }
}

(async () => {
  if (process.env.TODO_DSH_UI_SCREENSHOTS === '1') await fs.mkdir(out,{recursive:true});
  const browser = await chromium.launch({channel:'chrome',headless:true});
  try { for (const width of [1440,1024,768,375]) await test(browser,width); }
  finally { await browser.close(); }
  console.log('DSH inbox Chrome 1440/1024/768/375; explicit confirmation, new hierarchy, reload recovery, focus, no real writes.');
})().catch(error => { console.error(error); process.exitCode=1; });
