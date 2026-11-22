/* Source-grounded candidate review: no automatic confirmation or vector requests. */
const todoMemoryCandidates = (() => {
  const drawer = document.createElement('dialog');
  drawer.id = 'memoryCandidatesDrawer'; drawer.setAttribute('aria-labelledby','memoryCandidatesTitle');
  document.body.append(drawer);
  const entryId = 'memoryCandidatesEntry';
  const paintEntry=todoWorkspaceShell.addEntry({id:entryId,kind:'text',label:'记忆候选',onClick:open});
  const storageKey = 'todo.memoryCandidateWrite';
  let sequence=0, busy=false, loading=false, intent=null;
  let items=null, generation=0, status='', message='', react=null;
  try { intent=JSON.parse(sessionStorage.getItem(storageKey)||'null'); } catch {}

  function enableReact(mount) { react=mount(drawer); controls(); }
  function remember(value) {
    if(value) sessionStorage.setItem(storageKey,JSON.stringify(value));
    else sessionStorage.removeItem(storageKey);
    intent=value; controls();
  }
  function close() { drawer.close(); }
  function controls() {
    const locked=busy||loading;
    paintEntry({label:intent?'记忆保存待核对':'记忆候选'});
    react?.({model:{items,generation,status,error:message,busy:locked,pending:!!intent},
      actions:{close,refresh,save,reject,recover}});
  }
  function setList(result, state='') {
    items=result?.items??null; generation++;
    status=result?(result.capacity_full?'候选容量已满，暂停新增。 ':'')+(result.partial?'仅展示前100条待核对候选。':''):state;
    controls();
  }
  const isCurrent=ticket=>ticket===sequence&&drawer.open;
  async function readList() {
    const result=await api('/memory/candidates');
    if (!Array.isArray(result?.items)) throw Error('候选列表未能读回');
    return result;
  }
  function requireRetired(result,id) {
    if (id && result.items.some(item=>item.id===id)) throw Error('候选仍在待确认列表');
  }
  async function refresh() {
    if (!drawer.open || busy || loading) return;
    const ticket=++sequence;
    loading=true; message=''; setList(null,'正在读取候选…');
    try {
      const result=await readList();
      if(isCurrent(ticket))setList(result);
    } catch(error) {
      if(isCurrent(ticket)){message=error.message;setList(null,'候选未更新');}
    } finally {
      if(isCurrent(ticket)){loading=false;controls();}
    }
  }
  async function save(id,description,aliases) {
    if (!drawer.open || busy || loading || intent) return;
    const candidate=items?.find(item=>item.id===id);
    if (!candidate?.usable) return;
    const values=aliases.split('\n').map(value=>value.trim()).filter(Boolean);
    if(values.length>20||values.some(value=>value.length>80)) {
      message='简称最多20个，每个最多80字';controls();return;
    }
    const op=crypto.randomUUID(), ticket=sequence;
    const body={operation_id:op,candidate_id:id,expected_version:candidate.current.version,scope_version:candidate.current.scope_version,description,aliases:values,enabled:true};
    try {remember({operation_id:op,module_id:candidate.module_id,candidate_id:id});}
    catch {message='无法保存核对标识，尚未提交；请允许本机会话存储';controls();return;}
    busy=true;message='';controls();
    let acknowledged=false;
    try {
      const receipt=await api('/memory/modules/'+encodeURIComponent(candidate.module_id),'PUT',body);
      acknowledged=true;
      if (receipt?.module_id!==candidate.module_id || receipt.version!==body.expected_version+1) throw Error('保存回执与候选不匹配');
      const result=await readList();
      requireRetired(result,id);
      remember(null);
      if(isCurrent(ticket)){setList(result);notify('模块记忆已更新；向量索引需另行生成');}
    } catch(error) {
      if(!acknowledged&&error.status>=400&&error.status<500)remember(null);
      if(isCurrent(ticket)) {
        message=acknowledged?'已收到保存响应，但候选列表未能读回；请核对保存结果，不要重复提交':
          error.message+(intent?'；请核对保存结果，不要重复提交':'；输入已保留，请核对后再操作');
        if(acknowledged)setList(null,'候选未更新');
      }
    } finally {busy=false;controls();}
  }
  async function reject(id) {
    if (!drawer.open || busy || loading || intent || !items?.some(item=>item.id===id)) return;
    const ticket=sequence;
    busy=true;message='';controls();
    try {
      const response=await api('/memory/candidates/'+encodeURIComponent(id)+'/reject','POST');
      if(response?.state!=='rejected')throw Error('未能核实拒绝结果');
      const result=await readList();
      requireRetired(result,id);
      if(isCurrent(ticket))setList(result);
    } catch(error) {
      if(isCurrent(ticket)){message=error.message+'；刷新核对结果，未自动重试';setList(null,'候选未更新');}
    } finally {busy=false;controls();}
  }
  async function recover() {
    if(!drawer.open||!intent||busy||loading)return;
    const pending=intent,ticket=sequence;
    busy=true;message='';controls();
    try {
      const receipt=await api('/memory/operations/'+encodeURIComponent(pending.operation_id));
      if(receipt?.module_id!==pending.module_id||!Number.isInteger(receipt.version)||receipt.version<1)throw Error('回执与待核对模块不匹配');
      const result=await readList();
      requireRetired(result,pending.candidate_id);
      remember(null);
      if(isCurrent(ticket)){setList(result);notify('模块记忆已更新；向量索引需另行生成');}
    } catch(error) {
      if(isCurrent(ticket)){message=error.message+'；保留操作标识，未重复提交';setList(null,'候选未更新');}
    } finally {busy=false;controls();}
  }
  function open(){
    if(!react||drawer.open||busy)return;
    drawer.showModal();drawer.querySelector('#memoryCandidatesClose').focus();void refresh();
  }
  drawer.addEventListener('close',()=>{
    if(!drawer.open){sequence++;loading=false;message='';setList(null);todoWorkspaceShell.focus(entryId);}
  });
  controls();

  let basisSequence=0;
  function paintBasis(memoryBasis) {drawSuggestion({memoryBasis});}
  async function openBasis(id) {
    const ticket=++basisSequence;
    const isCurrent=()=>ticket===basisSequence&&suggestionDrawer.open&&reviewingSuggestion?.id===id;
    paintBasis({ticket,state:'正在核对引用…',items:[]});
    try {
      const result=await api('/memory/suggestions/'+encodeURIComponent(id)+'/basis');
      if(!isCurrent())return;
      if(!Array.isArray(result?.items))throw Error('未能读回记忆引用');
      const refs=result.items.map(({module_id,revision,status,valid,path,description,aliases})=>({
        module_id,revision,status,valid:valid===true,...(valid===true?{path,description,aliases}:{})
      }));
      paintBasis({ticket,state:refs.length?result.note:'本条建议未记录经核对的记忆引用。',items:refs});
    } catch(error) {
      if(isCurrent())paintBasis({ticket,state:'引用核对不可用：'+error.message,items:[]});
    }
  }
  suggestionDrawer.addEventListener('close',()=>{
    if(suggestionDrawer.open)return;
    basisSequence++;
    paintBasis(null);
  });
  return {enableReact,openBasis};
})();
