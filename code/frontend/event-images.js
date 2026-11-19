/* TECH-024: explicit writes, private links, no credential persistence or silent retry. */
const todoImages = (() => {
 const icon=kind=>`<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="${{save:'M19 21H5V3h12l4 4v14ZM7 3v5h9M7 21v-8h10v8',check:'M8 3v5m8-5v5M6 8h12v3a6 6 0 0 1-6 6v4',close:'m6 6 12 12M18 6 6 18',image:'M3 3h18v18H3ZM3 20l12-12 6 6M7 7h.01',refresh:'M21 11a9 9 0 1 0-2 7M21 3v8h-8'}[kind]}"/></svg>`;
 const button=(id,label,kind,extra='')=>`<button type="button" id="${id}" class="imageIcon ${extra}" title="${label}" aria-label="${label}">${icon(kind)}</button>`;
 const settings=document.querySelector('#matterPlanningDrawer'),tabs=document.querySelector('#mpSettingsTabs');
 const tab=document.createElement('button');tab.id='mpStorageTab';tab.type='button';tab.role='tab';tab.textContent='图片存储';tab.setAttribute('aria-controls','mpStoragePanel');tab.setAttribute('aria-selected','false');tab.tabIndex=-1;tabs.append(tab);
 const panel=document.createElement('section');panel.id='mpStoragePanel';panel.hidden=true;panel.role='tabpanel';panel.setAttribute('aria-labelledby','mpStorageTab');
 panel.innerHTML=`<div class="imageSettingsHead"><h3>腾讯云 COS</h3><div class="imageTools">${button('imageConfigCheck','检查连接','check')}${button('imageConfigSave','保存配置','save','primary')}</div></div><form id="imageConfigForm" autocomplete="off"><div class="imageConfigFields"><label>地域<input id="imageRegion" maxlength="50" required spellcheck="false"></label><label>存储桶<input id="imageBucket" maxlength="100" required spellcheck="false"></label><label>SecretId<input id="imageSecretId" type="password" autocomplete="new-password" maxlength="256"></label><label>SecretKey<input id="imageSecretKey" type="password" autocomplete="new-password" maxlength="256"></label></div><p class="imageHelp">已有密钥留空保留，替换时填写一组新密钥。</p><div class="imageConfigStatus"><p><span>密钥状态</span><span id="imageCredentialStatus">正在加载</span></p><p><span>连接状态</span><span id="imageConnectionStatus">尚未检查</span></p></div><p id="imageConfigError" class="imageError" role="status"></p><button id="imageConfigRecover" type="button" hidden>核对保存结果</button><button id="imageConfigRetry" type="button" hidden>使用原操作重试保存</button></form>`;
 document.querySelector('#mpSettings').append(panel);
 const q=id=>document.getElementById(id);
 let cfg=null,cfgBusy=false,cfgPending=null,cfgDirty=false,cfgLoad=0;
 function cfgControls(){q('imageConfigSave').disabled=cfgBusy||!cfg||!!cfgPending;q('imageConfigCheck').disabled=cfgBusy||!cfg?.has_credentials||cfgDirty||!!cfgPending;panel.querySelectorAll('input').forEach(el=>el.disabled=cfgBusy||!!cfgPending);q('imageConfigRecover').hidden=!cfgPending;}
 function fillConfig(value){cfg=value;cfgDirty=false;q('imageRegion').value=value.region;q('imageBucket').value=value.bucket;for(const id of ['imageSecretId','imageSecretKey']){q(id).value='';q(id).placeholder=value.has_credentials?'已配置，留空保留':'请输入';}q('imageCredentialStatus').textContent=value.has_credentials?'已配置':'未配置';q('imageConnectionStatus').textContent='尚未检查';cfgControls();}
 async function loadConfig(){if(cfgPending||cfgBusy)return;const token=++cfgLoad;cfgBusy=true;cfgControls();try{const value=await api('/image-storage');if(token===cfgLoad){fillConfig(value);q('imageConfigError').textContent='';}}catch(e){cfg=null;q('imageConfigError').textContent=e.message+'，重新进入本分类可重试';}finally{cfgBusy=false;cfgControls();}}
 tab.onclick=()=>settings.dispatchEvent(new Event('image-storage-select'));
 settings.addEventListener('image-storage-open',()=>{if(!cfgDirty)loadConfig();});
 q('imageConfigForm').addEventListener('input',()=>{cfgDirty=true;q('imageConnectionStatus').textContent='配置有修改，请保存后检查';cfgControls();});
 function cfgComplete(value){cfgPending=null;q('imageConfigRetry').hidden=true;fillConfig(value);q('imageConfigError').textContent='配置已保存并读回，可前往事件上传图片。';}
 q('imageConfigSave').onclick=async()=>{
  if(cfgBusy||!cfg||cfgPending)return;const sid=q('imageSecretId').value.trim(),key=q('imageSecretKey').value.trim();
  if(sid&&sid===key){q('imageConfigError').textContent='SecretId和SecretKey不能相同，请填写同一组密钥的两个不同字段';return;}
  if(Boolean(sid)!==Boolean(key)||(!cfg.has_credentials&&!sid)){q('imageConfigError').textContent='请填写一组SecretId和SecretKey';return;}
  cfgPending={operation_id:crypto.randomUUID(),expected_revision:cfg.revision,region:q('imageRegion').value.trim(),bucket:q('imageBucket').value.trim(),...(sid?{secret_id:sid,secret_key:key}:{})};cfgBusy=true;cfgControls();
  try{cfgComplete(await api('/image-storage','PUT',cfgPending));}catch(e){if(e.status>=400&&e.status<500)cfgPending=null;q('imageConfigError').textContent=e.message+(cfgPending?'；保存结果待核对，未自动重试':'');}finally{cfgBusy=false;cfgControls();}
 };
 q('imageConfigForm').onsubmit=e=>{e.preventDefault();q('imageConfigSave').click();};
 q('imageConfigRecover').onclick=async()=>{if(cfgBusy||!cfgPending)return;cfgBusy=true;cfgControls();try{cfgComplete(await api('/image-operations/'+cfgPending.operation_id));}catch(e){q('imageConfigRetry').hidden=e.status!==404;q('imageConfigError').textContent=e.message+'；配置仍待核对';}finally{cfgBusy=false;cfgControls();}};
 q('imageConfigRetry').onclick=async()=>{if(cfgBusy||!cfgPending)return;cfgBusy=true;cfgControls();try{cfgComplete(await api('/image-storage','PUT',cfgPending));}catch(e){q('imageConfigError').textContent=e.message+'；未自动重试';}finally{cfgBusy=false;cfgControls();}};
 q('imageConfigCheck').onclick=async()=>{if(q('imageConfigCheck').disabled)return;cfgBusy=true;cfgControls();q('imageConnectionStatus').textContent='检查中';try{const result=await api('/image-storage/check','POST',{});q('imageConnectionStatus').textContent='存储桶访问检查通过';q('imageConfigError').textContent=result.message;}catch(e){q('imageConnectionStatus').textContent='检查失败';q('imageConfigError').textContent=e.message;}finally{cfgBusy=false;cfgControls();}};
 const drawer=document.createElement('dialog');drawer.id='imageDrawer';drawer.setAttribute('aria-labelledby','imageTitle');
 drawer.innerHTML=`<div class="drawerHead"><h2 id="imageTitle">事件图片</h2><div class="imageTools">${button('imageReload','刷新图片与访问链接','refresh')}${button('imageClose','关闭图片','close')}</div></div><div class="imageBody"><div id="imageContext" class="imageContext"></div><div id="imageSource" hidden></div><div class="imageTools imageWrap"><button id="imagePaste" type="button">${icon('image')} 粘贴图片 <kbd>Ctrl+V</kbd></button><button id="imageChoose">选择图片</button><button id="imageUpload" class="primary">上传图片</button><button id="imageAnalyze" class="primary" hidden>分析图片</button></div><input id="imageFiles" type="file" accept="image/jpeg,image/png,image/webp" multiple hidden><p class="imageHelp">JPEG、PNG、WebP · 单张≤10MiB · 每个对象≤20张</p><p id="imageError" class="imageError" role="status"></p><div id="imageQueue" class="imageGrid"></div><h3>已保存图片</h3><div id="imageSaved" class="imageGrid"></div><section id="imageAnalysis" hidden><h3>下一步事件</h3><p id="imageSummary" role="status"></p><div id="imageCandidates"></div><div class="imageTools imageWrap"><button id="imageConfirm" type="button" class="primary" hidden>确认创建所选</button><button id="imageConfirmCheck" type="button" hidden>核对创建结果</button></div></section><p class="imageHelp">移除仅解除关联，云端原文件暂保留。</p></div>`;
 document.body.append(drawer);
 const viewer=document.createElement('dialog');viewer.id='imageViewer';viewer.setAttribute('aria-label','图片预览');viewer.innerHTML=`<div class="drawerHead"><h2 id="imageViewerName"></h2>${button('imageViewerClose','关闭预览','close')}</div><img id="imageLarge" alt="">`;document.body.append(viewer);const previewError=document.createElement('p');previewError.className='imageHelp';previewError.setAttribute('role','status');viewer.append(previewError);q('imageLarge').onerror=()=>{previewError.textContent='图片暂不可访问或链接已过期，请关闭预览后刷新图片。';};drawer.addEventListener('error',e=>{if(e.target.tagName==='IMG')q('imageError').textContent=e.target.src.startsWith('blob:')?'无法预览该文件，请重新选择图片。':'图片暂不可访问或链接已过期，请刷新图片。';},true);
 const removalRecovery=document.createElement('div');q('imageError').after(removalRecovery);
 let selected='',snapshot=null,rows=[],queue=[],busy=false,load=0,removePending=null,removeCanRetry=false;
 const drafts=new Map();
 const picks=new Set();
 const batches=new Map();
 const retryable=new Set();
 const submitted=new Map();
 const retryConfirm=document.createElement('button');
 retryConfirm.type='button';retryConfirm.textContent='重试原确认';retryConfirm.hidden=true;
 q('imageConfirmCheck').after(retryConfirm);
 retryConfirm.onclick=()=>{
  const id=uncertain[selected], body=submitted.get(selected);
  if(!busy&&id&&body&&retryable.has(selected))void sendConfirmation(id,body);
 };
 const pendingKey='todo-image-confirmations';
 let uncertain={};
 try{uncertain=JSON.parse(sessionStorage.getItem(pendingKey)||'{}')||{};}catch{}
 const imagePath=(id=selected)=>`/${get(id)?.type==='thing'?'items':'events'}/${encodeURIComponent(id)}/images`;
 const analysisPath=(id=selected)=>`/items/${encodeURIComponent(id)}/image-actions`;
 const canUpload=item=>['pending','failed','absent'].includes(item.state);
 function controls(){
  q('imageUpload').disabled=busy||!!removePending||!snapshot||!queue.some(canUpload);
  q('imageChoose').disabled=q('imagePaste').disabled=busy||!snapshot;
  q('imageReload').disabled=busy;
  q('imageAnalyze').hidden=!picks.size;
  q('imageAnalyze').disabled=busy||!snapshot||!!uncertain[selected]||picks.size>4;
  const batch=batches.get(selected);
  const changed=!!batch&&(batch.image_ids.length!==picks.size||batch.image_ids.some(id=>!picks.has(id)));
  q('imageConfirm').disabled=busy||!!uncertain[selected]||changed;
  q('imageConfirm').title=changed?'图片选择已变化，请重新分析':'';
  q('imageConfirmCheck').disabled=busy;
  retryConfirm.disabled=busy;
  retryConfirm.hidden=!retryable.has(selected);
  drawer.querySelectorAll('[data-action]').forEach(x=>x.disabled=busy||(!!removePending&&!['recover-remove','retry-remove','preview'].includes(x.dataset.action)));
 }
 function draw(){
  const labels={pending:'待上传',failed:'上传未完成',unknown:'结果待核对',absent:'云端未找到，可主动重试',mismatch:'内容不符，需检查',blocked:'事件已变化，图片未关联',ready:'已保存'};
  const card=(x,local)=>`<article class="imageCard">${x.url?`<button class="imageThumb" data-action="preview" data-id="${esc(x.id)}" aria-label="预览：${esc(x.name)}"><img src="${esc(x.url)}" alt="${esc(x.name)}"></button>`:''}<div class="imageCaption"><label class="imagePick"><input type="checkbox" data-action="pick" data-id="${esc(x.id)}" ${picks.has(x.id)?'checked':''}>${esc(x.name)}</label><p>${esc(labels[x.state]||'待核对')}</p>${!local&&x.created_at?`<p class="muted">${esc(new Date(x.created_at).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'}))}</p>`:''}${local&&['pending','failed'].includes(x.state)?`<button data-action="cancel" data-id="${esc(x.id)}">取消</button>`:['ready','absent','blocked'].includes(x.state)?`<button data-action="remove" data-id="${esc(x.id)}">移除</button>`:`<button data-action="reconcile" data-id="${esc(x.id)}">核对结果</button>`}</div></article>`;
  q('imageQueue').innerHTML=queue.map(x=>card(x,true)).join('');q('imageSaved').innerHTML=rows.filter(x=>!queue.some(d=>d.id===x.id)).map(x=>card(x,false)).join('')||'<p class="muted">暂无图片</p>';
  removalRecovery.innerHTML=removePending?'<button data-action="recover-remove">核对移除结果</button>'+(removeCanRetry?'<button data-action="retry-remove">使用原操作重试移除</button>':''):'';
  controls();
 }
 async function reload(){const token=++load;try{const result=await api(imagePath());if(token!==load)return;snapshot=result.event;rows=result.images;for(const item of [...queue]){const found=rows.find(x=>x.id===item.id);if(found){item.state=found.state;item.revision=found.revision;if(found.state==='ready'||found.state==='removed'){URL.revokeObjectURL(item.url);queue.splice(queue.indexOf(item),1);}}}const path=[];for(let parent=get(snapshot.parent);parent;parent=get(parent.parent))path.unshift(parent.name);q('imageContext').textContent=snapshot.name+(path.length?'\n'+path.join(' / '):'');q('imageTitle').textContent=snapshot.type==='thing'?'事情图片':'事件图片';const source=result.source;q('imageSource').hidden=!source;q('imageSource').innerHTML=source?`<details><summary>来源图片 · ${esc(source.name)}</summary><p>${esc(source.evidence)}</p>${source.url?`<a href="${esc(source.url)}" target="_blank" rel="noreferrer">查看原图</a>`:'<p class="muted">原图暂不可查看</p>'}</details>`:'';for(const id of picks){if(!rows.some(row=>row.id===id)&&!queue.some(row=>row.id===id))picks.delete(id);}draw();}catch(e){if(token===load){snapshot=null;q('imageError').textContent=e.message;controls();}}}
 async function open(id, focusIds){if(busy)return false;if(removePending&&id!==selected){notify('请先核对当前图片的移除结果');return false;}drafts.set(selected,queue);selected=id;queue=drafts.get(id)||[];rows=[];snapshot=null;picks.clear();for(const id of focusIds||batches.get(selected)?.image_ids||[])picks.add(id);q('imageContext').textContent='';q('imageSource').hidden=true;q('imageError').textContent='';paintBatch();draw();if(!drawer.open)drawer.showModal();await reload();return !!snapshot;}
 q('imageClose').onclick=()=>drawer.close();q('imageReload').onclick=reload;q('imageViewerClose').onclick=()=>viewer.close();
 q('imageChoose').onclick=()=>q('imageFiles').click();
 function addToDrawer(files){
  if(busy||!snapshot)return;
  for(const file of files){
   if(rows.length+queue.filter(x=>!rows.some(r=>r.id===x.id)).length>=20){q('imageError').textContent='每个对象最多20张图片';break;}
   if(!validFile(file)){q('imageError').textContent='仅支持不超过10MiB的JPEG、PNG、WebP';continue;}
   const item = draftImage(file);
   queue.push(item);
   if(picks.size<4)picks.add(item.id);
  }
  draw();
 }
 connectClipboard(q('imagePaste'),addToDrawer,message=>{q('imageError').textContent=message;},()=>selected);
 q('imageFiles').onchange=e=>{addToDrawer([...e.target.files]);e.target.value='';};
 q('imageUpload').onclick=async()=>{
  if(q('imageUpload').disabled)return;busy=true;controls();q('imageError').textContent='正在上传…';
  try{await storeImages(snapshot,queue.filter(canUpload));await reload();q('imageError').textContent='图片已上传并读回。';}
  catch(e){await reload();q('imageError').textContent=e.message;}
  finally{busy=false;draw();}
 };
 async function recoverRemoval(){try{const result=await api('/image-operations/'+removePending.body.operation_id);removePending=null;removeCanRetry=false;q('imageError').textContent='已核对移除结果';await reload();return result;}catch(e){removeCanRetry=e.status===404;throw e;}}
 async function sendRemoval(){try{await api(imagePath()+'/'+removePending.id+'/remove','POST',removePending.body);picks.delete(removePending.id);batches.delete(selected);paintBatch();removePending=null;removeCanRetry=false;await reload();q('imageError').textContent='图片关联已移除';}catch(e){if(e.status>=400&&e.status<500)removePending=null;throw e;}}
 drawer.addEventListener('click',async e=>{
  const b=e.target.closest('[data-action]');if(!b||busy)return;const x=[...queue,...rows].find(v=>v.id===b.dataset.id);
  if(b.dataset.action==='pick'){if(b.checked)picks.add(b.dataset.id);else picks.delete(b.dataset.id);controls();return;}
  if(b.dataset.action==='preview'){previewError.textContent='';q('imageViewerName').textContent=x.name;q('imageLarge').src=x.url;q('imageLarge').alt=x.name;viewer.showModal();return;}
  if(b.dataset.action==='cancel'){URL.revokeObjectURL(x.url);picks.delete(x.id);queue=queue.filter(v=>v!==x);drafts.set(selected,queue);draw();return;}
  busy=true;controls();try{
   if(b.dataset.action==='reconcile'){const result=await api(imagePath()+'/'+x.id+'/reconcile','POST',{});if(x.file)x.state=result.state;await reload();q('imageError').textContent=result.state==='ready'?'已核对图片保存成功':result.state==='absent'?'云端未找到图片，可主动重试原图片或移除占位。':'仍需核对，未自动重传';}
   else if(b.dataset.action==='remove'){if(removePending||!confirm('从事件中移除此图片？云端原文件暂保留。'))return;removePending={id:x.id,body:{operation_id:crypto.randomUUID(),expected_revision:x.revision}};await sendRemoval();}
   else if(b.dataset.action==='recover-remove')await recoverRemoval();
   else if(b.dataset.action==='retry-remove'&&removeCanRetry)await sendRemoval();
  }catch(error){q('imageError').textContent=error.message;}
  finally{busy=false;draw();}
 });
 function validFile(file){return ['image/jpeg','image/png','image/webp'].includes(file.type)&&file.size>0&&file.size<=10*1024*1024;}

 function draftImage(file){return {id:crypto.randomUUID(),file,name:file.name||'剪贴板图片',url:URL.createObjectURL(file),state:'pending'};}

 function connectClipboard(button, add, message, scope){
  button.addEventListener('paste',event=>{
   const files=[...(event.clipboardData?.items||[])].filter(item=>item.kind==='file'&&item.type.startsWith('image/')).map(item=>item.getAsFile()).filter(Boolean);
   if(files.length){event.preventDefault();add(files);}else message('剪贴板中没有图片。');
  });
  button.onclick=async()=>{
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
  };
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

 function paintBatch(){
  const batch=batches.get(selected), hasPending=!!uncertain[selected];
  q('imageAnalysis').hidden=!batch&&!hasPending;
  q('imageSummary').textContent=hasPending?'创建结果待核对。':batch?.summary||'';
  q('imageConfirm').hidden=!batch?.candidates.length||hasPending;
  q('imageConfirmCheck').hidden=!hasPending;
  q('imageCandidates').innerHTML=(batch?.candidates||[]).map((candidate,index)=>`
   <article class="imageCandidate" data-index="${index}">
    <div class="imageCandidateTitle"><input type="checkbox" aria-label="选中候选 ${index+1}" data-field="selected" ${candidate.selected?'checked':''}><input aria-label="事件名称" data-field="name" maxlength="120" value="${esc(candidate.name)}"></div>
    ${batch.duplicates?.includes(candidate.name)?'<small class="muted">已有同名事件，请先核对</small>':''}
    <details><summary>详情与图片依据</summary>
     <label>说明<textarea data-field="description" maxlength="2000">${esc(candidate.description)}</textarea></label>
     <div class="fieldGrid"><label>责任人<input data-field="owner" maxlength="80" value="${esc(candidate.owner)}"></label><label>计划结束<input type="date" data-field="planEnd" value="${esc(candidate.planEnd)}"></label></div>
     <p>${esc(candidate.evidence)}</p><button type="button" data-action="preview" data-id="${esc(candidate.image_id)}">对照来源图片</button>
    </details>
   </article>`).join('');
  controls();
 }
 q('imageCandidates').addEventListener('input',event=>{
  const field=event.target.dataset.field, index=Number(event.target.closest('[data-index]')?.dataset.index);
  const candidate=batches.get(selected)?.candidates[index];
  if(candidate&&field)candidate[field]=field==='selected'?event.target.checked:event.target.value;
 });

 async function analyzePicked(){
  if(q('imageAnalyze').disabled||!picks.size)return;
  if(batches.get(selected)?.candidates.length&&!confirm('重新分析会替换当前候选，继续吗？'))return;
  busy=true;controls();q('imageError').textContent='正在保存并分析所选图片…';
  try{
   await storeImages(snapshot,queue.filter(item=>picks.has(item.id)));
   const batch=await api(analysisPath(),'POST',{image_ids:[...picks]});
   batch.candidates.forEach(candidate=>{candidate.selected=true;});
   if(!batch.candidates.length)batch.summary=['未识别出可执行事项。',batch.summary].filter(Boolean).join(' ');
   batches.set(selected,batch);
   q('imageError').textContent='';
  }catch(e){q('imageError').textContent=e.message;}
  finally{await reload();busy=false;paintBatch();}
 }
 q('imageAnalyze').onclick=analyzePicked;

 function setUncertain(id){
  if(id)uncertain[selected]=id;else{delete uncertain[selected];retryable.delete(selected);submitted.delete(selected);}
  try{sessionStorage.setItem(pendingKey,JSON.stringify(uncertain));}catch{}
 }
 async function created(result){
  const count=result.created.length;
  setUncertain(null);batches.delete(selected);
  q('imageError').textContent=`已确认创建 ${count} 个${snapshot?.type==='event'?'子事件':'事件'}`;
  try{db.items=await api('/items');render();}catch{q('imageError').textContent+='。清单刷新失败，请刷新页面查看。';}
 }
 q('imageConfirm').onclick=async()=>{
  const batch=batches.get(selected);
  if(!batch||q('imageConfirm').disabled)return;
  if(!snapshot){q('imageError').textContent='请先刷新当前图片。';return;}
  const candidates=batch.candidates.map(({name,description,owner,planEnd,selected},index)=>selected?{index,name,description,owner,planEnd}:null).filter(Boolean);
  if(!candidates.length||candidates.some(item=>!item.name.trim())){q('imageError').textContent='请勾选并填写要创建的事件。';return;}
  submitted.set(selected,{candidates});
  await sendConfirmation(batch.id,{candidates});
 };
 async function sendConfirmation(id,body){
  busy=true;setUncertain(id);retryable.delete(selected);controls();
  try{await created(await api(`${analysisPath()}/${id}/confirm`,'POST',body));}
  catch(e){if(e.status>=400&&e.status<500)setUncertain(null);q('imageError').textContent=e.message;}
  finally{busy=false;paintBatch();}
 }
 q('imageConfirmCheck').onclick=async()=>{
  const id=uncertain[selected];if(!id||busy)return;
  busy=true;controls();
  try{await created(await api(`${analysisPath()}/${id}/result`));}
  catch(e){
   if(e.status===404&&submitted.has(selected))retryable.add(selected);
   q('imageError').textContent=e.status===404?'尚未查到已创建结果，请稍后核对。':e.message;
  }
  finally{busy=false;paintBatch();}
 };

 let editorFiles=[];
 const followFiles=new Map();
 function inlineImages(host, files, target){
  const area=document.createElement('section');
  area.className='inlineImageEntry';
  area.innerHTML=`<div class="imageTools imageWrap"><button type="button" class="imageIcon inlineImagePaste" aria-label="附加图片" title="附加图片 / Ctrl+V">${icon('image')}<span>附加图片</span></button><button type="button" class="inlineImageChoose">选文件</button>${target?'<button type="button" class="inlineAnalyze" hidden>分析图片</button>':''}</div><input type="file" accept="image/jpeg,image/png,image/webp" multiple hidden><div class="inlineImagePreview"></div><p class="imageHelp" role="status"></p>`;
  host.after(area);
  const input=area.querySelector('input'), list=area.querySelector('.inlineImagePreview');
  const message=text=>{area.querySelector('[role=status]').textContent=text;};
  const analysis=area.querySelector('.inlineAnalyze');
  function drawDraft(){
   list.innerHTML=files.map(item=>`<span><img src="${esc(item.url)}" alt="${esc(item.name)}"><button type="button" class="imageIcon" data-drop="${item.id}" aria-label="移除${esc(item.name)}">${icon('close')}</button>${item.state!=='ready'&&!canUpload(item)&&target?`<button type="button" data-check="${item.id}">核对</button>`:''}</span>`).join('');
   if(analysis)analysis.hidden=!files.length;
  }
  function add(newFiles){
   for(const file of newFiles){
    if(files.length>=20){message('最多附加20张图片');break;}
    if(!validFile(file)){message('仅支持不超过10MiB的JPEG、PNG、WebP');continue;}
    files.push(draftImage(file));
   }
   drawDraft();
  }
  connectClipboard(area.querySelector('.inlineImagePaste'),add,message,()=>area);
  area.querySelector('.inlineImageChoose').onclick=()=>input.click();
  input.onchange=()=>{add([...input.files]);input.value='';};
  list.onclick=async event=>{
   const button=event.target.closest('[data-drop],[data-check]');if(!button)return;
   const index=files.findIndex(item=>item.id===(button.dataset.drop||button.dataset.check));
   if(index<0)return;
   const item=files[index];
   if(button.dataset.drop){files.splice(index,1);URL.revokeObjectURL(item.url);drawDraft();return;}
   button.disabled=true;
   try{item.state=(await api(`${imagePath(target)}/${item.id}/reconcile`,'POST',{})).state;message(item.state==='ready'?'图片已保存。':'图片尚未完成保存。');}
   catch(e){message(e.message);}
   finally{drawDraft();}
  };
  if(analysis)analysis.onclick=async()=>{
   if(files.length>4){message('一次最多分析4张。请先保存跟进，再到事件图片中选择。');return;}
   if(!dailyView||dailyBusy||dailyPending)return;
   dailyBusy=true;dailyLock();analysis.disabled=true;
   try{
    const ids=await storeImages(dailyView.item,files);
    if(await open(target,ids))await analyzePicked();
   }catch(e){message(e.message);}
   finally{dailyBusy=false;dailyLock();analysis.disabled=false;drawDraft();}
  };
  drawDraft();
  return area;
 }

 function editorOpened(action){
  q('editor').querySelector('.inlineImageEntry')?.remove();
  editorFiles.forEach(item=>URL.revokeObjectURL(item.url));editorFiles=[];
  if(action)inlineImages(q('description'),editorFiles);
 }
 function editorSaved(item){
  if(!editorFiles.length)return;
  const files=editorFiles;editorFiles=[];
  drafts.set(item.id,files);
  void open(item.id).then(loaded=>{if(loaded&&selected===item.id)q('imageUpload').click();});
 }
 function mountFollow(id){
  q('dailyFollowDialog').querySelector('.inlineImageEntry')?.remove();
  const files=followFiles.get(id)||[];followFiles.set(id,files);
  return inlineImages(q('dailyContent'),files,id);
 }
 function followSaved(id){
  followFiles.get(id)?.forEach(item=>URL.revokeObjectURL(item.url));followFiles.delete(id);
  if(q('dailyFollowDialog').open&&dailyTarget===id)mountFollow(id);
 }
 function entry(label,id){
  const node=document.createElement('button');
  node.className='imageIcon eventImagesEntry';node.type='button';node.title=label;
  node.setAttribute('aria-label',label);node.innerHTML=icon('image');node.onclick=()=>open(id);
  return node;
 }
 function entries(){
  const matterHead=document.querySelector('#events > .panelHead');
  if(matterHead&&selection.thing&&!matterHead.querySelector('.eventImagesEntry')){
   const group=document.createElement('div');group.className='imageTools';
   group.append(entry('事情图片',selection.thing),...matterHead.querySelectorAll(':scope > button'));
   matterHead.append(group);
  }
  document.querySelectorAll('#events .eventActions').forEach(host=>{
   const id=host.querySelector('.followBell')?.dataset.event;
   if(id&&!host.querySelector('.eventImagesEntry'))host.append(entry('事件图片：'+(get(id)?.name||''),id));
  });
 }
 function eventDetail(id,visible){
  const header=q('eventDrawer').querySelector('.drawerHead');
  header.querySelector('.eventImagesEntry')?.remove();
  if(visible)header.querySelector('button').before(entry('事件图片',id));
 }
 new MutationObserver(entries).observe(document.getElementById('events'),{childList:true,subtree:true});entries();cfgControls();
 return {editorOpened,editorSaved,mountFollow,followSaved,eventDetail,open,
         followUpload:target=>storeImages(target,followFiles.get(target.id)||[])};
})();
