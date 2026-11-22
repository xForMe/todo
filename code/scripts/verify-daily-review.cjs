// TEST-018 retains the workbench regressions. TECH-023 replaced direct daily-review
// POSTs with the follow-up dialog; its records and legacy marks share daily_reviews.
// HTTP and WebSocket requests are intercepted; the React bundle is required.
const {chromium}=require('playwright');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const react=true,mode=react?'react':'legacy';
const base='http://127.0.0.1:18884',bundle='/dist/workbench-react.js';
const root=path.resolve(__dirname,'../frontend-react/public');
const output=path.resolve(__dirname,'../../runtime',react?'daily-review-ui-react':'daily-review-ui');
const widths=[1440,1024,768,375];

(async()=>{
 if(react)fs.accessSync(path.join(root,bundle.slice(1)),fs.constants.R_OK);
 fs.mkdirSync(output,{recursive:true});
 const browser=await chromium.launch({channel:'chrome',headless:true,
  args:['--disable-background-networking','--host-resolver-rules=MAP * ~NOTFOUND']});
 try{
  const page=await browser.newPage({serviceWorkers:'block'}),errors=[],writes=[],receiptReads=[];
  page.setDefaultTimeout(8000);
  page.on('pageerror',e=>errors.push(e.message));
  const item=(id,type,parent,name,extra={})=>({id,type,parent,name,description:'',owner:'',planStart:'',planEnd:'',status:'notStarted',version:1,...extra});
  const name=i=>`行动 ${String(i).padStart(2,'0')} 很长的标题验证自适应布局`;
  const items=[item('g','goal',null,'目标'),item('m','module','g','模块'),item('t','thing','m','事情'),
   item('g2','goal',null,'另一个目标'),item('m2','module','g2','另一个模块'),item('t2','thing','m2','另一件事情'),
   ...Array.from({length:12},(_,i)=>item('e'+i,'event',i===11?'t2':'t',name(i),{status:i<2?'working':'notStarted'}))];
  const marks=new Map(),records=new Map(),receipts=new Map(),priorities={week:'2026-11-16',items:[]};
  let day='2026-11-18',failure='',viewFailure=false,readFailure=false,holdAfterSave;
  const key=id=>`${day}/${id}`;
  const snapshot=()=>({items,priorities,attention:[],branches:[],links:[],dependencies:[],today:day,
   daily_reviews:[...marks.values()].filter(mark=>mark.day===day)});
  await page.clock.setFixedTime(new Date(`${day}T09:30:00+08:00`));
  await page.context().routeWebSocket('**/*',socket=>{errors.push(`Unexpected WebSocket: ${socket.url()}`);return socket.close()});
  await page.context().route('**/*',async route=>{
   const req=route.request(),url=new URL(req.url()),p=url.pathname,method=req.method();
   const abort=reason=>{errors.push(`${reason}: ${method} ${req.url()}`);return route.abort()};
   if(url.origin!==base)return abort('Unexpected origin');
   const follow=p.match(/^\/api\/items\/([^/]+)\/daily-follow-ups$/);
   if(follow){
    const id=follow[1],event=items.find(row=>row.id===id&&row.type==='event');
    if(!event)return abort('Unexpected follow-up event');
    const entryKey=key(id),entries=records.get(entryKey)||[],mark=marks.get(entryKey);
    if(method==='GET'){
     if(viewFailure){viewFailure=false;return route.fulfill({status:503,json:{detail:'模拟跟进读取失败'}})}
     return route.fulfill({json:{item:event,day,records:entries,revision:mark?.revision||0,
      legacy_at:entries.length?null:mark?.reviewed_at||null}});
    }
    if(method!=='POST')return abort('Unexpected follow-up method');
    const body=req.postDataJSON();writes.push({id,body});
    const fault=failure;failure='';
    if(fault==='reject')return route.fulfill({status:409,json:{detail:'事件已变化'}});
    if(fault==='lost-before')return route.abort();
    let result=receipts.get(body.operation_id);
    if(!result){
     assert.match(body.operation_id,/^[0-9a-f-]{36}$/i);
     assert.equal(body.day,day);assert.equal(body.expected_version,event.version);
     assert.equal(body.expected_revision,mark?.revision||0);assert.equal(body.skip_ai,false);
     assert.ok(body.content.trim());assert.equal('reviewed' in body,false,'Do not use the retired marker write contract');
     result={id:body.operation_id,item_id:id,day,created_at:`${day}T09:25:00+08:00`,content:body.content,
      note:'',old_end:event.planEnd,new_end:event.planEnd,revision:(mark?.revision||0)+1,item_version:event.version,
      completed:false,image_ids:[]};
     records.set(entryKey,[result,...entries]);receipts.set(result.id,result);
     marks.set(entryKey,{item_id:id,day,reviewed_at:result.created_at,revision:result.revision});
    }
    if(fault==='lost-after')return route.abort();
    return route.fulfill({json:result});
   }
   if(method!=='GET')return abort('Unexpected write');
   if(p.startsWith('/api/daily-follow-up-operations/')){
    const id=p.split('/').pop(),result=receipts.get(id);receiptReads.push(id);
    return route.fulfill({status:result?200:404,json:result||{detail:'尚未查到跟进提交记录'}});
   }
   if(p==='/api/workbench'){
    const data=snapshot();
    if(holdAfterSave&&writes.length){
     const held=holdAfterSave;holdAfterSave=null;
     held.start();await held.gate;
    }
    if(readFailure)return route.fulfill({status:503,json:{detail:'模拟工作台读取失败'}});
    return route.fulfill({json:data});
   }
   if(/^\/api\/events\/e\d+\/structure$/.test(p)){
    const event=items.find(row=>row.id===p.split('/')[3]);
    if(!event)return abort('Unexpected event structure');
    return route.fulfill({json:{events:items.filter(row=>row.type==='event'&&row.parent===event.parent),
     branches:[],links:[],dependencies:[],today:day,snapshot:`fixture-${event.parent}`}});
   }
   const reads={'/api/session':{},'/api/items':items,'/api/priorities':priorities,'/api/plan-history-counts':{},
    '/api/sources':[],'/api/sources/suggestions':[],'/api/sources/unmatched':[],'/api/sources/follow':[]};
   if(Object.hasOwn(reads,p))return route.fulfill({json:reads[p]});
   if(p==='/favicon.ico')return route.fulfill({status:404});
   if(p!=='/'&&!(react&&p===bundle)&&!/^\/[\w-]+\.(js|css)$/.test(p))return abort('Unexpected resource');
   const file=path.join(root,p==='/'?'index.html':p.slice(1));
   if(!fs.existsSync(file))return abort('Missing fixture asset');
   return route.fulfill({path:file,contentType:p.endsWith('.js')?'text/javascript':p.endsWith('.css')?'text/css':'text/html'});
  });

  await page.setViewportSize({width:1440,height:1000});
  await page.goto(`${base}/`);
  await page.waitForFunction(()=>typeof wbSnapshot!=='undefined'&&wbSnapshot&&!wbLoading);
  const workbench=page.locator('#globalWorkbench'),dialog=page.locator('#dailyFollowDialog');
  if(react)await page.locator('#globalWorkbench[data-panels-ui="react"] .wbActionRow').first().waitFor();
  else assert.equal(await workbench.getAttribute('data-panels-ui'),null);
  const rows=workbench.locator('.wbActionRow'),filter=k=>workbench.locator(`[data-daily-filter="${k}"]`);
  const mark=i=>rows.getByRole('button',{name:`当日跟进：${name(i)}`,exact:true});
  const category=k=>workbench.locator(`[data-action-category="${k}"]`),scope=workbench.locator('#wbScope');
  const content=dialog.locator('#dailyContent'),save=dialog.getByRole('button',{name:'保存跟进',exact:true});
  const verify=dialog.getByRole('button',{name:'核对保存结果',exact:true});
  const retry=dialog.getByRole('button',{name:'使用原操作标识重试',exact:true});
  const warning=workbench.getByRole('alert',{includeHidden:true}).filter({hasText:'跟进保存结果待核对'});
  const noUndo=()=>page.getByRole('button',{name:/撤销.*(标记|梳理|跟进)/,includeHidden:true}).count();
  const refresh=()=>page.evaluate(()=>loadWorkbench());
  const counts=async(pending,done)=>{
   assert.equal(await filter('pending').innerText(),String(pending));
   assert.equal(await filter('done').innerText(),String(done));
  };
  const open=async i=>{
   const before=writes.length;
   await mark(i).click();
   await dialog.locator('#dailyContext strong').getByText(name(i),{exact:true}).waitFor();
   assert.equal(await dialog.getAttribute('data-react-owned')!==null,react,'Run the matching follow-up dialog');
   assert.equal(writes.length,before,'Opening the follow-up does not write');
  };
  const close=async()=>{
   await dialog.getByRole('button',{name:'关闭当日跟进',exact:true}).click();
   await dialog.waitFor({state:'hidden'});
  };
  const prepare=async(i,text)=>{await open(i);await content.fill(text)};
  const settled=()=>page.waitForFunction(()=>!dailyBusy&&!dailyPending);
  const pending=()=>page.waitForFunction(()=>!dailyBusy&&!!dailyPending);
  const assertIconOnly=async i=>{
   assert.equal(await mark(i).count(),1);
   assert.equal(await rows.locator('.dailyAction button').count(),1,'Reviewed rows only provide the follow-up entry');
   assert.equal(await rows.locator('.dailyAction').innerText(),'','Reviewed rows keep an icon, not a time or action text');
   assert.equal(await rows.locator('.dailyTime').count(),0,'Time now belongs to the follow-up record');
   assert.equal(await noUndo(),0,'Neither the workbench nor the dialog provides an undo entry');
  };

  assert.equal(await rows.count(),10);assert.equal(await workbench.locator('.dailyFilters button').count(),2);
  assert.equal(await workbench.locator('.dailySummary').count(),0);
  await counts(12,0);
  await workbench.getByRole('button',{name:'下一页',exact:true}).click();
  assert.equal(await rows.count(),2);assert.equal(await mark(11).count(),1);
  await scope.selectOption('g2');await counts(1,0);assert.equal(await rows.count(),1);assert.equal(await mark(11).count(),1);
  await scope.selectOption('');await counts(12,0);assert.equal(await rows.count(),10);

  const first='已核对现场资料，等待对方反馈。';
  await prepare(0,first);
  const held=Promise.withResolvers(),gate=Promise.withResolvers();
  holdAfterSave={start:held.resolve,gate:gate.promise};
  const readRequested=page.waitForRequest(`${base}/api/workbench`);
  try{
   await Promise.all([save.click(),readRequested]);
   await held.promise;
   await page.waitForFunction(()=>dailyBusy&&wbLoading);
   assert.equal(await warning.count(),0,'A slow successful readback must not show an uncertain-result alert');
   assert.equal(await verify.isVisible(),false);
   assert.equal(await refresh(),true,'The overlapping refresh must finish before the held response');
   assert.equal(await page.evaluate(()=>dailyBusy&&!wbLoading),true);
   assert.equal(await warning.count(),0);
  }finally{gate.resolve();}
  await settled();
  assert.equal(await page.evaluate(()=>dailyPending),null,'An overlapping successful refresh must not create an uncertain write');
  assert.equal(await warning.count(),0);assert.equal(writes.length,1);
  assert.equal(writes[0].body.content,first);
  await close();await counts(11,1);
  await filter('done').click();assert.equal(await rows.count(),1);await assertIconOnly(0);
  assert.equal(await refresh(),true);assert.equal(await rows.count(),1);
  await open(0);
  const entry=dialog.locator('#dailyRecords .dailyEntry');
  assert.equal(await entry.count(),1);assert.equal(await entry.locator('time').innerText(),'09:25');
  assert.equal(await entry.locator('p').innerText(),first);assert.equal(await noUndo(),0);
  await close();assert.equal(writes.length,1);

  await filter('pending').click();await workbench.getByRole('button',{name:/^进行中 2$/}).click();
  await counts(1,1);assert.equal(await rows.count(),1);assert.equal(await mark(1).count(),1);
  const rejected='事件版本冲突时保留这段草稿。';
  await prepare(1,rejected);failure='reject';await save.click();await settled();
  await dialog.getByText('事件已变化；未自动重试',{exact:true}).waitFor();
  assert.equal(await content.inputValue(),rejected);assert.equal(await verify.isVisible(),false);
  assert.equal(writes.length,2);assert.equal(records.has(key('e1')),false);await counts(1,1);
  await close();

  const lostReceipt='保存已提交，客户端没有收到响应。';
  await prepare(1,lostReceipt);failure='lost-after';await save.click();await pending();
  assert.equal(await warning.count(),1);assert.equal(await retry.isVisible(),false);
  const submitted=writes.at(-1),afterSubmit=writes.length;
  await verify.click();await settled();
  assert.deepEqual(receiptReads,[submitted.body.operation_id]);
  assert.equal(writes.length,afterSubmit,'Receipt recovery must not POST again');
  assert.equal(records.get(key('e1')).length,1);await counts(0,2);
  assert.equal(await entry.locator('p').innerText(),lostReceipt);await close();

  await category('all').click();await counts(10,2);
  const retryText='请求未提交，核对后使用原操作标识保存。';
  await prepare(2,retryText);failure='lost-before';await save.click();await pending();
  const missing=writes.at(-1),beforeRetry=writes.length;
  assert.equal(await retry.isVisible(),false,'Only an explicit receipt miss may enable a retry');
  assert.equal(records.has(key('e2')),false);
  await verify.click();await retry.waitFor();
  assert.deepEqual(receiptReads,[submitted.body.operation_id,missing.body.operation_id]);
  assert.equal(writes.length,beforeRetry,'Receipt lookup must not silently retry');
  await retry.click();await settled();
  assert.equal(writes.length,beforeRetry+1);assert.deepEqual(writes.at(-1),missing,'Retry must preserve the operation key and request body');
  assert.equal(records.get(key('e2')).length,1);await counts(9,3);await close();
  await category('working').click();await counts(0,2);
  assert.equal(await rows.count(),0);await filter('done').click();
  assert.equal(await rows.count(),2);assert.equal(await mark(2).count(),0);
  await category('all').click();await counts(9,3);assert.equal(await rows.count(),3);

  // A compatible legacy mark still counts but must not fabricate a follow-up or resurrect undo.
  marks.set(key('e11'),{item_id:'e11',day,reviewed_at:`${day}T09:00:00+08:00`,revision:1});
  assert.equal(await refresh(),true);await counts(8,4);
  await scope.selectOption('g2');await counts(0,1);assert.equal(await rows.count(),1);await assertIconOnly(11);
  viewFailure=true;await mark(11).click();
  await dialog.getByText('读取失败：模拟跟进读取失败',{exact:true}).waitFor();
  assert.equal(await save.isDisabled(),true);assert.equal(await content.isDisabled(),true);
  await dialog.getByRole('button',{name:'重新读取',exact:true}).click();
  await dialog.getByText('旧梳理标记，无跟进正文',{exact:true}).waitFor();
  assert.equal(await entry.count(),0);assert.equal(await noUndo(),0);assert.equal(writes.length,5);
  await close();await scope.selectOption('');await counts(8,4);

  for(const width of widths){
   await page.setViewportSize({width,height:1000});
   await page.evaluate(()=>Promise.all(document.getAnimations().map(a=>a.finished.catch(()=>{}))));
   assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'Page overflows at '+width);
   const tabs=await workbench.locator('.dailyToolbar .wbTabs').boundingBox(),filters=await workbench.locator('.dailyFilters').boundingBox();
   assert.ok(tabs&&filters&&filters.x>=tabs.x&&filters.x+filters.width<=width,`Daily filter toolbar at ${width}px`);
   await page.screenshot({path:path.join(output,width+'.png'),fullPage:true});
  }
  day='2026-11-19';
  await page.clock.setFixedTime(new Date(`${day}T09:30:00+08:00`));
  assert.equal(await page.evaluate(()=>{dailyCheckDate();return wbLatestRead}),true);
  await counts(12,0);assert.equal(await rows.count(),0);
  await filter('pending').click();assert.equal(await rows.count(),10);
  await filter('done').click();assert.equal(await rows.count(),0);await filter('pending').click();
  await open(0);await dialog.getByText('今天还没有跟进记录',{exact:true}).waitFor();assert.equal(await entry.count(),0);await close();
  assert.equal(marks.size,4,'The next day resets the display, not history');

  readFailure=true;assert.equal(await refresh(),false);
  await workbench.getByRole('alert').filter({hasText:'工作台读取失败：模拟工作台读取失败'}).waitFor();
  assert.equal(await workbench.locator('.dailyFilters button').count(),0);assert.equal(await rows.count(),0);
  readFailure=false;assert.equal(await refresh(),true);await counts(12,0);assert.equal(await rows.count(),10);
  assert.equal(writes.length,5);assert.deepEqual(errors,[]);
  fs.writeFileSync(path.join(output,'report.json'),JSON.stringify({passed:true,mode,widths,mockWrites:writes.length,realWrites:0,errors,
   checks:['slow successful readback without false alert','overlapping refresh does not create uncertain write',
    'follow-up record time and content read back; legacy mark without fabricated content or undo',
    'summary removed; icon counts, category intersection, goal scope and pagination retained','rejected write retains draft',
    'lost response receipt recovery without retry','receipt miss and explicit original-key retry','next-day reset',
    'failed follow-up read and reload; failed workbench read hides counts','responsive icon toolbar']},null,2));
  console.log(`Daily review browser checks passed (${mode}; ${widths.join('/')} px; ${writes.length} mock POSTs; 0 real writes).`);
 }finally{await browser.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
