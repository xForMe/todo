/* TECH-024: explicit writes, private links, no credential persistence or silent retry. */
const todoImages = (() => {
 const settings=document.querySelector('#matterPlanningDrawer');
 const panel=document.createElement('section');panel.id='mpStoragePanel';panel.hidden=true;panel.role='tabpanel';panel.setAttribute('aria-labelledby','mpStorageTab');
 document.querySelector('#mpSettings').append(panel);
 const q=id=>document.getElementById(id);
 let cfg=null,cfgBusy=false,cfgPending=null,cfgDirty=false,cfgLoad=0;
 let cfgReact=null,cfgSession=0,cfgRetry=false;
 let cfgConnection='尚未检查',cfgError='';
 function mountStorage(mount){cfgReact=mount(panel);cfgControls()}
 function cfgControls(){
  const disabled=cfgBusy||!!cfgPending;
  const saveDisabled=disabled||!cfg,checkDisabled=disabled||!cfg?.has_credentials||cfgDirty;
  cfgReact({model:{saveDisabled,checkDisabled,disabled,pending:!!cfgPending,retry:cfgRetry&&!!cfgPending,
   credentials:cfg?(cfg.has_credentials?'已配置':'未配置'):'正在加载',connection:cfgConnection,error:cfgError,
   session:cfgSession,region:cfg?.region||'',bucket:cfg?.bucket||'',placeholder:cfg?(cfg.has_credentials?'已配置，留空保留':'请输入'):''},
   actions:{dirty:cfgMarkDirty,save:cfgSave,check:cfgCheck,recover:cfgRecover,retry:cfgRetrySave}});
 }
 function fillConfig(value){
  cfg=value;cfgDirty=false;cfgSession++;cfgConnection='尚未检查';
 }
 async function loadConfig(){
  if(!cfgReact||cfgPending||cfgBusy)return;
  const token=++cfgLoad;cfgBusy=true;cfgControls();
  try{const value=await api('/image-storage');if(token===cfgLoad){fillConfig(value);cfgError=''}}
  catch(e){cfg=null;cfgError=e.message+'，重新进入本分类可重试'}
  finally{cfgBusy=false;cfgControls()}
 }
 settings.addEventListener('image-storage-open',()=>{if(!cfgDirty)loadConfig();});
 function cfgMarkDirty(){cfgDirty=true;cfgConnection='配置有修改，请保存后检查';cfgControls()}
 function cfgComplete(value){cfgPending=null;cfgRetry=false;fillConfig(value);cfgError='配置已保存并读回，可前往事件上传图片。'}
 function cfgSafeError(error){
  let text=String(error.message||'图片存储操作失败');
  const secrets=[cfgPending?.secret_id,cfgPending?.secret_key,q('imageSecretId')?.value,q('imageSecretKey')?.value];
  for(const secret of secrets.filter(Boolean).sort((a,b)=>b.length-a.length))text=text.replaceAll(secret,'[已隐藏]');
  return text;
 }
 async function cfgSave(){
  if(cfgBusy||!cfg||cfgPending)return;const sid=q('imageSecretId').value.trim(),key=q('imageSecretKey').value.trim();
  if(sid&&sid===key){cfgError='SecretId和SecretKey不能相同，请填写同一组密钥的两个不同字段';cfgControls();return;}
  if(Boolean(sid)!==Boolean(key)||(!cfg.has_credentials&&!sid)){cfgError='请填写一组SecretId和SecretKey';cfgControls();return;}
  cfgPending={operation_id:crypto.randomUUID(),expected_revision:cfg.revision,region:q('imageRegion').value.trim(),bucket:q('imageBucket').value.trim(),...(sid?{secret_id:sid,secret_key:key}:{})};
  await cfgSend(false);
 }
 async function cfgSend(retry){
  cfgRetry=false;cfgBusy=true;cfgControls();
  try{cfgComplete(await api('/image-storage','PUT',cfgPending))}
  catch(e){const safe=cfgSafeError(e);if(e.status>=400&&e.status<500)cfgPending=null;cfgError=safe+(retry?'；未自动重试':cfgPending?'；保存结果待核对，未自动重试':'')}
  finally{cfgBusy=false;cfgControls()}
 }
 async function cfgRecover(){
  if(cfgBusy||!cfgPending)return;
  cfgBusy=true;cfgRetry=false;cfgControls();
  try{cfgComplete(await api('/image-operations/'+cfgPending.operation_id))}
  catch(e){cfgRetry=e.status===404;cfgError=cfgSafeError(e)+'；配置仍待核对'}
  finally{cfgBusy=false;cfgControls()}
 }
 function cfgRetrySave(){if(!cfgBusy&&cfgPending&&cfgRetry)return cfgSend(true)}
 async function cfgCheck(){
  if(q('imageConfigCheck').disabled)return;
  cfgBusy=true;cfgConnection='检查中';cfgControls();
  try{const result=await api('/image-storage/check','POST',{});cfgConnection='存储桶访问检查通过';cfgError=result.message}
  catch(e){cfgConnection='检查失败';cfgError=cfgSafeError(e)}
  finally{cfgBusy=false;cfgControls()}
 }
 const drawer=document.createElement('dialog');drawer.id='imageDrawer';drawer.setAttribute('aria-labelledby','imageTitle');
 document.body.append(drawer);
 const viewer=document.createElement('dialog');viewer.id='imageViewer';viewer.setAttribute('aria-label','图片预览');document.body.append(viewer);
 let selected='',snapshot=null,rows=[],queue=[],busy=false,load=0,removePending=null,removeCanRetry=false;
 const drafts=new Map();
 const picks=new Set();
 const batches=new Map();
 const retryable=new Set();
 const submitted=new Map();
 function retryImageConfirmation(){
  const id=uncertain[selected], body=submitted.get(selected);
  if(!busy&&id&&body&&retryable.has(selected))void sendConfirmation(id,body);
 };
 const pendingKey='todo-image-confirmations';
 let uncertain={};
 try{uncertain=JSON.parse(sessionStorage.getItem(pendingKey)||'{}')||{};}catch{}
 const imagePath=(id=selected)=>`/${get(id)?.type==='thing'?'items':'events'}/${encodeURIComponent(id)}/images`;
 const analysisPath=(id=selected)=>`/items/${encodeURIComponent(id)}/image-actions`;
 const canUpload=item=>['pending','failed','absent'].includes(item.state);
 let imageReact=null, viewerReact=null;
 function mountImages(mount,mountViewer,mountInline){
  mountInlineImages=mountInline;
  imageReact=mount(drawer);viewerReact=mountViewer(viewer);
 }
 viewer.addEventListener('close',()=>{if(viewerReact&&!viewer.open)renderImageViewer({name:'',url:'',error:''})});
 const imageModel={title:'事件图片',context:'',source:null,error:''};
 const viewerModel={name:'',url:'',error:''};
 function imageFeedback(error){imageModel.error=error;draw()}
 function renderImageViewer(patch={}){
  Object.assign(viewerModel,patch);
  viewerReact({model:viewerModel,actions:{close:()=>viewer.close(),error:()=>renderImageViewer({error:'图片暂不可访问或链接已过期，请关闭预览后刷新图片。'})}});
 }
 function draw(){
  const batch=batches.get(selected),pendingConfirm=!!uncertain[selected];
  const changed=!!batch&&(batch.image_ids.length!==picks.size||batch.image_ids.some(id=>!picks.has(id)));
  imageReact({model:{...imageModel,queue,rows:rows.filter(row=>!queue.some(item=>item.id===row.id)),
   picks:[...picks],batch,pendingConfirm,controls:{busy,removePending:!!removePending,removeCanRetry,
    uploadDisabled:busy||!!removePending||!snapshot||!queue.some(canUpload),chooseDisabled:busy||!snapshot,
    reloadDisabled:busy,analyzeHidden:!picks.size,analyzeDisabled:busy||!snapshot||pendingConfirm||picks.size>4,
    confirmDisabled:busy||pendingConfirm||changed,confirmTitle:changed?'图片选择已变化，请重新分析':'',
    checkDisabled:busy,retryConfirmHidden:!retryable.has(selected)}},
   actions:{close:()=>drawer.close(),reload,paste:pasteFromDrawer,clipboardPaste:pasteIntoDrawer,
    addFiles:addToDrawer,upload:uploadImages,analyze:analyzePicked,action:imageAction,editCandidate,
    confirm:confirmImages,checkConfirm:checkImageConfirmation,retryConfirm:retryImageConfirmation,readError:imageFeedback}});
 }
 async function reload(){const token=++load;try{const result=await api(imagePath());if(token!==load)return;snapshot=result.event;rows=result.images;for(const item of [...queue]){const found=rows.find(x=>x.id===item.id);if(found){item.state=found.state;item.revision=found.revision;if(found.state==='ready'||found.state==='removed'){URL.revokeObjectURL(item.url);queue.splice(queue.indexOf(item),1);}}}const path=[];for(let parent=get(snapshot.parent);parent;parent=get(parent.parent))path.unshift(parent.name);const title=snapshot.type==='thing'?'事情图片':'事件图片',context=snapshot.name+(path.length?'\n'+path.join(' / '):''),source=result.source;Object.assign(imageModel,{title,context,source});for(const id of picks){if(!rows.some(row=>row.id===id)&&!queue.some(row=>row.id===id))picks.delete(id);}draw();}catch(e){if(token===load){snapshot=null;imageFeedback(e.message);}}}
 async function open(id, focusIds){if(!imageReact||busy)return false;if(removePending&&id!==selected){notify('请先核对当前图片的移除结果');return false;}drafts.set(selected,queue);selected=id;queue=drafts.get(id)||[];rows=[];snapshot=null;picks.clear();for(const id of focusIds||batches.get(selected)?.image_ids||[])picks.add(id);Object.assign(imageModel,{context:'',source:null,error:''});draw();if(!drawer.open)drawer.showModal();await reload();return !!snapshot;}
 function addToDrawer(files){
  if(busy||!snapshot)return;
  for(const file of files){
   if(rows.length+queue.filter(x=>!rows.some(r=>r.id===x.id)).length>=20){imageFeedback('每个对象最多20张图片');break;}
   if(!validFile(file)){imageFeedback('仅支持不超过10MiB的JPEG、PNG、WebP');continue;}
   const item = draftImage(file);
   queue.push(item);
   if(picks.size<4)picks.add(item.id);
  }
  draw();
 }
 async function uploadImages(){
  if(q('imageUpload').disabled)return;busy=true;draw();imageFeedback('正在上传…');
  try{await storeImages(snapshot,queue.filter(canUpload));await reload();imageFeedback('图片已上传并读回。');}
  catch(e){await reload();imageFeedback(e.message);}
  finally{busy=false;draw();}
 };
 async function recoverRemoval(){try{const result=await api('/image-operations/'+removePending.body.operation_id);removePending=null;removeCanRetry=false;imageFeedback('已核对移除结果');await reload();return result;}catch(e){removeCanRetry=e.status===404;throw e;}}
 async function sendRemoval(){try{await api(imagePath()+'/'+removePending.id+'/remove','POST',removePending.body);picks.delete(removePending.id);batches.delete(selected);draw();removePending=null;removeCanRetry=false;await reload();imageFeedback('图片关联已移除');}catch(e){if(e.status>=400&&e.status<500)removePending=null;throw e;}}
 async function imageAction(kind,id,checked){
  if(busy)return;
  const x=[...queue,...rows].find(item=>item.id===id);
  if(!x&&!['recover-remove','retry-remove'].includes(kind))return;
  if(kind==='pick'){if(checked)picks.add(id);else picks.delete(id);draw();return;}
  if(kind==='preview'){renderImageViewer({name:x.name,url:x.url,error:''});if(!viewer.open)viewer.showModal();return;}
  if(kind==='cancel'){URL.revokeObjectURL(x.url);picks.delete(x.id);queue=queue.filter(v=>v!==x);drafts.set(selected,queue);draw();return;}
  busy=true;draw();try{
   if(kind==='reconcile'){const result=await api(imagePath()+'/'+x.id+'/reconcile','POST',{});if(x.file)x.state=result.state;await reload();imageFeedback(result.state==='ready'?'已核对图片保存成功':result.state==='absent'?'云端未找到图片，可主动重试原图片或移除占位。':'仍需核对，未自动重传');}
   else if(kind==='remove'){if(removePending||!confirm('从事件中移除此图片？云端原文件暂保留。'))return;removePending={id:x.id,body:{operation_id:crypto.randomUUID(),expected_revision:x.revision}};await sendRemoval();}
   else if(kind==='recover-remove')await recoverRemoval();
   else if(kind==='retry-remove'&&removeCanRetry)await sendRemoval();
  }catch(error){imageFeedback(error.message);}
  finally{busy=false;draw();}
 }
 function validFile(file){return ['image/jpeg','image/png','image/webp'].includes(file.type)&&file.size>0&&file.size<=10*1024*1024;}

 function draftImage(file){return {id:crypto.randomUUID(),file,name:file.name||'剪贴板图片',url:URL.createObjectURL(file),state:'pending'};}

 function clipboardPaste(event,add,message){
  const files=[...(event.clipboardData?.items||[])].filter(item=>item.kind==='file'&&item.type.startsWith('image/')).map(item=>item.getAsFile()).filter(Boolean);
  if(files.length){event.preventDefault();add(files);}else message('剪贴板中没有图片。');
 }
 function pasteIntoDrawer(event){clipboardPaste(event,addToDrawer,imageFeedback)}
 function pasteFromDrawer(){return readClipboard(q('imagePaste'),addToDrawer,imageFeedback,()=>selected)}
 async function readClipboard(button,add,message,scope){
   const target=scope();
   try{
    if(!navigator.clipboard?.read)throw Error();
    const clips=await navigator.clipboard.read(), files=[];
    for(const clip of clips){
     const type=clip.types.find(type=>['image/png','image/jpeg','image/webp'].includes(type));
     if(type)files.push(new File([await clip.getType(type)],'剪贴板图片.'+type.split('/')[1],{type}));
    }
    if(!button.isConnected||scope()!==target)return;
    if(files.length)add(files);else message('剪贴板中没有图片。');
   }catch{if(button.isConnected&&scope()===target)message('无法直接读取剪贴板。可聚焦图片按钮按 Ctrl+V，或选文件。');}
 }

 async function storeImages(target, pending){
  const endpoint=imagePath(target.id);
  for(const item of pending){
   if(item.state==='ready')continue;
   if(!canUpload(item))throw Error('请先核对图片保存结果');
   item.version ??= target.version;
   const body=new FormData();
   body.set('operation_id',item.id);
   body.set('expected_version',item.version);
   body.set('file',item.file);
   item.state='unknown';
   const response=await fetch('/api'+endpoint,{method:'POST',headers:{'X-Todo-Client':'web'},body});
   const value=await response.json();
   if(!response.ok){
    if(response.status>=400&&response.status<500)item.state='failed';
    throw Error(typeof value.detail==='string'?value.detail:'图片上传结果待核对');
   }
   item.state=value.state==='pending'?'unknown':value.state;
   item.revision=value.revision;
   if(item.state!=='ready')throw Error('部分图片尚未保存，请先核对上传结果。');
  }
  return pending.map(item=>item.id);
 }

 function editCandidate(index,field,value){
  const candidate=batches.get(selected)?.candidates[index];
  if(candidate&&field)candidate[field]=value;
  draw();
 }

 async function analyzePicked(){
  if(q('imageAnalyze').disabled||!picks.size)return;
  if(batches.get(selected)?.candidates.length&&!confirm('重新分析会替换当前候选，继续吗？'))return;
  busy=true;draw();imageFeedback('正在保存并分析所选图片…');
  try{
   await storeImages(snapshot,queue.filter(item=>picks.has(item.id)));
   const batch=await api(analysisPath(),'POST',{image_ids:[...picks]});
   batch.candidates.forEach(candidate=>{candidate.selected=true;});
   if(!batch.candidates.length)batch.summary=['未识别出可执行事项。',batch.summary].filter(Boolean).join(' ');
   batches.set(selected,batch);
   imageFeedback('');
  }catch(e){imageFeedback(e.message);}
  finally{await reload();busy=false;draw();}
 }

 function setUncertain(id){
  if(id)uncertain[selected]=id;else{delete uncertain[selected];retryable.delete(selected);submitted.delete(selected);}
  try{sessionStorage.setItem(pendingKey,JSON.stringify(uncertain));}catch{}
 }
 async function created(result){
  const count=result.created.length;
  setUncertain(null);batches.delete(selected);
  const message=`已确认创建 ${count} 个${snapshot?.type==='event'?'子事件':'事件'}`;
  imageFeedback(message);
  try{db.items=await api('/items');render();}catch{imageFeedback(message+'。清单刷新失败，请刷新页面查看。');}
 }
 async function confirmImages(){
  const batch=batches.get(selected);
  if(!batch||q('imageConfirm').disabled)return;
  if(!snapshot){imageFeedback('请先刷新当前图片。');return;}
  const candidates=batch.candidates.map(({name,description,owner,planEnd,selected},index)=>selected?{index,name,description,owner,planEnd}:null).filter(Boolean);
  if(!candidates.length||candidates.some(item=>!item.name.trim())){imageFeedback('请勾选并填写要创建的事件。');return;}
  submitted.set(selected,{candidates});
  await sendConfirmation(batch.id,{candidates});
 };
 async function sendConfirmation(id,body){
  busy=true;setUncertain(id);retryable.delete(selected);draw();
  try{await created(await api(`${analysisPath()}/${id}/confirm`,'POST',body));}
  catch(e){if(e.status>=400&&e.status<500)setUncertain(null);imageFeedback(e.message);}
  finally{busy=false;draw();}
 }
 async function checkImageConfirmation(){
  const id=uncertain[selected];if(!id||busy)return;
  busy=true;draw();
  try{await created(await api(`${analysisPath()}/${id}/result`));}
  catch(e){
   if(e.status===404&&submitted.has(selected))retryable.add(selected);
   imageFeedback(e.status===404?'尚未查到已创建结果，请稍后核对。':e.message);
  }
  finally{busy=false;draw();}
 };

 let editorFiles=[];
 const followFiles=new Map();
 let mountInlineImages=null;
 const inlineRoots=new WeakMap();
 const inlineViews=new WeakMap();
 function clearInline(slot){
  if(!slot)return;
  inlineViews.delete(slot);inlineRoots.get(slot)?.(null);
 }
 function paintInline(slot){inlineViews.get(slot)?.();}
 function reactInlineImages(slot,files,target){
  const render=inlineRoots.get(slot)||mountInlineImages(slot);
  inlineRoots.set(slot,render);
  let message='',analyzing=false;
  const checks=new Set();
  const host=target?q('dailyFollowDialog'):q('editor');
  const current=()=>inlineViews.get(slot)===paint&&host.open;
  const locked=()=>analyzing||!!(target&&(dailyTarget!==target||dailyBusy||dailyPending||!dailyCanWrite()));
  const feedback=text=>{message=text;paint()};
  const add=items=>{
   if(!current()||locked())return;
   for(const file of items){
    if(files.length>=20){message='最多附加20张图片';break;}
    if(!validFile(file)){message='仅支持不超过10MiB的JPEG、PNG、WebP';continue;}
    files.push(draftImage(file));
   }
   paint();
  };
  function paint(){
   if(inlineViews.get(slot)!==paint)return;
   render({model:{follow:!!target,disabled:locked(),message,files:files.map(file=>({id:file.id,name:file.name,url:file.url,
    check:!!target&&file.state!=='ready'&&!canUpload(file),checking:checks.has(file.id)}))},actions:{
    add,showTip,hideTip,paste:event=>clipboardPaste(event,add,text=>{if(current()&&!locked())feedback(text)}),
    clipboard:button=>{if(current()&&!locked())return readClipboard(button,add,text=>{if(current()&&!locked())feedback(text)},()=>current()&&!locked()?paint:null)},
    remove:id=>{
     if(!current()||locked()||checks.has(id))return;
     const index=files.findIndex(file=>file.id===id);
     if(index<0)return;
     const [file]=files.splice(index,1);URL.revokeObjectURL(file.url);paint();
    },
    reconcile:async id=>{
     if(!current()||locked()||checks.has(id))return;
     const file=files.find(file=>file.id===id);
     if(!target||!file||file.state==='ready'||canUpload(file))return;
     checks.add(id);paint();
     try{file.state=(await api(`${imagePath(target)}/${id}/reconcile`,'POST',{})).state;
      feedback(file.state==='ready'?'图片已保存。':'图片尚未完成保存。');}
     catch(error){feedback(error.message)}finally{checks.delete(id);paint()}
    },
    analyze:async()=>{
     if(!current()||locked()||!target||!files.length)return;
     if(files.length>4){feedback('一次最多分析4张。请先保存跟进，再到事件图片中选择。');return;}
     analyzing=true;dailyBusy=true;dailyLock();
     try{const ids=await storeImages(dailyView.item,files);if(await open(target,ids))await analyzePicked();}
     catch(error){feedback(error.message)}finally{analyzing=false;dailyBusy=false;dailyLock();}
    },
   }});
  }
  inlineViews.set(slot,paint);paint();
 }
 function editorOpened(action){
  const slot=q('editorImageSlot');
  clearInline(slot);
  editorFiles.forEach(item=>URL.revokeObjectURL(item.url));editorFiles=[];
  if(action&&slot&&mountInlineImages)reactInlineImages(slot,editorFiles);
 }
 function editorSaved(item){
  if(!editorFiles.length)return;
  const files=editorFiles;editorFiles=[];
  drafts.set(item.id,files);
  void open(item.id).then(loaded=>{if(loaded&&selected===item.id)q('imageUpload').click();});
 }
 function mountFollow(id){
  const slot=q('dailyImageSlot');
  const files=followFiles.get(id)||[];followFiles.set(id,files);
  return reactInlineImages(slot,files,id);
 }
 function followSaved(id){
  followFiles.get(id)?.forEach(item=>URL.revokeObjectURL(item.url));followFiles.delete(id);
  if(q('dailyFollowDialog').open&&dailyTarget===id)mountFollow(id);
 }
 return {editorOpened,editorSaved,mountFollow,followSaved,open,mountImages,mountStorage,
          paintFollowAttachments:()=>paintInline(q('dailyImageSlot')),
         followUpload:target=>storeImages(target,followFiles.get(target.id)||[])};
})();
