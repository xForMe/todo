// TEST-017: isolated Chrome, all requests served locally; no business writes.
const {chromium}=require('playwright');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const output=path.resolve(__dirname,'../../runtime/matter-planning-ui');fs.mkdirSync(output,{recursive:true});
(async()=>{
 const browser=await chromium.launch({channel:'chrome',headless:true});
 try{
  const page=await browser.newPage();await page.emulateMedia({reducedMotion:'reduce'});const errors=[];page.on('pageerror',e=>errors.push(e.message));
  const items=[['g','goal',null,'电力产品'],['m','module','g','电力运维'],['t','thing','m','电力运维热斑、根因分析功能']].map(([id,type,parent,name])=>({id,type,parent,name,description:'',owner:'',planStart:'',planEnd:'',status:'working',version:1}));
  const types=[{id:'feature',name:'功能交付',prompt:'原型评审、技术方案评审、发版、现场验证',version:0,enabled:true},{id:'issue',name:'问题排查',prompt:'收集证据、定位原因、验证结果',version:0,enabled:true}];
  let failTypes=false,failGenerate=false,unknown=false,writes=0,receipt,generated=0;
  let modelWrites=0, modelChecks=0, modelReceipt;
  let modelCatalog={models:[],assignments:{},revision:0,scenes:{image_analysis:'图片分析',matter_decomposition:'事情拆解',source_recognition:'飞书资料识别'}};
  await page.route('**/*',async route=>{
   const u=new URL(route.request().url()),p=u.pathname.slice(4),method=route.request().method();
   if(u.pathname.startsWith('/api/')){
    if(p==='/model-catalog'&&method==='GET')return route.fulfill({json:modelCatalog});
    if(p==='/model-catalog'&&method==='PUT'){
     modelWrites++;
     const body=route.request().postDataJSON();
     assert.equal(body.expected_revision,modelCatalog.revision);
     assert.equal(body.models.length,2);
     assert.equal(body.models[0].api_key,'mock-key');
     assert.equal(body.models[1].api_key,undefined);
     assert.equal(body.assignments.image_analysis,body.models[0].id);
     assert.equal(body.assignments.matter_decomposition,body.models[1].id);
     assert.equal(body.assignments.source_recognition,body.models[1].id);
     modelCatalog={...modelCatalog,models:body.models.map(({api_key,...profile})=>({...profile,has_key:Boolean(api_key)})),assignments:body.assignments,revision:1};
     modelReceipt=body.operation_id;
     return route.fulfill({status:500,json:{detail:'结果待核对'}});
    }
    if(p==='/model-catalog/operations/'+modelReceipt)return route.fulfill({json:modelCatalog});
    if(p==='/model-catalog/'+modelCatalog.models[0]?.id+'/check'){
     assert.equal(method,'POST');
     assert.equal(route.request().postData(),null);
     modelChecks++;
     return route.fulfill({json:{message:'目录中已找到模型'}});
    }
    if(p==='/decomposition/types')return failTypes?route.fulfill({status:503,json:{detail:'类型读取失败'}}):route.fulfill({json:types});
    if(p.startsWith('/decomposition/types/')&&method==='PUT'){
     const body=route.request().postDataJSON();const id=p.split('/').pop();let t=types.find(t=>t.id===id);if(!t){t={id};types.push(t)}Object.assign(t,{name:body.name,prompt:body.prompt,enabled:body.enabled,version:(t.version||0)+1});return route.fulfill({json:{type:t}});
    }
    if(p==='/matters/t/decomposition'){
     if(method==='GET')return route.fulfill({json:{snapshot:'a'.repeat(64),types,events:items.filter(x=>x.type==='event')}});
     generated++;if(failGenerate)return route.fulfill({status:502,json:{detail:'模型暂不可用'}});
     const typeId=route.request().postDataJSON().type_id||'feature';
     return route.fulfill({json:{snapshot:'a'.repeat(64),generation_id:'00000000-0000-4000-8000-000000000001',basis:{type_id:typeId},suggestions:['评审功能原型','评审技术方案','发布功能','现场验证'].map(name=>({name,description:'核对工作范围并记录结论与待解决问题。',reason:'关键交付节点'}))}});
    }
    if(p==='/matters/t/decomposition/confirm'){
     writes++;const body=route.request().postDataJSON();const created=body.events.map((e,i)=>({...e,id:'created'+i,version:1}));items.push(...created);receipt={created};
     return unknown?route.fulfill({status:503,json:{detail:'结果待核对'}}):route.fulfill({json:receipt});
    }
    if(p.startsWith('/event-operations/'))return route.fulfill({json:receipt});
    const priorities={week:'2026-11-16',items:[]};const data={'/session':{},'/items':items,'/sources/suggestions':[], '/sources':[], '/priorities':priorities,'/workbench':{items,priorities,attention:[],branches:[],links:[],today:'2026-11-16'}};
    return route.fulfill({json:data[p]||[]});
   }
   const filename=path.basename(u.pathname==='/'?'index.html':u.pathname),file=path.resolve(__dirname,'../frontend',filename);
   return fs.existsSync(file)?route.fulfill({body:fs.readFileSync(file),contentType:filename.endsWith('.js')?'text/javascript':filename.endsWith('.css')?'text/css':'text/html'}):route.fulfill({status:404,body:''});
  });
  await page.goto('http://127.0.0.1:18887/');await page.waitForFunction(()=>db.items.length===3);await page.evaluate(()=>showWorkbench('work'));
  await page.locator('#matterPlanningEntry').click();await page.waitForSelector('.mpCandidate');assert.equal(await page.locator('.mpCandidate').count(),4);assert.equal(await page.locator('#mpType').inputValue(),'feature');assert.equal(writes,0);
  for(const width of [1440,1024,887,768,375]){
   await page.setViewportSize({width,height:871});
   const layout=await page.evaluate(()=>{const d=document.querySelector('#matterPlanningDrawer'),h=d.querySelector('.mpHeader').getBoundingClientRect(),s=d.querySelector('#mpType').getBoundingClientRect();return{overflow:d.scrollWidth>d.clientWidth+1,header:s.bottom<=h.bottom,rows:[...d.querySelectorAll('.mpCandidate')].map(x=>x.getBoundingClientRect().height)}});
   assert.equal(layout.overflow,false);assert.equal(layout.header,true);await page.screenshot({path:path.join(output,`planning-${width}.png`)});
  }
  await page.setViewportSize({width:887,height:871});await page.locator('[data-edit="0"]').click();await page.locator('[data-field="name"]').fill('评审并确认原型');await page.locator('.mpEdit [data-edit="0"]').click();
  failGenerate=true;await page.locator('#mpGenerate').click();await page.waitForFunction(()=>document.querySelector('#mpError').textContent.includes('模型暂不可用'));assert.match(await page.locator('#mpRows').innerText(),/评审并确认原型/);
  failGenerate=false;await page.locator('#mpType').selectOption('issue');assert.equal(await page.locator('#mpAccept').isDisabled(),true);await page.locator('#mpGenerate').click();await page.waitForFunction(()=>!document.querySelector('#mpAccept').disabled);
  await page.locator('.mpCandidate').nth(3).locator('[data-field=selected]').uncheck();unknown=true;await page.locator('#mpAccept').click();await page.waitForFunction(()=>!document.querySelector('#mpRecover').hidden);const before=writes;await page.locator('#mpRecover').click();await page.waitForFunction(()=>!document.querySelector('#matterPlanningDrawer').open);assert.equal(writes,before);assert.equal(items.filter(x=>x.type==='event').length,3);
  await page.locator('.sidebarBottom button').first().click();await page.waitForFunction(()=>!document.querySelector('#mpSave').disabled);assert.deepEqual(await page.getByRole('tab').allTextContents(),['数据渠道','提示词','图片存储','大模型']);
  assert.equal(await page.locator('#mpChannelsPanel').isVisible(),true);assert.equal(await page.locator('#mpRefresh').count(),0);
  for(const width of [1440,1024,887,768,375]){await page.setViewportSize({width,height:871});assert.equal(await page.locator('#matterPlanningDrawer').evaluate(d=>d.scrollWidth>d.clientWidth+1),false);await page.screenshot({path:path.join(output,`channels-${width}.png`)});}
  await page.locator('#mpPromptsTab').click();await page.locator('#mpPrompt').fill('重点关注上线后的验证');
  await page.locator('#mpChannelsTab').click();await page.keyboard.press('ArrowRight');assert.equal(await page.locator('#mpPrompt').inputValue(),'重点关注上线后的验证');await page.locator('#mpSave').click();await page.waitForFunction(()=>!document.querySelector('#mpSave').disabled);assert.equal(types[0].prompt,'重点关注上线后的验证');
  for(const width of [1440,1024,887,768,375]){await page.setViewportSize({width,height:871});assert.equal(await page.locator('#matterPlanningDrawer').evaluate(d=>d.scrollWidth>d.clientWidth+1),false);await page.screenshot({path:path.join(output,`settings-${width}.png`)});}
  await page.locator('#mpNew').click();await page.locator('#mpName').fill('验收');await page.locator('#mpPrompt').fill('核对范围、完成验收');await page.locator('#mpSave').click();await page.waitForFunction(()=>document.querySelector('#mpTypes').textContent.includes('验收'));assert.equal(types.length,3);
  await page.locator('#mpEnabled').uncheck();await page.locator('#mpSave').click();await page.waitForFunction(()=>document.querySelector('#mpTypes').textContent.includes('停用'));assert.equal(types[2].enabled,false);
  await page.locator('#mpPromptsTab').focus();
  await page.keyboard.press('End');
  async function createModel(name, address, vision, key=''){
   await page.getByRole('button',{name:'新增模型'}).click();
   await page.getByLabel('显示名称').fill(name);
   await page.getByLabel('模型 ID').fill(name==='视觉模型'?'vision-mock':'text-mock');
   await page.getByLabel('模型地址').fill(address);
   if(vision)await page.getByLabel('支持图片输入').check();
   if(key)await page.getByLabel('API Key',{exact:true}).fill(key);
   await page.getByRole('button',{name:'确定',exact:true}).click();
  }
  await createModel('视觉模型','https://visual.example/v1',true,'mock-key');
  await createModel('日常文本','http://localhost:11434/v1',false);
  const scene=name=>page.locator('.modelScene').filter({hasText:name}).locator('select');
  assert.deepEqual(await scene('图片分析').locator('option').allTextContents(),['沿用现有配置','视觉模型']);
  await scene('图片分析').selectOption({label:'视觉模型'});
  await scene('事情拆解').selectOption({label:'日常文本'});
  await scene('飞书资料识别').selectOption({label:'日常文本'});
  assert.equal(await page.locator('#modelSourceNotice').isVisible(),true);
  await page.getByRole('button',{name:'编辑模型 视觉模型'}).click();
  await page.getByRole('button',{name:'移除模型'}).click();
  assert.match(await page.locator('#modelStatus').innerText(),/先调整/);
  await page.getByRole('button',{name:'取消',exact:true}).click();
  await createModel('临时模型','https://temp.example/v1',false);
  await page.getByRole('button',{name:'编辑模型 临时模型'}).click();
  await page.getByRole('button',{name:'移除模型'}).click();
  assert.equal(await page.getByRole('button',{name:'检查模型 视觉模型'}).isDisabled(),true);
  await page.getByRole('button',{name:'保存模型配置'}).click();
  await page.getByRole('button',{name:'核对保存结果'}).click();
  await page.waitForFunction(()=>document.querySelector('#modelStatus').textContent.includes('已核对'));
  assert.equal(await page.locator('#modelKey').inputValue(),'');
  assert.equal(modelWrites,1);
  await page.getByRole('button',{name:'检查模型 视觉模型'}).click();
  await page.waitForFunction(()=>document.querySelector('#modelStatus').textContent.includes('目录中已找到'));
  assert.equal(modelChecks,1);
  for(const width of [1440,1024,768,646,375]){
   await page.setViewportSize({width,height:871});
   assert.equal(await page.locator('#matterPlanningDrawer').evaluate(d=>d.scrollWidth>d.clientWidth+1),false);
   await page.screenshot({path:path.join(output,`model-settings-${width}.png`)});
  }
  await page.keyboard.press('Escape');failTypes=true;
  await page.locator('.sidebarBottom button').first().click();await page.locator('#mpPromptsTab').click();await page.waitForSelector('#mpLoadRetry:not([hidden])');assert.equal(await page.locator('#mpSave').isDisabled(),true);
  failTypes=false;await page.locator('#mpLoadRetry').click();await page.waitForFunction(()=>!document.querySelector('#mpSave').disabled);assert.equal(await page.locator('#mpLoadRetry').isVisible(),false);
  await page.keyboard.press('Escape');assert.equal(await page.locator('#matterPlanningDrawer').isVisible(),false);assert.deepEqual(errors,[]);
  fs.writeFileSync(path.join(output,'report.json'),JSON.stringify({passed:true,widths:[1440,1024,887,768,646,375],checks:['auto type','top controls','compact rows','edit','failed generation preserves edits','manual type','confirm selection','unknown result no resend','settings edit/create/disable','four settings tabs','tab keyboard and draft preservation','type load failure and retry','model create edit and remove','scene assignment and vision filter','model save receipt and masked key','model catalog check','Escape'],writes,generated,modelWrites,modelChecks,realWrites:0,errors},null,2));console.log('Matter planning browser checks passed');
 }finally{await browser.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
