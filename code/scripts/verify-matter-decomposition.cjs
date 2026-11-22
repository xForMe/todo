// TEST-017 / TEST-024 / TEST-025: offline Chrome against the built React UI.
// Set NODE_PATH=code/frontend-react/node_modules if Playwright isn't already on the module path.
const {chromium}=require('playwright');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const react=true,mode=react?'react':'native';
const base='http://127.0.0.1:18887',root=path.resolve(__dirname,'../frontend-react/public'),bundle='/dist/workbench-react.js';
const output=path.resolve(__dirname,'../../runtime',`matter-planning-ui${react?'-react':''}`);
const planningWidths=[1440,1024,887,768,375],modelWidths=[1440,1024,768,646,375]; // Four common widths plus existing breakpoints.
const mockKey='synthetic-model-api-key',discardedKey='synthetic-unsaved-model-key';
const scenes={image_analysis:'图片分析',matter_decomposition:'事情拆解',event_decomposition:'事件拆分',
 event_predecessors:'前置推荐',daily_follow_up:'当日跟进',source_recognition:'飞书资料识别'};

const planningHosts=[
 ['header.mpHeader > .mpTop > div#mpTools',['#mpType','#mpType option[value=feature]','#mpGenerate']],
 ['.mpBody > section#mpSplit',['#mpInstructions','#mpAdd','#mpRows','.mpCandidate','.mpCandidate [data-field=selected]',
  '.mpCandidate [data-edit]','.mpCandidate [data-remove]']],
 ['.mpLayout > footer.mpFooter',['#mpCount','#mpAccept','#mpRecover','#mpRetry']],
];

const settingsTabs=[
 ['mpChannelsTab','mpChannelsPanel','数据渠道'], ['mpPromptsTab','mpPromptsPanel','提示词'],
 ['mpStorageTab','mpStoragePanel','图片存储'], ['mpModelTab','mpModelPanel','大模型'],
];

async function assertRoot(host,original,controls){
 const actual=await host.evaluate((host,{original,controls,react})=>{
  const nodes=[...host.querySelectorAll('*')];
  const reactField=(node,prefix)=>node?.[Object.getOwnPropertyNames(node).find(key=>key.startsWith(prefix))];
  const fiber=node=>reactField(node,'__reactFiber$');
  const root=reactField(host,'__reactContainer$')?.stateNode;
  const owns=node=>{
   let current=fiber(node);
   if(current?.stateNode!==node)return false;
   if(!react)return true;
   while(current.return)current=current.return;
   return current.stateNode===root;
  };
  return {original:host===original,marked:host.hasAttribute('data-react-owned'),hostFiber:fiber(host)?.stateNode===host,
   root:root?.containerInfo===host,missing:controls.filter(control=>!host.querySelector(control)),
   mismatched:nodes.filter(node=>owns(node)!==react).map(node=>node.id||node.localName),
   inline:[host,...nodes].flatMap(node=>node.getAttributeNames().filter(name=>/^on/i.test(name)).map(name=>`${node.id||node.localName}.${name}`))};
 },{original,controls,react});
 assert.deepEqual(actual,{original:true,marked:react,hostFiber:false,root:react,missing:[],mismatched:[],inline:[]},String(host));
}

async function assertDrawerChrome(drawer,originalDrawer,{settings=false,context=''}={}){
 const shell=await drawer.evaluate((node,original)=>{
  const hasReact=(el,prefix)=>Object.getOwnPropertyNames(el).some(key=>key.startsWith(prefix)&&el[key]?.stateNode===el);
  const parts=['.mpTop #mpTitle','.mpTop #mpClose','.mpHeader #mpContext','.mpBody #mpError'];
  const native=[node,node.querySelector('#mpSettings')];
  return {original:node===original,modal:node instanceof HTMLDialogElement&&node.matches(':modal'),
   labelled:node.getAttribute('aria-labelledby')==='mpTitle',
   native:native.every(el=>el&&!el.hasAttribute('data-react-owned')&&!hasReact(el,'__reactFiber$')&&
    !Object.getOwnPropertyNames(el).some(key=>key.startsWith('__reactContainer$')&&el[key])),
   parts:parts.map(selector=>{
    const el=node.querySelector(selector);
    return el&&{fiber:hasReact(el,'__reactFiber$'),inline:el.getAttributeNames().filter(name=>/^on/i.test(name))};
   })};
 },originalDrawer);
 assert.deepEqual(shell,{original:true,modal:true,labelled:true,native:true,
  parts:Array.from({length:4},()=>({fiber:react,inline:[]}))},'keep the native modal and render its chrome in the expected positions');
 assert.equal(await drawer.getByRole('heading',{name:settings?'设置':'智能拆解',exact:true}).getAttribute('id'),'mpTitle');
 assert.equal(await drawer.getByRole('button',{name:'关闭',exact:true}).getAttribute('id'),'mpClose');
 assert.equal(await drawer.locator('#mpError').getAttribute('role'),'alert');
 assert.equal(await drawer.locator('#mpContext').isVisible(),!settings);
 assert.equal(await drawer.locator('#mpContext').textContent(),context);
 for(const selector of ['#mpTools','#mpSplit'])assert.equal(await drawer.locator(selector).isVisible(),!settings,selector);
 assert.equal(await drawer.locator('#mpSettingsTabs').isVisible(),settings);
}

async function assertPlanningDrawer(drawer,originalDrawer,originalHosts,context){
 await assertDrawerChrome(drawer,originalDrawer,{context});
 for(const [index,[selector,controls]] of planningHosts.entries()){
  await assertRoot(drawer.locator(selector),originalHosts[index],controls);
 }
}

