// TEST-020: actual frontend in Chrome, all HTTP intercepted, no business writes.
const {chromium}=require('playwright');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const output=path.resolve(__dirname,'../../runtime/daily-follow-up-ui');fs.mkdirSync(output,{recursive:true});
(async()=>{
 const browser=await chromium.launch({channel:'chrome',headless:true});
 try{
 const page=await browser.newPage(),errors=[],writes=[],receipts=new Map(),entries=new Map(),histories=new Map(),marks=new Map();let failure='';
 page.on('pageerror',e=>errors.push(e.message));
 const day='2026-11-18',item=(id,type,parent,name,extra={})=>({id,type,parent,name,description:'',owner:'',planStart:'',planEnd:'',status:'notStarted',version:1,...extra});
 const items=[item('g','goal',null,'蒸汽智能化'),item('m','module','g','蒸汽售前支持'),item('t','thing','m','大连蒸汽售前支持'),...Array.from({length:12},(_,i)=>item('e'+i,'event','t',i?'行动 '+i:'大连数据核对，索要新的数据',{planStart:'2026-11-18',planEnd:'2026-11-20',status:'working'}))];
 items.push(item('closed','event','t','已完成的前置行动',{status:'completed'}));
 const dependencies=[{event_id:'e0',predecessor_id:'closed'}];
 marks.set('e11',{item_id:'e11',day,reviewed_at:day+'T09:00:00+08:00',revision:1});
 const snapshot=()=>({items,priorities:{week:'2026-11-16',items:[]},attention:[],branches:[],links:[],dependencies,today:day,daily_reviews:[...marks.values()]});
 await page.route('**/*',async route=>{
  const req=route.request(),url=new URL(req.url()),p=url.pathname;
  if(p.startsWith('/api/')){
   const match=p.match(/^\/api\/items\/([^/]+)\/daily-follow-ups$/);
   if(match){const id=match[1],e=items.find(x=>x.id===id);
    if(req.method()==='GET'&&failure==='view502'){failure='';return route.fulfill({status:502,json:{detail:'模拟读回失败'}})}
    if(req.method()==='GET')return route.fulfill({json:{item:e,day,records:entries.get(id)||[],revision:marks.get(id)?.revision||0,legacy_at:!(entries.get(id)||[]).length?marks.get(id)?.reviewed_at:null}});
    const b=req.postDataJSON();writes.push(b);
    if(failure==='model'){failure='';return route.fulfill({status:502,json:{detail:'识别失败，正文尚未保存'}})}
    if(failure==='reject'){failure='';return route.fulfill({status:409,json:{detail:'事项已变化'}})}
    if(failure==='lost-before'){failure='';return route.abort()}
    let r=receipts.get(b.operation_id);
    if(!r){const old=e.planEnd,postponement=b.content.match(/11月(25|27)日/),date=postponement&&!b.skip_ai?'2026-11-'+postponement[1]:old,rev=(marks.get(id)?.revision||0)+1;
     if(date!==old){e.planEnd=date;e.version++;histories.set(id,[...(histories.get(id)||[]),{operation_id:b.operation_id,new_end:date,old_end:old,changed_at:day+'T16:00:00+08:00'}])}
     r={id:b.operation_id,item_id:id,day,created_at:day+'T16:00:00+08:00',content:b.content,note:b.skip_ai?'尚未识别，计划未变更':'',old_end:old,new_end:date,revision:rev,item_version:e.version};receipts.set(b.operation_id,r);entries.set(id,[r,...(entries.get(id)||[])]);marks.set(id,{item_id:id,day,reviewed_at:r.created_at,revision:rev});
    }
    if(failure==='lost-after'){failure='';return route.abort()}
    if(failure==='readback')failure='view502';
    return route.fulfill({json:r});
   }
   if(p.startsWith('/api/daily-follow-up-operations/')){const r=receipts.get(p.split('/').pop());return route.fulfill({status:r?200:404,json:r||{detail:'尚未查到跟进提交记录'}})}
   if(p.endsWith('/structure'))return route.fulfill({json:{events:items.filter(x=>x.type==='event'),branches:[],links:[],dependencies,today:day,snapshot:'snapshot-e0'}});
   if(p==='/api/items/e0'&&req.method()==='PUT'){
    const event=items.find(x=>x.id==='e0'),body=req.postDataJSON();
    assert.equal(body.expected_version,event.version);
    event.owner=body.owner;event.version++;
    return route.fulfill({json:event});
   }
   if(p.endsWith('/plan-history')){const id=p.split('/')[3];return route.fulfill({json:{item:items.find(x=>x.id===id),records:histories.get(id)||[],baseline:{scheduled:true,start:'2026-11-18',end:'2026-11-20',incomplete:false}}})}
   if(req.method()!=='GET')throw Error('Unexpected write '+p);
   const data={'/api/session':{},'/api/items':items,'/api/workbench':snapshot(),'/api/priorities':snapshot().priorities,'/api/plan-history-counts':Object.fromEntries([...histories].map(([k,v])=>[k,v.length]))};return route.fulfill({json:data[p]||[]});
  }
  const name=path.basename(p==='/'?'index.html':p),file=path.resolve(__dirname,'../frontend',name);
  return route.fulfill({status:fs.existsSync(file)?200:404,body:fs.existsSync(file)?fs.readFileSync(file):'',contentType:name.endsWith('.js')?'text/javascript':name.endsWith('.css')?'text/css':'text/html'});
 });
 await page.setViewportSize({width:1440,height:1000});await page.goto('http://127.0.0.1:18884/');await page.waitForFunction(()=>typeof wbSnapshot!=='undefined'&&wbSnapshot&&!wbLoading);
 const mark=()=>page.getByRole('button',{name:'当日跟进：大连数据核对，索要新的数据',exact:true}),dialog=page.locator('#dailyFollowDialog'),content=page.locator('#dailyContent'),save=page.locator('#dailySave');
 assert.equal(await page.locator('.wbActionRow').count(),10);assert.equal(await mark().innerText(),'');
 await mark().click();await page.waitForFunction(()=>dailyView&&!dailyBusy);assert.equal(await writes.length,0);assert.equal(await dialog.getByRole('button',{name:'关闭当日跟进'}).count(),1);assert.equal(await dialog.locator('.dailyHead #dailySave').count(),1);
 for(const width of [1440,1024,768,375]){
  await page.setViewportSize({width,height:900});await content.fill('今天已联系现场同事，继续收集数据。'.repeat(20));
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'No page overflow at '+width);
  const rect=await dialog.boundingBox();assert.ok(rect.x>=0&&rect.x+rect.width<=width+1);await page.screenshot({path:path.join(output,'before-assert-'+width+'.png'),fullPage:true});assert.ok(rect.height<850,'Compact dialog '+JSON.stringify(rect)+' '+await dialog.evaluate(el=>JSON.stringify({height:getComputedStyle(el).height,minHeight:getComputedStyle(el).minHeight,display:getComputedStyle(el).display})));
  await page.screenshot({path:path.join(output,'dialog-'+width+'.png'),fullPage:true});
 }
 await page.setViewportSize({width:1440,height:1000});await content.fill('今天数据没拿到，完成时间改到11月25日。');await save.click();await page.waitForFunction(()=>!dailyBusy&&!dailyPending);assert.equal(writes.length,1);assert.equal(entries.get('e0').length,1);assert.equal(histories.get('e0').length,1);assert.match(await page.locator('#dailyContext').innerText(),/2026-11-25/);assert.match(await page.locator('#dailyRecords').innerText(),/已加入延期记录/);
 await content.fill('下午再次跟进，等待反馈。');await save.click();await page.waitForFunction(()=>!dailyBusy&&!dailyPending);assert.equal(entries.get('e0').length,2);assert.equal(histories.get('e0').length,1);
 await page.locator('#dailyClose').click();await page.locator('[data-daily-filter="done"]').click();await mark().click();await page.waitForFunction(()=>dailyView);assert.equal(await page.locator('.dailyEntry').count(),2);
 await content.fill('识别失败也不能丢失正文');failure='model';await save.click();await page.waitForFunction(()=>!dailyBusy);assert.equal(await content.inputValue(),'识别失败也不能丢失正文');assert.equal(await page.locator('#dailyPlain').isVisible(),true);await page.locator('#dailyPlain').click();await page.waitForFunction(()=>!dailyBusy&&!dailyPending);assert.equal(writes.at(-1).skip_ai,true);
 await content.fill('保存成功但响应丢失');failure='lost-after';await save.click();await page.waitForFunction(()=>!dailyBusy&&dailyPending);const count=writes.length;assert.equal(await save.isDisabled(),true);await page.locator('#dailyVerify').click();await page.waitForFunction(()=>!dailyBusy&&!dailyPending);assert.equal(writes.length,count,'Recovery must not POST');
 await content.fill('刷新后也能核对');failure='lost-after';await save.click();await page.waitForFunction(()=>!dailyBusy&&dailyPending);await page.reload();await page.waitForFunction(()=>wbSnapshot&&!wbLoading);assert.ok(await page.evaluate(()=>dailyPending));await page.getByRole('button',{name:'核对跟进结果',exact:true}).click();await page.waitForFunction(()=>!dailyBusy&&!dailyPending);assert.equal(writes.length,count+1);
 await page.locator('[data-daily-filter="done"]').click();await mark().click();await page.waitForFunction(()=>dailyView);await content.fill('提交成功后读回502');failure='readback';await save.click();await page.waitForFunction(()=>!dailyBusy&&dailyPending);assert.equal(await save.isDisabled(),true);await page.locator('#dailyVerify').click();await page.waitForFunction(()=>!dailyBusy&&!dailyPending);await content.fill('草稿保留');await page.locator('#dailyClose').click();await mark().click();await page.waitForFunction(()=>dailyView);assert.equal(await content.inputValue(),'草稿保留');
 await save.click();await page.waitForFunction(()=>!dailyBusy&&!dailyPending);await page.screenshot({path:path.join(output,'saved-desktop.png'),fullPage:true});
 await page.locator('#dailyClose').click();
 await page.locator('.wbActionRow').filter({has:mark()}).getByRole('button',{name:'前置事件'}).click();
 const detail=page.locator('#eventDrawer'),detailFollow=detail.getByRole('button',{name:'当日跟进',exact:true});
 await detailFollow.waitFor();
 for(const width of [1440,1024,768,375]){
  await page.setViewportSize({width,height:900});
  const rect=await detail.locator('.eventDetailShortcuts').boundingBox();
  assert.ok(rect.x>=0&&rect.x+rect.width<=width+1);
  await page.screenshot({path:path.join(output,'event-detail-'+width+'.png')});
 }
 await detailFollow.focus();await page.keyboard.press('Enter');
 await page.waitForFunction(()=>dailyView&&!dailyBusy);
 const beforeDetailWrite=writes.length;
 await content.fill('从事件详情记录进展，完成时间改到11月27日。');
 await save.click();await page.waitForFunction(()=>!dailyBusy&&!dailyPending);
 assert.equal(writes.length,beforeDetailWrite+1);
 await page.locator('#dailyClose').click();
 await detail.getByText('计划结束 · 2026-11-27',{exact:true}).waitFor();
 assert.equal(await detailFollow.evaluate(button=>document.activeElement===button),true);
 await detail.getByRole('button',{name:'延期变更',exact:true}).click();
 await page.locator('#newPlanEnd').waitFor();
 assert.equal(await page.locator('#newPlanEnd').inputValue(),'2026-11-27');
 await page.locator('#planDrawer').getByRole('button',{name:'关闭',exact:true}).click();
 await detail.getByRole('button',{name:'编辑事件',exact:true}).click();
 await page.locator('#name').waitFor();
 assert.equal(await page.locator('#name').inputValue(),items.find(x=>x.id==='e0').name);
 await page.locator('#owner').fill('验收示例负责人');
 await page.locator('#save').click();
 await detail.getByText('责任人 · 验收示例负责人',{exact:true}).waitFor();
 await detail.getByRole('button',{name:'关闭',exact:true}).click();
 await mark().click();
 await page.locator('.dailyEntry').getByText('从事件详情记录进展，完成时间改到11月27日。',{exact:true}).waitFor();
 await page.locator('#dailyClose').click();
 await page.getByRole('button',{name:'目标与事情',exact:true}).click();
 const eventName=items.find(x=>x.id==='e0').name;
 const row=page.getByRole('row').filter({has:page.getByRole('button',{name:eventName,exact:true})});
 const rowFollow=row.getByRole('button',{name:'当日跟进：'+eventName,exact:true});
 const rowPlan=row.getByRole('button',{name:'延期变更：'+eventName,exact:true});
 await rowFollow.waitFor();
 for(const width of [1440,1024,768,375]){
  await page.setViewportSize({width,height:900});
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'Page overflow at '+width);
  await rowFollow.scrollIntoViewIfNeeded();
  await rowFollow.focus();
  await page.screenshot({path:path.join(output,'event-row-actions-'+width+'.png')});
 }
 const beforeRowWrite=writes.length;
 await rowFollow.press('Enter');
 await page.waitForFunction(()=>dailyView?.item.id==='e0'&&!dailyBusy);
 await page.locator('.dailyEntry').getByText('从事件详情记录进展，完成时间改到11月27日。',{exact:true}).waitFor();
 assert.equal(writes.length,beforeRowWrite,'Opening must not write');
 await content.fill('从事件清单追加跟进。');
 await save.click();await page.waitForFunction(()=>!dailyBusy&&!dailyPending);
 assert.equal(writes.length,beforeRowWrite+1);
 await page.locator('#dailyClose').click();
 await page.waitForFunction(()=>document.activeElement?.dataset.dailyRow==='e0');
 await rowPlan.click();
 await page.locator('#newPlanEnd').waitFor();
 assert.equal(await page.locator('#newPlanEnd').inputValue(),'2026-11-27');
 await page.locator('#planDrawer').getByRole('button',{name:'关闭',exact:true}).click();
 assert.equal(await page.getByRole('row').filter({hasText:'已完成的前置行动'}).getByRole('button',{name:/^当日跟进/}).count(),0);
 await page.getByRole('button',{name:'已完成的前置行动',exact:true}).click();
 await detail.getByText('已完成',{exact:true}).waitFor();
 assert.equal(await detailFollow.count(),0);
 assert.deepEqual(errors,[]);fs.writeFileSync(path.join(output,'verification.json'),JSON.stringify({passed:true,widths:[1440,1024,768,375],eventDetail:true,eventRow:true,writes:writes.length,errors,scope:'all HTTP intercepted; no real business writes'},null,2));console.log('PASS: four widths, workbench, event detail and event-row follow-up, focus and refresh, edit and plan entries, ended event, append, postponement, recovery and zero page errors.');
 }finally{await browser.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
