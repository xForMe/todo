// REQ-O-010 / TEST-005: isolated browser checks; every HTTP request intercepted.
const {chromium}=require('playwright');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const out=path.resolve(__dirname,'../../runtime/follow-people-ui');fs.mkdirSync(out,{recursive:true});
(async()=>{const browser=await chromium.launch({channel:'chrome',headless:true});try{
const page=await browser.newPage();let rule=null,fail=false,queries=0,unique=false,partial=false,contextFail=false;const writes=[],errors=[];
page.on('pageerror',e=>errors.push(e.message));
const item=(id,type,parent)=>({id,type,parent,name:type,description:'',owner:type==='event'?'张三':'',planStart:'',planEnd:'2026-11-20',status:'notStarted',version:1});
const items=[item('g','goal',null),item('m','module','g'),item('t','thing','m'),item('e','event','t'),item('parent','event','t'),item('root','event','t')];
items.find(x=>x.id==='t').description='确保原型可评审';items.find(x=>x.id==='e').description='整理功能与演示流程';items.find(x=>x.id==='parent').name='下周汇报';items.find(x=>x.id==='root').name='原型交付';
const branches=[{child_id:'e',parent_id:'parent'},{child_id:'parent',parent_id:'root'}];
await page.route('**/*',async route=>{const req=route.request(),url=new URL(req.url());
if(url.pathname.startsWith('/api/')){
if(req.method()!=='GET'){writes.push(req.postDataJSON());rule={...writes.at(-1),event_id:'e',version:1,count:0,logs:[]};return route.fulfill({json:rule});}
if(url.pathname==='/api/events/e/structure'){if(contextFail)return route.fulfill({status:503,json:{detail:'模拟上下文失败'}});return route.fulfill({json:{events:items.filter(x=>x.type==='event'),branches}});}
if(url.pathname==='/api/sources/follow-people'){queries++;if(fail)return route.fulfill({status:503,json:{detail:'模拟查询失败'}});return route.fulfill({json:{people:url.searchParams.get('query')==='无人'?[]:[{id:'ou_one',name:'张三',department:'研发',enterprise_email:'a@example.com'},...((unique||url.searchParams.get('saved')==='true')?[]:[{id:'ou_two',name:'张三',department:'交付',enterprise_email:'b@example.com'}])],has_more:partial}});}
const data={'/api/session':{},'/api/items':items,'/api/workbench':{items,priorities:{items:[]},attention:[],branches:[],links:[],today:'2026-11-17'},'/api/priorities':{items:[]},'/api/sources/follow':rule?[rule]:[]};return route.fulfill({json:data[url.pathname]||[]});}
const name=path.basename(url.pathname==='/'?'index.html':url.pathname),file=path.resolve(__dirname,'../frontend',name);return route.fulfill({body:fs.existsSync(file)?fs.readFileSync(file):'',contentType:name.endsWith('.js')?'text/javascript':name.endsWith('.css')?'text/css':'text/html'});
});
await page.goto('http://127.0.0.1:18883/');await page.waitForFunction(()=>typeof get==='function'&&get('e'));await page.evaluate(()=>openFollowRule('e'));
assert.equal(await page.locator('#followPersonQuery').inputValue(),'张三');assert.equal(queries,1);
const draft=await page.locator('#followContent').inputValue();assert.match(draft,/事情「thing」/);assert.match(draft,/确保原型可评审/);assert.match(draft,/原型交付 → 下周汇报/);assert.match(draft,/整理功能与演示流程/);assert.match(draft,/2026-11-20/);
await page.locator('#followSearch').click();await page.waitForFunction(()=>document.querySelector('#followRecipient').options.length===3);assert.equal(await page.locator('#followRecipient').inputValue(),'');
await page.evaluate(()=>saveFollowRule(true));assert.equal(writes.length,0);
await page.locator('#followRecipient').selectOption('ou_two');await page.locator('#followRecipient').selectOption('ou_one');assert.equal(await page.locator('#followVerified').count(),0);
await page.locator('#followSearch').focus();for(const width of [1440,1024,768,375]){await page.setViewportSize({width,height:1000});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await page.locator('#followDrawer').evaluate(e=>e.scrollTop=0);await page.screenshot({path:path.join(out,`people-${width}.png`)});}
await page.locator('#followContent').fill('已批准的人工正文');await page.getByRole('button',{name:'保存催办配置',exact:true}).click();await page.waitForFunction(()=>document.querySelector('#followRecipient').value==='ou_one');assert.equal(await page.locator('#followContent').inputValue(),'已批准的人工正文');assert.equal(writes[0].recipient,'ou_one');assert.equal(await page.locator('#followRecipient').inputValue(),'ou_one');assert.equal(await page.locator('#followVerified').count(),0);
fail=true;await page.locator('#followSearch').click();await page.getByText(/模拟查询失败；请重新查询/).waitFor();await page.evaluate(()=>saveFollowRule(false));assert.equal(writes.at(-1).recipient,'ou_one');assert.equal(writes.at(-1).enabled,false);
fail=false;await page.locator('#followPersonQuery').fill('无人');await page.locator('#followSearch').click();await page.getByText(/未找到可识别的人员/).waitFor();assert.equal(await page.locator('#followRecipient').inputValue(),'');
rule=null;unique=true;await page.evaluate(()=>openFollowRule('e'));
assert.equal(await page.locator('#followRecipient').inputValue(),'ou_one');assert.equal(await page.locator('#followVerified').count(),0);
assert.equal(writes.length,2);await page.evaluate(()=>saveFollowRule(true));assert.equal(writes.length,3);assert.equal(writes.at(-1).enabled,true);assert.equal('verified' in writes.at(-1),false);
await page.locator('#followContent').fill('人工编辑');await page.getByRole('button',{name:'按当前上下文重新整理',exact:true}).click();assert.equal(await page.locator('#followContent').inputValue(),draft);
rule=null;partial=true;await page.evaluate(()=>openFollowRule('e'));assert.equal(await page.locator('#followRecipient').inputValue(),'');partial=false;
contextFail=true;await page.evaluate(()=>openFollowRule('e'));assert.equal(await page.locator('#followContent').inputValue(),'');await page.evaluate(()=>saveFollowRule(true));assert.equal(writes.length,3);contextFail=false;
await page.evaluate(()=>{const e=get('e'),items=db.items;const plain=makeFollowDraft(e,items,[]);if(plain.includes('上级事件'))throw Error('top level context');try{makeFollowDraft(e,items,[{child_id:'e',parent_id:'e'}]);throw Error('accepted cycle')}catch(err){if(err.message==='accepted cycle')throw err}});
await page.evaluate(async()=>{
 const original=api;let release;let first=true;
 api=async function(url,...args){if(url==='/events/e/structure'&&first){first=false;await new Promise(resolve=>release=resolve)}return original(url,...args)};
 const opening=openFollowRule('e');while(!release)await new Promise(resolve=>setTimeout(resolve,5));
 document.querySelector('#followDrawer').close();await new Promise(resolve=>setTimeout(resolve,30));
 await openFollowRule('e');document.querySelector('#followContent').value='新抽屉编辑';release();await opening;
 if(document.querySelector('#followContent').value!=='新抽屉编辑')throw Error('late response overwrote content');api=original;
});
assert.deepEqual(errors,[]);fs.writeFileSync(path.join(out,'report.json'),JSON.stringify({passed:true,widths:[1440,1024,768,375],queries,mockedWrites:writes.length},null,2));console.log('PASS: name selection, duplicate names, single-save activation without identity checkbox, saved identity, query failure/pause, empty results, four widths');
}finally{await browser.close()}})().catch(e=>{console.error(e);process.exit(1)});