async function assertSelectedTab(tabList,panels,active,{focused=false}={}){
 const actual=await tabList.evaluate((list,{panels,focused})=>{
  const settings=list.closest('dialog').querySelector('#mpSettings');
  return [...list.querySelectorAll('[role=tab]')].map((tab,index)=>{
   const panel=tab.ownerDocument.getElementById(tab.getAttribute('aria-controls'));
   return {id:tab.id,label:tab.textContent,selected:tab.getAttribute('aria-selected'),tabIndex:tab.tabIndex,
    panel:panel?.id,original:panel===panels[index],linked:panel?.matches('[role=tabpanel]')&&
     panel.parentElement===settings&&panel.getAttribute('aria-labelledby')===tab.id,
    hidden:panel?.hidden,...(focused?{focused:tab===document.activeElement}:{})};
  });
 },{panels,focused});
 assert.deepEqual(actual,settingsTabs.map(([id,panel,label],index)=>({id,label,selected:String(index===active),tabIndex:index===active?0:-1,
  panel,original:true,linked:true,hidden:index!==active,...(focused?{focused:index===active}:{})})),`settings tab ${settingsTabs[active][0]}`);
 assert.equal(await tabList.page().locator(`#${settingsTabs[active][1]}`).isVisible(),true);
}

async function assertModelPanel(panel,originalPanel){
 const actual=await panel.evaluate((shell,original)=>{
  const tab=document.getElementById('mpModelTab'),nodes=[...shell.querySelectorAll('*')];
  const hasFiber=node=>node&&Object.getOwnPropertyNames(node).some(key=>key.startsWith('__reactFiber$')&&node[key]?.stateNode===node);
  const controls=['#modelList .modelProfileRow button','#modelEditor #modelKey','#modelSave','#modelScenes select',
   '#modelScenes option','#modelStatus','#modelRecover','#modelReload'];
  return {
   original:shell===original,native:shell.matches('section[role="tabpanel"][aria-labelledby="mpModelTab"]')&&
    shell.parentElement?.id==='mpSettings'&&tab?.getAttribute('aria-controls')===shell.id&&tab.getAttribute('aria-selected')==='true',
   marked:shell.hasAttribute('data-react-owned'),shellFiber:hasFiber(shell),owned:nodes.filter(hasFiber).length,
   missing:controls.filter(selector=>!hasFiber(shell.querySelector(selector))),
   unowned:nodes.filter(node=>!hasFiber(node)).map(node=>node.id||node.localName),
   inline:[shell,...nodes].flatMap(node=>node.getAttributeNames().filter(name=>/^on/i.test(name)).map(name=>`${node.id||node.localName}.${name}`)),
  };
 },originalPanel);
 assert.equal(actual.original,true,'preview must keep the existing tabpanel node');
 assert.equal(actual.native,true,'the original model panel must stay labelled and selected by its tab');
 assert.equal(actual.marked,react,'only the React preview may mark the model panel as React-owned');
 assert.equal(actual.shellFiber,false,'the native panel shell must not be a React host node');
 if(react){
  assert.deepEqual(actual.missing,[],'model controls and dynamic rows/options must have real DOM Fibers');
  assert.deepEqual(actual.unowned,[],'the tabpanel body must be rendered by React');
  assert.deepEqual(actual.inline,[],'React markup must not contain inline event handlers');
 }else assert.equal(actual.owned,0,'native mode must not mount React model content');
}

async function assertPromptsPanel(panel,originalPanel){
 const actual=await panel.evaluate((shell,original)=>{
  const tab=document.getElementById('mpPromptsTab'),nodes=[...shell.querySelectorAll('*')];
  const hasFiber=node=>node&&Object.getOwnPropertyNames(node).some(key=>key.startsWith('__reactFiber$')&&node[key]?.stateNode===node);
  const controls=['#mpLoadRetry','#mpNew','#mpTypes [data-type=feature]','#mpTypes [data-type=issue]',
   '#mpConfigForm','#mpName','#mpPrompt','#mpEnabled','#mpSave'];
  return {
   original:shell===original,native:shell.matches('section[role="tabpanel"][aria-labelledby="mpPromptsTab"]')&&
    shell.parentElement?.id==='mpSettings'&&tab?.getAttribute('aria-controls')===shell.id&&tab.getAttribute('aria-selected')==='true',
   marked:shell.hasAttribute('data-react-owned'),shellFiber:hasFiber(shell),
   missing:controls.filter(selector=>!shell.querySelector(selector)),
   mismatched:nodes.filter(node=>hasFiber(node)!==shell.hasAttribute('data-react-owned')).map(node=>node.id||node.localName),
   inline:[shell,...nodes].flatMap(node=>node.getAttributeNames().filter(name=>/^on/i.test(name)).map(name=>`${node.id||node.localName}.${name}`)),
  };
 },originalPanel);
 assert.deepEqual(actual,{original:true,native:true,marked:react,shellFiber:false,missing:[],mismatched:[],inline:[]},
  'the original native prompts tabpanel must contain only real React-owned descendants in preview');
}

async function assertNoKeyLeak(page,{typing=false}={}){
 const actual=await page.evaluate(async keys=>{
  const includesKey=value=>keys.some(key=>value.includes(key));
  const field=document.querySelector('#modelKey');
  return {
   type:field.type,autocomplete:field.autocomplete,valueAttribute:field.hasAttribute('value'),
   blank:field.value==='',keyInOtherFields:[...document.querySelectorAll('input,textarea,select')].some(el=>el!==field&&includesKey(el.value)),
   html:includesKey(document.documentElement.outerHTML),cookies:includesKey(document.cookie),
   storage:[localStorage,sessionStorage].some(store=>Object.keys(store).some(key=>includesKey(key)||includesKey(store.getItem(key)||''))),
   indexedDB:(await indexedDB.databases()).length,caches:(await caches.keys()).length,
  };
 },[mockKey,discardedKey]);
 assert.equal(actual.type,'password');
 assert.equal(actual.autocomplete,'new-password');
 assert.equal(actual.valueAttribute,false,'password must not have a value attribute, even while typing');
 assert.equal(actual.blank,!typing,'only the actively typed password may have a live input value');
 assert.equal(actual.keyInOtherFields,false,'no other form field may contain the key');
 assert.equal(actual.html,false,'no key may be serialized into HTML');
 assert.equal(actual.storage,false,'no key may appear in localStorage or sessionStorage');
 assert.equal(actual.cookies,false,'no key may appear in cookies');
 assert.equal(actual.indexedDB,0,'no IndexedDB may be opened by the isolated page');
 assert.equal(actual.caches,0,'no Cache Storage may be opened by the isolated page');
}

