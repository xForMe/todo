/* Event structure is separate from the containing matter. */
let eventLoad=0, eventContext=null, eventSnapshot='', eventBusy=false, eventPending=null, aiGeneration=0;
const eventBaseRender=render;
render=function(){todoDependencies.closeWaiting();eventBaseRender();void loadEventTree()};
async function loadEventTree(){
 todoDependencies.closeWaiting();
 const run=++eventLoad,id=selection.thing,items=id?children('event',id):[];
 const mounted=typeof wbEventsReact!=='undefined'&&wbEventsReact;
 if(!items.length){if(mounted)wbEventTree=null;return}
 if(mounted){
  if(wbEventTree?.id!==id)wbEventTree={id};
  wbEventTree.message='正在核对事件层级与完成率…';wbDrawEvents();
 }
 try{
  const view=await api('/events/'+items[0].id+'/structure');
  if(run!==eventLoad||id!==selection.thing)return;
  if(!Array.isArray(view?.branches))throw Error('事件结构响应无效');
  for(const row of view.events||[]){const i=db.items.findIndex(x=>x.id===row.id);if(i<0)db.items.push(row);else db.items[i]=row;}
  if(mounted){
   todoDependencies.closeWaiting();
   wbEventTree={id,view,items:view.events||items};wbDrawEvents();
  }
 }catch(e){
  if(run!==eventLoad||id!==selection.thing)return;
  if(mounted){wbEventTree.message='事件层级加载失败：'+e.message;wbDrawEvents()}
 }
}
const eventDialog=document.createElement('dialog');
eventDialog.id='eventDrawer';eventDialog.setAttribute('aria-labelledby','eventTitle');
const eventHeader=document.createElement('div'),eventContent=document.createElement('div'),eventFeedback=document.createElement('div');
eventHeader.className='drawerHead';eventContent.id='eventContent';eventFeedback.dataset.eventFeedback='';
eventDialog.append(eventHeader,eventContent,eventFeedback);document.body.append(eventDialog);
const eventChrome={title:'事件详情',imageId:null,error:''};
let eventRetryAllowed=false;
function eventChromeModel(){return {...eventChrome,busy:eventBusy,pending:!!eventPending?.exposed,canRetry:!!eventPending&&!eventPending.acknowledged&&eventRetryAllowed}}
function paintEventChrome(patch={}){
 Object.assign(eventChrome,patch);
 if(wbEventDrawerReact)wbDrawEventDrawer({});
}
function closeEvent(){if(eventBusy){paintEventChrome({error:'请求处理中，请等待结果'});return}aiGeneration++;eventDialog.close()}
eventDialog.addEventListener('cancel',e=>{if(eventBusy)e.preventDefault();else aiGeneration++});
async function refreshEventDetail() {
 if(!eventDialog.open||eventDialog.dataset.mode!=='detail'||eventBusy||eventPending)return;
 const id=eventContext,item=get(id),version=eventDialog.dataset.version;
 if(!item||!version||version===String(item.version))return;
 const shortcut=document.activeElement?.dataset.eventShortcut;
 await openEvent(id);
 if(eventDialog.open&&eventContext===id&&shortcut){
  eventDialog.querySelector(`[data-event-shortcut="${shortcut}"]`)?.focus();
 }
}
$('#editor').addEventListener('close',refreshEventDetail);
async function openEvent(id,mode='detail',showPredecessorSettings=false){
 if(!wbEventDrawerReact||eventBusy)return;
 if(eventPending){
  paintEventChrome({error:'请先核对上次操作'});
  if(!eventDialog.open)eventDialog.showModal();
  return;
 }
 eventDialog.dataset.mode=mode;delete eventDialog.dataset.version;eventContext=id;
 const opening=++aiGeneration;
 wbDrawEventDrawer({session:opening,mode,loading:true,event:null,predecessors:null,split:{loading:false,message:'',proposals:[]}});
 paintEventChrome({title:mode==='split'?'拆分事件':mode==='followup'?'新建后续跟进':'事件详情',imageId:mode==='detail'?id:null,error:''});
 if(!eventDialog.open)eventDialog.showModal();
 const current=()=>id===eventContext&&eventDialog.open&&opening===aiGeneration;
 try{
  const view=await api('/events/'+id+'/structure');
  if(!current())return;
  for(const row of view.events||[])finish(row);
  eventSnapshot=view.snapshot;
  const event=get(id);
  eventDialog.dataset.version=String(event.version);
  showReactEventDrawer(event,view,mode,showPredecessorSettings);
 }catch(error){if(current())paintEventChrome({error:error.message})}
}
function showReactEventDrawer(event,view,mode,showPredecessorSettings){
 const parent=view.branches.find(branch=>branch.child_id===event.id);
 wbDrawEventDrawer({
  loading:false,event:wbEventItem(event),matterName:get(event.parent)?.name||'',
  parentName:parent?(get(parent.parent_id)?.name||''):null,
 });
 if(mode==='split'&&$('#generateSplit'))void generateSplit();
 else{
  const focused=mode==='detail'&&todoDependencies.mount($('#eventDependencies'),event,view,showPredecessorSettings,
    predecessors=>wbDrawEventDrawer({predecessors}));
  if(!focused)$('#eventContent button, #eventContent input')?.focus();
 }
}
async function writeEvent(data,snapshot=eventSnapshot,id=eventContext,onSaved){
 if(eventBusy||eventPending)return;
 eventPending={id,onSaved,acknowledged:false,body:{...data,operation_id:crypto.randomUUID(),snapshot}};
 await sendEvent();
}
async function sendEvent(){
 const intent=eventPending;
 if(eventBusy||!intent||intent.acknowledged)return;
 eventRetryAllowed=false;eventBusy=true;paintEventChrome({error:''});setEventDisabled(true);
 try{
  const receipt=await api('/events/'+encodeURIComponent(intent.id)+'/children','POST',intent.body);
  intent.acknowledged=true;
  await eventSaved(intent,receipt);
 }catch(e){
  if(e.acknowledged)intent.acknowledged=true;
  if(!intent.acknowledged&&e.status>=400&&e.status<500&&e.status!==408)eventPending=null;
  else intent.exposed=true;
  const message=intent.acknowledged?'操作已提交，读回失败，请核对结果。':e.message;
  const inline=!eventPending&&intent.body.action==='predecessors'&&todoDependencies.reportError($('#eventDependencies'),message);
  paintEventChrome({error:inline?'':message});
 }finally{eventBusy=false;setEventDisabled(false);paintEventChrome()}
}
function setEventDisabled(on){
 eventDialog.dataset.busy=String(on);
 eventDialog.querySelectorAll('button,input,textarea,select').forEach(control=>{
  if(on&&!control.disabled){control.dataset.eventLocked='true';control.disabled=true;}
  if(!on&&control.dataset.eventLocked){delete control.dataset.eventLocked;control.disabled=false;}
 });
}
async function eventSaved(intent,receipt){
 const {id,body,onSaved}=intent;
 if(receipt?.action!==body.action||!Array.isArray(receipt.created))throw Error('事件回执与原操作不匹配');
 let message='已保存并读回事件结果';
 let view;
 if(body.action==='predecessors'){
  view=await api('/events/'+id+'/structure');
  const stored=view.dependencies.filter(edge=>edge.event_id===id).map(edge=>edge.predecessor_id);
  const requested=body.predecessor_ids;
  if(stored.length!==requested.length||!requested.every(target=>stored.includes(target))){
   message='操作已提交，当前的前置关系随后发生变化，请核对最新详情';
  }
 }
 const items=await api('/items');
 if(!Array.isArray(items))throw Error('未能读回事件列表');
 if(body.action==='children'||body.action==='followup'){
  const created=new Set(receipt.created);
  if(created.size!==body.children.length||receipt.created.length!==created.size||
     !receipt.created.every(child=>items.some(row=>row.id===child&&row.type==='event'&&row.parent===body.children[0].parent)))throw Error('未能读回创建的事件');
 }
 db.items=items;eventPending=null;eventRetryAllowed=false;
 paintEventChrome({error:''});
 if(view&&onSaved&&eventDialog.open&&eventContext===id){
  eventSnapshot=view.snapshot;
  setEventDisabled(false);
  onSaved(view);
 }else{
  aiGeneration++;
  eventDialog.close();
 }
 render();notify(message);
}
async function recoverEvent(){
 const intent=eventPending;
 if(eventBusy||!intent||!eventDialog.open)return;
 eventRetryAllowed=false;eventBusy=true;paintEventChrome({error:''});setEventDisabled(true);
 try{
  let receipt;
  try{receipt=await api('/event-operations/'+encodeURIComponent(intent.body.operation_id))}
  catch(error){
   if(error.acknowledged)intent.acknowledged=true;
   eventRetryAllowed=error.status===404&&!intent.acknowledged;
   if(error.status===404&&intent.acknowledged)throw Error('已收到提交响应，但暂未能核对回执；请继续核对，不要重试原操作。');
   throw error;
  }
  intent.acknowledged=true;
  await eventSaved(intent,receipt);
 }catch(error){paintEventChrome({error:error.message})}
 finally{eventBusy=false;setEventDisabled(false);paintEventChrome()}
}
async function retryEvent(){if(eventDialog.open&&eventChromeModel().canRetry)await sendEvent()}
function saveChildren(rows,action='children'){const e=get(eventContext);if(!rows.length){paintEventChrome({error:'至少选择一个子事件'});return}if(rows.some(r=>!r.name.trim()||(r.planStart&&r.planEnd&&r.planEnd<r.planStart))){paintEventChrome({error:'名称不能为空，结束日期不能早于开始'});return}writeEvent({action,children:rows.map(r=>({...r,name:r.name.trim(),type:'event',parent:e.parent,status:'notStarted'}))})}
const splitRequests=new Map();
function requestEventSplit(id,snapshot,instructions,force){
 const key=JSON.stringify([id,snapshot,instructions]);
 let request=force?null:splitRequests.get(key);
 if(!request){
  request=api('/events/'+id+'/decomposition','POST',{consent:true,instructions,snapshot});
  splitRequests.set(key,request);
  request.catch(()=>{if(splitRequests.get(key)===request)splitRequests.delete(key)});
 }
 return request;
}
async function generateSplit(force=false){
 const host=$('#splitCandidates'),button=$('#generateSplit');
 if(eventBusy||eventPending||!host||!button||button.disabled)return;
 if(force&&host.querySelector('.splitCandidate')&&!confirm('重新生成会替换尚未保存的候选编辑，继续？'))return;
 const run=++aiGeneration,id=eventContext,snapshot=eventSnapshot,instructions=$('#splitInstructions').value;
 const current=()=>run===aiGeneration&&eventDialog.open&&eventContext===id&&host.isConnected;
 const paint=(message,proposals=[],loading=false)=>{
  wbDrawEventDrawer({generation:run,split:{message,proposals,loading}});
  if(eventBusy)setEventDisabled(true);
 };
 paintEventChrome({error:''});
 paint('',[],true);
 try{
  const result=await requestEventSplit(id,snapshot,instructions,force);
  if(!current())return;
  paint(result.suggestions.length?'':'没有可用建议，请补充要求或手动拆分。',result.suggestions);
 }catch(error){
  if(!current())return;
  paint('生成失败，可点击重新生成或手动添加。');
  paintEventChrome({error:error.message});
 }
}
if(db.items.length)loadEventTree();
