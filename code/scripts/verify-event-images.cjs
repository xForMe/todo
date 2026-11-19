// TEST-021: independent Chrome with every HTTP request intercepted; no cloud or business writes.
const {chromium}=require('playwright');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const output=path.resolve(__dirname,'../../runtime/event-images-ui');fs.mkdirSync(output,{recursive:true});
(async()=>{
 const browser=await chromium.launch({channel:'chrome',headless:true});
 try{
  const page=await browser.newPage(),errors=[],writes=[];page.on('pageerror',e=>errors.push(e.message));
  const item=(id,type,parent)=>({id,type,parent,name:type,description:'',owner:'',planStart:'',planEnd:'',status:'notStarted',version:1});
  const items=[item('g','goal',null),item('m','module','g'),item('t','thing','m'),item('e','event','t')];
  const snapshot={items,priorities:{week:'2026-11-16',items:[]},attention:[],branches:[],links:[],today:'2026-11-18',daily_reviews:[]};
  let cfg={region:'ap-shanghai',bucket:'cc-1300161961',revision:0,has_credentials:false},images=[],lost=false;
  const receipts=new Map();
  const pixel=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZ1sAAAAASUVORK5CYII=','base64');
  await page.route('**/*',async route=>{
   const req=route.request(),url=new URL(req.url()),p=url.pathname;
   if(p==='/image.png')return route.fulfill({body:pixel,contentType:'image/png'});
   if(p.startsWith('/api/')){
    if(req.method()!=='GET')writes.push({path:p,method:req.method()});
    if(p==='/api/image-storage'){
     if(req.method()==='PUT'){const body=req.postDataJSON();cfg={region:body.region,bucket:body.bucket,revision:cfg.revision+1,has_credentials:true};receipts.set(body.operation_id,cfg);if(lost){lost=false;return route.abort();}}
     return route.fulfill({json:cfg});
    }
    if(p==='/api/image-storage/check')return route.fulfill({json:{message:'存储桶访问检查通过；尚未验证上传和下载权限'}});
    if(p.startsWith('/api/image-operations/'))return route.fulfill({json:receipts.get(p.split('/').pop())});
    if(p==='/api/events/e/images'){
     if(req.method()==='POST'){
      const raw=req.postDataBuffer().toString(),id=raw.match(/name="operation_id"\r\n\r\n([^\r]+)/)[1];
      const image={id,name:'截图.png',size:pixel.length,mime:'image/png',state:'ready',revision:2,created_at:'2026-11-18T09:00:00Z',url:'http://127.0.0.1:18889/image.png'};images.push(image);return route.fulfill({json:image});
     }return route.fulfill({json:{event:items[3],images}});
    }
    if(p.endsWith('/remove')){const result={state:'removed'};receipts.set(req.postDataJSON().operation_id,result);images=[];return route.fulfill({json:result});}
    const data={'/api/session':{},'/api/items':items,'/api/workbench':snapshot,'/api/priorities':snapshot.priorities,'/api/events/e/structure':{events:[items[3]],branches:[],links:[]},'/api/decomposition/types':[], '/api/plan-history-counts':{}};
    return route.fulfill({json:data[p]||[]});
   }
   const name=path.basename(p==='/'?'index.html':p),file=path.resolve(__dirname,'../frontend',name);
   return route.fulfill({status:fs.existsSync(file)?200:404,body:fs.existsSync(file)?fs.readFileSync(file):'',contentType:name.endsWith('.js')?'text/javascript':name.endsWith('.css')?'text/css':'text/html'});
  });
  await page.goto('http://127.0.0.1:18889/');await page.locator('.wbActionRow').first().waitFor();
  await page.locator('.sidebarBottom button').first().click();await page.getByRole('tab',{name:'图片存储'}).click();
  await page.waitForFunction(()=>document.querySelector('#imageRegion').value==='ap-shanghai');
  assert.equal(await page.locator('#imageBucket').inputValue(),'cc-1300161961');assert.equal(await page.locator('#mpStoragePanel input[type=checkbox]').count(),0);
  assert.equal(await page.locator('#mpStoragePanel').getByText('私有访问',{exact:true}).count(),0);
  const save=page.getByRole('button',{name:'保存配置',exact:true}),check=page.getByRole('button',{name:'检查连接',exact:true});
  assert.equal(await save.locator('svg').count(),1);assert.equal(await check.locator('svg').count(),1);
  for(const width of [1440,1024,887,768,646,375]){
   await page.setViewportSize({width,height:871});assert.equal(await page.locator('#matterPlanningDrawer').evaluate(el=>el.scrollWidth>el.clientWidth+1),false);
   await page.screenshot({path:path.join(output,`settings-${width}.png`)});
  }
  await page.locator('#imageSecretId').fill('demo-id');await page.locator('#imageSecretKey').fill('demo-id');await save.click();
  assert.match(await page.locator('#imageConfigError').innerText(),/不能相同/);assert.equal(writes.filter(x=>x.method==='PUT').length,0);
  await page.locator('#imageSecretKey').fill('demo-secret');await save.click();await page.waitForFunction(()=>document.querySelector('#imageSecretKey').value==='');
  assert.equal(await page.locator('#imageCredentialStatus').innerText(),'已配置');await check.click();await page.getByText('存储桶访问检查通过；尚未验证上传和下载权限',{exact:true}).waitFor();
  await page.locator('#imageBucket').fill('another-123');assert.equal(await check.isDisabled(),true);await page.locator('#imageSecretId').fill('demo-id');await page.locator('#imageSecretKey').fill('demo-secret');lost=true;await save.click();
  await page.locator('#imageConfigRecover:not([hidden])').click();await page.waitForFunction(()=>document.querySelector('#imageConfigRecover').hidden);
  await page.keyboard.press('Escape');await page.getByRole('button',{name:'目标与事情',exact:true}).click();
  await page.getByRole('button',{name:'事件图片：event',exact:true}).click();await page.waitForFunction(()=>!document.querySelector('#imageChoose').disabled);
  await page.locator('#imageFiles').setInputFiles({name:'截图.png',mimeType:'image/png',buffer:pixel});
  assert.equal(writes.filter(x=>x.path==='/api/events/e/images').length,0);await page.locator('#imageUpload').click();
  await page.waitForFunction(()=>document.querySelector('#imageQueue').children.length===0);
  await page.locator('#imageSaved img').waitFor();
  assert.equal(await page.locator('#imageSaved img').evaluate(el=>el.complete&&el.naturalWidth>0),true);
  assert.equal(await page.locator('#imageChoose').innerText(),'选择图片');
  await page.getByRole('button',{name:'预览：截图.png'}).click();assert.equal(await page.locator('#imageViewer').isVisible(),true);await page.locator('#imageViewerClose').click();
  await page.screenshot({path:path.join(output,'images-375.png')});
  page.once('dialog',dialog=>dialog.accept());await page.locator('#imageSaved').getByRole('button',{name:'移除',exact:true}).click();await page.getByText('图片关联已移除',{exact:true}).waitFor();
  assert.equal(images.length,0);assert.deepEqual(errors,[]);
  fs.writeFileSync(path.join(output,'report.json'),JSON.stringify({passed:true,widths:[1440,1024,887,768,646,375],realWrites:0,mockWrites:writes,errors,checks:['header icons','no private badge or upload toggle','write-only credentials','explicit connection check','dirty check disabled','unknown save receipt recovery','choose does not upload','upload readback','preview','remove association']},null,2));
  console.log('Event image browser checks passed');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
