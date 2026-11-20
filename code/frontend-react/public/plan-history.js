/* TECH-022: explicit plan mutations share the existing write receipt. */
let planCounts={},planCountLoad=0,planLoad=0,planBusy=false,planUnknown=false;
const planDialog=document.createElement('dialog');planDialog.id='planDrawer';planDialog.setAttribute('aria-labelledby','planTitle');document.body.append(planDialog);
planDialog.addEventListener('close',refreshEventDetail);
let planReact=null,planModel=null,planActions=null;
function mountPlanDrawer(mount){planReact=mount(planDialog)}
async function refreshPlanMarks(){
 const run=++planCountLoad;
 try{
  const counts=await api('/plan-history-counts');
  if(run!==planCountLoad)return;
  const changed=Object.keys(counts).length!==Object.keys(planCounts).length||
   Object.keys(counts).some(id=>counts[id]!==planCounts[id]);
  planCounts=counts;
  if(wbEventsReact&&changed)wbDrawEvents();
  if(wbRenderReact&&changed)drawWorkbench(true);
 }catch(e){/* Counts are optional; opening details reports read errors. */}
}
function planTime(value){return new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',dateStyle:'short',timeStyle:'short',hour12:false}).format(new Date(value))}
function drawReactPlan(patch){
 planModel={...planModel,...patch,busy:planBusy,unknown:planUnknown};
 planReact({model:planModel,actions:planActions});
}
function focusPlanHistory(){
 const records=$('#planRecords'),heading=records.querySelector('summary');
 records.scrollIntoView({block:'start'});heading.tabIndex=-1;heading.focus({preventScroll:true});
}
function planEnded(item){return ['completed','cancelled'].includes(item.status)}
async function writePlan(id,item,start,end,reason,paint){
 if(pendingWrite){paint('请先核对上次保存结果');return}
 if(planBusy||planUnknown||planEnded(item)||(start===(item.planStart||'')&&end===(item.planEnd||'')))return;
 if(start&&end&&end<start){paint('结束日期不能早于开始日期');return}
 planBusy=true;paint();
 try{
  await commit({...item,planStart:start,planEnd:end,plan_change_reason:reason},id,'plan');
  await planSaved(id);
 }catch(error){
  planUnknown=!!pendingWrite;
  paint(error.message+(planUnknown?'；结果待核对，请勿重复提交':'；输入已保留'));
 }finally{planBusy=false;paint()}
}
async function verifyPlan(id,paint){
 const intent=pendingWrite;
 if(planBusy||intent?.origin!=='plan'||intent.id!==id||intent.writing||intent.checking)return;
 planBusy=true;paint();
 try{await readWorkReceipt(intent);planUnknown=false;await planSaved(id)}
 catch(error){paint(error.message+'；请继续核对，不会自动重发')}
 finally{planBusy=false;paint()}
}
async function openPlanChange(id,historyOnly=false){
 if(!planReact||planBusy)return;
 if(planUnknown||pendingWrite){
  notify('请先核对上次保存结果');
  if(planUnknown&&!planDialog.open)planDialog.showModal();
  return;
 }
 const session=++planLoad;
 const current=()=>session===planLoad&&planDialog.open;
 // A write may finish after close. Keep its receipt UI available on reopening.
 const paint=error=>{if(session===planLoad)drawReactPlan(error===undefined?{}:{error})};
 planActions={
  close:()=>planDialog.close(),reload:()=>openPlanChange(id,historyOnly),verify:()=>verifyPlan(id,paint),
  save:(start,end,reason)=>{if(current()&&planModel.view)void writePlan(id,planModel.view.item,start,end,reason,paint)},
  showTip,hideTip,
 };
 drawReactPlan({session,view:null,readError:'',error:''});
 if(!planDialog.open)planDialog.showModal();
 try{
  const result=await api('/items/'+id+'/plan-history');
  if(!current())return;
  const item=result.item;
  drawReactPlan({view:{item,baseline:result.baseline,ended:planEnded(item),
   typeLabel:names[item.type],statusLabel:states[item.status],
   records:result.records.map(record=>({...record,displayTime:planTime(record.changed_at)})),
  }});
  if(historyOnly)focusPlanHistory();
 }catch(error){if(current())drawReactPlan({readError:error.message})}
}
async function planSaved(id){planDialog.close();planUnknown=false;await connect();if(typeof loadWorkbench==='function')await loadWorkbench();await refreshPlanMarks();notify('计划已更新，时间变更记录已保存')}
function abandonPlanWrite(){planUnknown=false;planDialog.close()}
// Keep the count read triggered by changes to the React-managed event panel.
const planObserver=new MutationObserver(()=>{clearTimeout(window.planRefreshTimer);window.planRefreshTimer=setTimeout(refreshPlanMarks,120)});planObserver.observe(document.querySelector('#events'),{childList:true});
refreshPlanMarks();
