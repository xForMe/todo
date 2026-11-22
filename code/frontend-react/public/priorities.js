const priorityLabels=['未评估','重要且紧急','重要不紧急','不重要但紧急','不重要不紧急'];
let priorityDueOnly=false;
let priorityData=null,priorityPending=null,priorityContext=null,priorityBusy=false,priorityGeneration=0;
const priorityDialog=document.createElement('dialog');priorityDialog.id='priorityDrawer';priorityDialog.setAttribute('aria-labelledby','priorityTitle');document.body.append(priorityDialog);
let priorityReact=null,priorityName='',priorityValue=0,priorityError='',priorityRetry=false;
function mountPriorityDrawer(mount){priorityReact=mount(priorityDialog)}
function drawPriorityDrawer(){
 priorityReact({name:priorityName,value:priorityValue,error:priorityError,retry:priorityRetry,
  labels:priorityLabels,actions:{
   close:()=>priorityDialog.close(),select:value=>{priorityValue=value;drawPriorityDrawer()},
   submit:submitPriority,recover:recoverPriority,refresh:refreshPriorityEditor,retry:retryPriority,showTip,hideTip,
  }});
}
function priorityFeedback(message,retry=false){
 priorityError=message;priorityRetry=retry;drawPriorityDrawer();
}
function paintPriorities(){if(typeof paintAttention==='function')paintAttention()}
async function loadPriorities(){const run=++priorityGeneration;try{const result=await api('/priorities');if(run!==priorityGeneration)return;priorityData=result;paintPriorities()}catch(e){if(run!==priorityGeneration)return;priorityData=null;paintPriorities()}}
const priorityConnect=connect;connect=async function(){await priorityConnect();await loadPriorities()};
const priorityCommit=commit;commit=async function(...args){const result=await priorityCommit(...args);await loadPriorities();return result};
function openPriority(id){
 if(!priorityReact)return;
 if(priorityPending){if(!priorityDialog.open)priorityDialog.showModal();priorityFeedback('请先核对上一次保存结果');return}
 const state=priorityData?.items.find(x=>x.id===id);
 if(!state)return;
 priorityContext={id,version:state.version,week:priorityData.week};
 priorityName=get(id)?.name||'';
 priorityValue=state.priority;
 priorityFeedback('');
 if(!priorityDialog.open)priorityDialog.showModal();
}
async function refreshPriorityEditor(){
 if(priorityPending){priorityFeedback('请先核对保存结果');return}
 const context=priorityContext;
 await connect();
 if(!priorityDialog.open||context!==priorityContext||priorityPending)return;
 priorityDialog.close();if(context?.id)openPriority(context.id);
}
async function finishPriority(saved,message){
 const index=db.items.findIndex(item=>item.id===saved.id);
 if(index>=0)db.items[index]=saved;
 priorityPending=null;
 await loadPriorities();render();
 if(!priorityData)throw Error('已提交，优先级读回失败，请刷新核对');
 priorityDialog.close();notify(message);
}
async function submitPriority(review){
 if(priorityBusy||priorityPending||!priorityContext)return;
 const priority=priorityValue;
 if(review&&!priority){priorityFeedback('请先选择优先级');return}
 if(pendingWrite){priorityFeedback('请先核对工作保存结果');return}
 priorityPending={id:priorityContext.id,body:{operation_id:crypto.randomUUID(),
  expected_version:priorityContext.version,week:priorityContext.week,priority,review}};
 await sendPriority('优先级已保存','；输入已保留');
}
async function sendPriority(message,suffix){
 const {id,body}=priorityPending;
 priorityBusy=true;
 try{await finishPriority(await api('/items/'+id+'/priority','POST',body),message)}
 catch(error){
  if(error.status>=400&&error.status<500)priorityPending=null;
  priorityFeedback(error.message+suffix);
 }finally{priorityBusy=false}
}
async function recoverPriority(){
 if(priorityBusy)return;
 if(!priorityPending){priorityFeedback('没有待核对操作');return}
 priorityBusy=true;
 try{await finishPriority(await api('/operations/'+priorityPending.body.operation_id),'已核对保存结果')}
 catch(error){priorityFeedback(error.message+'；未自动重试',!!priorityPending&&error.status===404)}
 finally{priorityBusy=false}
}
window.addEventListener('focus',loadPriorities);setInterval(()=>{if(!document.hidden)loadPriorities()},60000);loadPriorities();


async function retryPriority(){
 if(priorityBusy||!priorityPending)return;
 await sendPriority('保存结果已核对','');
}
