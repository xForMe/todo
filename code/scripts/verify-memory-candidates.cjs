// TEST-016: real frontend assets; synthetic candidates, no business service requests.
const {chromium}=require('playwright');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const output=path.resolve(__dirname,'../../runtime/memory-candidates-ui');fs.mkdirSync(output,{recursive:true});
(async()=>{
 const browser=await chromium.launch({channel:'chrome',headless:true});
 try{
  const page=await browser.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
  const items=[['g','goal',null,'年度目标'],['m','module','g','客户交付'],['t','thing','m','上线准备']].map(([id,type,parent,name])=>({id,type,parent,name,description:'',owner:'',planStart:'',planEnd:'',status:'notStarted',version:1}));
  const card={module_id:'m',path:'年度目标 / 客户交付',scope_version:'a'.repeat(64),version:1,description:'负责客户实施和验收',aliases:[],enabled:true,usable:true,status:'已确认'};
  const candidate=id=>({id,module_id:'m',path:card.path,source_id:'s',usable:true,status:'待核对',current:{...card},description:card.description,aliases:['华东一期'],draft:{module_id:'m',kind:'alias',description:'',aliases:['华东一期'],reason:'原文明确说明稳定简称',evidence:'客户交付模块简称华东一期。<img src=x onerror=alert(1)> '+ 'LongUnbrokenText'.repeat(7)}});
  let list=[candidate('c1'),{...candidate('c2'),usable:false,draft:null,current:null,status:'来源已变化，原文不再展示',description:'',aliases:[]}];
  let mode='normal',writes=0,receipt,readFailure=false,basisValid=true;
  const suggestion={id:'sg',source_id:'s',source_kind:'chat',thing_id:'t',event_id:null,action:'new',state:'pending',body:JSON.stringify({name:'合成新行动',evidence:'明天核对接口',owner:'',plan_end:'',status:'notStarted',module_id:'m',goal_id:'g',placement_reason:'模块职责匹配'})};
  await page.route('**/*',async route=>{
   const url=new URL(route.request().url());
   if(url.pathname.startsWith('/api/')){
    const endpoint=url.pathname.slice(4);
    if(endpoint==='/memory/candidates')return readFailure?route.fulfill({status:503,json:{detail:'候选存储暂不可用'}}):route.fulfill({json:{items:list,partial:false,capacity_full:mode==='full'}});
    if(endpoint==='/memory/modules/m'&&route.request().method()==='PUT'){
     writes++;if(mode==='conflict')return route.fulfill({status:409,json:{detail:'模块或记忆已变化，请刷新核对'}});
     const data=route.request().postDataJSON();assert.equal(data.candidate_id,'c1');
     receipt={...card,...data,version:2};list=list.filter(x=>x.id!=='c1');
     if(mode==='unknown')return route.fulfill({status:503,json:{detail:'保存结果待核对'}});
     return route.fulfill({json:receipt});
    }
    if(endpoint.startsWith('/memory/operations/'))return route.fulfill({json:receipt});
    if(endpoint.endsWith('/reject')){list=list.filter(x=>!endpoint.includes(x.id));return route.fulfill({json:{state:'rejected'}});}
    if(endpoint==='/memory/suggestions/sg/basis')return route.fulfill({json:{items:[{module_id:'m',revision:1,valid:basisValid,path:basisValid?card.path:'',description:basisValid?card.description:'',aliases:[],status:basisValid?'当前有效':'引用版本或授权已失效，正文不再展示'}],note:'模型明确报告且经服务端核对的引用，不代表完整内部推理'}});
    const priorities={week:'2026-11-16',items:[]};
    const data={'/session':{},'/items':items,'/sources/suggestions':[suggestion],'/sources':[{id:'s',kind:'chat'}],'/sources/unmatched':[], '/priorities':priorities,'/workbench':{items,priorities,attention:[],branches:[],links:[],today:'2026-11-16'}};
    return route.fulfill({json:data[endpoint]||[]});
   }
   const filename=path.basename(url.pathname==='/'?'index.html':url.pathname),file=path.resolve(__dirname,'../frontend',filename);
   if(!fs.existsSync(file))return route.fulfill({status:404,body:''});
   return route.fulfill({body:fs.readFileSync(file),contentType:filename.endsWith('.js')?'text/javascript':filename.endsWith('.css')?'text/css':'text/html'});
  });
  await page.goto('http://127.0.0.1:18883/');await page.waitForFunction(()=>db.items.length===3);
  await page.locator('#memoryCandidatesEntry').click();
  const drawer=page.locator('#memoryCandidatesDrawer');await page.locator('form[data-candidate-id="c1"] textarea').first().waitFor();
  assert.equal(await page.locator('dialog[open]').count(),1);assert.equal(await drawer.locator('img').count(),0);
  assert.equal(await page.locator('form[data-candidate-id="c2"] textarea').count(),0);
  assert.equal(await page.locator('#memoryCandidatesClose').evaluate(e=>e===document.activeElement),true);
  for(const width of [1440,1024,768,375]){
   await page.setViewportSize({width,height:960});await page.evaluate(()=>Promise.all(document.getAnimations().map(a=>a.finished.catch(()=>{}))));
   await drawer.locator('details').first().evaluate(e=>e.open=true);
   const box=await drawer.boundingBox();assert.ok(box.x>=0&&box.x+box.width<=width+1);assert.ok(await drawer.evaluate(e=>e.scrollWidth<=e.clientWidth));
   await page.screenshot({path:path.join(output,`candidates-${width}.png`),fullPage:true});
  }
  const form=page.locator('form[data-candidate-id="c1"]');mode='conflict';
  await form.locator('textarea').first().fill('保留我核对后的职责');await form.getByRole('button',{name:'确认更新记忆'}).click();
  await page.waitForFunction(()=>document.querySelector('#memoryCandidatesError').textContent.includes('输入已保留'));
  assert.equal(await form.locator('textarea').first().inputValue(),'保留我核对后的职责');
  mode='unknown';await form.getByRole('button',{name:'确认更新记忆'}).click();
  await page.waitForFunction(()=>document.querySelector('#memoryCandidatesError').textContent.includes('不要重复提交'));
  assert.equal(await form.getByRole('button',{name:'确认更新记忆'}).isDisabled(),true);const before=writes;
  await page.keyboard.press('Escape');await page.reload();await page.waitForFunction(()=>db.items.length===3);
  assert.ok((await page.locator('#memoryCandidatesEntry').textContent()).includes('待核对'));
  await page.locator('#memoryCandidatesEntry').click();await page.locator('#memoryCandidatesRecover').click();
  await page.waitForFunction(()=>document.querySelector('#memoryCandidatesRecover').hidden);assert.equal(writes,before);
  await page.locator('form[data-candidate-id="c2"]').getByRole('button',{name:'拒绝候选'}).click();
  await page.waitForFunction(()=>document.querySelector('#memoryCandidatesList').textContent.includes('暂无待确认'));
  readFailure=true;await page.locator('#memoryCandidatesRefresh').click();await page.waitForFunction(()=>document.querySelector('#memoryCandidatesError').textContent.includes('存储暂不可用'));
  await page.keyboard.press('Escape');
  await page.evaluate(s=>{if(!aiSources.length)aiSources=[{id:'s',kind:'chat'}];openSuggestion(s);},suggestion);
  await page.waitForFunction(()=>document.querySelector('#suggestionMemoryBasis').textContent.includes('当前有效'));
  assert.ok((await page.locator('#suggestionMemoryBasis').textContent()).includes('第1版'));
  await page.keyboard.press('Escape');basisValid=false;await page.evaluate(s=>openSuggestion(s),suggestion);
  await page.waitForFunction(()=>document.querySelector('#suggestionMemoryBasis').textContent.includes('已失效'));
  assert.ok(!(await page.locator('#suggestionMemoryBasis').textContent()).includes('负责客户实施和验收'));
  assert.deepEqual(errors,[]);
  fs.writeFileSync(path.join(output,'report.json'),JSON.stringify({passed:true,widths:[1440,1024,768,375],checks:['candidate review','redacted source','escaped evidence','responsive','conflict preserves input','uncertain confirmation survives reload','receipt without resend','reject','empty and read failure','explicit citation','stale citation redacted','keyboard focus and Escape'],businessWrites:0,externalCalls:0,errors},null,2));
  console.log('Memory candidates browser checks passed');
 }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
