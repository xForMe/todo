/* Source-grounded candidate review: no automatic confirmation or vector requests. */
(() => {
  const drawer = document.createElement('dialog');
  drawer.id = 'memoryCandidatesDrawer'; drawer.setAttribute('aria-labelledby','memoryCandidatesTitle');
  drawer.innerHTML = `<div class="drawerHead"><h2 id="memoryCandidatesTitle">记忆候选</h2><button type="button" id="memoryCandidatesClose">关闭</button></div>
    <p class="sourceHint">核对来源和模块记忆，确认后用于辅助归属。</p><p id="memoryCandidatesStatus" role="status"></p>
    <div id="memoryCandidatesList"></div><p id="memoryCandidatesError" role="alert"></p>
    <div class="actions"><button type="button" id="memoryCandidatesRefresh">刷新候选</button><button type="button" id="memoryCandidatesRecover" hidden>核对保存结果</button></div>`;
  document.body.append(drawer);
  const find = id => drawer.querySelector('#'+id);
  const entry = document.createElement('button'); entry.type='button'; entry.id='memoryCandidatesEntry'; entry.textContent='记忆候选';
  $('.workspaceBar').append(entry);
  let sequence=0, busy=false, intent=null;
  try { intent=JSON.parse(sessionStorage.getItem('todo.memoryCandidateWrite')||'null'); } catch {}
  function remember(value) {
    if(value) sessionStorage.setItem('todo.memoryCandidateWrite',JSON.stringify(value));
    else sessionStorage.removeItem('todo.memoryCandidateWrite');
    intent=value;
    controls();
  }
  function controls() {
    drawer.querySelectorAll('form button, form textarea').forEach(node=>{node.disabled=busy||!!intent||node.dataset.unavailable==='true';});
    find('memoryCandidatesRefresh').disabled=busy;
    find('memoryCandidatesRecover').hidden=!intent; find('memoryCandidatesRecover').disabled=busy;
    entry.textContent=intent?'记忆保存待核对':'记忆候选';
  }
  function text(tag,value,parent,cls='') {const n=document.createElement(tag);n.textContent=value;n.className=cls;parent.append(n);return n;}
  function render(result) {
    const list=find('memoryCandidatesList'); list.replaceChildren();
    find('memoryCandidatesStatus').textContent=(result.capacity_full?'候选容量已满，暂停新增。 ':'')+(result.partial?'仅展示前100条待核对候选。':'');
    if(!result.items.length) text('p','暂无待确认记忆候选。仅处理后续已授权来源的识别结果。',list);
    for(const candidate of result.items) {
      const card=text('article','',list,'memoryCandidateCard');
      text('h3',candidate.path,card); text('p',candidate.status,card,'muted');
      const form=text('form','',card); form.dataset.candidateId=candidate.id;
      if(candidate.usable) {
        text('p',candidate.draft.kind==='alias'?'简称候选':'模块职责候选',card);
        text('p','提取理由：'+candidate.draft.reason,card);
        const proof=text('details','',card); text('summary','来源原文',proof);text('blockquote',candidate.draft.evidence,proof);
        const current=text('details','',card);text('summary',`当前记忆 · 第${candidate.current.version}版`,current);
        text('p',candidate.current.description||'尚未配置职责',current);text('p',candidate.current.aliases.join('、')||'暂无简称',current);
        const descId='candidateDescription-'+candidate.id, aliasesId='candidateAliases-'+candidate.id;
        const label=text('label','确认后的模块职责',form);label.htmlFor=descId;
        const desc=document.createElement('textarea');desc.id=descId;desc.maxLength=2000;desc.rows=3;desc.value=candidate.description;form.append(desc);
        const aliasesLabel=text('label','确认后的简称（每行一个，最多20个）',form);aliasesLabel.htmlFor=aliasesId;
        const aliases=document.createElement('textarea');aliases.id=aliasesId;aliases.maxLength=1620;aliases.rows=2;aliases.value=candidate.aliases.join('\n');form.append(aliases);
        const save=text('button','确认更新记忆',form,'primary');save.type='submit';
        form.onsubmit=async event=>{
          event.preventDefault();if(busy||intent)return;
          const values=aliases.value.split('\n').map(x=>x.trim()).filter(Boolean);
          if(values.length>20||values.some(x=>x.length>80)){find('memoryCandidatesError').textContent='简称最多20个，每个最多80字';return;}
          const op=crypto.randomUUID(), ticket=sequence;
          const body={operation_id:op,candidate_id:candidate.id,expected_version:candidate.current.version,scope_version:candidate.current.scope_version,description:desc.value,aliases:values,enabled:true};
          try {remember({operation_id:op,module_id:candidate.module_id});}
          catch {find('memoryCandidatesError').textContent='无法保存核对标识，尚未提交；请允许本机会话存储';return;}
          busy=true;controls();find('memoryCandidatesError').textContent='';
          try {
            await api('/memory/modules/'+encodeURIComponent(candidate.module_id),'PUT',body);
            remember(null);
            if(ticket===sequence&&drawer.open){await refresh();notify('模块记忆已更新；向量索引需另行生成');}
          } catch(error) {
            if(error.status>=400&&error.status<500)remember(null);
            if(ticket===sequence)find('memoryCandidatesError').textContent=error.message+(intent?'；请核对保存结果，不要重复提交':'；输入已保留，请核对后再操作');
          } finally {busy=false;controls();}
        };
      }
      const reject=text('button','拒绝候选',form);reject.type='button';
      reject.onclick=async()=>{
        if(busy||intent)return;busy=true;controls();find('memoryCandidatesError').textContent='';
        try {await api('/memory/candidates/'+encodeURIComponent(candidate.id)+'/reject','POST');await refresh();}
        catch(error){find('memoryCandidatesError').textContent=error.message+'；刷新核对结果，未自动重试';}
        finally{busy=false;controls();}
      };
      // Place proof and comparison before the editable result.
      card.append(form);
    }
    controls();
  }
  async function refresh() {
    const ticket=++sequence;
    find('memoryCandidatesStatus').textContent='正在读取候选…';find('memoryCandidatesError').textContent='';
    try {
      const result=await api('/memory/candidates');
      if(ticket===sequence&&drawer.open)render(result);
    } catch(error) {if(ticket===sequence){find('memoryCandidatesList').replaceChildren();find('memoryCandidatesStatus').textContent='候选未更新';find('memoryCandidatesError').textContent=error.message;}}
  }
  entry.onclick=()=>{drawer.showModal();refresh();find('memoryCandidatesClose').focus();};
  find('memoryCandidatesClose').onclick=()=>drawer.close();
  drawer.addEventListener('close',()=>{if(!drawer.open){sequence++;entry.focus();}});
  find('memoryCandidatesRefresh').onclick=refresh;
  find('memoryCandidatesRecover').onclick=async()=>{
    if(!intent||busy)return;busy=true;controls();
    try{await api('/memory/operations/'+encodeURIComponent(intent.operation_id));remember(null);await refresh();}
    catch(error){find('memoryCandidatesError').textContent=error.message+'；保留操作标识，未重复提交';}
    finally{busy=false;controls();}
  };
  controls();

  const previous=openSuggestion;
  let basisSequence=0;
  openSuggestion=function(suggestion){
    previous(suggestion);
    let basis=$('#suggestionMemoryBasis');
    if(!basis){basis=document.createElement('section');basis.id='suggestionMemoryBasis';$('#suggestionRecommendation').after(basis);}
    basis.replaceChildren();text('h3','记忆引用',basis);const state=text('p','正在核对引用…',basis);
    const ticket=++basisSequence;
    api('/memory/suggestions/'+encodeURIComponent(suggestion.id)+'/basis').then(result=>{
      if(ticket!==basisSequence||!$('#suggestionDrawer').open)return;
      state.textContent=result.items.length?result.note:'本条建议未记录经核对的记忆引用。';
      for(const ref of result.items){const item=text('details','',basis);text('summary',`${ref.valid?ref.path:'已失效引用'} · 第${ref.revision}版`,item);text('p',ref.status,item);if(ref.valid){text('p',ref.description,item);text('p',ref.aliases.join('、'),item);}}
    }).catch(error=>{if(ticket===basisSequence)state.textContent='引用核对不可用：'+error.message;});
  };
  $('#suggestionDrawer').addEventListener('close',()=>{if(!$('#suggestionDrawer').open)basisSequence++;});
})();
