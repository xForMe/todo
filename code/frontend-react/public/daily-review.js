/* TECH-023: explicit append-only follow-ups and recoverable atomic postponements. */
let dailyFilter='pending',dailyBusy=false,dailyPending=null,dailyCanRetry=false;
let dailyView=null,dailyTarget=null,dailyRun=0;
const dailyDrafts=new Map();
try{dailyPending=JSON.parse(sessionStorage.getItem('todo-follow-up-pending')||'null')}catch(e){/* Corrupt local state must not crash the workbench. */}
const dailyDialog=document.createElement('dialog');dailyDialog.id='dailyFollowDialog';dailyDialog.setAttribute('aria-labelledby','dailyFollowTitle');document.body.append(dailyDialog);
let dailyReact=null,dailyResult=null,dailyControls={};
function mountDailyDrawer(mount){dailyReact=mount(dailyDialog)}
function renderDailyDrawer(){
 if(!dailyReact)return;
 dailyReact({model:{
  view:dailyView,path:dailyView?wbPath(wbGet(dailyView.item.id))?.text||'':'',
  content:dailyDrafts.get(dailyTarget)||'',busy:!!(dailyBusy||dailyPending),canWrite:dailyCanWrite(),
  result:dailyResult,...dailyControls,
 },actions:{
  save:()=>saveDailyFollow(),close:()=>{if(!dailyBusy&&!dailyPending)dailyDialog.close()},
  input:value=>{dailyDrafts.set(dailyTarget,value);renderDailyDrawer()},
  reload:dailyRead,plain:()=>saveDailyFollow(true),verify:recoverDailyReview,retry:sendDailyReview,images:openDailyImages,
 }});
}
function dailyRecoveryControls(patch){
 Object.assign(dailyControls,patch);
 renderDailyDrawer();
}
function dailyRecord(id){return wbSnapshot?.daily_reviews?.find(x=>x.item_id===id&&x.day===wbSnapshot.today)}
function dailyReviewed(id){return !!dailyRecord(id)?.reviewed_at}
function dailyDisabled(){return dailyBusy||dailyPending||wbLoading||wbError||wbBusy||wbPending}
function dailyFocus(){wbHome.querySelector(`[data-daily-filter="${dailyFilter}"]`)?.focus({preventScroll:true})}
function dailyStore(){try{if(dailyPending)sessionStorage.setItem('todo-follow-up-pending',JSON.stringify(dailyPending));else sessionStorage.removeItem('todo-follow-up-pending')}catch(e){notify('无法保存本页恢复标识，请保持页面打开完成核对')}}
function dailyMessage(text,error=false){
 if(dailyDialog.querySelector('#dailyResult')){dailyResult=text?{text,error}:null;renderDailyDrawer();return}
 if(text)notify(text);
}
function dailyCanWrite(){return !!dailyView&&pending(dailyView.item)}
function dailyLock(){
 dailyDialog.dataset.busy=String(!!(dailyBusy||dailyPending));
 if(dailyDialog.querySelector('#dailyResult'))renderDailyDrawer();
 if(typeof todoImages!=='undefined')todoImages.paintFollowAttachments();
 drawWorkbench();
}
async function setDailyReview(id,fromEventPage=false){
 if(!dailyReact||dailyDialog.open||dailyBusy||wbBusy||busy||eventBusy||priorityBusy||moveBusy||deletionBusy)return;
 if(!fromEventPage&&(wbLoading||wbError))return;
 if(dailyPending||wbPending||pendingWrite||eventPending||priorityPending||moveIntent||deletionIntent){notify('请先核对尚未完成的保存操作');return}
 const item=get(id);
 if(!item||!pending(item))return;
 dailyTarget=id;dailyView=null;dailyResult=null;dailyControls={};
 renderDailyDrawer();
 if(typeof todoImages!=='undefined')todoImages.mountFollow(id);
 dailyDialog.showModal();
 const request=dailyRead(),run=dailyRun;
 await request;
 if(run===dailyRun&&dailyDialog.open&&id===dailyTarget)$('#dailyContent')?.focus();
}
function openDailyImages(id){
 const record=dailyView?.records.find(row=>row.id===id);
 if(record&&!dailyBusy&&!dailyPending&&typeof todoImages!=='undefined')todoImages.open(record.item_id,record.image_ids);
}
async function dailyRead(){
 const run=++dailyRun,id=dailyTarget,current=()=>run===dailyRun&&id===dailyTarget&&dailyDialog.open;
 dailyView=null;dailyLock();dailyRecoveryControls({reload:false,plain:false});dailyMessage('正在读取…');
 try{
  const view=await api('/items/'+id+'/daily-follow-ups');
  if(!current())return;
  dailyView=view;dailyMessage('');
 }catch(e){
  if(current()){dailyMessage('读取失败：'+e.message,true);dailyRecoveryControls({reload:true})}
 }finally{if(current())dailyLock()}
}
async function saveDailyFollow(skip=false){
 if(dailyBusy||dailyPending||!dailyCanWrite())return;
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
 if(result.completed&&(view.item.version<result.item_version||(view.item.version===result.item_version&&view.item.status!=='completed')))throw Error('完成状态尚未读回，请核对');
 const message=result.completed&&!pending(view.item)?'跟进已保存，任务已标记为完成':!pending(view.item)?'跟进已保存，当前任务已结束':view.day===result.day?'已保存，可继续记录下一次跟进':'已核对上一日期的跟进，今日可重新记录';
 dailyDrafts.delete(result.item_id);
 if(typeof todoImages!=='undefined')todoImages.followSaved(result.item_id);
 if(dailyTarget===result.item_id&&dailyDialog.open){
  dailyView=view;
  dailyRecoveryControls({plain:false,verify:false,retry:false});
  dailyMessage(message);
 }
 dailyPending=null;dailyCanRetry=false;dailyStore();if(typeof refreshPlanMarks==='function')await refreshPlanMarks();notify(result.completed?message:'跟进已保存并读回');
}
async function sendDailyReview(){
 if(dailyBusy||!dailyPending)return;dailyBusy=true;dailyCanRetry=false;dailyLock();dailyMessage('正在识别并保存…');let accepted=false;
 try{const result=await api('/items/'+dailyPending.id+'/daily-follow-ups','POST',dailyPending.body);accepted=true;await dailyConfirm(result)}
 catch(e){
  if(!accepted&&((e.status>=400&&e.status<500)||e.status===502)){
   dailyPending=null;dailyStore();
   if(dailyDialog.open){
    if(e.status!==502)dailyView=null;
    dailyRecoveryControls({plain:e.status===502,reload:e.status!==502,verify:false,retry:false});
   }
  }else if(dailyDialog.open)dailyRecoveryControls({verify:true});
  dailyMessage(e.message+'；未自动重试',true);
 }
 finally{dailyBusy=false;dailyLock();if(dailyDialog.open&&!dailyPending)(dailyCanWrite()?$('#dailyContent'):$('#dailyClose'))?.focus()}
}
async function recoverDailyReview(){
 if(dailyBusy||!dailyPending)return;dailyBusy=true;dailyLock();let found=false;
 try{const result=await api('/daily-follow-up-operations/'+dailyPending.body.operation_id);found=true;await dailyConfirm(result)}
 catch(e){dailyCanRetry=!found&&e.status===404;if(dailyDialog.open)dailyRecoveryControls({verify:true,retry:dailyCanRetry});dailyMessage(e.message+'；未自动重试',true)}
 finally{dailyBusy=false;dailyLock()}
}
dailyDialog.addEventListener('cancel',e=>{if(dailyBusy||dailyPending)e.preventDefault()});
dailyDialog.addEventListener('close',()=>{
 if(dailyDialog.open)return;
 ++dailyRun;
 if(eventDialog.open)void refreshEventDetail();
 else if(wbView==='work')$(`#events [data-daily-row="${CSS.escape(dailyTarget)}"]`)?.focus({preventScroll:true});
 else dailyFocus();
});
function dailyCheckDate(){const today=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());if(wbView==='home'&&wbSnapshot&&wbSnapshot.today!==today&&!wbLoading&&!dailyBusy)loadWorkbench()}
setInterval(dailyCheckDate,30000);
document.addEventListener('visibilitychange',()=>{if(!document.hidden&&wbView==='home'&&!dailyBusy)loadWorkbench()});
