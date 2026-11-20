/* AI results appear inside their existing thing; no standalone workflow. */
let aiSuggestions=[],aiSources=[],aiLoaded=false,aiError='',aiReadVersion=0;
function isChatSuggestion(s){return s.source_kind==='chat'||aiSources.some(src=>src.id===s.source_id&&src.kind==='chat')}
function renderSuggestions(){if(typeof wbEventsReact!=='undefined'&&wbEventsReact)wbDrawEvents()}
async function refreshSuggestions(){const run=++aiReadVersion;try{const [suggestions,sources]=await Promise.all([api('/sources/suggestions'),api('/sources')]);if(run!==aiReadVersion)return;aiSuggestions=suggestions;aiSources=sources;aiLoaded=true;aiError='';renderSuggestions();if(typeof loadUnmatched==='function')await loadUnmatched()}catch(e){if(run!==aiReadVersion)return;aiError=e.message}finally{if(run===aiReadVersion&&typeof renderChatResults==='function')renderChatResults()}}
async function decideSuggestion(id,accept){try{const result=await api('/sources/suggestions/'+id,'POST',{accept});if(result.saved)finish(result.saved);await refreshSuggestions();render();notify('已核对并保存')}catch(e){notify(e.message+'；请核对操作结果，不会自动重试')}}
setInterval(refreshSuggestions,10000);

const suggestionDrawer=$('#suggestionDrawer');
let reviewingSuggestion=null, suggestionBusy=false, suggestionPlacementEditable=false;
let suggestionReact=null,suggestionModel=null;
function mountSuggestionDrawer(mount){suggestionReact=mount(suggestionDrawer)}
function drawSuggestion(patch={}){
  if(!suggestionModel)return;
  Object.assign(suggestionModel,patch);
  const {fields}=suggestionModel;
  const newModule=fields.module==='__new__',newThing=fields.thing==='__new__';
  const saveScope=reviewingSuggestion.action==='new'
    ?'确认后保存：'+[newModule?'新模块':null,newThing?'新事情':null,'新事件'].filter(Boolean).join('、')+'。确认前不会创建。'
    :'更新已有事件，归属保持不变。';
  function input(key,value){fields[key]=value;drawSuggestion()}
  suggestionReact({model:{...suggestionModel,saveScope,goals:children('goal'),
    modules:fields.goal?children('module',fields.goal):[],things:fields.module&&!newModule?children('thing',fields.module):[],
    editable:suggestionPlacementEditable,busy:suggestionBusy,states},actions:{input,
    goal:value=>{Object.assign(fields,{goal:value,module:'',thing:'',newModule:'',newThing:''});drawSuggestion()},
    module:value=>{Object.assign(fields,{module:value,thing:value==='__new__'?'__new__':'',newThing:''});drawSuggestion()},
    thing:value=>input('thing',value),close:()=>suggestionDrawer.close(),confirm:confirmSuggestion,showTip,hideTip,
  }});
}
function setSuggestionRecommendation(recommendation){drawSuggestion({recommendation})}
function openSuggestion(s) {
  if(!suggestionReact||suggestionBusy)return;
  reviewingSuggestion=s;
  const p=JSON.parse(s.body),existing=get(s.event_id),thing=get(s.thing_id),module=get(thing?.parent||p.module_id),goal=get(module?.parent||p.goal_id);
  suggestionPlacementEditable=s.action==='new'&&isChatSuggestion(s);
  const moduleId=module?.type==='module'&&module.parent===goal?.id?module.id
    :goal&&p.new_module_name&&suggestionPlacementEditable?'__new__':'';
  const thingId=thing?.type==='thing'&&thing.parent===moduleId?thing.id
    :moduleId&&suggestionPlacementEditable&&(p.new_thing_name||moduleId==='__new__')?'__new__':'';
  suggestionModel={basis:'原文：'+p.evidence+(existing?'；当前记录：'+existing.name:'；新事件确认后才入库'),
    recommendation:p.placement_reason?'AI 归属建议：'+p.placement_reason:'归属建议请核对；没有合适事情时可新建，不必选择不相关的事情。',
    error:children('goal').length?'':'请先在主界面创建目标，再回来核对归属。',
    fields:{name:p.name||'',owner:p.owner||'',date:p.plan_end||'',status:p.status||'notStarted',
      goal:goal?.type==='goal'?goal.id:'',module:moduleId,thing:thingId,
      newModule:p.new_module_name||'',newThing:p.new_thing_name||''}};
  drawSuggestion();
  if(!suggestionDrawer.open)suggestionDrawer.showModal();
  if(typeof todoMemoryCandidates!=='undefined')void todoMemoryCandidates.openBasis(s.id);
}
async function confirmSuggestion() {
  if(!reviewingSuggestion||suggestionBusy)return;
  const s=reviewingSuggestion,p=JSON.parse(s.body);
  // Read the rendered controls so an empty option or a date normalized by the browser stays empty.
  const value=id=>suggestionDrawer.querySelector('#'+id).value;
  const thing=value('suggestionThing');
  let placement;
  if(suggestionPlacementEditable) {
    const goal=value('suggestionGoal'),module=value('suggestionModule');
    const newModule=module==='__new__'?value('suggestionNewModule').trim():'',newThing=thing==='__new__'?value('suggestionNewThing').trim():'';
    if(!goal||!module||!thing||(module==='__new__'&&!newModule)||(thing==='__new__'&&!newThing)) {
      drawSuggestion({error:'请选择目标、模块和事情；选择新建时请填写名称。'});return;
    }
    placement={goal_id:goal,module_id:module==='__new__'?'':module,new_module_name:newModule,new_thing_name:newThing};
  } else if(!thing) {drawSuggestion({error:'原归属已失效，请刷新后核对。'});return;}
  const body={accept:true,edited:{...p,name:value('suggestionName'),owner:value('suggestionOwner'),plan_end:value('suggestionDate'),status:value('suggestionStatus'),thing_id:thing==='__new__'?'':thing},...(placement?{placement}:{})};
  suggestionBusy=true;
  drawSuggestion();
  suggestionDrawer.dataset.busy='true';
  try {
    const result=await api('/sources/suggestions/'+s.id,'POST',body);
    db.items=await api('/items');
    if(result.saved){const savedThing=get(result.saved.parent),savedModule=get(savedThing?.parent);selection.thing=savedThing?.id;selection.module=savedModule?.id;selection.goal=savedModule?.parent;}
    suggestionDrawer.close();await refreshSuggestions();render();if(typeof loadWorkbench==='function')await loadWorkbench();notify('已保存并读回');
  } catch(e) {drawSuggestion({error:e.message+'；输入已保留，核对后可再次确认同一建议，不会重复创建。'});}
  finally {
    suggestionBusy=false;suggestionDrawer.dataset.busy='false';
    drawSuggestion();
  }
}
suggestionDrawer.addEventListener('cancel',e=>{if(suggestionBusy)e.preventDefault()});
