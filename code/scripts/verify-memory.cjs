// TEST-016: isolated Chrome; every HTTP request is fulfilled locally.
const {chromium} = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const output = path.resolve(__dirname, '../../runtime/memory-ui');
fs.mkdirSync(output, {recursive:true});
(async () => {
  const browser = await chromium.launch({channel:'chrome',headless:true});
  try {
    const page = await browser.newPage();
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    const items = [['g','goal',null,'年度目标'],['m','module','g','客户实施模块'],['t','thing','m','上线准备']].map(([id,type,parent,name])=>({id,type,parent,name,description:'',owner:'',planStart:'',planEnd:'',status:'notStarted',version:1}));
    let card = {module_id:'m',path:'年度目标 / 客户实施模块',scope_version:'a'.repeat(64),version:0,description:'',aliases:[],enabled:true,usable:false,status:'未配置'};
    let failRead = false, failWrite = false, unknownWrite = false, writes = 0, receipt;
    await page.route('**/*',async route => {
      const url = new URL(route.request().url());
      if(url.pathname.startsWith('/api/')) {
        const endpoint = url.pathname.slice(4);
        if(endpoint.startsWith('/memory/operations/')) return route.fulfill({json:receipt});
        if(endpoint === '/memory/modules/m') {
          if(route.request().method() === 'PUT') {
            writes++;
            if(failWrite) return route.fulfill({status:409,json:{detail:'模块已变化，请刷新后核对'}});
            const data=route.request().postDataJSON();
            card={...card,...data,version:card.version+1,usable:data.enabled,status:data.enabled?'已确认':'已停用'};
            receipt={...card};
            if(unknownWrite) return route.fulfill({status:503,json:{detail:'保存结果待核对'}});
            return route.fulfill({json:card});
          }
          if(failRead) return route.fulfill({status:503,json:{detail:'存储暂不可用'}});
          return route.fulfill({json:{card,index_state:'not_indexed',embedding_configured:false,enabled:true}});
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
    await page.goto('http://127.0.0.1:18881/');
    await page.waitForFunction(()=>db.items.length===3);
    await page.evaluate(()=>{ openForm('module','m'); });
    await page.locator('#moduleMemoryEntry').click();
    const drawer=page.locator('#memoryDrawer');
    await page.waitForFunction(()=>document.querySelector('#memoryDescription').disabled===false);
    assert.equal(await page.locator('dialog[open]').count(),1);
    assert.equal(await page.locator('#memoryIndex').isDisabled(),true);
    await page.locator('#memoryDescription').fill('负责客户项目实施、联调和验收。');
    await page.locator('#memoryAliases').fill('华东一期');
    await page.locator('#memorySave').click();
    await page.waitForFunction(()=>document.querySelector('#memoryState').textContent==='已确认');
    assert.equal(writes,1);
    for(const width of [1440,1024,768,375]) {
      await page.setViewportSize({width,height:960});
      await page.evaluate(()=>Promise.all(document.getAnimations().map(a=>a.finished.catch(()=>{}))));
      const bounds=await drawer.boundingBox();
      assert.ok(bounds.x>=0 && bounds.x+bounds.width<=width+1);
      assert.ok(await drawer.evaluate(e=>e.scrollWidth<=e.clientWidth));
      await page.screenshot({path:path.join(output,`memory-${width}.png`),fullPage:true});
    }
    failWrite=true;
    await page.locator('#memoryDescription').fill('保留我的修改');
    await page.locator('#memorySave').click();
    await page.waitForFunction(()=>document.querySelector('#memoryError').textContent.includes('模块已变化'));
    assert.equal(await page.locator('#memoryDescription').inputValue(),'保留我的修改');
    failWrite=false; unknownWrite=true;
    await page.locator('#memorySave').click();
    await page.waitForFunction(()=>document.querySelector('#memoryError').textContent.includes('待核对'));
    assert.equal(await page.locator('#memorySave').isDisabled(),true);
    const before=writes;
    await page.locator('#memoryRecover').click();
    await page.waitForFunction(()=>document.querySelector('#memoryRecover').hidden);
    assert.equal(writes,before);
    unknownWrite=false;
    await page.locator('#memoryDisable').click();
    await page.waitForFunction(()=>document.querySelector('#memoryState').textContent==='已停用');
    await page.keyboard.press('Escape');
    assert.equal(await drawer.isVisible(),false);
    await page.evaluate(()=>openForm('module','m'));
    failRead=true;
    await page.locator('#moduleMemoryEntry').click();
    await page.waitForFunction(()=>document.querySelector('#memoryError').textContent.includes('存储暂不可用'));
    assert.equal(await page.locator('#memorySave').isDisabled(),true);
    assert.deepEqual(errors,[]);
    fs.writeFileSync(path.join(output,'report.json'),JSON.stringify({passed:true,widths:[1440,1024,768,375],checks:['entry','one modal','save','disable','conflict preserves input','unknown write readback without resend','configuration boundary','read failure','keyboard Escape','responsive'],realWrites:0,errors},null,2));
    console.log('Memory browser checks passed');
  } finally { await browser.close(); }
})().catch(e=>{console.error(e);process.exitCode=1});
