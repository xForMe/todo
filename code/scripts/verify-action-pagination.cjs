// TEST-009 / REQ-O-007: real frontend with all HTTP requests intercepted.
const {chromium}=require('playwright');
const fs=require('node:fs');
const path=require('node:path');
const assert=require('node:assert/strict');
const output=path.resolve(__dirname,'../../runtime/action-pagination-ui');
const root=path.resolve(__dirname,'../frontend-react/public'),origin='http://127.0.0.1:18883',bundle='/dist/workbench-react.js';
fs.accessSync(path.join(root,bundle.slice(1)),fs.constants.R_OK);
fs.mkdirSync(output,{recursive:true});
(async()=>{
 const browser=await chromium.launch({channel:'chrome',headless:true});
 try{
  const page=await browser.newPage(),errors=[],writes=[];
  page.on('pageerror',e=>errors.push(e.message));
  const item=(id,type,parent,name,extra={})=>({id,type,parent,name,description:'',owner:'',planStart:'',planEnd:'',status:'notStarted',version:1,...extra});
  const base=[item('g','goal',null,'目标一'),item('m','module','g','模块'),item('t','thing','m','事情'),item('g2','goal',null,'目标二'),item('m2','module','g2','模块二'),item('t2','thing','m2','事情二')];
  let count=11,readFailure=false,transform=x=>x;const savedItems=new Map();
  const snapshot=()=>transform({items:[...base,...Array.from({length:count},(_,i)=>item('e'+i,'event','t',`行动 ${String(i).padStart(2,'0')}`,{status:i<2?'working':'notStarted',planEnd:'2026-11-18'}))],priorities:{week:'2026-11-16',items:[]},attention:[],branches:[],links:[],today:'2026-11-16'});
  const rawSnapshot=snapshot;const currentSnapshot=()=>{const data=rawSnapshot();data.items=data.items.map(x=>savedItems.get(x.id)||x);return data;};
  await page.route('**/*',async route=>{
   const url=new URL(route.request().url());
    if(url.origin!==origin)return route.abort();
   if(url.pathname.startsWith('/api/')){
    if(route.request().method()!=='GET'){writes.push({path:url.pathname,method:route.request().method(),body:route.request().postDataJSON()});if(route.request().method()==='PUT'&&url.pathname==='/api/items/e10'){const body=route.request().postDataJSON(),current=currentSnapshot().items.find(x=>x.id==='e10'),saved={...current,...body,version:current.version+1};savedItems.set(saved.id,saved);return route.fulfill({json:saved});}return route.abort();}
    if(readFailure&&url.pathname==='/api/workbench')return route.fulfill({status:503,json:{detail:'模拟读取失败'}});
    const data={'/api/session':{},'/api/items':currentSnapshot().items,'/api/workbench':currentSnapshot(),'/api/priorities':currentSnapshot().priorities};
    return route.fulfill({json:data[url.pathname]||[]});
   }
   const name=url.pathname===bundle?bundle.slice(1):path.basename(url.pathname==='/'?'index.html':url.pathname),file=path.join(root,name);
   if(!fs.existsSync(file))return route.fulfill({status:404,body:''});
   return route.fulfill({body:fs.readFileSync(file),contentType:name.endsWith('.js')?'text/javascript':name.endsWith('.css')?'text/css':'text/html'});
  });
  // Exercise the same workbench panel that the default bundle mounts.
   await page.goto(`${origin}/`);
  await page.waitForFunction(()=>typeof wbSnapshot!=='undefined'&&wbSnapshot&&!wbLoading);
  const workbench=page.locator('#globalWorkbench[data-panels-ui="react"]');
   const pager=workbench.getByRole('navigation',{name:'行动清单分页'}),prev=pager.getByRole('button',{name:'上一页'}),next=pager.getByRole('button',{name:'下一页'}),rows=workbench.locator('.wbActionRow');
   assert.ok(await next.evaluate(node=>Object.keys(node).some(key=>key.startsWith('__reactFiber$')&&node[key]?.stateNode===node)), 'React owns pagination controls');
   assert.equal(await workbench.locator('[onclick], [onchange]').count(),0);
  const reload=()=>page.evaluate(()=>loadWorkbench());
  assert.equal(await rows.count(),10);assert.equal(await prev.isDisabled(),true);
  assert.match(await pager.innerText(),/共 11 条 · 第 1–10 条 · 第 1\/2 页/);
  const first=await rows.locator('.wbTitle').allTextContents();
  await next.click();assert.equal(await rows.count(),1);assert.equal(await next.isDisabled(),true);
  assert.match(await pager.innerText(),/第 11–11 条 · 第 2\/2 页/);
  assert.equal(new Set([...first,...await rows.locator('.wbTitle').allTextContents()]).size,11);
  await reload();assert.equal(await rows.count(),1);
  await page.locator('[data-action-category=working]').click();assert.equal(await rows.count(),2);assert.match(await pager.innerText(),/第 1\/1 页/);
  await page.locator('[data-action-category=all]').click();await next.click();
  await page.locator('#wbScope').selectOption('g2');assert.equal(await rows.count(),0);assert.match(await pager.innerText(),/共 0 条 · 第 0–0 条 · 第 1\/1 页/);
  assert.equal(await prev.isDisabled(),true);assert.equal(await next.isDisabled(),true);
  await page.locator('#wbScope').selectOption('');
  for(const size of [0,1,10,11,21]){
   count=size;await reload();await page.evaluate(()=>{wbPages.events=0;drawWorkbench()});
   assert.equal(await rows.count(),Math.min(10,size));assert.equal(await next.isDisabled(),size<=10);
  }
  await next.focus();await page.keyboard.press('Enter');assert.match(await pager.innerText(),/第 2\/3 页/);
  assert.equal(await next.evaluate(e=>e===document.activeElement),true);
  await page.keyboard.press('Enter');assert.equal(await rows.count(),1);assert.match(await pager.innerText(),/第 3\/3 页/);
  assert.equal(await prev.evaluate(e=>e===document.activeElement),true);
  await page.keyboard.press('Enter');assert.match(await pager.innerText(),/第 2\/3 页/);
  count=11;await reload();assert.equal(await rows.count(),1);count=1;await reload();assert.match(await pager.innerText(),/第 1\/1 页/);
  count=21;await reload();
  for(const width of [1440,768,375]){
   await page.setViewportSize({width,height:960});
   await page.evaluate(()=>Promise.all(document.getAnimations().map(a=>a.finished.catch(()=>{}))));
   assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
   assert.ok(await pager.evaluate(e=>e.scrollWidth<=e.clientWidth));
   await next.click();assert.equal(await rows.count(),10);await prev.click();
   await page.screenshot({path:path.join(output,`actions-${width}.png`),fullPage:true});
  }
  const sidePanels=workbench.locator('.wbStack .wbPanel');
   transform=data=>{
    const matters=Array.from({length:21},(_,i)=>item(`side${i}`,'thing','m',`侧栏事情 ${i+1}`));
    data.items.push(...matters);
    data.attention=matters.map(({id})=>({item_id:id,enabled:true}));
    data.priorities.items=matters.map(({id})=>({id,due:true}));
    return data;
   };
   await reload();
   for(const section of [sidePanels.nth(0),sidePanels.nth(1)]){
    const titles=section.locator('.wbRow .wbTitle'),sideNext=section.getByRole('button',{name:'下一页'}),sidePrev=section.getByRole('button',{name:'上一页'});
    const firstPage=await titles.allTextContents();
    assert.equal(firstPage.length,20);
    assert.equal(await sidePrev.isDisabled(),true);
    assert.match(await section.locator('.wbPager').innerText(),/共 21 条 · 第 1\/2 页/);
    await sideNext.click();
    const lastPage=await titles.allTextContents();
    assert.equal(lastPage.length,1);
    assert.equal(new Set([...firstPage,...lastPage]).size,21);
    assert.equal(await sideNext.isDisabled(),true);
    await sidePrev.click();
    assert.deepEqual(await titles.allTextContents(),firstPage);
   }
  assert.deepEqual(writes,[]);
  // REQ-O-011: the card body filters, and the arrow navigates independently.
  transform=data=>{
   data.items.push(item('other','event','t2','跨目标行动',{status:'working'}));
   data.attention=[{item_id:'t',enabled:true},{item_id:'t2',enabled:true}];
   data.priorities.items=[{id:'t',due:true},{id:'t2',due:true}];
   data.daily_reviews=[{item_id:'e0',day:data.today,reviewed_at:data.today+'T09:00:00+08:00'}];
   return data;
  };
  count=21;await reload();
  const cards=page.locator('.wbGoal'),filter=id=>page.locator(`.wbGoalFilter[value="${id}"]`),jump=id=>page.locator(`.wbGoalLink[value="${id}"]`),scope=page.locator('#wbScope');
  const homeNav=page.getByRole('button',{name:'工作台',exact:true}),workNav=page.getByRole('button',{name:'目标与事情',exact:true});
  await next.click();await filter('g2').click();
  assert.equal(await page.locator('#workPage').isVisible(),false);
  assert.equal(await cards.count(),2);assert.equal(await filter('g2').getAttribute('aria-pressed'),'true');
  assert.equal(await scope.inputValue(),'g2');assert.equal(await rows.count(),1);
  assert.match(await rows.first().innerText(),/跨目标行动/);assert.ok((await pager.innerText()).includes('第 1/1 页'));
  for(let i=0;i<2;i++){assert.equal(await sidePanels.nth(i).locator('.wbCount').innerText(),'1');assert.equal(await sidePanels.nth(i).locator('.wbTitle').innerText(),'事情二');}
  assert.equal(await rows.locator('.wbLocate').count(),0);assert.equal(await rows.locator('.dailyMark').count(),1);
  assert.equal(await cards.locator('.wbGoalLink .icon').count(),2);
  await filter('g2').focus();await page.keyboard.press('Enter');
  assert.equal(await scope.inputValue(),'');
  assert.equal(await filter('g2').getAttribute('aria-pressed'),'false');
  assert.equal(await filter('g2').evaluate(e=>e===document.activeElement),true);
  assert.equal(await page.locator('#workPage').isVisible(),false);
  await scope.selectOption('g');
  assert.equal(await filter('g').getAttribute('aria-pressed'),'true');
  assert.equal(await cards.count(),2);assert.equal(await sidePanels.first().locator('.wbTitle').innerText(),'事情');
  await page.locator('[data-action-category=working]').click();await page.locator('[data-daily-filter="done"]').click();
  await scope.selectOption('g2');assert.equal(await rows.count(),0);assert.match(await page.locator('.wbEmpty').first().innerText(),/暂无符合/);
  assert.equal(await page.locator('[data-action-category=working]').getAttribute('aria-pressed'),'true');assert.equal(await page.locator('[data-daily-filter=done]').getAttribute('aria-pressed'),'true');
  await scope.selectOption('g');assert.equal(await rows.count(),1);assert.equal(await rows.locator('.dailyMark').innerText(),'');assert.equal(await rows.locator('.dailyTime').count(),0);
  await page.locator('[data-daily-filter="pending"]').click();await page.locator('[data-action-category=all]').click();
  const normalTransform=transform;
  await next.click();
  await jump('g2').click();
  await page.locator('#workPage').waitFor({state:'visible'});
  assert.equal(await page.locator('#goalSelect').inputValue(),'g2');
  assert.equal(await page.locator('#moduleChoices input:checked').inputValue(),'m2');
  assert.equal(await page.locator('#events .detailTitle h1').innerText(),'事情二');
  assert.equal(await page.locator('#things .thing').count(),1);
  assert.equal(await workNav.getAttribute('aria-current'),'page');
  await homeNav.click();
  await page.waitForFunction(()=>wbView==='home'&&!wbLoading);
  assert.equal(await scope.inputValue(),'g');
  assert.match(await pager.innerText(),/第 2\/2 页/);

  await jump('g').focus();await page.keyboard.press('Enter');
  await page.locator('#workPage').waitFor({state:'visible'});
  assert.equal(await page.locator('#goalSelect').inputValue(),'g');
  assert.equal(await page.locator('#goalSelect').evaluate(e=>e===document.activeElement),true);
  await homeNav.click();
  await page.waitForFunction(()=>wbView==='home'&&!wbLoading);

  transform=data=>{const result=normalTransform(data);result.items.push(item('g3','goal',null,'空目标'));return result;};
  await reload();
  await jump('g3').click();
  await page.locator('#workPage').waitFor({state:'visible'});
  assert.equal(await page.locator('#goalSelect').inputValue(),'g3');
  assert.equal(await page.locator('#moduleChoices input').count(),0);
  assert.match(await page.locator('#things').innerText(),/暂无模块/);
  await homeNav.click();
  await page.waitForFunction(()=>wbView==='home'&&!wbLoading);

  transform=normalTransform;
  await jump('g3').click();
  await page.waitForFunction(()=>document.querySelector('#notice').textContent.includes('对象已删除'));
  assert.equal(await page.locator('#globalWorkbench').isVisible(),true);
  assert.equal(await jump('g3').count(),0);
  readFailure=true;
  await jump('g2').click();
  await page.waitForFunction(()=>document.querySelector('#notice').textContent.includes('读取失败'));
  assert.equal(await page.locator('#globalWorkbench').isVisible(),true);
  readFailure=false;await reload();

  transform=data=>{const result=normalTransform(data);result.items.find(x=>x.id==='g').name='很长的目标名称用于检查筛选卡片在手机和桌面显示与换行';return result;};await reload();
  for(const width of [1440,1024,768,375]){
   await page.setViewportSize({width,height:1000});
   assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'Scope layout overflow at '+width);
   assert.ok(await rows.first().evaluate(e=>e.scrollWidth<=e.clientWidth),'Action row overflow at '+width);
   await page.screenshot({path:path.join(output,'scope-'+width+'.png'),fullPage:true});
  }
  await filter('g2').locator('.wbGoalStats').click();
  assert.equal(await scope.inputValue(),'g2');
  assert.equal(await page.locator('#workPage').isVisible(),false);
  await jump('g2').locator('.icon').click();
  await page.locator('#workPage').waitFor({state:'visible'});
  assert.equal(await page.locator('#goalSelect').inputValue(),'g2');
  await homeNav.click();
  await page.waitForFunction(()=>wbView==='home'&&!wbLoading);
  transform=data=>data;await page.evaluate(()=>{wbFilter='all';dailyFilter='pending';wbSetScope('')});await reload();
  assert.deepEqual(writes,[]);
  // Direct editing uses the real form and save handler, with isolated mock persistence.
  count=11;await reload();
  const editor=page.locator('#editor');
  const closeEditor=async()=>{
   await editor.getByRole('button',{name:'取消',exact:true}).click();
   await editor.waitFor({state:'hidden'});
  };
  await rows.first().locator('.wbTitle').click();
  await editor.waitFor({state:'visible'});
  assert.equal(await page.locator('#formTitle').innerText(),'编辑事件');
  assert.equal(await page.locator('#name').inputValue(),'行动 00');
  assert.equal(await page.locator('#planEnd').inputValue(),'2026-11-18');
  assert.equal(await page.locator('#formContext').innerText(),'所属事情：事情');
  assert.equal(await page.locator('dialog[open]').count(),1);
  assert.equal(await page.locator('#globalWorkbench').isVisible(),true);
  assert.equal(await page.locator('#workPage').isVisible(),false);
  await closeEditor();
  await next.click();await rows.first().locator('.wbTitle').focus();await page.keyboard.press('Enter');
  await editor.waitFor({state:'visible'});
  assert.equal(await page.locator('#name').inputValue(),'行动 10');
  await page.locator('#name').fill('修改后行动');await page.locator('#description').fill('确认更新说明');await page.locator('#owner').fill('张工');
  await page.locator('#save').click();await editor.waitFor({state:'hidden'});
  await page.waitForFunction(()=>wbSnapshot?.items.some(x=>x.id==='e10'&&x.name==='修改后行动'));
  assert.match(await pager.innerText(),/第 2\/2 页/);
  assert.equal(writes.length,1);assert.equal(writes[0].path,'/api/items/e10');assert.equal(writes[0].body.parent,'t');assert.equal(writes[0].body.expected_version,1);
  await rows.first().locator('.wbTitle').click();await editor.waitFor({state:'visible'});
  assert.equal(await page.locator('#description').inputValue(),'确认更新说明');assert.equal(await page.locator('#owner').inputValue(),'张工');
  await closeEditor();assert.match(await pager.innerText(),/第 2\/2 页/);
  await page.locator('[data-action-category=working]').click();await rows.first().locator('.wbTitle').click();await editor.waitFor({state:'visible'});await closeEditor();
  assert.equal(await page.locator('[data-action-category=working]').getAttribute('aria-pressed'),'true');
  transform=data=>{data.items.push(item('other','event','t2','跨目标事件',{description:'另一目标内容',owner:'李工',planStart:'2026-11-16',planEnd:'2026-11-20'}));return data;};
  await reload();await page.locator('[data-action-category=all]').click();await page.locator('#wbScope').selectOption('g2');await rows.first().locator('.wbTitle').click();await editor.waitFor({state:'visible'});
  assert.equal(await page.locator('#formContext').innerText(),'所属事情：事情二');assert.equal(await page.locator('#owner').inputValue(),'李工');assert.equal(await page.locator('#planStart').inputValue(),'2026-11-16');
  for(const width of [1440,375]){await page.setViewportSize({width,height:960});await page.evaluate(()=>Promise.all(document.getAnimations().map(a=>a.finished.catch(()=>{}))));assert.ok(await editor.evaluate(e=>e.scrollWidth<=e.clientWidth));await page.screenshot({path:path.join(output,'edit-'+width+'.png')});}
  await closeEditor();
  transform=data=>data;await reload();await page.locator('#wbScope').selectOption('');
  readFailure=true;await rows.first().locator('.wbTitle').click();await page.waitForFunction(()=>wbError);assert.equal(await editor.isVisible(),false);
  readFailure=false;await reload();
  transform=data=>{data.items=data.items.filter(x=>x.id!=='e0');return data;};await rows.first().locator('.wbTitle').click();await page.waitForFunction(()=>document.querySelector('#notice').textContent.includes('事件已不可用'));assert.equal(await editor.isVisible(),false);
  transform=data=>data;await reload();
  await page.evaluate(()=>notify(''));
   transform=data=>{data.items=data.items.filter(x=>x.id!=='t');return data;};await rows.first().locator('.wbTitle').click();await page.waitForFunction(()=>document.querySelector('#notice').textContent.includes('事件已不可用'));assert.equal(await editor.isVisible(),false);
  transform=data=>data;await reload();
  await page.evaluate(()=>{pendingWrite={body:{operation_id:'test'}};});await rows.first().locator('.wbTitle').click();assert.equal(await editor.isVisible(),false);await page.evaluate(()=>pendingWrite=null);
  assert.equal(writes.length,1);assert.deepEqual(errors,[]);

  fs.writeFileSync(path.join(output,'report.json'),JSON.stringify({passed:true,counts:[0,1,10,11,21],widths:[1440,1024,768,375],checks:['10+1 rows and total','unique ordered pages','first and last disabled','filter and scope reset','goal card body filters in place and syncs with the dropdown','selecting the same goal again restores all goals','all goal cards remain visible','daily and category filters preserved','action locate removed','only the arrow navigates to the selected goal and its matters','keyboard support and focus for both goal buttons','mobile card statistics filter and mobile arrow navigates','returning preserves scope and page','empty goal opens its empty state','missing goal and read failure leave workbench visible','long goal titles at four widths','empty state','refresh preserves page','shrink clamps page','keyboard focus continuity','both sidebars render 20 + 1 rows with working pagination','direct edit on both pages','correct fields and cross-goal parent','cancel preserves filter and page','mock save and snapshot readback','keyboard open','read failure and missing event/parent rejected','pending write guarded'],realBusinessWrites:0,mockSaves:writes.length,errors},null,2));
  console.log('Action pagination browser checks passed');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
