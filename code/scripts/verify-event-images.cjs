// TEST-021 / TEST-025: isolated Chrome with every request intercepted.
const {chromium}=require('playwright');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const react=true,bundle='/dist/workbench-react.js',base='http://127.0.0.1:18889';
const root=path.resolve(__dirname,'../frontend-react/public');
const output=path.resolve(__dirname,'../../runtime',`event-images-ui${react?'-react':''}`);
const settingsWidths=[1440,1024,887,768,646,375],imageWidths=[1440,1024,768,375];
const imageList='/api/events/e/images',receiptPrefix='/api/image-operations/';
const storagePath='/api/image-storage',storageCheck=storagePath+'/check';
const storagePut={path:storagePath,method:'PUT'},storageGet={path:storagePath,method:'GET'},storageCheckPost={path:storageCheck,method:'POST'};
const storageControls=['.imageSettingsHead','#imageConfigForm','#imageRegion','#imageBucket','#imageSecretId','#imageSecretKey',
 '#imageConfigSave','#imageConfigCheck','#imageCredentialStatus','#imageConnectionStatus','#imageConfigError'];
const secretSelectors=['#imageSecretId','#imageSecretKey'],secretId='synthetic-cos-id',secretKey='synthetic-cos-key';
const drawerControls=['#imageTitle','#imageClose','#imageReload','.imageBody','#imageContext','#imageSource','#imageError',
 '#imageChoose','#imagePaste','#imageUpload','#imageFiles','#imageQueue','#imageSaved','#imageAnalyze','#imageCandidates'];
