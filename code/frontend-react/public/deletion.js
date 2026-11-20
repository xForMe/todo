/* Reviewed deletion, explicit destination, and durable uncertain-result recovery. */
let deletionView = null, deletionBusy = false, deletionRetryAllowed = false;
let deletionIntent = JSON.parse(sessionStorage.getItem('todo.pendingDeletion') || 'null');
const paintDeleteRecovery = todoWorkspaceShell.addEntry({id:'deleteRecoveryEntry',
  kind:'icon',icon:'trash',label:'核对待确认删除',hidden:!deletionIntent,beforeDate:true,
  onClick:()=>openDeletion(deletionIntent?.id)});

function saveDeleteIntent(value) {
  deletionIntent = value;
  if (value) sessionStorage.setItem('todo.pendingDeletion', JSON.stringify(value));
  else sessionStorage.removeItem('todo.pendingDeletion');
  paintDeleteRecovery({hidden:!value});
}
function itemPath(item) {
  const parts = [];
  for (let i = 0; item && i < 4; i++, item = get(item.parent)) parts.unshift(item.name);
  return parts.join(' / ');
}
const deleteDialog = $('#deleteDrawer');
let deleteReact = null;
const deleteForm = {title:'确认删除',name:'',impact:'',hint:'',error:'',options:[],target:''};
function mountDeleteDrawer(mount) { deleteReact = mount(deleteDialog); }
function selectDeleteTarget(value) { updateDeleteControls({target:value}); }
function closeDeletion() { if (!deletionBusy) deleteDialog.close(); }
function updateDeleteControls(patch = {}) {
  Object.assign(deleteForm, patch);
  const uncertain = Boolean(deletionIntent);
  const requiresTarget = !uncertain && !!deletionView?.impact?.requires_target;
  const submitDisabled = deletionBusy || (uncertain ? !deletionRetryAllowed :
    !deletionView?.impact || (requiresTarget && !deleteForm.target));
  const submitLabel = uncertain ? deletionBusy ? '处理中…' : deletionRetryAllowed ? '再次提交原操作' : '确认删除'
    : requiresTarget ? '换绑并删除' : '确认删除';
  const destination = itemPath(get(deleteForm.target));
  deleteReact({model:{...deleteForm, requiresTarget, uncertain, busy:deletionBusy, submitDisabled, submitLabel, destination},
    actions:{ select:selectDeleteTarget,reload:loadDeletion,check:checkDeletion,submit:submitDeletion,close:closeDeletion }});
}
async function openDeletion(id) {
  if (!deleteReact || deletionBusy) return;
  if (!id && !deletionIntent) return;
  if (pendingWrite) { notify('请先核对待确认保存操作'); return; }
  if (busy || eventBusy || eventPending || moveBusy || moveIntent || priorityBusy || priorityPending || wbBusy || wbPending) {
    notify('请先核对其他尚未完成的操作'); return;
  }
  aiGeneration++;
  if (eventDialog.open) eventDialog.close();
  $('#editor').close();
  if (deletionIntent) {
    deletionView = {id:deletionIntent.id};
    updateDeleteControls({title:'核对删除结果',hint:'',name:deletionIntent.name,target:'',options:[],error:'',
      impact:'上次删除结果待核对；保留原操作，不会自动重新提交。'});
    if (!deleteDialog.open) deleteDialog.showModal();
    return;
  }
  deletionView = {id};
  const loading = loadDeletion();
  if (!deleteDialog.open) deleteDialog.showModal();
  await loading;
}
async function loadDeletion() {
  if (!deletionView || deletionIntent || deletionBusy) return;
  const id = deletionView.id;
  deletionBusy = true;
  deletionView.impact = null;
  updateDeleteControls({impact:'正在核对下级内容和关联资料…',name:get(id)?.name||'',
    title:'删除'+(names[get(id)?.type]||'对象'),hint:'',error:'',options:[],target:''});
  try {
    db.items = await api('/items');
    const impact = await api('/items/' + id + '/deletion');
    deletionView.impact = impact;
    const options = children(impact.item.type).filter(item => item.id !== id)
      .map(item => ({id:item.id,label:itemPath(item)}));
    const hasReferences = impact.documents || impact.suggestions || impact.reminders || impact.relations.length;
    const hint = impact.item.type === 'event' && hasReferences
      ? '关联解除；文档保留到所属事情，读取与催办暂停，待处理建议作废。历史记录保留，不改变其他事件。'
      : impact.requires_target && !options.length
      ? '暂无可用接收位置，请取消后先创建另一个' + names[impact.item.type] + '。'
      : impact.requires_target
        ? '下级内容会完整保留，受影响来源和催办暂停。'
        : '';
    updateDeleteControls({name:'确定删除“'+impact.item.name+'”？',title:'删除'+names[impact.item.type],hint,options,
      impact:impact.requires_target
        ? `下级内容 ${impact.descendants} 项（直接下级 ${impact.children} 项） · 文档来源 ${impact.documents} 条 · AI 建议 ${impact.suggestions} 条 · 催办规则 ${impact.reminders} 条。`
        : ''});
  } catch (e) {
    updateDeleteControls({impact:'尚未获取到有效影响范围。',error:e.message});
  } finally {
    deletionBusy = false;
    updateDeleteControls();
    if ($('#deleteDrawer').open) {
      (deletionView?.impact?.requires_target ? $('#deleteTarget') : $('#closeDelete')).focus();
    }
  }
}
async function finishDeletion(result) {
  db.items = await api('/items');
  saveDeleteIntent(null);
  const target = get(result.target_id);
  if (target) {
    for (let item = target; item; item = get(item.parent)) selection[item.type] = item.id;
  }
  deletionView = null;
  $('#deleteDrawer').close();
  editing = null;
  await refreshSuggestions();
  render();
  notify('已删除，历史记录已保留');
}
async function submitDeletion() {
  if (deletionBusy) return;
  if (deletionIntent) {
    if (!deletionRetryAllowed) return;
    deletionBusy = true;
    deletionRetryAllowed = false;
    updateDeleteControls();
    try { await finishDeletion(await api('/items/' + deletionIntent.id + '/deletion', 'POST', deletionIntent.body)); }
    catch (e) {
      if (e.status >= 400 && e.status < 500) { saveDeleteIntent(null); deletionView.impact = null; }
      updateDeleteControls({error:e.message+'；请核对结果或刷新影响范围。'});
    } finally { deletionBusy = false; updateDeleteControls(); }
    return;
  }
  if (!deletionView?.impact) return;
  const impact = deletionView.impact;
  if (impact.requires_target && !deleteForm.target) return;
  const intent = {id:deletionView.id, name:impact.item.name, body:{
    operation_id:crypto.randomUUID(), snapshot:impact.snapshot,
    target_id:impact.requires_target ? deleteForm.target : null
  }};
  saveDeleteIntent(intent);
  deletionBusy = true;
  updateDeleteControls();
  try { await finishDeletion(await api('/items/' + intent.id + '/deletion', 'POST', intent.body)); }
  catch (e) {
    if (e.status >= 400 && e.status < 500) {
      saveDeleteIntent(null);
      deletionView.impact = null;
      updateDeleteControls({error:e.message+'；请刷新影响范围。'});
    } else updateDeleteControls({error:e.message+'；请点击核对删除结果。'});
  } finally { deletionBusy = false; updateDeleteControls(); }
}
async function checkDeletion() {
  if (!deletionIntent || deletionBusy) return;
  deletionBusy = true;
  updateDeleteControls();
  try { await finishDeletion(await api('/deletions/' + deletionIntent.body.operation_id)); }
  catch (e) {
    deletionRetryAllowed = e.status === 404;
    updateDeleteControls({error:e.message + (deletionRetryAllowed
      ? '；可手动再次提交原操作，相同标识不会重复执行。' : '')});
  } finally { deletionBusy = false; updateDeleteControls(); }
}
deleteDialog.addEventListener('cancel', e => { if (deletionBusy) e.preventDefault(); });