(async()=>{
 if(react)fs.accessSync(path.join(root,bundle.slice(1)),fs.constants.R_OK);
 fs.mkdirSync(output,{recursive:true});
 const browser=await chromium.launch({channel:'chrome',headless:true});
 try{
  const context=await browser.newContext({serviceWorkers:'block'}),page=await context.newPage(),errors=[],requests=[];
  await page.emulateMedia({reducedMotion:'reduce'});page.on('pageerror',e=>errors.push(e.message));
  await context.routeWebSocket('**/*',socket=>{errors.push(`Unexpected WebSocket: ${socket.url()}`);return socket.close()});
  const items=[['g','goal',null,'电力产品'],['m','module','g','电力运维'],['t','thing','m','电力运维热斑、根因分析功能']].map(([id,type,parent,name])=>({id,type,parent,name,description:'',owner:'',planStart:'',planEnd:'',status:'working',version:1}));
  const types=[{id:'feature',name:'功能交付',prompt:'原型评审、技术方案评审、发版、现场验证',version:0,enabled:true},{id:'issue',name:'问题排查',prompt:'收集证据、定位原因、验证结果',version:0,enabled:true}];
  const itemReadError='模拟事件列表读取失败';
  let failTypes=false,failGenerate=false,unknown=false,failItemRead=false,writes=0,receipt,receiptId,generated=0;
  let modelWrites=0, modelChecks=0, modelReceipt, bundleRequests=0;
  let modelCatalog={models:[],assignments:{},revision:0,scenes};
  const typesPath='/decomposition/types',featurePath=`${typesPath}/feature`;
  let staleTypes,promptReceipt,promptReceiptChecked=false,releasePromptReadback,releaseBundle;
  const promptReadbackReady=new Promise(resolve=>{releasePromptReadback=resolve});
  const bundleReady=new Promise(resolve=>{releaseBundle=resolve});
  await context.route('**/*',async route=>{
   const req=route.request(),u=new URL(req.url()),p=u.pathname.slice(4),method=req.method();
   const reject=message=>{errors.push(message);return route.abort()};
   if(u.origin!==base)return reject(`Unexpected origin: ${req.url()}`);
   if(u.pathname.startsWith('/api/')){
    requests.push({path:p,method});
    if(p==='/model-catalog'&&method==='GET')return route.fulfill({json:modelCatalog});
    if(p==='/model-catalog'&&method==='PUT'){
     modelWrites++;
     const body=req.postDataJSON();
     try{
      assert.match(body.operation_id,/^[0-9a-f-]{36}$/i);
      assert.equal(body.expected_revision,modelCatalog.revision);
      assert.deepEqual(body.models,[
       {id:body.models[0].id,name:'视觉模型',model:'vision-mock',base_url:'https://visual.example/v1',vision:true,api_key:mockKey},
       {id:body.models[1].id,name:'日常文本',model:'text-mock',base_url:'http://localhost:11434/v1',vision:false},
      ]);
      assert.deepEqual(body.assignments,{image_analysis:body.models[0].id,matter_decomposition:body.models[1].id,source_recognition:body.models[1].id});
     }catch(error){errors.push(error.message);return route.fulfill({status:400,json:{detail:'Unexpected model save payload'}})}
     modelCatalog={...modelCatalog,models:body.models.map(({api_key,...profile})=>({...profile,has_key:Boolean(api_key)})),assignments:body.assignments,revision:1};
     modelReceipt=body.operation_id;
     return route.fulfill({status:500,json:{detail:'结果待核对'}});
    }
    if(modelReceipt&&p==='/model-catalog/operations/'+modelReceipt&&method==='GET')return route.fulfill({json:modelCatalog});
    if(modelReceipt&&p==='/model-catalog/'+modelCatalog.models[0].id+'/check'&&method==='POST'){
     if(req.postData()!==null)return reject('Model check must not send credentials or business data');
     modelChecks++;
     return route.fulfill({json:{message:'目录中已找到模型'}});
    }
    if(p===typesPath&&method==='GET'){
     if(failTypes)return route.fulfill({status:503,json:{detail:'类型读取失败'}});
     if(staleTypes){
      if(!promptReceiptChecked)return route.fulfill({json:staleTypes});
      await promptReadbackReady;
      staleTypes=null;
     }
     return route.fulfill({json:types});
    }
    if(p.startsWith(`${typesPath}/`)&&method==='PUT'){
     const body=req.postDataJSON(),id=decodeURIComponent(p.slice(typesPath.length+1)),index=types.findIndex(t=>t.id===id);
     const firstFeatureSave=p===featurePath&&!promptReceipt;
     if(firstFeatureSave)staleTypes=types.slice();
     const type={id,name:body.name,prompt:body.prompt,enabled:body.enabled,version:(types[index]?.version||0)+1};
     if(index<0)types.push(type);else types[index]=type;
     const result={type};
     if(firstFeatureSave)promptReceipt={id:body.operation_id,result};
     return route.fulfill({json:result});
    }
    if(promptReceipt&&p==='/event-operations/'+promptReceipt.id&&method==='GET'){
     promptReceiptChecked=true;
     return route.fulfill({json:promptReceipt.result});
    }
    if(p==='/matters/t/decomposition'&&method==='GET')return route.fulfill({json:{snapshot:'a'.repeat(64),types,events:items.filter(x=>x.type==='event')}});
    if(p==='/matters/t/decomposition'&&method==='POST'){
     generated++;if(failGenerate)return route.fulfill({status:502,json:{detail:'模型暂不可用'}});
     const typeId=req.postDataJSON().type_id||'feature';
     return route.fulfill({json:{snapshot:'a'.repeat(64),generation_id:'00000000-0000-4000-8000-000000000001',basis:{type_id:typeId},suggestions:['评审功能原型','评审技术方案','发布功能','现场验证'].map(name=>({name,description:'核对工作范围并记录结论与待解决问题。',reason:'关键交付节点'}))}});
    }
    if(p==='/matters/t/decomposition/confirm'&&method==='POST'){
     const first=items.filter(x=>x.type==='event').length;
     writes++;const body=req.postDataJSON();const created=body.events.map((e,i)=>({...e,id:'created'+(first+i),version:1}));items.push(...created);receipt={created};receiptId=body.operation_id;
     return unknown?route.fulfill({status:503,json:{detail:'结果待核对'}}):route.fulfill({json:receipt});
    }
    if(receiptId&&p==='/event-operations/'+receiptId&&method==='GET')return route.fulfill({json:receipt});
    if(p==='/items'&&method==='GET'&&failItemRead)return route.fulfill({status:403,json:{detail:itemReadError}});
    const priorities={week:'2026-11-16',items:[]};
    const data={'/session':{},'/items':items,'/sources/suggestions':[],'/sources':[],'/sources/unmatched':[],'/sources/follow':[],
     '/image-storage':{region:'ap-shanghai',bucket:'fixture-images-1000000000',has_credentials:false,revision:0},
     '/plan-history-counts':{},'/priorities':priorities,'/workbench':{items,priorities,attention:[],branches:[],links:[],today:'2026-11-16'},
     '/events/created0/structure':{events:items.filter(x=>x.type==='event'),branches:[],links:[]}};
    if(method==='GET'&&Object.hasOwn(data,p))return route.fulfill({json:data[p]});
    return reject(`Unexpected mock API request: ${method} ${u.pathname}`);
   }
   if(method!=='GET')return reject(`Unexpected static request: ${method} ${u.pathname}`);
   // Capture the native dialog and containers before releasing the exact local preview bundle.
   if(u.pathname===bundle){
    if(!react)return reject('Native mode must not load the React bundle');
    bundleRequests++;await bundleReady;
   }
   const filename=u.pathname==='/'?'index.html':u.pathname.slice(1);
   if(u.pathname!==bundle&&!/^[\w-]+\.(?:js|css|html)$/.test(filename))return route.fulfill({status:404,body:''});
   const file=path.join(root,filename);
   return fs.existsSync(file)?route.fulfill({body:fs.readFileSync(file),contentType:filename.endsWith('.js')?'text/javascript':filename.endsWith('.css')?'text/css':'text/html'}):route.fulfill({status:404,body:''});
  });
  await page.goto(`${base}/`,{waitUntil:'commit'});
  const drawer=page.locator('#matterPlanningDrawer'),originalDrawer=await drawer.elementHandle();
  const tabList=drawer.locator('#mpSettingsTabs'),originalTabList=await tabList.elementHandle();
  const originalPanels=await Promise.all(settingsTabs.map(([,id])=>drawer.locator(`#${id}`).elementHandle()));
  const [originalChannels,originalPrompts,originalStorage,originalPanel]=originalPanels;
  const originalHosts=await Promise.all(planningHosts.map(([selector])=>drawer.locator(selector).elementHandle()));
   for(const host of [originalChannels,originalPrompts,originalPanel,...originalHosts])assert.equal(await host.evaluate(node=>node.childNodes.length),0,
    'Settings and planning React hosts must not contain old fields before the bundle');
  releaseBundle();
  if(react){
   for(const selector of ['#mpModelPanel[data-react-owned] #modelEditor','#mpPromptsPanel[data-react-owned] #mpConfigForm',
    '#mpStoragePanel[data-react-owned] #imageConfigForm','#mpSettingsTabs[data-react-owned] #mpModelTab',
    '#mpChannelsPanel[data-react-owned] #mpSource'])await drawer.locator(selector).waitFor({state:'attached'});
  }
  await page.waitForFunction(()=>db.items.length===3);await page.evaluate(()=>showWorkbench('work'));
  await page.locator('#matterPlanningEntry').click();await page.waitForSelector('.mpCandidate');assert.equal(await page.locator('.mpCandidate').count(),4);assert.equal(await page.locator('#mpType').inputValue(),'feature');assert.equal(writes,0);
  await assertPlanningDrawer(drawer,originalDrawer,originalHosts,items[2].name);
  for(const width of planningWidths){
   await page.setViewportSize({width,height:871});
   const layout=await page.evaluate(()=>{const d=document.querySelector('#matterPlanningDrawer'),h=d.querySelector('.mpHeader').getBoundingClientRect(),s=d.querySelector('#mpType').getBoundingClientRect();return{overflow:d.scrollWidth>d.clientWidth+1,header:s.bottom<=h.bottom,rows:[...d.querySelectorAll('.mpCandidate')].map(x=>x.getBoundingClientRect().height)}});
   assert.equal(layout.overflow,false);assert.equal(layout.header,true);await page.screenshot({path:path.join(output,`planning-${width}.png`)});
  }
  await page.setViewportSize({width:887,height:871});await page.locator('[data-edit="0"]').click();await page.locator('[data-field="name"]').fill('评审并确认原型');await page.locator('.mpEdit [data-edit="0"]').click();
  failGenerate=true;await page.locator('#mpGenerate').click();await page.waitForFunction(()=>document.querySelector('#mpError').textContent.includes('模型暂不可用'));assert.match(await page.locator('#mpRows').innerText(),/评审并确认原型/);
  await drawer.locator('.mpCandidate').first().locator('[data-edit="0"]').click();
  await drawer.locator('[data-field=owner]').fill('合成负责人');
  await drawer.locator('#mpSplit summary').click();
  await drawer.locator('#mpInstructions').fill('只拆关键验收节点');
  const lastSelected=drawer.locator('.mpCandidate').nth(3).locator('[data-field=selected]');
  await lastSelected.uncheck();
  const beforeDraftClose=generated;
  await page.keyboard.press('Escape');await drawer.waitFor({state:'hidden'});
  await page.locator('#matterPlanningEntry').click();await drawer.locator('.mpEdit').waitFor();
  assert.equal(await drawer.locator('[data-field=name]').inputValue(),'评审并确认原型');
  assert.equal(await drawer.locator('[data-field=owner]').inputValue(),'合成负责人');
  assert.equal(await drawer.locator('#mpInstructions').inputValue(),'只拆关键验收节点');
  assert.equal(await lastSelected.isChecked(),false);
  assert.match(await drawer.locator('#mpCount').innerText(),/3\s*\/\s*4/);
  assert.equal(generated,beforeDraftClose,'reopening a draft must not generate replacements');
  assert.equal(writes,0,'editing and reopening must not create events');
  await assertPlanningDrawer(drawer,originalDrawer,originalHosts,items[2].name);
  await drawer.locator('.mpEdit [data-edit="0"]').click();
  failGenerate=false;await page.locator('#mpType').selectOption('issue');assert.equal(await page.locator('#mpAccept').isDisabled(),true);await page.locator('#mpGenerate').click();await page.waitForFunction(()=>!document.querySelector('#mpAccept').disabled);
  await page.locator('.mpCandidate').nth(3).locator('[data-field=selected]').uncheck();unknown=true;await page.locator('#mpAccept').click();await page.waitForFunction(()=>!document.querySelector('#mpRecover').hidden);const before=writes;await page.locator('#mpRecover').click();await page.waitForFunction(()=>!document.querySelector('#matterPlanningDrawer').open);assert.equal(writes,before);assert.equal(items.filter(x=>x.type==='event').length,3);

  // Acknowledged POST + readback 403 is distinct from the unknown POST tested above.
  const unknownReceiptId=receiptId,confirmPath='/matters/t/decomposition/confirm',extraEvent='核对已保存事件';
  unknown=false;
  await page.locator('#matterPlanningEntry').click();await drawer.locator('.mpCandidate').first().waitFor();
  await drawer.locator('.mpCandidate').nth(3).locator('[data-field=selected]').uncheck();
  await drawer.locator('#mpAdd').click();
  await drawer.locator('.mpEdit [data-field=name]').fill(extraEvent);
  assert.match(await drawer.locator('#mpCount').innerText(),/1\s*\/\s*5/);
  const requestStart=requests.length;
  const saveExchange=()=>requests.slice(requestStart).filter(r=>[confirmPath,'/items'].includes(r.path)||r.path.startsWith('/event-operations/'));
  failItemRead=true;
  const [confirmed,readback]=await Promise.all([
   page.waitForResponse(r=>new URL(r.url()).pathname===`/api${confirmPath}`&&r.request().method()==='POST'),
   page.waitForResponse(r=>new URL(r.url()).pathname==='/api/items'&&r.request().method()==='GET'),
   drawer.locator('#mpAccept').click(),
  ]);
  assert.equal(confirmed.status(),200);assert.equal(readback.status(),403);
  await page.waitForFunction(()=>document.querySelector('#mpError').textContent.includes('已收到保存响应'));
  assert.match(await drawer.locator('#mpError').innerText(),/未能读回.*核对结果/);
  assert.equal(await drawer.locator('#mpAccept').isDisabled(),true);
  assert.equal(await drawer.locator('#mpGenerate').isDisabled(),true);
  assert.equal(await drawer.locator('#mpRecover').isVisible(),true);
  assert.equal(await drawer.locator('#mpRetry').isVisible(),false,'an acknowledged write may only be checked, not resent');
  assert.match(receiptId,/^[0-9a-f-]{36}$/i);assert.notEqual(receiptId,unknownReceiptId);
  const pendingId=()=>page.evaluate(()=>JSON.parse(sessionStorage.getItem('todo.matterPlanningWrite'))?.body.operation_id);
  assert.equal(await pendingId(),receiptId);
  assert.equal(await page.locator('#events').getByText(extraEvent,{exact:true}).isVisible(),false);
  const postConfirm={path:confirmPath,method:'POST'},getItems={path:'/items',method:'GET'},getReceipt={path:`/event-operations/${receiptId}`,method:'GET'};
  assert.deepEqual(saveExchange(),[postConfirm,getItems]);
  await drawer.locator('#mpRecover').click();
  await page.waitForFunction(message=>document.querySelector('#mpError').textContent.includes(message),itemReadError);
  assert.equal(await pendingId(),receiptId,'a receipt whose records still cannot be read leaves the same operation pending');
  assert.equal(await drawer.locator('#mpRetry').isVisible(),false);
  assert.deepEqual(saveExchange(),[postConfirm,getItems,getReceipt,getItems]);
  await page.keyboard.press('Escape');await drawer.waitFor({state:'hidden'});
  assert.equal(await pendingId(),receiptId);
  failItemRead=false;
  await page.locator('#matterPlanningRecovery').click();
  await drawer.waitFor({state:'hidden'});
  await page.locator('#events').getByText(extraEvent,{exact:true}).waitFor();
  assert.equal(await pendingId(),undefined);
  assert.equal(await page.locator('#matterPlanningRecovery').isVisible(),false);
  assert.equal(writes,before+1);assert.equal(items.filter(x=>x.type==='event').length,4);
  assert.deepEqual(saveExchange(),[postConfirm,getItems,getReceipt,getItems,getReceipt,getItems]);
  const settings=page.locator('#workspaceSettings'),channelsPanel=drawer.locator('#mpChannelsPanel');
  const selected=(index,options)=>assertSelectedTab(tabList,originalPanels,index,options);
  const keyTab=async(key,index)=>{await page.keyboard.press(key);await selected(index,{focused:true})};
  await settings.click();await page.waitForFunction(()=>!document.querySelector('#mpSave').disabled);
  await assertDrawerChrome(drawer,originalDrawer,{settings:true});
  assert.equal(await tabList.getAttribute('role'),'tablist');assert.equal(await tabList.getAttribute('aria-label'),'设置分类');
  await assertRoot(tabList,originalTabList,settingsTabs.map(([id])=>`#${id}`));
  await assertRoot(channelsPanel,originalChannels,['.mpChannel strong','.mpChannel p','#mpSource']);
  await selected(0);assert.equal(await page.locator('#mpRefresh').count(),0);
  assert.equal(await channelsPanel.locator('strong').innerText(),'飞书聊天');
  assert.equal(await channelsPanel.locator('p').innerText(),'管理聊天来源与读取授权');
  for(const width of planningWidths){await page.setViewportSize({width,height:871});assert.equal(await drawer.evaluate(d=>d.scrollWidth>d.clientWidth+1),false);await page.screenshot({path:path.join(output,`channels-${width}.png`)});}

  // The channel switch only reads the intercepted source list and returns focus to Settings.
  const sourceDrawer=page.locator('#sourceDrawer'),sourceStart=requests.length;
  await Promise.all([page.waitForResponse(r=>r.url()===`${base}/api/sources`&&r.request().method()==='GET'&&r.ok()),
   channelsPanel.getByRole('button',{name:'管理',exact:true}).click()]);
  await sourceDrawer.getByRole('heading',{name:'设置 · 聊天来源',exact:true}).waitFor();
  await sourceDrawer.getByText('当前上下文尚未关联来源',{exact:true}).waitFor();
  assert.equal(await drawer.isVisible(),false);assert.equal(await page.locator('dialog:modal').count(),1);
  assert.deepEqual(requests.slice(sourceStart).filter(r=>r.path==='/sources'),[{path:'/sources',method:'GET'}]);
  await sourceDrawer.getByRole('button',{name:'关闭',exact:true}).click();await sourceDrawer.waitFor({state:'hidden'});
  await page.waitForFunction(()=>document.activeElement?.id==='workspaceSettings');
  await settings.press('Enter');await page.waitForFunction(()=>!document.querySelector('#mpSave').disabled);
  await selected(0);

  const promptsPanel=drawer.locator('#mpPromptsPanel'),prompt=promptsPanel.locator('#mpPrompt'),promptSave=promptsPanel.locator('#mpSave');
  const promptText='重点关注上线后的验证';
  const draftStart=requests.length;
  await drawer.locator('#mpPromptsTab').click();await selected(1);await assertPromptsPanel(promptsPanel,originalPrompts);await prompt.fill(promptText);
  await drawer.locator('#mpChannelsTab').click();await selected(0);await keyTab('ArrowRight',1);assert.equal(await prompt.inputValue(),promptText);
  await keyTab('ArrowRight',2);
  const storagePanel=drawer.locator('#mpStoragePanel'),region=storagePanel.locator('#imageRegion'),bucket=storagePanel.locator('#imageBucket');
  await page.waitForFunction(()=>document.querySelector('#imageRegion')?.value==='ap-shanghai');
  await assertRoot(storagePanel,originalStorage,['#imageConfigForm','#imageRegion','#imageBucket','#imageConfigSave','#imageConfigCheck']);
  const countStorageReads=()=>requests.filter(r=>r.path==='/image-storage'&&r.method==='GET').length;
  const storageReads=countStorageReads();
  await region.fill('ap-guangzhou');await bucket.fill('draft-images-1000000000');
  await drawer.locator('#mpStorageTab').focus();await keyTab('End',3);
  const draftModelName=drawer.locator('#modelName');
  await drawer.locator('#modelAdd').click();await draftModelName.fill('未提交模型草稿');
  await drawer.locator('#mpModelTab').focus();await keyTab('ArrowRight',0);await keyTab('ArrowLeft',3);
  assert.equal(await draftModelName.isVisible(),true);assert.equal(await draftModelName.inputValue(),'未提交模型草稿');
  await drawer.locator('#mpModelPanel').getByRole('button',{name:'取消',exact:true}).click();
  await drawer.locator('#mpModelTab').focus();await keyTab('ArrowLeft',2);
  assert.equal(await region.inputValue(),'ap-guangzhou');assert.equal(await bucket.inputValue(),'draft-images-1000000000');
  assert.equal(countStorageReads(),storageReads,'switching back to a dirty storage panel must not reload the draft');
  await keyTab('Home',0);await keyTab('End',3);await keyTab('ArrowLeft',2);await keyTab('ArrowLeft',1);
  assert.equal(await prompt.inputValue(),promptText);
  assert.deepEqual(requests.slice(draftStart).filter(r=>r.method!=='GET'),[],'tab changes and draft edits must not write');

  // The PUT and catalog GET both return 200, but that list still lacks the saved version.
  const promptStart=requests.length;
  const promptExchange=()=>requests.slice(promptStart).filter(r=>r.path===typesPath||r.path.startsWith(`${typesPath}/`)||r.path.startsWith('/event-operations/'));
  const forResponse=(p,method)=>r=>new URL(r.url()).pathname===`/api${p}`&&r.request().method()===method;
  const [promptSaved,staleRead]=await Promise.all([
   page.waitForResponse(forResponse(featurePath,'PUT')),page.waitForResponse(forResponse(typesPath,'GET')),promptSave.click(),
  ]);
  assert.equal(promptSaved.status(),200);assert.equal(staleRead.status(),200);
  const expectedType={id:'feature',name:'功能交付',prompt:promptText,version:1,enabled:true};
  assert.deepEqual(await promptSaved.json(),{type:expectedType});
  assert.equal((await staleRead.json()).find(t=>t.id==='feature')?.version,0);
  assert.match(promptReceipt.id,/^[0-9a-f-]{36}$/i);
  const promptBody={operation_id:promptReceipt.id,expected_version:0,name:expectedType.name,prompt:promptText,enabled:true};
  assert.deepEqual(promptSaved.request().postDataJSON(),promptBody);
  const putPrompt={path:featurePath,method:'PUT'},getTypes={path:typesPath,method:'GET'};
  const promptReceiptPath=`/event-operations/${promptReceipt.id}`,getPromptReceipt={path:promptReceiptPath,method:'GET'};
  const promptPending=()=>page.evaluate(()=>JSON.parse(sessionStorage.getItem('todo.matterPlanningWrite')));
  const expectedPending={kind:'type',path:featurePath,method:'PUT',body:promptBody,acknowledged:true};
  await page.waitForFunction(()=>document.querySelector('#mpError').textContent.includes('已收到保存响应'));
  assert.match(await drawer.locator('#mpError').innerText(),/未能读回.*核对结果/);
  assert.doesNotMatch(await page.locator('#notice').textContent(),/提示词配置已保存/);
  assert.deepEqual(await promptPending(),expectedPending);
  assert.equal(await prompt.inputValue(),promptText);
  assert.equal(await promptSave.isDisabled(),true);
  assert.equal(await drawer.locator('#mpRecover').isVisible(),true);
  assert.equal(await drawer.locator('#mpRetry').isVisible(),false,'acknowledged prompts may only be checked, not resent');
  assert.deepEqual(promptExchange(),[putPrompt,getTypes]);
  try{
   const [checked]=await Promise.all([
    page.waitForResponse(forResponse(promptReceiptPath,'GET')),
    page.waitForRequest(req=>new URL(req.url()).pathname===`/api${typesPath}`&&req.method()==='GET'),
    drawer.locator('#mpRecover').click(),
   ]);
   assert.equal(checked.status(),200);assert.deepEqual(await checked.json(),{type:expectedType});
   assert.deepEqual(await promptPending(),expectedPending,'receipt alone must not clear the same operation before the type list arrives');
   assert.equal(await promptSave.isDisabled(),true);
  }finally{releasePromptReadback()}
  await page.waitForFunction(()=>!document.querySelector('#mpSave').disabled);
  assert.equal(await promptPending(),null);
  assert.equal(await drawer.locator('#mpRecover').isVisible(),false);
  assert.equal(await drawer.locator('#mpRetry').isVisible(),false);
  assert.equal(await drawer.locator('#mpError').isVisible(),false);
  assert.match(await page.locator('#notice').textContent(),/提示词配置已保存并读回/);
  assert.equal(await prompt.inputValue(),promptText);assert.equal(types[0].prompt,promptText);
  assert.deepEqual(promptExchange(),[putPrompt,getTypes,getPromptReceipt,getTypes]);
  for(const width of planningWidths){await page.setViewportSize({width,height:871});assert.equal(await page.locator('#matterPlanningDrawer').evaluate(d=>d.scrollWidth>d.clientWidth+1),false);await page.screenshot({path:path.join(output,`settings-${width}.png`)});}
  await page.locator('#mpNew').click();await page.locator('#mpName').fill('验收');await page.locator('#mpPrompt').fill('核对范围、完成验收');await page.locator('#mpSave').click();await page.waitForFunction(()=>document.querySelector('#mpTypes').textContent.includes('验收'));assert.equal(types.length,3);
  await page.locator('#mpEnabled').uncheck();await page.locator('#mpSave').click();await page.waitForFunction(()=>document.querySelector('#mpTypes').textContent.includes('停用'));assert.equal(types[2].enabled,false);
  await page.locator('#mpPromptsTab').focus();
  await page.keyboard.press('End');
  const panel=page.locator(react?'#mpModelPanel[data-react-owned]':'#mpModelPanel');
  const add=panel.getByRole('button',{name:'新增模型'}),keyField=panel.getByLabel('API Key',{exact:true});
  const save=panel.getByRole('button',{name:'保存模型配置'}),recover=panel.getByRole('button',{name:'核对保存结果'});
  const check=panel.getByRole('button',{name:'检查模型 视觉模型'}),editVision=panel.getByRole('button',{name:'编辑模型 视觉模型'});
  const cancel=panel.getByRole('button',{name:'取消',exact:true}),confirm=panel.getByRole('button',{name:'确定',exact:true});
  const modelRequests=()=>requests.filter(r=>r.path.startsWith('/model-catalog')&&!(r.path==='/model-catalog'&&r.method==='GET'));
  await panel.waitFor();
  assert.equal(await page.locator('#mpModelTab').evaluate(tab=>document.activeElement===tab),true,'End focuses the model tab');
  await assertNoKeyLeak(page);
  await add.click();await keyField.fill(discardedKey);await assertNoKeyLeak(page,{typing:true});
  await cancel.click();await assertNoKeyLeak(page);
  assert.equal(await panel.locator('.modelProfileRow').count(),0);
  async function createModel(name,address,vision,key=''){
   await add.click();
   await panel.getByLabel('显示名称').fill(name);
   await panel.getByLabel('模型 ID').fill(name==='视觉模型'?'vision-mock':'text-mock');
   await panel.getByLabel('模型地址').fill(address);
   if(vision)await panel.getByLabel('支持图片输入').check();
   if(key){await keyField.fill(key);await assertNoKeyLeak(page,{typing:true})}
   await confirm.click();await assertNoKeyLeak(page);
  }
  await createModel('视觉模型','https://visual.example/v1',true,mockKey);
  await createModel('日常文本','http://localhost:11434/v1',false);
  await assertModelPanel(panel,originalPanel);
  const scene=name=>panel.locator('.modelScene').filter({hasText:name}).locator('select');
  assert.equal(await panel.locator('.modelScene select').count(),Object.keys(scenes).length);
  for(const name of Object.values(scenes)){
   assert.deepEqual(await scene(name).locator('option').allTextContents(),name==='图片分析'?
    ['沿用现有配置','视觉模型']:['沿用现有配置','视觉模型','日常文本']);
   assert.equal(await scene(name).inputValue(),'');
  }
  assert.equal(await panel.locator('#modelSourceNotice').isVisible(),false);
  await scene('图片分析').selectOption({label:'视觉模型'});
  await scene('事情拆解').selectOption({label:'日常文本'});
  await scene('飞书资料识别').selectOption({label:'日常文本'});
  assert.equal(await panel.locator('#modelSourceNotice').isVisible(),true);
  await editVision.click();
  await panel.getByRole('button',{name:'移除模型'}).click();
  assert.match(await panel.locator('#modelStatus').innerText(),/先调整/);
  await cancel.click();await assertNoKeyLeak(page);
  await createModel('临时模型','https://temp.example/v1',false);
  await panel.getByRole('button',{name:'编辑模型 临时模型'}).click();
  await panel.getByRole('button',{name:'移除模型'}).click();
  assert.equal(await panel.locator('.modelProfileRow').count(),2);
  assert.equal(await check.isDisabled(),true);
  assert.deepEqual(modelRequests(),[],'form confirmation and scene changes only stage a draft');
  await save.click();
  await recover.waitFor();
  await page.waitForFunction(()=>document.querySelector('#modelStatus').textContent.includes('结果待核对'));
  assert.equal(await save.isDisabled(),true);assert.equal(await check.isDisabled(),true);
  assert.deepEqual(modelRequests(),[{path:'/model-catalog',method:'PUT'}]);
  await assertNoKeyLeak(page);
  await recover.click();
  await page.waitForFunction(()=>document.querySelector('#modelStatus').textContent.includes('已核对'));
  assert.equal(await recover.isVisible(),false);
  assert.deepEqual(modelRequests(),[{path:'/model-catalog',method:'PUT'},{path:'/model-catalog/operations/'+modelReceipt,method:'GET'}]);
  assert.equal(modelWrites,1);assert.equal(modelChecks,0);
  assert.equal(await scene('图片分析').inputValue(),modelCatalog.models[0].id);
  assert.equal(await scene('事情拆解').inputValue(),modelCatalog.models[1].id);
  await editVision.click();
  assert.equal(await keyField.getAttribute('placeholder'),'留空保留已有密钥');
  await assertNoKeyLeak(page);
  await assertModelPanel(panel,originalPanel);
  for(const width of modelWidths){
   await page.setViewportSize({width,height:871});
   const fits=await panel.evaluate(shell=>[shell,shell.closest('dialog'),shell.querySelector('#modelEditor')]
    .every(node=>node.scrollWidth<=node.clientWidth+1));
   assert.equal(fits,true,`model settings and editor must fit at ${width}px`);
   await page.screenshot({path:path.join(output,`model-editor-${width}.png`)});
  }
  await cancel.click();
  await check.click();
  await page.waitForFunction(()=>document.querySelector('#modelStatus').textContent.includes('目录中已找到'));
  assert.equal(modelChecks,1);
  assert.deepEqual(modelRequests().slice(2),[{path:'/model-catalog/'+modelCatalog.models[0].id+'/check',method:'POST'}]);
  await assertNoKeyLeak(page);
  for(const width of modelWidths){
   await page.setViewportSize({width,height:871});
   assert.equal(await page.locator('#matterPlanningDrawer').evaluate(d=>d.scrollWidth>d.clientWidth+1),false);
   await page.screenshot({path:path.join(output,`model-settings-${width}.png`)});
  }
  await page.keyboard.press('Escape');await drawer.waitFor({state:'hidden'});failTypes=true;
  await settings.click();await selected(0);await drawer.locator('#mpPromptsTab').click();await selected(1);
  await page.waitForSelector('#mpLoadRetry:not([hidden])');assert.equal(await page.locator('#mpSave').isDisabled(),true);
  await assertDrawerChrome(drawer,originalDrawer,{settings:true});
  assert.match(await drawer.getByRole('alert').innerText(),/类型读取失败/);
  failTypes=false;await page.locator('#mpLoadRetry').click();await page.waitForFunction(()=>!document.querySelector('#mpSave').disabled);assert.equal(await page.locator('#mpLoadRetry').isVisible(),false);
  await assertPromptsPanel(promptsPanel,originalPrompts);
  assert.equal(await drawer.locator('#mpError').isVisible(),false);
  await drawer.getByRole('button',{name:'关闭',exact:true}).click();await drawer.waitFor({state:'hidden'});
  await page.waitForFunction(()=>document.activeElement?.id==='workspaceSettings');
  await Promise.all([originalDrawer,originalTabList,...originalHosts,...originalPanels].map(host=>host.dispose()));
  assert.equal(bundleRequests,react?1:0);
  assert.deepEqual(errors,[]);
  const checks=['auto type','top controls','compact rows','edit','failed generation preserves edits','manual type','confirm selection',
   'unknown result no resend','draft reopen preserves edits, instructions and selection without regenerating',
   'acknowledged write with readback 403 stays pending and recovers the same operation without resending',
   'original native planning dialog; close, context and feedback in both modes','settings edit/create/disable',
   'four ARIA-linked settings tabs with roving tabIndex, wrapping arrows, Home and End','original tabpanels and prompt, storage and model drafts survive switching',
   'chat source opens from settings using only mocked reads and restores focus','type load failure and retry',
   'acknowledged prompt PUT with stale 200 list stays pending until the original receipt and matching list are read without resending',
   'model create edit and remove','six scene selectors and vision filter','explicit save and same-operation receipt',
   'key only in live password entry and explicit save payload','saved key not read back','explicit bodyless model directory check','Escape'];
  if(react)checks.push('native tabpanel shell with Fiber-owned content and no inline handlers',
   'original native prompts tabpanel with Fiber-owned content and no inline handlers',
   'original planning tools, candidates and footer hosts contain real Fibers with no inline handlers',
   'original tabs and channels host separate React roots; title, close, context and feedback have real Fibers without inline handlers');
  fs.writeFileSync(path.join(output,'report.json'),JSON.stringify({passed:true,mode,widths:[1440,1024,887,768,646,375],planningWidths,modelWidths,
   checks,writes,generated,modelWrites,modelChecks,bundleRequests,realWrites:0,errors},null,2));
  console.log(`Matter planning browser checks passed (${mode})`);
 }finally{await browser.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
