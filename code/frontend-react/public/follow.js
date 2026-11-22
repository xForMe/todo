let followRules=[],followEventId=null,followBusy=false,followPeopleSeq=0,followReadyEvent=null,followOpenSeq=0,followDraftText=null;
const followDrawer=$('#followDrawer');
let followReact=null,followOpenedRule=null,followReadOnly=false;
const followModel={context:'',disabled:false,query:'',recipient:'',people:[],hint:'',at:'09:00',cap:3,content:'',error:'',logs:[]};
function mountFollowDrawer(mount){followReact=mount(followDrawer)}
function paintFollow(patch={}){
  Object.assign(followModel,patch);
  followReact({model:followModel,actions:{close:()=>followDrawer.close(),query:changeFollowQuery,
    recipient:followPersonChanged,search:()=>searchFollowPeople(),input:(key,value)=>paintFollow({[key]:value}),
    regenerate:regenerateFollowContent,save:saveFollowRule,showTip,hideTip}});
}
async function refreshFollow(){
  try{
    followRules=await api('/sources/follow');
    if(typeof wbEventsReact!=='undefined'&&wbEventsReact)wbDrawEvents();
  }catch(e){/* Opening the drawer displays read errors. */}
}
function makeFollowDraft(event, items, branches){
  const matter=items.find(x=>x.id===event.parent&&x.type==='thing');
  if(!matter)throw new Error('所属事情读取不完整，请重新打开');
  const ancestors=[],seen=new Set([event.id]);
  let current=event;
  while(true){
    const parents=branches.filter(x=>x.child_id===current.id);
    if(!parents.length)break;
    const parent=items.find(x=>x.id===parents[0].parent_id&&x.type==='event'&&x.parent===event.parent);
    if(parents.length!==1||!parent||seen.has(parent.id))throw new Error('上级事件关系异常，请核对后重新打开');
    seen.add(parent.id);ancestors.unshift(parent);current=parent;
  }
  const brief=(value,limit)=>{const text=String(value||'').trim();return text.length>limit?text.slice(0,limit)+'…':text;};
  const lines=[event.owner?brief(event.owner,80)+'，你好。':'你好。','关于事情「'+brief(matter.name,120)+'」。'];
  if(matter.description)lines.push('事情背景：'+brief(matter.description,300));
  if(ancestors.length)lines.push('上级事件：'+brief(ancestors.map(x=>x.name).join(' → '),350));
  const direct=ancestors.at(-1);
  if(direct?.description)lines.push('上级工作要求：'+brief(direct.description,200));
  lines.push('请同步「'+brief(event.name,120)+'」的当前进展。');
  if(event.description)lines.push('本次工作：'+brief(event.description,400));
  lines.push('计划结束日期：'+(event.planEnd||'未设置')+'。','如有阻塞或需调整计划，请说明原因及预计完成时间，谢谢。');
  return lines.join('\n');
}
function regenerateFollowContent(){
  if(followDraftText===null){paintFollow({error:'上下文尚未读取完成，请重新打开后整理'});return}
  paintFollow({content:followDraftText});
}
async function openFollowRule(id,{preserveDraftOnFailure=false}={}){
  if(!followReact||!get(id))return false;
  followEventId=id;const opening=++followOpenSeq;++followPeopleSeq;
  followOpenedRule=null;followReadyEvent=null;followDraftText=null;followReadOnly=false;
  const active=()=>opening===followOpenSeq&&followEventId===id&&followDrawer.open;
  if(!preserveDraftOnFailure)paintFollow({disabled:true,query:'',content:'',context:'正在读取事件与上级上下文…',error:'',logs:[],people:[],recipient:'',hint:''});
  else paintFollow({disabled:true});
  if(!followDrawer.open)followDrawer.showModal();
  let rules;
  try{rules=await api('/sources/follow')}
  catch(error){if(active())paintFollow({error:error.message,disabled:false});return false}
  if(!active())return false;
  followRules=rules;
  const rule=followOpenedRule=rules.find(row=>row.event_id===id);
  followReadyEvent=id;
  const logs=(rule?.logs||[]).map(log=>new Date(log.created*1000).toLocaleString('zh-CN')+' · '+
    ({confirmed:'已发送并读回确认',pending:'发送结果待核对',unknown:'结果未知，已暂停'}[log.state]||log.state)+' · '+log.content);
  paintFollow({at:rule?.at||'09:00',cap:rule?.cap||3,content:rule?.content||'',logs:logs.length?logs:'尚无发送记录',error:''});
  try{
    const [items,view]=await Promise.all([api('/items'),api('/events/'+id+'/structure')]);
    if(!active())return false;
    const event=view.events.find(x=>x.id===id);
    if(!event)throw new Error('事件已失效，请刷新后重新打开');
    followDraftText=makeFollowDraft(event,[...items.filter(x=>x.type!=='event'),...view.events],view.branches);
    const index=db.items.findIndex(x=>x.id===id);if(index>=0)db.items[index]=event;
    paintFollow({context:event.name+' · 责任人：'+(event.owner||'未指定')+' · 截止：'+(event.planEnd||'未设置')+' · '+(rule?.status||'未开启'),
      content:followModel.content||followDraftText,query:event.owner||'',disabled:false,people:[],recipient:'',hint:''});
    if(rule?.recipient)await searchFollowPeople(true);
    else if(event.owner?.trim())await searchFollowPeople(false,true);
    else paintFollow({hint:'事件尚未指定负责人，请先完善事件负责人。'});
  }catch(error){if(active())paintFollow({context:'上下文读取失败',error:error.message+'；请重新打开，已有规则仍可暂停',disabled:false})}
  return active();
}
async function saveFollowRule(enabled){
  if(followBusy)return;
  if(followReadOnly||followReadyEvent!==followEventId){paintFollow({error:'请重新打开并读回规则后再保存'});return}
  const event=get(followEventId),rule=followOpenedRule;
  if(!event)return;
  if(enabled&&followDraftText===null){paintFollow({error:'请重新打开并读取完整上下文后再开启'});return}
  const chosen=followModel.recipient;
  if(enabled&&!chosen){paintFollow({error:'请选择事件负责人后保存'});return}
  const opening=followOpenSeq;
  const body={recipient:enabled?chosen:(rule?.recipient||chosen),content:followModel.content,at:followModel.at,
    cap:Number(followModel.cap),enabled,expected_version:rule?.version||0,event_version:event.version};
  followBusy=true;
  try{
    const saved=await api('/sources/follow/'+event.id,'POST',body);
    if(opening!==followOpenSeq||!followDrawer.open)return;
    const loaded=await openFollowRule(event.id,{preserveDraftOnFailure:true});
    if(!followDrawer.open||followEventId!==event.id||followOpenSeq!==opening+1)return;
    const latest=followOpenedRule;
    const matches=latest&&latest.version===saved.version&&
      ['recipient','content','at','cap','enabled','event_version'].every(key=>latest[key]===saved[key]);
    if(!loaded||!matches){
      followReadOnly=true;
      paintFollow({error:'规则已提交，但读回失败；请重新打开核对结果，不会自动重试'});
      return;
    }
    await refreshFollow();notify('规则已保存并读回');
  }catch(error){
    if(opening===followOpenSeq&&followDrawer.open){
      if(!error.status||error.status>=500)followReadOnly=true;
      paintFollow({error:error.message+'；请重新打开核对结果，不会自动重试'});
    }
  }finally{followBusy=false}
}
const priorRender=render;render=function(){priorRender();refreshFollow()};setInterval(refreshFollow,10000);
function changeFollowQuery(query){++followPeopleSeq;paintFollow({query,recipient:'',people:[],hint:''})}
function followPersonChanged(value){paintFollow({recipient:value,error:''})}
async function searchFollowPeople(saved=false,automatic=false){
  const id=followEventId,seq=++followPeopleSeq,query=followModel.query.trim();
  const active=()=>seq===followPeopleSeq&&id===followEventId&&followDrawer.open;
  paintFollow({recipient:'',people:[],hint:!saved&&!query?'请输入姓名或企业邮箱':'正在查询人员…'});
  if(!saved&&!query)return;
  try{
    const data=await api('/sources/follow-people?'+new URLSearchParams({event_id:id,query,saved:String(saved)}));
    if(!active())return;
    const people=data.people.map(person=>({id:person.id,label:[person.name,person.department,person.enterprise_email].filter(Boolean).join(' · ')}));
    const matches=data.people.filter(p=>p.name===query||p.enterprise_email?.toLowerCase()===query.toLowerCase());
    const selected=automatic&&!data.has_more&&matches.length===1&&data.people.length===1;
    const savedPerson=saved&&data.people.length===1?data.people[0]:null;
    paintFollow({people,recipient:savedPerson?.id||(selected?matches[0].id:''),
      ...(savedPerson?{query:savedPerson.name}:{}),
      hint:selected?'已按事件负责人自动匹配。':data.people.length
        ?(data.has_more?'仅显示部分人员，请用完整姓名或企业邮箱缩小范围。':'请选择人员；同名请结合部门或企业邮箱区分。')
        :(saved?'已保存人员暂无法识别，请重新查询；仍可暂停已有规则。':'未找到可识别的人员，请核对姓名或企业邮箱。')});
  }catch(error){if(active())paintFollow({hint:error.message+'；请重新查询，已有规则仍可暂停'})}
}
followDrawer.addEventListener('close',()=>{
  if(!followDrawer.open){++followPeopleSeq;++followOpenSeq;followReadyEvent=null}
});
