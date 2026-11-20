const names={goal:'目标',module:'模块',thing:'事情',event:'事件'},parentType={module:'goal',thing:'module',event:'thing'};
const states={notStarted:'未开始',working:'进行中',completed:'已完成',cancelled:'已取消'};
const statusOf=x=>x.status||(x.done?'completed':'notStarted');
const pending=x=>['notStarted','working'].includes(statusOf(x));
let db={items:[]},selection={},editing=null,busy=false,pendingWrite=null;
const $=s=>document.querySelector(s),get=id=>db.items.find(x=>x.id===id), children=(type,parent)=>db.items.filter(x=>x.type===type&&(!parent||x.parent===parent));
const noticeHost = $('#notice');
let noticeMessage = '', noticeTimer, noticeReact = null;
function paintNotice(){
 noticeReact?.(noticeMessage);
}
function enableReactNotice(mount){
 if(noticeReact)return;
 noticeReact=mount(noticeHost);
 paintNotice();
}
function notify(message){
 noticeMessage=String(message??'');
 clearTimeout(noticeTimer);
 noticeTimer=noticeMessage?setTimeout(()=>{noticeMessage='';paintNotice()},4500):undefined;
 paintNotice();
}
function normalize(){for(const type of ['goal','module','thing']){let p=parentType[type];let list=db.items.filter(x=>x.type===type&&(!p||x.parent===selection[p]));if(!list.some(x=>x.id===selection[type]))selection[type]=list[0]?.id||null}}
function select(type,id){selection[type]=id;render()}
function render(){
 normalize();
 if(typeof wbSelectionReact!=='undefined'&&wbSelectionReact){
  wbDrawSelection(get(selection.goal),get(selection.module),get(selection.thing));
 }
 if(typeof wbEventsReact!=='undefined'&&wbEventsReact)wbDrawEvents();
}
const editorActionDefinitions = [
 {id:'workingMemoryEntry',type:'thing',label:'当前工作摘要',open:id=>todoWorkingMemory.open(id)},
 {id:'moduleMemoryEntry',type:'module',label:'模块记忆',open:id=>todoModuleMemory.open(id)},
 {id:'moveEntry',type:'event',label:'迁移事件',icon:'move',open:id=>openEventMove(id)},
 {id:'deleteEntry',label:'删除',icon:'trash',className:'quiet danger',open:id=>openDeletion(id)},
];
function editorActionModels(context){
 const item=context?.id&&get(context.id);
 return editorActionDefinitions.map(({id,type,label,icon,className,open})=>({id,icon,className,
  label:id==='deleteEntry'&&item&&item.type===context.type?'删除'+names[context.type]:label,
  hidden:!item||item.type!==context.type||Boolean(type&&context.type!==type),
  run:()=>{
   if(!$('#editor').open||editing!==context||!context?.id)return;
   if(busy||pendingWrite){notify('请先完成或核对当前保存操作');return}
   const current=get(context.id);
   if(current?.type!==context.type||(type&&current.type!==type))return;
   void open(current.id);
  }
 }));
}
function openForm(type,id){
 if(!wbEditorReact)return;
 if(pendingWrite){notify('请先核对上次保存结果');return}
 const item=get(id),parentKind=parentType[type],parent=parentKind?selection[parentKind]:null;
 if(!id&&parentKind&&!get(parent)){notify('请先选择有效的'+names[parentKind]);return}
 editing={type,id,parent,version:item?.version};
 const title=(id?'编辑':'新建')+names[type];
 const context=item?.parent?'所属'+names[parentKind]+'：'+get(item.parent)?.name
  :parent?'所属'+names[parentKind]+'：'+get(parent).name:'';
 const work=['thing','event'].includes(type);
 wbOpenEditorView(title,context,work,id,item,editorActionModels(editing));
 if(typeof todoImages!=='undefined')todoImages.editorOpened(!id&&work);
 $('#editor').showModal();$('#name').focus();
}

