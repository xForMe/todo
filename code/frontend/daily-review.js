/* TECH-023: explicit append-only follow-ups and recoverable atomic postponements. */
let dailyFilter='pending',dailyBusy=false,dailyPending=null,dailyCanRetry=false;
let dailyView=null,dailyTarget=null,dailyRun=0;
const dailyDrafts=new Map();
try{dailyPending=JSON.parse(sessionStorage.getItem('todo-follow-up-pending')||'null')}catch(e){/* Corrupt local state must not crash the workbench. */}
const dailyDialog=document.createElement('dialog');dailyDialog.id='dailyFollowDialog';dailyDialog.setAttribute('aria-labelledby','dailyFollowTitle');document.body.append(dailyDialog);
const dailySaveIcon='<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h12l4 4v12a2 2 0 0 1-2 2Z"/><path d="M17 21v-8H7v8M7 3v5h9"/></svg>';
function dailyRecord(id){return wbSnapshot?.daily_reviews?.find(x=>x.item_id===id&&x.day===wbSnapshot.today)}
function dailyReviewed(id){return !!dailyRecord(id)?.reviewed_at}
function dailyIcon(kind){const paths={pending:'<path d="M21 12a9 9 0 1 1-9-9M12 7v5l3 2"/>',done:'<path d="M21 11v1a9 9 0 1 1-5.3-8.2m-6.7 7.2 3 3L22 4"/>'};return `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true">${paths[kind]}</svg>`}
function dailyDisabled(){return dailyBusy||dailyPending||wbLoading||wbError||wbBusy||wbPending}
function dailyActionButton(event,placement='workbench'){
 const detail=placement==='detail',workbench=placement==='workbench',id=esc(event.id);
 const attributes=detail?'data-event-shortcut="follow"':`class="dailyIcon dailyMark"${workbench?'':` data-daily-row="${id}"`}`;
 const label=detail?'当日跟进':`当日跟进：${esc(event.name)}`;
 return `<button type="button" ${attributes} ${workbench&&dailyDisabled()?'disabled':''}
  title="当日跟进" aria-label="${label}" onclick="setDailyReview('${id}',${!workbench})">${dailyIcon('done')}${detail?'当日跟进':''}</button>`;
}
function dailyAction(event){return `<div class="dailyAction">${dailyActionButton(event)}</div>`}
function dailyToolbar(rows){return `<div class="dailyFilters" role="group" aria-label="当日跟进筛选">${['pending','done'].map(k=>{const name=k==='done'?'已跟进':'未跟进',count=rows.filter(x=>dailyReviewed(x.id)===(k==='done')).length;return `<button class="dailyIcon ${dailyFilter===k?'active':''}" data-daily-filter="${k}" title="当日${name} ${count} 项" aria-label="当日${name} ${count} 项" aria-pressed="${dailyFilter===k}" onclick="dailyFilter='${k}';wbPages.events=0;drawWorkbench()">${dailyIcon(k)}<span>${count}</span></button>`}).join('')}</div>`}
function dailyFocus(){wbHome.querySelector(`[data-daily-filter="${dailyFilter}"]`)?.focus({preventScroll:true})}
function dailyWarning(){return dailyPending&&!dailyBusy?`<div class="wbWarning" role="alert">跟进保存结果待核对。<button onclick="recoverDailyReview()">核对跟进结果</button>${dailyCanRetry?'<button onclick="sendDailyReview()">使用原操作标识重试</button>':''}</div>`:''}
function dailyStore(){try{if(dailyPending)sessionStorage.setItem('todo-follow-up-pending',JSON.stringify(dailyPending));else sessionStorage.removeItem('todo-follow-up-pending')}catch(e){notify('无法保存本页恢复标识，请保持页面打开完成核对')}}
function dailyMessage(text,error=false){const box=dailyDialog.querySelector('#dailyResult');if(box){box.hidden=false;box.textContent=text;box.classList.toggle('error',error)}else notify(text)}
function dailyLock(){dailyDialog.dataset.busy=String(!!(dailyBusy||dailyPending));for(const id of ['dailySave','dailyClose','dailyContent','dailyPlain','dailyReload']){const el=document.getElementById(id);if(el)el.disabled=!!(dailyBusy||dailyPending)||(id==='dailySave'&&!dailyView)}dailyDialog.querySelectorAll('.inlineImageEntry button,.inlineImageEntry input').forEach(el=>el.disabled=!!(dailyBusy||dailyPending)||!dailyView);drawWorkbench()}
function dailyShell(){dailyDialog.innerHTML=`<div class="dailyHead"><h2 id="dailyFollowTitle">当日跟进</h2><div class="dailyHeadActions"><button id="dailySave" class="primary" title="保存跟进" aria-label="保存跟进" disabled>${dailySaveIcon}</button><button id="dailyClose" title="关闭当日跟进" aria-label="关闭当日跟进"><svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg></button></div></div><div class="dailyBody"><div id="dailyContext"></div><label for="dailyContent">本次跟进</label><textarea id="dailyContent" maxlength="4000" rows="3" placeholder="记录这次跟进情况…"></textarea><small>写明新的日期，保存时自动同步延期记录。</small><p id="dailyResult" role="status" hidden></p><div class="dailyRecovery"><button id="dailyReload" hidden>重新读取</button><button id="dailyPlain" hidden>仅保存跟进</button><button id="dailyVerify" hidden>核对保存结果</button><button id="dailyRetry" hidden>使用原操作标识重试</button></div><h3 id="dailyRecordsTitle">当日记录</h3><div id="dailyRecords"></div></div>`;
 $('#dailySave').onclick=()=>saveDailyFollow();$('#dailyClose').onclick=()=>{if(!dailyBusy&&!dailyPending)dailyDialog.close()};$('#dailyContent').oninput=()=>dailyDrafts.set(dailyTarget,$('#dailyContent').value);$('#dailyReload').onclick=()=>dailyRead();$('#dailyPlain').onclick=()=>saveDailyFollow(true);$('#dailyVerify').onclick=recoverDailyReview;$('#dailyRetry').onclick=sendDailyReview;
}
async function setDailyReview(id,fromEventPage=false){
 if(dailyDialog.open||dailyBusy||wbBusy||busy||eventBusy||priorityBusy||moveBusy||deletionBusy)return;
 if(!fromEventPage&&(wbLoading||wbError))return;
 if(dailyPending||wbPending||pendingWrite||eventPending||priorityPending||moveIntent||deletionIntent){notify('请先核对尚未完成的保存操作');return}
 const item=get(id);
 if(!item||!pending(item))return;
 dailyTarget=id;dailyView=null;dailyShell();if(typeof todoImages!=='undefined')todoImages.mountFollow(id);$('#dailyContent').value=dailyDrafts.get(id)||'';dailyDialog.showModal();await dailyRead();$('#dailyContent')?.focus();
}
function dailyPaint(){if(!dailyView)return;const v=dailyView,e=v.item,path=wbPath(wbGet(e.id));$('#dailyContext').innerHTML=`<strong>${esc(e.name)}</strong><p>${esc(path?.text||'')}</p><p>当前截止：${esc(e.planEnd||'未排期')}</p>`;$('#dailyRecordsTitle').textContent=`当日记录 ${v.records.length} · ${v.day}`;$('#dailyRecords').innerHTML=v.records.map(r=>`<article class="dailyEntry"><time>${esc(r.created_at.slice(11,16))}</time><p>${esc(r.content)}</p>${r.new_end!==r.old_end?`<small>截止时间 ${esc(r.old_end)} → ${esc(r.new_end)} · 已加入延期记录</small>`:''}${r.note?`<small>${esc(r.note)}</small>`:''}${r.image_ids?.length?`<button type="button" data-follow-images="${esc(r.id)}">图片 ${r.image_ids.length} 张</button>`:''}</article>`).join('')||(v.legacy_at?'<p class="muted">旧梳理标记，无跟进正文</p>':'<p class="muted">今天还没有跟进记录</p>')}
dailyDialog.addEventListener('click',event=>{
 const button=event.target.closest('[data-follow-images]');
 const record=dailyView?.records.find(row=>row.id===button?.dataset.followImages);
 if(record&&!dailyBusy&&!dailyPending&&typeof todoImages!=='undefined')todoImages.open(record.item_id,record.image_ids);
});
async function dailyRead(){const run=++dailyRun,id=dailyTarget;dailyView=null;dailyLock();dailyMessage('正在读取…');try{const view=await api('/items/'+id+'/daily-follow-ups');if(run!==dailyRun||id!==dailyTarget||!dailyDialog.open)return;dailyView=view;dailyPaint();$('#dailyResult').hidden=true;$('#dailyReload').hidden=true}catch(e){dailyMessage('读取失败：'+e.message,true);$('#dailyReload').hidden=false}finally{dailyLock()}}
async function saveDailyFollow(skip=false){
 if(dailyBusy||dailyPending||!dailyView)return;
 const content=$('#dailyContent').value.trim();
 if(!content){dailyMessage('请填写本次跟进内容',true);$('#dailyContent').focus();return;}
 const view=dailyView;
 let imageIds=[];
 if(typeof todoImages!=='undefined'){
  dailyBusy=true;dailyLock();
  try{imageIds=await todoImages.followUpload(view.item);}
  catch(e){dailyMessage('附图尚未全部保存：'+e.message,true);return;}
  finally{dailyBusy=false;dailyLock();}
 }
 dailyPending={id:dailyTarget,body:{operation_id:crypto.randomUUID(),expected_version:view.item.version,expected_revision:view.revision,day:view.day,content,skip_ai:skip}};
 if(imageIds.length)dailyPending.body.image_ids=imageIds;
 dailyStore();await sendDailyReview();
}
async function dailyConfirm(result){
 if(!await loadWorkbench())throw Error('已提交，工作台读回失败，请核对');
 const view=await api('/items/'+result.item_id+'/daily-follow-ups');
 if(view.day===result.day&&!view.records.some(r=>r.id===result.id))throw Error('跟进记录尚未读回，请核对');
 if(result.new_end!==result.old_end){const history=await api('/items/'+result.item_id+'/plan-history');if(!history.records.some(r=>r.operation_id===result.id))throw Error('延期历史尚未读回，请核对');if(history.item.version<result.item_version)throw Error('计划尚未读回，请核对')}
 dailyDrafts.delete(result.item_id);if(typeof todoImages!=='undefined')todoImages.followSaved(result.item_id);if(dailyTarget===result.item_id&&dailyDialog.open){dailyView=view;dailyPaint();$('#dailyContent').value='';$('#dailyPlain').hidden=true;$('#dailyVerify').hidden=true;$('#dailyRetry').hidden=true;dailyMessage(view.day===result.day?'已保存，可继续记录下一次跟进':'已核对上一日期的跟进，今日可重新记录')}
 dailyPending=null;dailyCanRetry=false;dailyStore();if(typeof refreshPlanMarks==='function')await refreshPlanMarks();notify('跟进已保存并读回');
}
async function sendDailyReview(){
 if(dailyBusy||!dailyPending)return;dailyBusy=true;dailyCanRetry=false;dailyLock();dailyMessage('正在识别并保存…');let accepted=false;
 try{const result=await api('/items/'+dailyPending.id+'/daily-follow-ups','POST',dailyPending.body);accepted=true;await dailyConfirm(result)}
 catch(e){if(!accepted&&((e.status>=400&&e.status<500)||e.status===502)){dailyPending=null;dailyStore();if(dailyDialog.open){$('#dailyPlain').hidden=e.status!==502;if(e.status!==502){dailyView=null;$('#dailyReload').hidden=false}}}else if(dailyDialog.open)$('#dailyVerify').hidden=false;dailyMessage(e.message+'；未自动重试',true)}
 finally{dailyBusy=false;dailyLock();if(dailyDialog.open&&!dailyPending)$('#dailyContent')?.focus()}
}
async function recoverDailyReview(){
 if(dailyBusy||!dailyPending)return;dailyBusy=true;dailyLock();let found=false;
 try{const result=await api('/daily-follow-up-operations/'+dailyPending.body.operation_id);found=true;await dailyConfirm(result)}
 catch(e){dailyCanRetry=!found&&e.status===404;if(dailyDialog.open){$('#dailyVerify').hidden=false;$('#dailyRetry').hidden=!dailyCanRetry}dailyMessage(e.message+'；未自动重试',true)}
 finally{dailyBusy=false;dailyLock()}
}
dailyDialog.addEventListener('cancel',e=>{if(dailyBusy||dailyPending)e.preventDefault()});
dailyDialog.addEventListener('close',()=>{
 ++dailyRun;
 if(eventDialog.open)void refreshEventDetail();
 else if(wbView==='work')$(`#events [data-daily-row="${CSS.escape(dailyTarget)}"]`)?.focus({preventScroll:true});
 else dailyFocus();
});
function dailyCheckDate(){const today=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());if(wbView==='home'&&wbSnapshot&&wbSnapshot.today!==today&&!wbLoading&&!dailyBusy)loadWorkbench()}
setInterval(dailyCheckDate,30000);
document.addEventListener('visibilitychange',()=>{if(!document.hidden&&wbView==='home'&&!dailyBusy)loadWorkbench()});