async function assertReactRegion(page,selector){
 const region=page.locator(selector);await region.waitFor();
 const inline=await region.evaluate(root=>[root,...root.querySelectorAll('*')].flatMap(node=>
  node.getAttributeNames().filter(name=>/^on/i.test(name)).map(name=>`${node.id||node.tagName}.${name}`)));
 assert.deepEqual(inline,[],`${selector} must not contain inline event handlers`);
}
async function assertStoragePanel(page,panel,originalPanel){
 const actual=await panel.evaluate((shell,{required,originalPanel})=>{
  const hasFiber=node=>node&&Object.keys(node).some(key=>key.startsWith('__reactFiber$')&&node[key]?.stateNode===node);
  const tab=document.getElementById('mpStorageTab'),nodes=[...shell.querySelectorAll('*')];
  return {
   original:shell===originalPanel,native:shell.matches('section[role="tabpanel"][aria-labelledby="mpStorageTab"]')&&
    shell.parentElement?.id==='mpSettings'&&tab?.getAttribute('aria-controls')===shell.id&&tab.getAttribute('aria-selected')==='true',
   marked:shell.hasAttribute('data-react-owned'),shellFiber:hasFiber(shell),
   owned:nodes.filter(hasFiber).map(node=>node.id||node.localName),
   missing:required.filter(selector=>!hasFiber(shell.querySelector(selector))),
   unowned:nodes.filter(node=>!hasFiber(node)).map(node=>node.id||node.localName),
  };
 },{required:storageControls,originalPanel});
 assert.equal(actual.original,true,'mounting settings must keep the original tabpanel node');
 assert.equal(actual.native,true,'storage settings must stay labelled and selected by the existing tab');
 assert.equal(actual.marked,react,'only React mode may mark storage settings as React-owned');
 assert.equal(actual.shellFiber,false,'React must not replace the native storage tabpanel');
 if(!react){assert.deepEqual(actual.owned,[],'legacy mode must not mount React storage content');return;}
 assert.deepEqual(actual.missing,[],'storage settings controls must have real DOM Fibers');
 assert.deepEqual(actual.unowned,[],'all tabpanel content must be produced by React');
 await assertReactRegion(page,'#mpStoragePanel[data-react-owned]');
}
async function assertNoCredentialLeak(page,{blank=false}={}){
 const state=await page.evaluate(async ({selectors,credentials})=>{
  const containsSecret=value=>credentials.some(secret=>value.includes(secret));
  return {
   inputs:selectors.map(selector=>{
    const field=document.querySelector(selector);
    return {type:field.type,autocomplete:field.autocomplete,hasValueAttribute:field.hasAttribute('value'),blank:field.value===''};
   }),
   markup:containsSecret(document.documentElement.outerHTML),
   webStorage:[localStorage,sessionStorage].some(store=>Object.keys(store).some(key=>containsSecret(key)||containsSecret(store.getItem(key)||''))),
   cookies:containsSecret(document.cookie),
   indexedDB:(await indexedDB.databases()).length,
  };
 },{selectors:secretSelectors,credentials:[secretId,secretKey]});
 for(const input of state.inputs){
  assert.equal(input.type,'password');assert.equal(input.autocomplete,'new-password');
  assert.equal(input.hasValueAttribute,false,'passwords must never use a DOM value attribute');
  if(blank)assert.equal(input.blank,true,'saved credentials must not be filled back into password fields');
 }
 assert.equal(state.markup,false,'credentials must not be serialized in page markup');
 assert.equal(state.webStorage,false,'credentials must not appear in localStorage or sessionStorage');
 assert.equal(state.cookies,false,'credentials must not appear in cookies');
 assert.equal(state.indexedDB,0,'isolated page must not create an IndexedDB credential store');
}
async function assertEmptyImageDialog(dialog,original,mounted){
 const actual=await dialog.evaluate((shell,initial)=>({
  sameHost:shell===initial,native:shell instanceof HTMLDialogElement,open:shell.open,modal:shell.matches(':modal'),
  children:shell.childNodes.length,reactRoot:Object.keys(shell).some(key=>key.startsWith('__reactContainer$')&&
   shell[key]?.stateNode?.containerInfo===shell),
 }),original);
 assert.deepEqual(actual,{sameHost:true,native:true,open:false,modal:false,children:0,reactRoot:mounted},
  `${dialog}: must be the original empty native dialog ${mounted?'after React mounts, before first open':'before the bundle loads'}`);
 return actual;
}
async function assertImageDialog(dialog,original,required){
 const actual=await dialog.evaluate((shell,{initial,selectors})=>{
  const hasFiber=node=>node&&Object.keys(node).some(key=>key.startsWith('__reactFiber$')&&node[key]?.stateNode===node);
  const label=node=>node.id||node.localName;
  const nodes=[...shell.querySelectorAll('*')];
  return {
   sameHost:shell===initial,modal:shell instanceof HTMLDialogElement&&shell.open&&shell.matches(':modal'),
   marked:shell.hasAttribute('data-react-owned'),shellFiber:hasFiber(shell),
   owned:nodes.filter(hasFiber).map(label),
   missing:selectors.filter(selector=>!hasFiber(shell.querySelector(selector))),
   unowned:nodes.filter(node=>!hasFiber(node)&&!(node.parentElement===shell&&node.matches('.iconTip[role="tooltip"]'))).map(label),
   inline:[shell,...nodes].flatMap(node=>node.getAttributeNames().filter(name=>/^on/i.test(name)).map(name=>`${label(node)}.${name}`)),
  };
 },{initial:original,selectors:required});
 assert.equal(actual.sameHost,true,'opening the image window must retain the original dialog');
 assert.equal(actual.modal,true,'image dialog must open as a native modal');
 assert.equal(actual.marked,react,'React mode must mark the native image dialog');
 assert.equal(actual.shellFiber,false,'React must not replace the native image dialog');
 if(!react){assert.deepEqual(actual.owned,[],'legacy mode must not mount React image content');return;}
 assert.deepEqual(actual.missing,[],'image controls and current content must have real DOM Fibers');
 assert.deepEqual(actual.unowned,[],'only the shared dialog tooltip may lack Fiber ownership');
 assert.deepEqual(actual.inline,[],'React image dialogs must not contain inline event handlers');
}
async function assertImageLoaded(img){
 await img.waitFor();
 await img.evaluate(async el=>{await el.decode()});
 assert.equal(await img.evaluate(el=>el.complete&&el.naturalWidth>0),true);
}
(async()=>{
 if(react)fs.accessSync(path.join(root,bundle.slice(1)),fs.constants.R_OK);
 fs.mkdirSync(output,{recursive:true});
 const browser=await chromium.launch({channel:'chrome',headless:true});
 let releaseBundle;
 const bundleReady=new Promise(resolve=>{releaseBundle=resolve});
 try{
  const page=await browser.newPage({serviceWorkers:'block'}),errors=[],writes=[],imageRequests=[];page.on('pageerror',e=>errors.push(e.message));
  const item=(id,type,parent)=>({id,type,parent,name:type,description:'',owner:'',planStart:'',planEnd:'',status:'notStarted',version:1});
  const items=[item('g','goal',null),item('m','module','g'),item('t','thing','m'),item('e','event','t')];
  const snapshot={items,priorities:{week:'2026-11-16',items:[]},attention:[],branches:[],links:[],today:'2026-11-18',daily_reviews:[]};
  let cfg={region:'ap-shanghai',bucket:'cc-1300161961',revision:0,has_credentials:false},images=[],lostSave='',lostRemoval=false,removeOperation;
  let imageReads=0,credentials=null;
  const receipts=new Map(),storageWrites=[];
  const pixel=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZ1sAAAAASUVORK5CYII=','base64');
  await page.context().routeWebSocket('**/*',socket=>{errors.push(`Unexpected WebSocket: ${socket.url()}`);return socket.close()});
  await page.context().route('**/*',async route=>{
   const req=route.request(),url=new URL(req.url()),p=url.pathname,method=req.method();
   if(url.origin!==base){errors.push(`Unexpected origin: ${req.url()}`);return route.abort()}
   if(p==='/image.png')return route.fulfill({body:pixel,contentType:'image/png'});
   if(p.startsWith('/api/')){
    if(method!=='GET')writes.push({path:p,method});
    if(/^\/api\/(?:image-|(?:items|events)\/[^/]+\/image(?:s|-[^/]+)(?:\/|$))/.test(p))imageRequests.push({path:p,method});
    if(p===storagePath){
     if(method==='PUT'){
      const body=req.postDataJSON(),loss=lostSave;lostSave='';storageWrites.push(body);
      if(loss==='uncommitted')return route.abort();
      if(body.secret_id!==undefined||body.secret_key!==undefined)credentials={id:body.secret_id,key:body.secret_key};
      cfg={region:body.region,bucket:body.bucket,revision:cfg.revision+1,has_credentials:!!credentials};
      receipts.set(body.operation_id,cfg);
      if(loss==='committed')return route.abort();
     }
     return route.fulfill({json:cfg});
    }
    if(p===storageCheck)return route.fulfill({json:{message:'存储桶访问检查通过；尚未验证上传和下载权限'}});
    if(p.startsWith(receiptPrefix)){
     const result=receipts.get(p.slice(receiptPrefix.length));
     return route.fulfill({status:result?200:404,json:result||{detail:'未找到图片操作回执'}});
    }
    if(p===imageList){
     if(method==='POST'){
      const raw=req.postDataBuffer().toString(),id=raw.match(/name="operation_id"\r\n\r\n([^\r]+)/)[1];
      const image={id,name:'截图.png',size:pixel.length,mime:'image/png',state:'ready',revision:2,created_at:'2026-11-18T09:00:00Z',url:`${base}/image.png`};images.push(image);return route.fulfill({json:image});
     }
     if(method==='GET')imageReads++;
     return route.fulfill({json:{event:items[3],images}});
    }
    if(p.endsWith('/remove')){
     const body=req.postDataJSON(),result={state:'removed'};
     removeOperation={path:p,...body};receipts.set(body.operation_id,result);images=[];
     if(lostRemoval){lostRemoval=false;return route.abort();}
     return route.fulfill({json:result});
    }
    const data={'/api/session':{},'/api/items':items,'/api/workbench':snapshot,'/api/priorities':snapshot.priorities,'/api/events/e/structure':{events:[items[3]],branches:[],links:[]},'/api/decomposition/types':[], '/api/plan-history-counts':{}};
    return route.fulfill({json:data[p]||[]});
   }
   // Keep the production bundle pending until the original settings and picture hosts are captured.
   if(react&&p===bundle)await bundleReady;
   const name=react&&p===bundle?bundle.slice(1):path.basename(p==='/'?'index.html':p),file=path.join(root,name);
   return route.fulfill({status:fs.existsSync(file)?200:404,body:fs.existsSync(file)?fs.readFileSync(file):'',contentType:name.endsWith('.js')?'text/javascript':name.endsWith('.css')?'text/css':'text/html'});
  });
  await Promise.all([page.waitForRequest(`${base}${bundle}`),page.goto(`${base}/`,{waitUntil:'domcontentloaded'})]);
  const startup=page.locator('body[data-ui-startup]');
  await startup.waitFor({state:'attached'});
  const drawer=page.locator('#imageDrawer'),viewer=page.locator('#imageViewer');
  const [originalPanel,originalDrawer,originalViewer]=await Promise.all([
   page.locator('#mpStoragePanel').elementHandle(),drawer.elementHandle(),viewer.elementHandle(),
  ]);
  const pictureHosts={beforeBundle:{
   drawer:await assertEmptyImageDialog(drawer,originalDrawer,false),
   viewer:await assertEmptyImageDialog(viewer,originalViewer,false),
  }};
  const storageShell=()=>page.locator('#mpStoragePanel').evaluate((node,original)=>({
   sameHost:node===original,native:node.matches('section[role="tabpanel"][aria-labelledby="mpStorageTab"]'),
   hidden:node.hidden,children:node.childElementCount,mounted:node.hasAttribute('data-react-owned'),
  }),originalPanel);
  const storageBeforeBundle=await storageShell();
  assert.deepEqual(storageBeforeBundle,{sameHost:true,native:true,hidden:true,children:0,mounted:false},
   'the storage tabpanel contains no legacy form before React loads');
  releaseBundle();
  // Wait for the loader to finish all React mounts before checking hidden tabpanels.
  await startup.waitFor({state:'detached'});
  const storageAfterMount=await storageShell();
  assert.ok(storageAfterMount.sameHost&&storageAfterMount.native&&storageAfterMount.hidden&&storageAfterMount.mounted&&storageAfterMount.children>0,
   'React renders the original hidden panel without loading configuration');
  pictureHosts.afterMount={
   drawer:await assertEmptyImageDialog(drawer,originalDrawer,true),
   viewer:await assertEmptyImageDialog(viewer,originalViewer,true),
  };
  assert.deepEqual(imageRequests,[],'startup must not request image data or storage configuration');
  await page.locator('.wbActionRow').first().waitFor();
  if(react){await page.locator('#globalWorkbench[data-panels-ui="react"] .wbActionRow').first().waitFor();await assertReactRegion(page,'#globalWorkbench[data-panels-ui="react"]')}
  const storagePanel=page.locator(react?'#mpStoragePanel[data-react-owned]':'#mpStoragePanel');
  const storageTab=page.getByRole('tab',{name:'图片存储'});
  await page.locator('.sidebarBottom button').first().click();await storageTab.click();
  await page.waitForFunction(()=>document.querySelector('#imageRegion')?.value==='ap-shanghai');
  await assertStoragePanel(page,storagePanel,originalPanel);await originalPanel.dispose();
  const bucket=storagePanel.locator('#imageBucket'),secretIdField=storagePanel.locator(secretSelectors[0]),secretKeyField=storagePanel.locator(secretSelectors[1]);
  const save=storagePanel.getByRole('button',{name:'保存配置',exact:true}),check=storagePanel.getByRole('button',{name:'检查连接',exact:true});
  const configError=storagePanel.locator('#imageConfigError'),configRecover=storagePanel.getByRole('button',{name:'核对保存结果',exact:true});
  const configRetry=storagePanel.getByRole('button',{name:'使用原操作重试保存',exact:true});
  const configSaved=storagePanel.getByText('配置已保存并读回，可前往事件上传图片。',{exact:true});
  const connStatus=storagePanel.locator('#imageConnectionStatus');
  const receiptGet=operation=>({path:receiptPrefix+operation.operation_id,method:'GET'});
  const assertOperation=(operation,expectedRevision,expectedBucket,secretFields={})=>{
   assert.match(operation.operation_id,/^[0-9a-f-]{36}$/i);
   assert.deepEqual(operation,{operation_id:operation.operation_id,expected_revision:expectedRevision,region:'ap-shanghai',bucket:expectedBucket,...secretFields});
  };
  assert.equal(await bucket.inputValue(),'cc-1300161961');assert.equal(await storagePanel.locator('input[type=checkbox]').count(),0);
  assert.equal(await storagePanel.getByText('私有访问',{exact:true}).count(),0);
  assert.equal(await save.locator('svg').count(),1);assert.equal(await check.locator('svg').count(),1);
  assert.equal(await check.isDisabled(),true);await assertNoCredentialLeak(page,{blank:true});
  const settingsGeometry={};
  for(const width of settingsWidths){
   await page.setViewportSize({width,height:871});
   settingsGeometry[width]=await storagePanel.evaluate(panel=>{
    const drawer=panel.closest('dialog'),form=panel.querySelector('form');
    return {drawerWidth:drawer.clientWidth,panelWidth:panel.clientWidth,formHeight:form.offsetHeight,
     overflow:Math.max(drawer.scrollWidth-drawer.clientWidth,panel.scrollWidth-panel.clientWidth,document.documentElement.scrollWidth-innerWidth)};
   });
   assert.ok(settingsGeometry[width].overflow<=1,`settings drawer, panel or page overflows at ${width}px`);
   await page.screenshot({path:path.join(output,`settings-${width}.png`)});
  }
  await secretIdField.fill(secretId);await secretKeyField.fill(secretId);await assertNoCredentialLeak(page);await save.click();
  assert.match(await configError.innerText(),/不能相同/);assert.equal(writes.filter(x=>x.method==='PUT').length,0);
  await secretKeyField.fill(secretKey);await assertNoCredentialLeak(page);await save.click();await configSaved.waitFor();
  assertOperation(storageWrites[0],0,'cc-1300161961',{secret_id:secretId,secret_key:secretKey});
  assert.equal(await storagePanel.locator('#imageCredentialStatus').innerText(),'已配置');
  await assertNoCredentialLeak(page,{blank:true});
  assert.equal(await connStatus.innerText(),'尚未检查');
  assert.deepEqual(imageRequests,[storageGet,storagePut],'initial load and save must not trigger a connection check');
  await check.click();await storagePanel.getByText('存储桶访问检查通过；尚未验证上传和下载权限',{exact:true}).waitFor();
  assert.deepEqual(imageRequests,[storageGet,storagePut,storageCheckPost],'connection check must be explicit');

  await bucket.fill('another-123');assert.equal(await check.isDisabled(),true);
  // Commit the write but drop its response: only a manual lookup can confirm it.
  const beforeCommitted=imageRequests.length;
  lostSave='committed';await save.click();await configRecover.waitFor();
  await storagePanel.getByText(/保存结果待核对/).waitFor();
  const committed=storageWrites[1];assertOperation(committed,1,'another-123');
  assert.equal(cfg.revision,2);assert.deepEqual(credentials,{id:secretId,key:secretKey},'blank password fields must retain the saved pair');
  assert.equal(await bucket.isDisabled(),true);assert.equal(await save.isDisabled(),true);assert.equal(await check.isDisabled(),true);
  assert.equal(await configRetry.isVisible(),false);
  assert.deepEqual(imageRequests.slice(beforeCommitted),[storagePut],'unknown save must not query or resend before user action');
  await configRecover.click();await configSaved.waitFor();await configRecover.waitFor({state:'hidden'});
  assert.deepEqual(imageRequests.slice(beforeCommitted),[storagePut,receiptGet(committed)],'recover the original save without resending or checking the connection');
  assert.equal(await bucket.inputValue(),'another-123');assert.equal(await connStatus.innerText(),'尚未检查');
  await assertNoCredentialLeak(page,{blank:true});

  // Drop an uncommitted write: the 404 may only enable a manual retry with the original payload.
  await bucket.fill('retry-123');await secretIdField.fill(secretId);await secretKeyField.fill(secretKey);
  const beforeUncommitted=imageRequests.length;
  lostSave='uncommitted';await save.click();await configRecover.waitFor();
  await storagePanel.getByText(/保存结果待核对/).waitFor();
  const uncommitted=storageWrites[2];assertOperation(uncommitted,2,'retry-123',{secret_id:secretId,secret_key:secretKey});
  assert.equal(cfg.revision,2);assert.equal(await configRetry.isVisible(),false);await assertNoCredentialLeak(page);
  assert.deepEqual(imageRequests.slice(beforeUncommitted),[storagePut]);
  await configRecover.click();await configRetry.waitFor();
  assert.match(await configError.innerText(),/仍待核对/);assert.equal(await save.isDisabled(),true);
  assert.deepEqual(imageRequests.slice(beforeUncommitted),[storagePut,receiptGet(uncommitted)],'404 must not automatically resend');
  await configRetry.click();await configSaved.waitFor();await configRecover.waitFor({state:'hidden'});await configRetry.waitFor({state:'hidden'});
  assert.deepEqual(storageWrites[3],uncommitted,'manual retry must reuse the original ID, revision and payload');
  assert.deepEqual(imageRequests.slice(beforeUncommitted),[storagePut,receiptGet(uncommitted),storagePut]);
  assert.equal(cfg.revision,3);assert.equal(await bucket.inputValue(),'retry-123');
  assert.equal(await connStatus.innerText(),'尚未检查');await assertNoCredentialLeak(page,{blank:true});
  await page.keyboard.press('Escape');await page.getByRole('button',{name:'目标与事情',exact:true}).click();
  const imageEntry=page.getByRole('button',{name:'事件图片：event',exact:true});
  if(react){await imageEntry.waitFor();await assertReactRegion(page,'#events[data-events-ui="react"]')}
  const choose=drawer.locator('#imageChoose'),files=drawer.locator('#imageFiles'),upload=drawer.locator('#imageUpload');
  const queue=drawer.locator('#imageQueue'),saved=drawer.locator('#imageSaved');
  await imageEntry.click();
  await drawer.locator('#imageChoose:enabled').waitFor();
  await assertImageDialog(drawer,originalDrawer,drawerControls);
  assert.equal(await upload.isDisabled(),true);
  const beforeChoose=imageRequests.length;
  await files.setInputFiles({name:'待取消.png',mimeType:'image/png',buffer:pixel});
  await queue.getByText('待取消.png',{exact:true}).waitFor();
  assert.equal(await upload.isEnabled(),true);
  assert.equal(imageRequests.length,beforeChoose,'choosing a file must only queue it locally');
  const queuedCancel=queue.getByRole('button',{name:'取消',exact:true});
  await assertImageDialog(drawer,originalDrawer,[...drawerControls,'#imageQueue .imageCard','#imageQueue button[data-action="cancel"]']);
  await queuedCancel.click();await queuedCancel.waitFor({state:'detached'});
  assert.equal(await upload.isDisabled(),true);
  assert.equal(imageRequests.length,beforeChoose,'canceling a local queue entry must not request the image API');

  const preview=saved.getByRole('button',{name:'预览：截图.png'});
  async function uploadImage(){
   const before=imageRequests.length;
   await files.setInputFiles({name:'截图.png',mimeType:'image/png',buffer:pixel});
   await queue.getByText('截图.png',{exact:true}).waitFor();
   assert.equal(imageRequests.length,before,'selection still must not upload');
   const beforeRead=imageReads;
   await upload.click();await drawer.getByText('图片已上传并读回。',{exact:true}).waitFor();
   await page.waitForFunction(()=>document.querySelector('#imageQueue')?.children.length===0);
   assert.equal(imageReads,beforeRead+1,'uploaded images must be read back');
   await assertImageLoaded(saved.locator('img'));
  }
  await uploadImage();
  assert.equal(await choose.innerText(),'选择图片');
  await assertImageDialog(drawer,originalDrawer,[...drawerControls,'#imageSaved .imageCard','#imageSaved img','#imageSaved button[data-action="remove"]']);
  pictureHosts.beforePreview=await assertEmptyImageDialog(viewer,originalViewer,true);
  await preview.click();await viewer.getByRole('heading',{name:'截图.png',exact:true}).waitFor();
  await assertImageDialog(viewer,originalViewer,['#imageViewerName','#imageViewerClose','#imageLarge','[role="status"]']);
  assert.equal(await viewer.locator('#imageViewerName').innerText(),'截图.png');
  await assertImageLoaded(viewer.getByRole('img',{name:'截图.png'}));
  await viewer.locator('#imageViewerClose').click();await viewer.waitFor({state:'hidden'});
  assert.equal(await drawer.evaluate(el=>el.matches(':modal')),true,'closing preview must return to the open image modal');
  for(const width of imageWidths){
   await page.setViewportSize({width,height:871});
   assert.equal(await drawer.evaluate(el=>Math.max(el.scrollWidth-el.clientWidth,
    document.documentElement.scrollWidth-innerWidth)>1),false,`image drawer or page overflows at ${width}px`);
   await page.screenshot({path:path.join(output,`images-${width}.png`)});
  }
  const remove=saved.getByRole('button',{name:'移除',exact:true});
  const firstPath=`${imageList}/${images[0].id}/remove`;
  page.once('dialog',dialog=>dialog.accept());await remove.click();
  await drawer.getByText('图片关联已移除',{exact:true}).waitFor();
  assert.equal(images.length,0);

  await uploadImage();
  const secondImage=images[0],readBeforeRemoval=imageReads,requestBeforeRemoval=imageRequests.length;
  lostRemoval=true;
  page.once('dialog',dialog=>dialog.accept());await remove.click();
  const recover=drawer.getByRole('button',{name:'核对移除结果',exact:true});
  await recover.waitFor();
  assert.equal(images.length,0,'the fixture commits removal before losing the response');
  assert.equal(await saved.locator('img').count(),1,'lost response must not be treated as confirmed removal');
  assert.equal(await remove.isDisabled(),true,'pending removal must not allow resending');
  assert.equal(await drawer.getByRole('button',{name:'使用原操作重试移除',exact:true}).count(),0);
  await assertImageDialog(drawer,originalDrawer,[...drawerControls,'button[data-action="recover-remove"]']);
  const removalPath=`${imageList}/${secondImage.id}/remove`;
  assert.equal(removeOperation.path,removalPath);
  assert.equal(removeOperation.expected_revision,secondImage.revision);
  assert.match(removeOperation.operation_id,/^[0-9a-f-]{36}$/i);
  const removalWrite={path:removalPath,method:'POST'};
  assert.deepEqual(imageRequests.slice(requestBeforeRemoval),[removalWrite],'no automatic resend or receipt lookup before user action');
  await recover.click();
  await drawer.getByText('已核对移除结果',{exact:true}).waitFor();
  await saved.getByText('暂无图片',{exact:true}).waitFor();
  await recover.waitFor({state:'detached'});
  assert.equal(imageReads,readBeforeRemoval+1);
  assert.deepEqual(imageRequests.slice(requestBeforeRemoval),[removalWrite,{path:receiptPrefix+removeOperation.operation_id,method:'GET'},
   {path:imageList,method:'GET'}],'explicit recovery must query the original receipt and read back without resending');
  await drawer.locator('#imageClose').click();await drawer.waitFor({state:'hidden'});
  assert.deepEqual(writes,[storagePut,storageCheckPost,storagePut,storagePut,storagePut,
   {path:imageList,method:'POST'},{path:firstPath,method:'POST'},
   {path:imageList,method:'POST'},removalWrite]);
  assert.deepEqual(errors,[]);
  await Promise.all([originalDrawer.dispose(),originalViewer.dispose()]);
  fs.writeFileSync(path.join(output,'report.json'),JSON.stringify({passed:true,mode:react?'react':'legacy',widths:settingsWidths,
   imageWidths,settingsGeometry,pictureHosts,realWrites:0,mockWrites:writes,imageRequests,errors,checks:['header icons','no private badge or upload toggle',
    'write-only password fields, no DOM value attributes or browser storage','blank credentials retain existing credentials',
    'explicit connection check','dirty check disabled','unknown save receipt recovery without resend','404 manual retry reuses original operation',
    react?'storage panel Fiber ownership without inline events, original tabpanel retained':'legacy storage settings',
    'original native picture hosts are closed and empty before the bundle and after successful React mount',
    'choose does not upload','cancel local queue without request','upload readback','preview','native image modals',
    ...(react?['image drawer and preview Fiber ownership without inline events']:[]),'remove association','lost removal response recovery without resend']},null,2));
  console.log('Event image browser checks passed');
 }finally{releaseBundle();await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
