// TEST-018: real frontend in Chrome; every HTTP request is intercepted.
const {chromium}=require('playwright');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const output=path.resolve(__dirname,'../../runtime/daily-review-ui');fs.mkdirSync(output,{recursive:true});
(async()=>{
 const browser=await chromium.launch({channel:'chrome',headless:true});
 try{
  const page=await browser.newPage(),errors=[],writes=[],receipts=new Map(),records=new Map();
  page.on('pageerror',e=>errors.push(e.message));
  const item=(id,type,parent,name,extra={})=>({id,type,parent,name,description:'',owner:'',planStart:'',planEnd:'',status:'notStarted',version:1,...extra});
  const items=[item('g','goal',null,'目标'),item('m','module','g','模块'),item('t','thing','m','事情'),...Array.from({length:12},(_,i)=>item('e'+i,'event','t',`行动 ${String(i).padStart(2,'0')} 很长的标题验证自适应布局`,{status:i<2?'working':'notStarted'}))];
  let day='2026-11-18',failure='',readFailure=false,holdRead=false,releaseRead;
  const snapshot=()=>({items,priorities:{week:'2026-11-16',items:[]},attention:[],branches:[],links:[],today:day,daily_reviews:[...records.values()].filter(r=>r.day===day)});
  await page.route('**/*',async route=>{
   const req=route.request(),url=new URL(req.url());
   if(url.pathname.startsWith('/api/')){
    if(req.method()==='POST'&&url.pathname.endsWith('/daily-review')){
     const body=req.postDataJSON(),id=url.pathname.split('/')[3];writes.push(body);
     if(failure==='reject'){failure='';return route.fulfill({status:409,json:{detail:'事件已变化'}})}
     if(failure==='lost-before'){failure='';return route.abort()}
     const prior=records.get(day+id),result={item_id:id,day,reviewed_at:body.reviewed?'2026-11-18T09:25:00+08:00':'',revision:(prior?.revision||0)+1};
     records.set(day+id,result);receipts.set(body.operation_id,result);
     if(failure==='lost-after'){failure='';return route.abort()}
     return route.fulfill({json:result});
    }
    if(req.method()!=='GET')throw Error('Unexpected write '+url.pathname);
    if(url.pathname.startsWith('/api/daily-review-operations/')){const r=receipts.get(url.pathname.split('/').pop());return route.fulfill({status:r?200:404,json:r||{detail:'尚未查到提交'}})}
    if(holdRead&&writes.length&&url.pathname==='/api/workbench'){holdRead=false;await new Promise(resolve=>releaseRead=resolve);}
    if(readFailure&&url.pathname==='/api/workbench')return route.fulfill({status:503,json:{detail:'模拟读取失败'}});
    const data={'/api/session':{},'/api/items':items,'/api/workbench':snapshot(),'/api/priorities':snapshot().priorities};return route.fulfill({json:data[url.pathname]||[]});
   }
   const name=path.basename(url.pathname==='/'?'index.html':url.pathname),file=path.resolve(__dirname,'../frontend',name);
   return route.fulfill({status:fs.existsSync(file)?200:404,body:fs.existsSync(file)?fs.readFileSync(file):'',contentType:name.endsWith('.js')?'text/javascript':name.endsWith('.css')?'text/css':'text/html'});
  });
  await page.setViewportSize({width:1440,height:1000});await page.goto('http://127.0.0.1:18884/');
  await page.waitForFunction(()=>typeof wbSnapshot!=='undefined'&&wbSnapshot&&!wbLoading);
  const rows=page.locator('.wbActionRow'),mark=()=>rows.first().locator('.dailyMark'),filter=k=>page.locator(`[data-daily-filter="${k}"]`);
  assert.equal(await rows.count(),10);assert.equal(await page.locator('.dailyFilters button').count(),2);
  assert.equal(await page.locator('.dailySummary').count(),0);
  holdRead=true;await mark().click();await page.waitForFunction(()=>dailyBusy&&wbLoading);
  assert.equal(await page.getByRole('alert').filter({hasText:'梳理保存结果待核对'}).count(),0,'Normal successful save must not show an uncertain-result alert');
  await page.evaluate(()=>loadWorkbench());releaseRead();await page.waitForFunction(()=>!dailyBusy);
  assert.equal(await page.evaluate(()=>dailyPending),null,'An overlapping successful refresh must not create an uncertain write');
  assert.equal(await filter('done').innerText(),'1');assert.equal(writes.length,1);
  await filter('done').click();assert.equal(await rows.count(),1);assert.equal(await page.locator('.dailyTime').innerText(),'09:25');
  await page.evaluate(()=>loadWorkbench());assert.equal(await rows.count(),1);
  assert.equal(await rows.locator('.dailyAction button').count(),0,'Reviewed actions show time only, without an undo entry');
  assert.equal(await page.getByRole('button',{name:/撤销.*标记/}).count(),0);
  await filter('pending').click();await page.getByRole('button',{name:/^进行中 2$/}).click();assert.equal(await rows.count(),1);assert.equal(await filter('pending').innerText(),'1');
  failure='reject';await mark().click();await page.waitForFunction(()=>!dailyBusy&&!dailyPending);assert.equal(await filter('done').innerText(),'1');
  failure='lost-after';await mark().click();await page.waitForFunction(()=>!dailyBusy&&!!dailyPending);const count=writes.length;
  await page.getByRole('button',{name:'核对梳理结果',exact:true}).click();await page.waitForFunction(()=>!dailyBusy&&!dailyPending);assert.equal(writes.length,count);assert.equal(await filter('done').innerText(),'2');
  failure='lost-before';await mark().click();await page.waitForFunction(()=>!dailyBusy&&!!dailyPending);await page.getByRole('button',{name:'核对梳理结果',exact:true}).click();
  await page.getByRole('button',{name:'使用原操作标识重试'}).click();await page.waitForFunction(()=>!dailyBusy&&!dailyPending);assert.equal(writes.at(-1).operation_id,writes.at(-2).operation_id);
  for(const width of [1440,1024,768,375]){
   await page.setViewportSize({width,height:1000});await page.evaluate(()=>Promise.all(document.getAnimations().map(a=>a.finished.catch(()=>{}))));
   assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'Page overflows at '+width);
   const category=await page.locator('.dailyToolbar .wbTabs').boundingBox(),filters=await page.locator('.dailyFilters').boundingBox();
   assert.ok(filters.x>=category.x);await page.screenshot({path:path.join(output,width+'.png'),fullPage:true});
  }
  day='2026-11-19';await page.evaluate(()=>loadWorkbench());assert.equal(await filter('done').innerText(),'0');
  await filter('done').click();assert.equal(await rows.count(),0);await filter('pending').click();
  readFailure=true;await page.evaluate(()=>loadWorkbench());assert.equal(await page.locator('.dailyFilters button').count(),0);
  readFailure=false;await page.evaluate(()=>loadWorkbench());assert.equal(await rows.count(),10);
  assert.deepEqual(errors,[]);fs.writeFileSync(path.join(output,'report.json'),JSON.stringify({passed:true,widths:[1440,1024,768,375],mockWrites:writes.length,realWrites:0,errors,checks:['normal slow save has no false alert','overlapping refresh does not create uncertain write','mark time-only refresh; no undo entry','summary removed; icon counts and intersection retained','rejected write','lost response receipt recovery without retry','explicit original ID retry','next day reset','read failure hides counts','responsive icon toolbar']},null,2));
  console.log('Daily review browser checks passed');
 }finally{await browser.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
