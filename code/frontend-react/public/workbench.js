/* Global read snapshot and explicit attention writes. No external adapter calls. */
let wbSnapshot=null,wbGeneration=0,wbView='home',wbFilter='all',wbScope='',wbEnded=false,wbOnly=false;
let wbPages={events:0,attention:0,reviews:0},wbPending=null,wbBusy=false,wbLoading=false,wbError='',wbDetail=null;
const wbSize=20,wbMain=document.querySelector('main'),wbWork=document.createElement('section');
wbWork.id='workPage';while(wbMain.firstChild)wbWork.append(wbMain.firstChild);wbMain.append(wbWork);
const wbHome=document.createElement('section');wbHome.id='globalWorkbench';wbMain.prepend(wbHome);
const wbDrawer=document.createElement('dialog');wbDrawer.id='workbenchDrawer';wbDrawer.setAttribute('aria-labelledby','wbDetailTitle');document.body.append(wbDrawer);
function wbItems(){return wbSnapshot?.items||[]}
function wbGet(id){return wbItems().find(x=>x.id===id)}
function wbMatter(item){return item?.type==='event'?wbGet(item.parent):item?.type==='thing'?item:null}
function wbPath(item){const m=wbMatter(item),mod=m&&wbGet(m.parent),goal=mod&&wbGet(mod.parent);return m&&mod?.type==='module'&&goal?.type==='goal'?{m,mod,goal,text:[goal.name,mod.name,m.name].join(' / ')}:null}
function wbWatched(id){return !!wbSnapshot?.attention.find(x=>x.item_id===id)?.enabled}
function wbPriority(id){return wbSnapshot?.priorities.items.find(x=>x.id===id)}
function wbProgress(m){const parents=new Set(wbSnapshot.branches.map(x=>x.parent_id)),leaves=wbItems().filter(x=>x.type==='event'&&x.parent===m.id&&!parents.has(x.id)),valid=leaves.filter(x=>x.status!=='cancelled'),done=valid.filter(x=>x.status==='completed').length;return valid.length?`事件完成率 ${Math.round(done/valid.length*100)}% · ${done}/${valid.length}`:'暂无进度'}
let wbLatestRead=Promise.resolve(false);
function loadWorkbench(){const request=wbReadWorkbench(++wbGeneration);wbLatestRead=request;return request}
async function wbReadWorkbench(run){wbLoading=true;drawWorkbench();if(wbSelectionReact)wbDrawThings();if(wbEventsReact)wbDrawEvents();if(wbDrawer.open)wbPaintDrawer();try{const result=await api('/workbench');if(run!==wbGeneration)return wbLatestRead;wbSnapshot=result;wbError='';db.items=result.items;priorityData=result.priorities;wbBaseRender();paintAttention();return true}catch(e){if(run!==wbGeneration)return wbLatestRead;wbError=e.message;return false}finally{if(run===wbGeneration){wbLoading=false;drawWorkbench();paintAttention();if(wbDrawer.open)wbPaintDrawer()}}}
function wbPage(key,rows){
 const size=key==='events'?10:wbSize,total=rows.length,last=Math.max(0,Math.ceil(total/size)-1);
 const index=wbPages[key]=Math.max(0,Math.min(wbPages[key],last));
 return {size,total,last,index,rows:rows.slice(index*size,(index+1)*size)};
}
function wbChangeActionPage(direction){
 wbPages.events+=direction;drawWorkbench();
 const pager=wbHome.querySelector('nav.wbPager');
 const target=pager?.querySelector(`[data-direction="${direction}"]:not(:disabled)`)||pager?.querySelector('button:not(:disabled)');
 target?.focus({preventScroll:true});
}
const wbActionCategories={all:'所有分类',overdue:'已逾期',today:'今日到期',working:'进行中',follow:'待跟进',undated:'未排期'};
function wbSetActionFilter(value){
 wbFilter=value;
 wbPages.events=0;drawWorkbench();
 wbHome.querySelector('button[data-action-category="'+value+'"]')?.focus({preventScroll:true});
}
function drawWorkbench(fromPlanMarks=false){
 todoDependencies.closeWaiting();
 if(!fromPlanMarks&&typeof refreshPlanMarks==='function')setTimeout(refreshPlanMarks,0);
 if(wbSnapshot)todoWorkspaceShell.setDate(wbSnapshot.today);
 if(!fromPlanMarks)renderChatResults();
 if(!wbRenderReact)return;
 const goals=wbItems().filter(x=>x.type==='goal');
 const message=wbError?{error:true,text:`工作台读取失败：${wbError}。统计暂不可用，请手动刷新。`}
  :!wbSnapshot?{text:'正在读取工作台…'}
  :wbScope&&!goals.some(g=>g.id===wbScope)?{text:'所选目标已不可用，请切换到全部目标。'}:null;
 if(message){
  wbDrawReact(goals,message);
  return;
 }
 const allMatters=wbItems().filter(x=>x.type==='thing'&&wbPath(x));
 const matters=allMatters.filter(x=>!wbScope||wbPath(x).goal.id===wbScope);
 const events=wbItems().filter(x=>x.type==='event'&&pending(x)&&matters.some(m=>m.id===x.parent));const follows=new Set(wbSnapshot.links.filter(x=>x.kind==='followup').map(x=>x.source));
 const rules={all:()=>true,overdue:x=>x.planEnd&&x.planEnd<wbSnapshot.today,today:x=>x.planEnd===wbSnapshot.today,working:x=>x.status==='working',follow:x=>follows.has(x.id),undated:x=>!x.planEnd};
 const dependencies=todoDependencies.index(wbSnapshot,wbItems());
 const ready=events.filter(event=>!todoDependencies.reasons(event,dependencies).length);
 const filtered=ready.filter(rules[wbFilter]).sort((a,b)=>(a.planEnd||'9999').localeCompare(b.planEnd||'9999')||a.name.localeCompare(b.name,'zh-CN')||a.id.localeCompare(b.id));const watched=matters.filter(x=>wbWatched(x.id)&&(wbEnded||pending(x))),reviews=matters.filter(x=>wbPriority(x.id)?.due);
 const actions=filtered.filter(x=>dailyReviewed(x.id)===(dailyFilter==='done'));
 wbDrawReact(goals,null,allMatters,{ready,rules,filtered,actions,watched,reviews,dependencies,follows});
}
function paintAttention(){
 if(wbSelectionReact)wbDrawThings();
 if(wbEventsReact)wbDrawEvents();
}
const wbBaseRender=render;let wbTimer;render=function(){wbBaseRender();paintAttention();clearTimeout(wbTimer);wbTimer=setTimeout(loadWorkbench,100)};
function setWorkbenchView(view){
 todoDependencies.closeWaiting();
 wbView=view;
 wbHome.hidden=view!=='home';
 wbWork.hidden=view!=='work';
 todoWorkspaceShell.setView(view);
}
async function showWorkbench(view){setWorkbenchView(view);await loadWorkbench()}
async function locateWorkbench(id,review=false,isCurrent=()=>true){
 const loaded=await loadWorkbench();
 if(!isCurrent())return;
 if(!loaded){notify('读取失败，未切换位置');return}
 const item=wbGet(id),path=wbPath(item);
 if(item?.type!=='goal'&&!path){notify('对象已删除或归属变化，请刷新后核对');return}
 if(path)selection={goal:path.goal.id,module:path.mod.id,thing:path.m.id};
 else selection.goal=item.id;
 priorityDueOnly=false;
 wbOnly=false;
 setWorkbenchView('work');
 wbBaseRender();
 paintAttention();
 if(wbDrawer.open)wbDrawer.close();
 if(review&&path)openPriority(path.m.id);
 else if(item.type==='event')await openEvent(item.id);
 else if(item.type==='goal')$('#goalSelect').focus();
 notify('已定位：'+(path?.text??item.name));
}
async function openWorkbenchEditor(id){
 if(dailyBusy||busy||wbBusy||wbLoading||eventBusy||priorityBusy||moveBusy||deletionBusy)return;
 if(dailyPending||pendingWrite||wbPending||eventPending||priorityPending||moveIntent||deletionIntent){notify('请先核对尚未完成的保存操作');return}
 if($('#editor').open)return;
 if(!await loadWorkbench()){notify('编辑读取失败，请刷新后重试');return}
 const item=wbGet(id),path=wbPath(item);
 if(item?.type!=='event'||!path||path.m.type!=='thing'){notify('事件已不可用或归属变化，请刷新后核对');return}
 openForm('event',id);
}
let wbDrawerReact=null,wbDrawerMode='',wbDrawerError='',wbDrawerTicket=0;
function wbMountDrawer(mount){
 wbDrawerReact=mount(wbDrawer);wbDrawerReact({model:null});
}
wbDrawer.addEventListener('close',()=>{
 if(wbDrawer.open)return;
 wbDrawerTicket++;wbDrawerMode='';wbDrawerError='';wbDetail=null;
});
function wbPaintDrawer(){
 if(!wbDrawerReact||!wbDrawerMode)return;
 const item=wbGet(wbDetail),path=wbPath(item),status=item&&statusOf(item);
 const detail=path&&{id:item.id,name:item.name,path:path.text,description:item.description,status,statusLabel:states[status],
  owner:item.owner||'未指定',start:item.planStart?.slice(0,10)||'未设置',end:item.planEnd?.slice(0,10)||'未设置',
  progress:wbProgress(path.m),priority:priorityLabels[wbPriority(path.m.id)?.priority||0],matterId:path.m.id,
  matterName:path.m.name,watched:wbWatched(path.m.id),watchLabel:wbWatched(path.m.id)?'取消持续关注':'持续关注',
  watchDisabled:!!(wbBusy||wbPending||wbError||wbLoading)};
 if(wbDrawerMode==='detail'&&!detail){
  if(wbDrawer.open){wbDrawer.close();if(!wbBusy)notify('对象已删除或归属变化，请刷新后核对')}
  return;
 }
 const canRetry=!!(wbPending?.retryAllowed&&!wbPending.acknowledged);
 const model={mode:wbDrawerMode,busy:wbBusy,error:wbDrawerError,canRetry,detail};
 const actions={close:()=>wbDrawer.close(),recover:recoverAttention,retry:retryAttention,locate:wbLocateFromDrawer,watch:setAttention};
 const active=wbDrawer.contains(document.activeElement)?document.activeElement:null;
 const activeKey=active?.dataset.wbDrawer||(active?.classList.contains('wbWatch')?'watch':'');
 wbDrawerReact({model,actions});
 if(active&&document.activeElement!==active){
  const next=(activeKey&&(wbDrawer.querySelector(`[data-wb-drawer="${activeKey}"]:not(:disabled)`)||
   (activeKey==='watch'&&wbDrawer.querySelector('.wbWatch:not(:disabled)'))))||wbDrawer.querySelector('[data-wb-drawer="close"]');
  next?.focus({preventScroll:true});
 }
}
function wbLocateFromDrawer(id){
 const ticket=wbDrawerTicket;
 return locateWorkbench(id,false,()=>wbDrawer.open&&wbDrawerMode==='detail'&&wbDrawerTicket===ticket&&wbDetail===id);
}
async function openWorkbenchDetail(id){
 if(!wbDrawerReact||wbBusy)return;
 const ticket=++wbDrawerTicket,view=wbView,loaded=await loadWorkbench();
 if(ticket!==wbDrawerTicket||view!==wbView||wbBusy)return;
 if(!loaded){notify('详情读取失败');return}
 if(!wbPath(wbGet(id))){notify('对象已不可用，请刷新');return}
 wbDetail=id;wbDrawerMode='detail';wbDrawerError='';wbPaintDrawer();
 if(!wbDrawer.open)wbDrawer.showModal();
}
async function setAttention(id,enabled){
 if(wbBusy||wbPending||wbLoading||wbError)return;
 if(pendingWrite||priorityPending||eventPending){notify('请先核对尚未完成的保存操作');return}
 const item=wbGet(id);
 if(item?.type!=='thing'||!wbPath(item)||typeof enabled!=='boolean'){notify('事情不可用，请刷新');return}
 wbPending={id,body:{operation_id:crypto.randomUUID(),expected_version:item.version,enabled},acknowledged:false,retryAllowed:false,version:null};
 await sendAttention();
}
function wbAcknowledgeAttention(pending,receipt){
 pending.acknowledged=true;pending.retryAllowed=false;
 if(receipt?.id!==pending.id||receipt.type!=='thing'||!Number.isInteger(receipt.version)||receipt.version<=pending.body.expected_version){
  throw Error('关注回执与原操作不匹配，请继续核对');
 }
 pending.version=Math.max(pending.version||0,receipt.version);
}
async function wbReadAttention(pending){
 if(!await loadWorkbench())throw Error('回执存在，但关注状态读取失败');
 const item=wbGet(pending.id),flag=wbSnapshot?.attention.find(row=>row.item_id===pending.id);
 if(item?.type!=='thing'||!wbPath(item)||!Number.isInteger(item.version)||item.version<pending.version||flag?.enabled!==pending.body.enabled){
  throw Error('当前版本或关注状态与回执不一致，请继续核对');
 }
}
function wbPaintAttentionOperation(){drawWorkbench();paintAttention();if(wbDrawer.open)wbPaintDrawer()}
function showAttentionRecovery(message){
 if(!wbDrawerReact)return;
 wbDrawerTicket++;wbDrawerMode='recovery';wbDrawerError=message;wbPaintDrawer();
 if(!wbDrawer.open)wbDrawer.showModal();
}
async function sendAttention(){
 const pending=wbPending;
 if(wbBusy||!pending||pending.acknowledged)return;
 const opened=wbDrawer.open,ticket=wbDrawerTicket,view=wbView;
 const mayShow=()=>ticket===wbDrawerTicket&&view===wbView&&(!opened||wbDrawer.open);
 wbBusy=true;pending.retryAllowed=false;wbDrawerError='';wbPaintAttentionOperation();
 try {
  const receipt=await api('/items/'+encodeURIComponent(pending.id)+'/attention','POST',pending.body);
  wbAcknowledgeAttention(pending,receipt);
  await wbReadAttention(pending);
  wbPending=null;
  if(wbDrawer.open&&wbDrawerMode==='recovery')wbDrawer.close();
  notify('关注状态已保存并读回');
 } catch(error) {
  if(!pending.acknowledged&&error.status>=400&&error.status<500&&error.status!==408)wbPending=null;
  notify(error.message+'；未自动重试');
  if(mayShow()){
   if(wbPending)showAttentionRecovery(error.message);
   else if(wbDrawer.open&&wbDrawerMode==='recovery')wbDrawer.close();
   else wbDrawerError=error.message;
  }
 } finally {wbBusy=false;wbPaintAttentionOperation()}
}
function retryAttention(){if(wbPending?.retryAllowed&&!wbPending.acknowledged)return sendAttention()}
async function recoverAttention(){
 if(wbBusy)return;
 const pending=wbPending;
 if(!pending){notify('没有待核对的关注操作');return}
 const opened=wbDrawer.open,ticket=wbDrawerTicket,view=wbView;
 const mayShow=()=>ticket===wbDrawerTicket&&view===wbView&&(!opened||wbDrawer.open);
 wbBusy=true;pending.retryAllowed=false;wbPaintAttentionOperation();
 try {
  let receipt;
  try {receipt=await api('/operations/'+encodeURIComponent(pending.body.operation_id))}
  catch(error){pending.retryAllowed=error.status===404&&!pending.acknowledged;throw error}
  wbAcknowledgeAttention(pending,receipt);
  await wbReadAttention(pending);
  wbPending=null;
  if(mayShow()&&wbDrawer.open)wbDrawer.close();
  notify('已核对关注保存结果');
 } catch(error) {if(mayShow())showAttentionRecovery(error.message)}
 finally {wbBusy=false;wbPaintAttentionOperation()}
}
const wbPriorityLoad=loadPriorities;loadPriorities=async function(){await wbPriorityLoad();if(wbSnapshot&&priorityData){wbSnapshot.priorities=priorityData;drawWorkbench()}};
window.addEventListener('focus',()=>{if(wbView==='home'&&!wbBusy)loadWorkbench()});
document.addEventListener('DOMContentLoaded',wbLoadReact,{once:true});
(async()=>{await api('/session');await showWorkbench('home');await refreshSuggestions()})().catch(e=>{wbError=e.message;drawWorkbench()});
