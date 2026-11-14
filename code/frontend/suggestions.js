/* AI results appear inside their existing thing; no standalone workflow. */
let aiSuggestions=[],aiSources=[];
function isChatSuggestion(s){return s.source_kind==='chat'||aiSources.some(src=>src.id===s.source_id&&src.kind==='chat')}
const workRender=render;
render=function(){workRender();renderSuggestions()};
function renderSuggestions(){const root=$('#events');root.querySelector('.aiSuggestions')?.remove();const list=aiSuggestions.filter(s=>s.thing_id===selection.thing||(!s.thing_id&&isChatSuggestion(s)));if(!list.length)return;const section=document.createElement('section');section.className='aiSuggestions sourceCard';const title=document.createElement('h3');title.textContent='来源进展与待确认行动';section.append(title);for(const s of list){const p=JSON.parse(s.body),card=document.createElement('div');card.className='sourceCard';const name=document.createElement('strong');name.textContent=(!s.thing_id?'归属待确认 · ':s.state==='linked'?'新进展 · ':'待确认 · ')+p.name;const fields=document.createElement('p');fields.textContent='责任人：'+(p.owner||'待确认')+' · 结束：'+(p.plan_end||'待确认')+' · 建议状态：'+states[p.status];const basis=document.createElement('p');basis.textContent='原文依据：'+p.evidence;const buttons=document.createElement('div');buttons.className='actions';const reject=document.createElement('button');reject.textContent=s.state==='linked'?'关联有误':'舍弃建议';reject.onclick=()=>decideSuggestion(s.id,false);buttons.append(reject);if(s.state!=='linked'){const accept=document.createElement('button');accept.textContent=s.action==='new'?'确认新增事件':'确认修改事件';accept.onclick=()=>openSuggestion(s);buttons.append(accept)}card.append(name,fields,basis,buttons);section.append(card)}root.append(section)}
async function refreshSuggestions(){try{aiSuggestions=await api('/sources/suggestions');aiSources=await api('/sources');renderSuggestions()}catch(e){/* Source configuration displays errors; keep existing view intact. */}}
async function decideSuggestion(id,accept){try{const result=await api('/sources/suggestions/'+id,'POST',{accept});if(result.saved)finish(result.saved);await refreshSuggestions();render();notify('已核对并保存')}catch(e){notify(e.message+'；请核对操作结果，不会自动重试')}}
setInterval(refreshSuggestions,10000);