async function api(path,method='GET',body){const r=await fetch('/api'+path,{method,headers:{'X-Todo-Client':'web','Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});let p;try{p=await r.json()}catch{const error=Error('未能读取服务器响应');error.acknowledged=r.ok;throw error}if(!r.ok){const error=Error(typeof p?.detail==='string'?p.detail:p?.detail?.message||'输入无效或请求失败');error.status=r.status;throw error;}return p}
async function connect(){if(pendingWrite){notify('请先核对待确认操作');return}try{await api('/session');db.items=await api('/items');render();notify('工作空间已更新')}catch(e){notify(e.message)}}
function finish(saved){const i=db.items.findIndex(x=>x.id===saved.id);if(i<0)db.items.push(saved);else db.items[i]=saved;return saved}
function verifyWorkReceipt(saved,intent){
 if(!saved||typeof saved.id!=='string'||!saved.id||saved.type!==intent.body.type||
    !Number.isInteger(saved.version)||saved.version<(intent.body.expected_version??1)||
    (intent.id?saved.id!==intent.id:saved.parent!==intent.body.parent))throw Error('保存回执与原操作不匹配，请继续核对');
 return saved;
}
function completeWorkWrite(saved,intent){
 if(pendingWrite!==intent)throw Error('待核对操作已变化');
 verifyWorkReceipt(saved,intent);
 const result=finish(saved);pendingWrite=null;return result;
}
async function commit(item,id,origin='editor'){
 if(pendingWrite)throw Error('请先核对上一次操作');
 const keys=['type','parent','name','description','owner','planStart','planEnd','status','plan_change_reason'];
 const body=Object.fromEntries(keys.map(k=>[k,item[k]??(k==='parent'?null:k==='status'?'notStarted':'')]));
 body.operation_id=crypto.randomUUID();if(id)body.expected_version=item.version;
 const intent=pendingWrite={body,id,origin,writing:true,acknowledged:false,checking:false};
 try{
  const saved=await api('/items'+(id?'/'+encodeURIComponent(id):''),id?'PUT':'POST',body);
  intent.acknowledged=true;
  return completeWorkWrite(saved,intent);
 }catch(error){
  if(error.acknowledged)intent.acknowledged=true;
  if(!intent.acknowledged&&error.status>=400&&error.status<500&&error.status!==408)pendingWrite=null;
  throw error;
 }finally{intent.writing=false;}
}
async function readWorkReceipt(intent){
 if(!intent||pendingWrite!==intent||intent.writing||intent.checking)throw Error('正在处理，请稍后核对');
 intent.checking=true;
 try{
  const saved=await api('/operations/'+encodeURIComponent(intent.body.operation_id));
  intent.acknowledged=true;
  return completeWorkWrite(saved,intent);
 }catch(error){if(error.acknowledged)intent.acknowledged=true;throw error}
 finally{intent.checking=false;}
}
const pendingDrawer=$('#pendingDrawer');
let pendingDrawerModel=null,pendingDrawerReact=null;
function closePendingDrawer(){if(pendingDrawer.open)pendingDrawer.close()}
function paintPendingDrawer(){
 const model=pendingDrawerModel??{error:'',canAbandon:false};
 const actions={close:closePendingDrawer,abandon:abandonPending,showTip,hideTip};
 pendingDrawerReact({model,actions});
}
function mountPendingWrite(mountDrawer,mountTools){
 pendingDrawerReact=mountDrawer(pendingDrawer);
 paintPendingDrawer();
 mountTools($('.connectionTools'),{actions:{refresh:connect,check:checkPending,showTip,hideTip}});
}
pendingDrawer.addEventListener('close',()=>{if(!pendingDrawer.open)pendingDrawerModel=null});
async function checkPending(){
 if(!pendingDrawerReact)return;
 const intent=pendingWrite;
 if(!intent){notify('没有待确认操作');return}
 if(busy||intent.writing||intent.checking||pendingDrawer.open)return;
 let saved;
 try{saved=await readWorkReceipt(intent)}
 catch(error){
  if(pendingWrite!==intent)return;
  pendingDrawerModel={intent,error:error.message,canAbandon:error.status===404&&!intent.acknowledged};
  notify(error.message);paintPendingDrawer();pendingDrawer.showModal();return;
 }
 if(intent.origin==='plan'&&typeof planSaved==='function'){await planSaved(saved.id);return}
 if(intent.origin==='editor'){
  if(saved.type!=='event')selection[saved.type]=saved.id;
  editing=null;$('#editor').close();
 }
 render();
 if(intent.origin==='editor'&&typeof todoImages!=='undefined')todoImages.editorSaved(saved);
 notify('已核对保存结果');
}
async function abandonPending(){
 const intent=pendingWrite;
 if(!pendingDrawer.open||!intent||intent!==pendingDrawerModel?.intent||!pendingDrawerModel.canAbandon||
    intent.acknowledged||intent.writing||intent.checking)return;
 intent.checking=true;pendingDrawerModel.canAbandon=false;paintPendingDrawer();
 try{
  await api('/session');
  const items=await api('/items');
  if(!Array.isArray(items))throw Error('工作空间未能读回');
  if(!pendingDrawer.open||pendingWrite!==intent||pendingDrawerModel?.intent!==intent)return;
  db.items=items;pendingWrite=null;closePendingDrawer();
  if(intent.origin==='plan'&&typeof abandonPlanWrite==='function')abandonPlanWrite();
  render();notify('工作空间已更新');
 }catch(error){
  if(pendingDrawer.open&&pendingWrite===intent&&pendingDrawerModel?.intent===intent){
   pendingDrawerModel={intent,error:error.message+'；原操作仍保留，请继续核对',canAbandon:false};paintPendingDrawer();
  }
 }finally{intent.checking=false;}
}
function updateEditor({error,saving}){
 const patch={};
 if(error!==undefined)patch.error=error;
 if(saving!==undefined)patch.busy=saving;
 wbUpdateEditorView(patch);
}
$('#form').onsubmit=async e=>{
 e.preventDefault();if(busy||!editing)return;
 const name=$('#name').value.trim();
 if(!name){updateEditor({error:'请输入名称'});return}
 const action=['thing','event'].includes(editing.type),start=$('#planStart').value,end=$('#planEnd').value;
 if(action&&start&&end&&end<start){updateEditor({error:'计划结束不能早于开始'});return}
 const current=get(editing.id);
 const item={...current,version:editing.version,type:editing.type,parent:current?.parent??editing.parent,
  name,description:$('#description').value,plan_change_reason:$('#editorPlanReason')?.value??'',
  ...(action?{planStart:start,planEnd:end,owner:$('#owner').value.trim(),status:$('#status').value}:{})};
 busy=true;updateEditor({saving:true});
 try{
  const saved=await commit(item,editing.id);
  if(saved.type!=='event')selection[saved.type]=saved.id;
  editing=null;$('#editor').close();render();
  if(typeof todoImages!=='undefined')todoImages.editorSaved(saved);
  notify('已保存');
 }catch(e){updateEditor({error:e.message+'；输入已保留，请核对操作结果'})}
 finally{busy=false;updateEditor({saving:false})}
};
async function toggle(id){if(busy)return;busy=true;try{const item=get(id);if(item.status==='cancelled')throw Error('请通过编辑恢复已取消事件');await commit({...item,status:item.status==='completed'?'notStarted':'completed'},id,'toggle');render();notify('状态已保存')}catch(e){notify(e.message)}finally{busy=false}}
render();

connect();
