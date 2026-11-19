// TEST-016 / SRC-MEMORY-003: real frontend assets, all network requests intercepted.
const {chromium} = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const output = path.resolve(__dirname, '../../runtime/working-memory-ui');
fs.mkdirSync(output, {recursive:true});
(async () => {
  const browser = await chromium.launch({channel:'chrome',headless:true});
  try {
    const page = await browser.newPage();
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    const items = [['g','goal',null,'年度目标'],['m','module','g','客户交付'],['t','thing','m','上线准备'],['other','thing','m','另外一件事情'],['e','event','t','接口联调']].map(([id,type,parent,name])=>({id,type,parent,name,description:'',owner:'',planStart:'',planEnd:'',status:'notStarted',version:1}));
    let mode = 'normal', calls = 0, delayed;
    const summary = id => ({thing_id:id,thing_version:1,path:'年度目标 / 客户交付 / '+(id==='t'?'上线准备':'另外一件事情'),status:'working',counts:{notStarted:2,working:1,completed:4,cancelled:0},actions:[{id:'e',version:1,name:'接口联调',status:'working',owner:'李工',plan_end:'2026-11-18'},{id:'e2',version:1,name:'资料核对 <img src=x onerror=alert(1)> '+ 'LongUnbrokenText'.repeat(5),status:'notStarted',owner:'',plan_end:''}],omitted:1,partial:true});
    await page.route('**/*', async route => {
      const url = new URL(route.request().url());
      if(url.pathname.startsWith('/api/')) {
        const endpoint = url.pathname.slice(4);
        if(endpoint.startsWith('/memory/working/')) {
          calls++;
          assert.equal(route.request().method(),'POST');
          if(mode==='failed') return route.fulfill({status:503,json:{detail:'摘要存储暂不可用'}});
          if(mode==='disabled') return route.fulfill({status:409,json:{detail:'模块记忆尚未启用'}});
          const id=endpoint.split('/')[3], data=summary(id);
          if(mode==='empty') {data.actions=[];data.omitted=0;data.partial=false;data.counts={notStarted:0,working:0,completed:0,cancelled:0};}
          const result={thing_id:id,state:mode==='inactive'?'inactive':mode==='capacity'?'capacity_uncached':'cached',fingerprint:'test',generated_at:1794700000,summary:mode==='inactive'?null:data};
          if(mode==='delayed') return new Promise(resolve=>{delayed=async()=>{await route.fulfill({json:result});resolve();};});
          return route.fulfill({json:result});
        }
        const priorities={week:'2026-11-09',items:[]};
        const data={'/session':{},'/items':items,'/sources/suggestions':[], '/sources':[], '/priorities':priorities,'/workbench':{items,priorities,attention:[],branches:[],links:[],today:'2026-11-15'}};
        return route.fulfill({json:data[endpoint] || []});
      }
      const filename=path.basename(url.pathname==='/'?'index.html':url.pathname);
      const file=path.resolve(__dirname,'../frontend',filename);
      if(!fs.existsSync(file)) return route.fulfill({status:404,body:''});
      return route.fulfill({body:fs.readFileSync(file),contentType:filename.endsWith('.js')?'text/javascript':filename.endsWith('.css')?'text/css':'text/html'});
    });
    await page.goto('http://127.0.0.1:18882/');
    await page.waitForFunction(()=>db.items.length===5);
    await page.evaluate(()=>openForm('thing','t'));
    await page.locator('#workingMemoryEntry').click();
    await page.waitForFunction(()=>document.querySelector('#workingMemoryBody').textContent.includes('接口联调'));
    const drawer=page.locator('#workingMemoryDrawer');
    assert.equal(await page.locator('dialog[open]').count(),1);
    assert.equal(await page.locator('#workingMemoryBody img').count(),0);
    assert.equal(calls,1);
    assert.equal(await page.locator('#workingMemoryClose').evaluate(e=>e===document.activeElement),true);
    for(const width of [1440,1024,768,375]) {
      await page.setViewportSize({width,height:960});
      await page.evaluate(()=>Promise.all(document.getAnimations().map(a=>a.finished.catch(()=>{}))));
      const bounds=await drawer.boundingBox();
      assert.ok(bounds.x>=0 && bounds.x+bounds.width<=width+1);
      assert.ok(await drawer.evaluate(e=>e.scrollWidth<=e.clientWidth));
      assert.ok(await page.locator('#workingMemoryRefresh').evaluate(e=>e.getBoundingClientRect().height>=44));
      await page.screenshot({path:path.join(output,`working-${width}.png`),fullPage:true});
    }
    mode='failed'; const prior=calls;
    await page.locator('#workingMemoryRefresh').click();
    await page.waitForFunction(()=>document.querySelector('#workingMemoryError').textContent.includes('未自动重试'));
    assert.equal(await page.locator('#workingMemoryBody').textContent(),'');
    assert.equal(calls,prior+1);
    for(const [state,message] of [['empty','没有未结束'],['inactive','事情已结束'],['capacity','容量已满'],['disabled','尚未启用']]) {
      mode=state; await page.locator('#workingMemoryRefresh').click();
      await page.waitForFunction(expected=>document.querySelector('#workingMemoryDrawer').textContent.includes(expected),message);
      await page.screenshot({path:path.join(output,`working-${state}.png`),fullPage:true});
    }
    mode='delayed';
    await page.locator('#workingMemoryRefresh').click();
    await page.waitForFunction(()=>document.querySelector('#workingMemoryRefresh').disabled);
    await page.keyboard.press('Escape');
    assert.equal(await drawer.isVisible(),false);
    mode='normal';
    await page.evaluate(()=>openForm('thing','other'));
    await page.locator('#workingMemoryEntry').click();
    await page.waitForFunction(()=>document.querySelector('#workingMemoryBody').textContent.includes('另外一件事情'));
    assert.ok(delayed);
    const lateResponse=page.waitForResponse(r=>r.url().endsWith('/working/t/refresh'));
    await delayed(); await lateResponse;
    assert.ok((await page.locator('#workingMemoryBody').textContent()).includes('另外一件事情'));
    await page.evaluate(()=>{locateWorkbench=async id=>{document.body.dataset.located=id;};});
    await page.getByRole('button',{name:'查看事件：接口联调',exact:true}).click();
    assert.equal(await drawer.isVisible(),false);
    assert.equal(await page.locator('body').getAttribute('data-located'),'e');
    assert.deepEqual(errors,[]);
    fs.writeFileSync(path.join(output,'report.json'),JSON.stringify({passed:true,widths:[1440,1024,768,375],checks:['entry','one modal','factual counts','escaped text','long text','read failure clears stale content','no automatic retry','inactive','empty','capacity','disabled','late response ignored','navigation delegation','keyboard focus and Escape'],realBusinessWrites:0,errors},null,2));
    console.log('Working memory browser checks passed');
  } finally { await browser.close(); }
})().catch(e=>{console.error(e);process.exitCode=1;});