let reviewingSuggestion=null, suggestionBusy=false, suggestionPlacementEditable=false;
function suggestionOptions(selector, rows, placeholder, allowNew=false) {
  const node=$(selector);
  node.replaceChildren(new Option(placeholder,''));
  rows.forEach(x=>node.add(new Option(x.name,x.id)));
  if(allowNew)node.add(new Option('新建'+(selector==='#suggestionModule'?'模块':'事情')+'…','__new__'));
}
function updateSuggestionScope() {
  const newModule=$('#suggestionModule').value==='__new__',newThing=$('#suggestionThing').value==='__new__';
  $('#suggestionNewModuleGroup').hidden=!newModule;
  $('#suggestionNewThingGroup').hidden=!newThing;
  $('#suggestionSaveScope').textContent=reviewingSuggestion?.action==='new'
    ? '确认后保存：'+[newModule?'新模块':null,newThing?'新事情':null,'新事件'].filter(Boolean).join('、')+'。确认前不会创建。'
    : '更新已有事件，归属保持不变。';
}
function suggestionGoalChanged() {
  const goal=$('#suggestionGoal').value;
  suggestionOptions('#suggestionModule',goal?children('module',goal):[],'请选择模块',Boolean(goal&&suggestionPlacementEditable));
  $('#suggestionModule').disabled=!goal||!suggestionPlacementEditable;
  $('#suggestionNewModule').value='';
  suggestionModuleChanged();
}
function suggestionModuleChanged() {
  const module=$('#suggestionModule').value;
  suggestionOptions('#suggestionThing',module&&module!=='__new__'?children('thing',module):[],'请选择事情',Boolean(module&&suggestionPlacementEditable));
  $('#suggestionThing').disabled=!module||!suggestionPlacementEditable;
  $('#suggestionNewThing').value='';
  if(module==='__new__')$('#suggestionThing').value='__new__';
  updateSuggestionScope();
}
function openSuggestion(s) {
  if(suggestionBusy)return;
  reviewingSuggestion=s;
  const p=JSON.parse(s.body),existing=get(s.event_id),thing=get(s.thing_id),module=get(thing?.parent||p.module_id),goal=get(module?.parent||p.goal_id);
  suggestionPlacementEditable=s.action==='new'&&isChatSuggestion(s);
  $('#suggestionBasis').textContent='原文：'+p.evidence+(existing?'；当前记录：'+existing.name:'；新事件确认后才入库');
  $('#suggestionName').value=p.name;$('#suggestionOwner').value=p.owner;$('#suggestionDate').value=p.plan_end;$('#suggestionStatus').value=p.status;
  $('#suggestionError').textContent='';
  $('#suggestionRecommendation').textContent=p.placement_reason?'AI 归属建议：'+p.placement_reason:'归属建议请核对；没有合适事情时可新建，不必选择不相关的事情。';
  suggestionOptions('#suggestionGoal',children('goal'),'请选择目标');
  $('#suggestionGoal').disabled=!suggestionPlacementEditable;
  $('#suggestionGoal').value=goal?.id||'';
  suggestionGoalChanged();
  $('#suggestionModule').value=module?.id||(goal&&p.new_module_name?'__new__':'');
  suggestionModuleChanged();
  $('#suggestionThing').value=thing?.id||($('#suggestionModule').value&&p.new_thing_name?'__new__':$('#suggestionModule').value==='__new__'?'__new__':'');
  $('#suggestionNewModule').value=p.new_module_name||'';
  $('#suggestionNewThing').value=p.new_thing_name||'';
  if(!children('goal').length)$('#suggestionError').textContent='请先在主界面创建目标，再回来核对归属。';
  updateSuggestionScope();
  $('#suggestionDrawer').showModal();
}
async function confirmSuggestion() {
  if(!reviewingSuggestion||suggestionBusy)return;
  const s=reviewingSuggestion,p=JSON.parse(s.body),thing=$('#suggestionThing').value;
  let placement;
  if(suggestionPlacementEditable) {
    const goal=$('#suggestionGoal').value,module=$('#suggestionModule').value;
    const newModule=module==='__new__'?$('#suggestionNewModule').value.trim():'',newThing=thing==='__new__'?$('#suggestionNewThing').value.trim():'';
    if(!goal||!module||!thing||(module==='__new__'&&!newModule)||(thing==='__new__'&&!newThing)) {
      $('#suggestionError').textContent='请选择目标、模块和事情；选择新建时请填写名称。';return;
    }
    placement={goal_id:goal,module_id:module==='__new__'?'':module,new_module_name:newModule,new_thing_name:newThing};
  } else if(!thing) {$('#suggestionError').textContent='原归属已失效，请刷新后核对。';return;}
  const body={accept:true,edited:{...p,name:$('#suggestionName').value,owner:$('#suggestionOwner').value,plan_end:$('#suggestionDate').value,status:$('#suggestionStatus').value,thing_id:thing==='__new__'?'':thing},...(placement?{placement}:{})};
  suggestionBusy=true;
  const button=$('#suggestionDrawer .primary');button.disabled=true;
  try {
    const result=await api('/sources/suggestions/'+s.id,'POST',body);
    db.items=await api('/items');
    if(result.saved){const savedThing=get(result.saved.parent),savedModule=get(savedThing?.parent);selection.thing=savedThing?.id;selection.module=savedModule?.id;selection.goal=savedModule?.parent;}
    $('#suggestionDrawer').close();await refreshSuggestions();render();notify('已保存并读回');
  } catch(e) {$('#suggestionError').textContent=e.message+'；输入已保留，核对后可再次确认同一建议，不会重复创建。';}
  finally {suggestionBusy=false;button.disabled=false;}
}
$('#suggestionGoal').onchange=suggestionGoalChanged;
$('#suggestionModule').onchange=suggestionModuleChanged;
$('#suggestionThing').onchange=updateSuggestionScope;
$('#suggestionDrawer').addEventListener('cancel',e=>{if(suggestionBusy)e.preventDefault()});

