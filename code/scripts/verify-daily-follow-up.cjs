// TEST-020: Chrome with all requests intercepted.
const {chromium}=require('playwright');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const react=true,bundle='/dist/workbench-react.js',base='http://127.0.0.1:18884';
const root=path.resolve(__dirname,'../frontend-react/public');
const output=path.resolve(__dirname,'../../runtime',`daily-follow-up-ui${react?'-react':''}`);
async function assertReactRegion(page,selector){
 const region=page.locator(selector);await region.waitFor();
 const inline=await region.evaluate(root=>[root,...root.querySelectorAll('*')].flatMap(node=>
  node.getAttributeNames().filter(name=>/^on/i.test(name)).map(name=>`${node.id||node.tagName}.${name}`)));
 assert.deepEqual(inline,[],`${selector} must not contain inline event handlers`);
}
async function assertEmptyDailyHost(dialog,mounted){
 const actual=await dialog.evaluate(host=>({
  nativeClosed:host instanceof HTMLDialogElement&&!host.open&&!host.matches(':modal'),
  namedBy:host.getAttribute('aria-labelledby'),childNodes:host.childNodes.length,
  marked:host.hasAttribute('data-react-owned'),
  reactRoot:Object.getOwnPropertyNames(host).some(key=>key.startsWith('__reactContainer$')&&host[key]?.stateNode?.containerInfo===host),
 }));
 assert.deepEqual(actual,{nativeClosed:true,namedBy:'dailyFollowTitle',childNodes:0,marked:mounted,reactRoot:mounted},
  mounted?'React 挂载后、首次打开前，原生跟进宿主仍关闭且没有内容':'bundle 被延迟时，跟进必须只是没有旧字段的原生空 dialog');
}
async function assertDailyOwnership(dialog){
 const actual=await dialog.evaluate(shell=>{
  const nodes=[...shell.querySelectorAll('*')];
  const fiber=node=>{
   const key=node&&Object.getOwnPropertyNames(node).find(key=>key.startsWith('__reactFiber$'));
   const value=node?.[key];
   return value?.stateNode===node?value:undefined;
  };
  const fiberRoot=node=>{
   let value=fiber(node);
   while(value?.return)value=value.return;
   return value?.stateNode?.containerInfo;
  };
  const label=node=>node.id||node.localName;
  const slot=shell.querySelector('#dailyImageSlot'),attachment=shell.querySelector('.inlineImageEntry');
  const content=nodes.filter(node=>!node.matches('#dailyFollowDialog > .iconTip[role="tooltip"]'));
  return {
   nativeModal:shell instanceof HTMLDialogElement&&shell.open&&shell.matches(':modal'),
   namedBy:shell.getAttribute('aria-labelledby'),marked:shell.hasAttribute('data-react-owned'),shellFiber:!!fiber(shell),
   owned:nodes.filter(fiber).map(label),unowned:content.filter(node=>!fiber(node)).map(label),
   slotPresent:!!slot,slotInDialogRoot:!!slot&&fiberRoot(slot)===shell,
   attachmentCount:shell.querySelectorAll('.inlineImageEntry').length,attachmentInSlot:!!slot&&attachment?.parentElement===slot,
   attachmentInSlotRoot:!!slot&&!!attachment&&[...slot.querySelectorAll('*')].every(node=>fiberRoot(node)===slot),
   nativeAttachmentPosition:!!attachment&&attachment.previousElementSibling?.id==='dailyContent',
   inline:[shell,...nodes].flatMap(node=>node.getAttributeNames()
    .filter(name=>/^on/i.test(name)).map(name=>`${label(node)}.${name}`)),
  };
 });
 assert.equal(actual.nativeModal,true,'当日跟进仍使用原生模态 dialog');
 assert.equal(actual.namedBy,'dailyFollowTitle');
 assert.equal(actual.marked,react);
 assert.equal(actual.shellFiber,false,'原生 dialog 不由 React 替换');
 assert.equal(actual.attachmentCount,1,'跟进窗口必须且只应有一个附件区');
 if(!react){
  assert.equal(actual.slotPresent,false,'原生模式不创建 React 插槽');
  assert.equal(actual.nativeAttachmentPosition,true,'原生附件区仍在正文后');
  assert.deepEqual(actual.owned,[],'原生模式的正文和附件区不得由 React 渲染');
  return;
 }
 for(const id of ['dailyFollowTitle','dailySave','dailyClose','dailyContext','dailyContent','dailyImageSlot','dailyResult',
  'dailyReload','dailyPlain','dailyVerify','dailyRetry','dailyRecordsTitle','dailyRecords'])assert.ok(actual.owned.includes(id),`${id} 缺少 React Fiber`);
 assert.equal(actual.slotInDialogRoot,true,'跟进窗口的外层 React 根必须持有附件插槽');
 assert.equal(actual.attachmentInSlot,true,'附件区必须挂载在 #dailyImageSlot 下');
 assert.equal(actual.attachmentInSlotRoot,true,'附件插槽内的所有元素必须由独立 React 根持有');
 assert.deepEqual(actual.unowned,[],'唯一所有权例外是原生外壳的共享提示');
 assert.deepEqual(actual.inline,[],'包括附件区在内的内容均不得使用内联事件');
}
(async()=>{
 if(react)fs.accessSync(path.join(root,bundle.slice(1)),fs.constants.R_OK);
 fs.mkdirSync(output,{recursive:true});
 const browser=await chromium.launch({channel:'chrome',headless:true,
  args:['--disable-background-networking','--host-resolver-rules=MAP * ~NOTFOUND']});
 let releaseBundle;
 const bundleGate=new Promise(resolve=>{releaseBundle=resolve});
 try{
 const page=await browser.newPage({serviceWorkers:'block'}),errors=[],writes=[],httpWrites=[],reads=[],receipts=new Map(),entries=new Map(),histories=new Map(),marks=new Map();
 page.setDefaultTimeout(8000);
 let failure='',heldRead;
 page.on('pageerror',e=>errors.push(e.message));
 await page.addInitScript(()=>{
  // Wait until the intercepted body has been consumed and the UI continuation has had time to render.
  const json=Response.prototype.json;
  Response.prototype.json=async function(...args){
   const result=await json.apply(this,args),label=this.headers.get('x-test-late-follow-up');
   if(label)requestAnimationFrame(()=>requestAnimationFrame(()=>{window.testLateFollowUpConsumed=label}));
   return result;
  };
 });
 const completion='现场已核对完毕，当前任务已完成。';
 const day='2026-11-18',item=(id,type,parent,name,extra={})=>({id,type,parent,name,description:'',owner:'',planStart:'',planEnd:'',status:'notStarted',version:1,...extra});
 const items=[item('g','goal',null,'蒸汽智能化'),item('m','module','g','蒸汽售前支持'),item('t','thing','m','大连蒸汽售前支持'),...Array.from({length:12},(_,i)=>item('e'+i,'event','t',i?'行动 '+i:'大连数据核对，索要新的数据',{planStart:'2026-11-18',planEnd:'2026-11-20',status:'working'}))];
 items.push(item('closed','event','t','已完成的前置行动',{status:'completed'}));
 const dependencies=[{event_id:'e0',predecessor_id:'closed'}];
 marks.set('e11',{item_id:'e11',day,reviewed_at:day+'T09:00:00+08:00',revision:1});
 const snapshot=()=>({items,priorities:{week:'2026-11-16',items:[]},attention:[],branches:[],links:[],dependencies,today:day,daily_reviews:[...marks.values()]});
 await page.context().routeWebSocket('**/*',socket=>{errors.push(`Unexpected WebSocket: ${socket.url()}`);return socket.close()});
 await page.context().route('**/*',async route=>{
  const req=route.request(),url=new URL(req.url()),p=url.pathname,method=req.method();
  if(!['GET','HEAD','OPTIONS'].includes(method))httpWrites.push(`${method} ${req.url()}`);
  const abort=reason=>{errors.push(`${reason}: ${method} ${req.url()}`);return route.abort()};
  if(url.origin!==base)return abort('Unexpected origin');
  if(p.startsWith('/api/')){
   const match=p.match(/^\/api\/items\/([^/]+)\/daily-follow-ups$/);
   if(match){const id=match[1],e=items.find(x=>x.id===id);
    if(!e)return abort('Unexpected follow-up event');
    if(method==='GET'){
     reads.push(id);
     const view={item:e,day,records:entries.get(id)||[],revision:marks.get(id)?.revision||0,legacy_at:!(entries.get(id)||[]).length?marks.get(id)?.reviewed_at:null};
     if(failure==='view502'){failure='';return route.fulfill({status:502,json:{detail:'模拟读回失败'}})}
     if(heldRead?.id===id){
      const {label,status,gate}=heldRead;heldRead=null;
      await gate;
      return route.fulfill({status,headers:{'x-test-late-follow-up':label},json:status===200?view:{detail:'过期窗口模拟读回失败'}});
     }
     return route.fulfill({json:view});
    }
    if(method!=='POST')return abort('Unexpected follow-up write');
    const b=req.postDataJSON();writes.push(b);
    if(failure==='model'){failure='';return route.fulfill({status:502,json:{detail:'识别失败，正文尚未保存'}})}
    if(failure==='reject'){failure='';return route.fulfill({status:409,json:{detail:'事项已变化'}})}
    if(failure==='lost-before'){failure='';return route.abort()}
    let r=receipts.get(b.operation_id);
    if(!r){
     if(e.status==='completed')return abort('Unexpected follow-up write for a completed event');
     assert.equal(b.expected_version,e.version);assert.equal(b.expected_revision,marks.get(id)?.revision||0);assert.equal(b.day,day);
     const old=e.planEnd,completed=!b.skip_ai&&b.content===completion,postponement=b.content.match(/11月(25|27)日/),date=postponement&&!b.skip_ai&&!completed?'2026-11-'+postponement[1]:old,rev=(marks.get(id)?.revision||0)+1;
     if(date!==old){e.planEnd=date;e.version++;histories.set(id,[...(histories.get(id)||[]),{operation_id:b.operation_id,new_end:date,old_end:old,changed_at:day+'T16:00:00+08:00'}])}
     if(completed){e.status='completed';e.version++;}
     r={id:b.operation_id,item_id:id,day,created_at:day+'T16:00:00+08:00',content:b.content,note:b.skip_ai?'尚未识别，计划未变更':'',old_end:old,new_end:date,revision:rev,item_version:e.version,completed};receipts.set(b.operation_id,r);entries.set(id,[r,...(entries.get(id)||[])]);marks.set(id,{item_id:id,day,reviewed_at:r.created_at,revision:rev});
    }
    if(failure==='lost-after'){failure='';return route.abort()}
    if(failure==='readback')failure='view502';
    return route.fulfill({json:r});
   }
   if(p==='/api/items/e0'&&method==='PUT'){
    const event=items.find(x=>x.id==='e0'),body=req.postDataJSON();
    assert.equal(body.expected_version,event.version);
    event.owner=body.owner;event.version++;
    return route.fulfill({json:event});
   }
   if(method!=='GET')return abort('Unexpected API write');
   if(p.startsWith('/api/daily-follow-up-operations/')){const r=receipts.get(p.split('/').pop());return route.fulfill({status:r?200:404,json:r||{detail:'尚未查到跟进提交记录'}})}
   if(p.endsWith('/structure'))return route.fulfill({json:{events:items.filter(x=>x.type==='event'),branches:[],links:[],dependencies,today:day,snapshot:'snapshot-e0'}});
   if(p.endsWith('/plan-history')){const id=p.split('/')[3];return route.fulfill({json:{item:items.find(x=>x.id===id),records:histories.get(id)||[],baseline:{scheduled:true,start:'2026-11-18',end:'2026-11-20',incomplete:false}}})}
   const data={'/api/session':{},'/api/items':items,'/api/workbench':snapshot(),'/api/priorities':snapshot().priorities,'/api/plan-history-counts':Object.fromEntries([...histories].map(([k,v])=>[k,v.length]))};return route.fulfill({json:data[p]||[]});
  }
  if(method!=='GET')return abort('Unexpected static write');
  if(p===bundle)await bundleGate;
  const name=react&&p===bundle?bundle.slice(1):path.basename(p==='/'?'index.html':p),file=path.join(root,name);
  return route.fulfill({status:fs.existsSync(file)?200:404,body:fs.existsSync(file)?fs.readFileSync(file):'',contentType:name.endsWith('.js')?'text/javascript':name.endsWith('.css')?'text/css':'text/html'});
 });
 const dialog=page.locator('#dailyFollowDialog'),content=dialog.locator('#dailyContent'),save=dialog.locator('#dailySave');
 await page.setViewportSize({width:1440,height:1000});
 await Promise.all([
  page.waitForRequest(`${base}${bundle}`),
  page.goto(`${base}/`,{waitUntil:'domcontentloaded'}),
 ]);
 await page.locator('body[data-ui-startup]').waitFor({state:'attached'});
 await assertEmptyDailyHost(dialog,false);
 const originalDialog=await dialog.elementHandle();
 const assertDialogIdentity=async()=>assert.equal(await dialog.evaluate((node,original)=>node===original,originalDialog),true,
  '挂载和打开跟进都必须保留原生 dialog 节点');
 releaseBundle();
 await page.locator('body:not([data-ui-startup])').waitFor({state:'attached'});
 await assertDialogIdentity();
 await assertEmptyDailyHost(dialog,true);
 await page.waitForFunction(()=>typeof wbSnapshot!=='undefined'&&wbSnapshot&&!wbLoading);
 if(react){await page.locator('#globalWorkbench[data-panels-ui="react"] .wbActionRow').first().waitFor();await assertReactRegion(page,'#globalWorkbench[data-panels-ui="react"]')}
 const mark=(name='大连数据核对，索要新的数据')=>page.getByRole('button',{name:`当日跟进：${name}`,exact:true});
 const close=dialog.getByRole('button',{name:'关闭当日跟进',exact:true}),reload=dialog.getByRole('button',{name:'重新读取',exact:true});
 const result=dialog.locator('#dailyResult'),imageControls=dialog.locator('.inlineImageEntry button, .inlineImageEntry input');
 const assertImageLock=async disabled=>{
  assert.ok(await imageControls.count()>0,'附件控件必须存在');
  assert.ok(await imageControls.evaluateAll((nodes,expected)=>nodes.every(node=>node.disabled===expected),disabled));
 };
 assert.equal(await page.locator('.wbActionRow').count(),10);assert.equal(await mark().innerText(),'');

 // Read requests do not lock dismissal or allow saving until a fresh view arrives.
 failure='view502';
 await mark().click();
 await dialog.getByText('读取失败：模拟读回失败',{exact:true}).waitFor();
 await reload.waitFor();
 assert.deepEqual(reads,['e0']);assert.equal(writes.length,0);
 assert.equal(await save.isDisabled(),true);assert.equal(await content.isDisabled(),true);assert.equal(await close.isEnabled(),true);
 await assertImageLock(true);
 await assertDialogIdentity();
 await assertDailyOwnership(dialog);
 await originalDialog.dispose();
 await reload.click();
 await dialog.locator('#dailyContext').getByText('大连数据核对，索要新的数据',{exact:true}).waitFor();
 await dialog.getByText('今天还没有跟进记录',{exact:true}).waitFor();
 assert.deepEqual(reads,['e0','e0']);assert.equal(writes.length,0);
 assert.equal(await result.isVisible(),false);assert.equal(await reload.isVisible(),false);
 assert.equal(await save.isEnabled(),true);assert.equal(await content.isEnabled(),true);
 await assertImageLock(false);
 await close.click();await dialog.waitFor({state:'hidden'});

 // The first GET is released only after a different modal view is ready.
 const lateReadStatuses=[200,502];
 for(const status of lateReadStatuses){
  const label=String(status),id='e0';
  let release;
  heldRead={id,label,status,gate:new Promise(resolve=>{release=resolve})};
  try{
   const requested=page.waitForRequest(`${base}/api/items/${id}/daily-follow-ups`);
   await mark().click();await requested;
   await dialog.getByText('正在读取…',{exact:true}).waitFor();
   assert.equal(await save.isDisabled(),true);
   await page.keyboard.press('Escape');await dialog.waitFor({state:'hidden'});
   await mark('行动 1').click();
   await dialog.locator('#dailyContext').getByText('行动 1',{exact:true}).waitFor();
   await content.fill('新窗口草稿不应被迟到的读取改写');
   await close.focus();
   release();
   await page.waitForFunction(value=>window.testLateFollowUpConsumed===value,label);
   assert.equal(await dialog.locator('#dailyContext strong').innerText(),'行动 1');
   assert.equal(await content.inputValue(),'新窗口草稿不应被迟到的读取改写');
   assert.equal(await result.isVisible(),false);assert.equal(await reload.isVisible(),false);
   assert.equal(await close.evaluate(button=>document.activeElement===button),true,'过期读取不得夺走焦点');
   assert.equal(writes.length,0);
   await close.click();await dialog.waitFor({state:'hidden'});
  }finally{release();}
 }
 await mark().click();
 await dialog.locator('#dailyContext').getByText('大连数据核对，索要新的数据',{exact:true}).waitFor();
 assert.equal(await content.inputValue(),'','不同事件的草稿必须隔离');
 assert.equal(await close.count(),1);assert.equal(await dialog.locator('.dailyHead #dailySave').count(),1);
 const draftImage={name:'合成附件.png',mimeType:'image/png',buffer:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+lZ9sAAAAASUVORK5CYII=','base64')};
 const attachment=dialog.locator('.inlineImageEntry');
 const [chooser]=await Promise.all([page.waitForEvent('filechooser'),attachment.getByRole('button',{name:'选文件',exact:true}).click()]);
 await chooser.setFiles(draftImage);
 const preview=attachment.getByRole('img',{name:draftImage.name,exact:true});
 const remove=attachment.getByRole('button',{name:`移除${draftImage.name}`,exact:true});
 await preview.waitFor();
 await assertDailyOwnership(dialog);
 await remove.click();
 await preview.waitFor({state:'detached'});
 await remove.waitFor({state:'detached'});
 assert.equal(writes.length,0,'打开、重读、切换和本地附件草稿都不能提交跟进');
 assert.deepEqual(httpWrites,[],'选择和移除本地附件草稿不能发出任何 HTTP 写请求');
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
 await content.fill('保存成功但响应丢失');failure='lost-after';await save.click();await page.waitForFunction(()=>!dailyBusy&&dailyPending);
 const count=writes.length;
 assert.equal(await save.isDisabled(),true);assert.equal(await close.isDisabled(),true);assert.equal(await content.isDisabled(),true);
 await assertImageLock(true);
 await page.keyboard.press('Escape');assert.equal(await dialog.isVisible(),true,'保存结果待核对时不能用 Escape 关闭');
 await dialog.getByRole('button',{name:'核对保存结果',exact:true}).click();
 await page.waitForFunction(()=>!dailyBusy&&!dailyPending);
 assert.equal(writes.length,count,'Recovery must not POST');await assertImageLock(false);
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
 if(react)await assertReactRegion(page,'#events[data-events-ui="react"]');
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
 await detail.getByRole('button',{name:'关闭',exact:true}).click();

 // Simulate the existing `completed` receipt and authoritative readback, not model recognition.
 const event=items.find(x=>x.id==='e0'),beforeCompletion={writes:writes.length,records:entries.get('e0').length,
  version:event.version,start:event.planStart,end:event.planEnd,history:histories.get('e0').slice()};
 await rowFollow.click();
 await dialog.locator('#dailyContext').getByText(eventName,{exact:true}).waitFor();
 await content.fill(completion);await save.click();
 await dialog.getByText('跟进已保存，任务已标记为完成',{exact:true}).waitFor();
 await page.waitForFunction(()=>!dailyBusy&&!dailyPending);
 await dialog.locator('.dailyEntry').getByText(completion,{exact:true}).waitFor();
 assert.equal(await dialog.locator('.dailyEntry').count(),beforeCompletion.records+1);
 assert.equal(event.status,'completed');assert.equal(event.version,beforeCompletion.version+1);
 assert.equal(event.planStart,beforeCompletion.start);assert.equal(event.planEnd,beforeCompletion.end);
 assert.deepEqual(histories.get('e0'),beforeCompletion.history);
 assert.equal(await save.isDisabled(),true);assert.equal(await content.isDisabled(),true);assert.equal(await close.isEnabled(),true);
 await assertImageLock(true);
 await assertDailyOwnership(dialog);
 await close.click();await dialog.waitFor({state:'hidden'});
 await row.getByText('已完成',{exact:true}).waitFor();
 assert.equal(await rowFollow.count(),0);
 assert.equal(writes.length,beforeCompletion.writes+1);

 assert.deepEqual(errors,[]);
 fs.writeFileSync(path.join(output,'verification.json'),JSON.stringify({passed:true,widths:[1440,1024,768,375],eventDetail:true,eventRow:true,
  delayedBundleHost:true,reactOwnership:react,openReadRetry:true,lateReadStatuses,attachmentDraft:true,completedReadOnly:true,
  writes:writes.length,errors,scope:'all HTTP and WebSocket intercepted; no real business writes'},null,2));
 console.log('PASS: delayed bundle and native host identity, four widths, all follow-up entries, focus and refresh, read retry, late reads, attachment draft, append, postponement, recovery, completed read-only and zero page errors.');
 }finally{releaseBundle();await browser.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
