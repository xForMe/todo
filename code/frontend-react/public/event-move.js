/* Explicit relocation, scoped previews, and durable uncertain-result recovery. */
let moveContext = null, movePreview = null, moveBusy = false, moveGeneration = 0;
let moveIntent = JSON.parse(sessionStorage.getItem('todo.pendingEventMove') || 'null');
const moveDrawer = document.createElement('dialog');
moveDrawer.id = 'moveDrawer';
moveDrawer.setAttribute('aria-labelledby', 'moveTitle');
document.body.append(moveDrawer);

// The work page is hidden after reload; recovery must also be reachable on the homepage.
const paintMoveRecovery = todoWorkspaceShell.addEntry({id:'moveRecoveryEntry',
  kind:'icon',icon:'move',label:'核对待确认迁移',hidden:!moveIntent,beforeDate:true,
  onClick:()=>openEventMove(moveIntent?.id)});
function persistMove(value) {
  // Store before sending so a reload can recover the same operation key.
  if (value) sessionStorage.setItem('todo.pendingEventMove', JSON.stringify(value));
  else sessionStorage.removeItem('todo.pendingEventMove');
  moveIntent = value;
  paintMoveRecovery({hidden:!value});
}
let moveReact = null;
let moveForm = {};
function mountMoveDrawer(mount) { moveReact = mount(moveDrawer); }
function moveControls(patch = {}) {
  Object.assign(moveForm, patch);
  moveDrawer.dataset.busy = String(moveBusy);
  moveReact({ model: { ...moveForm, busy: moveBusy, pending: !!moveIntent, preview: !!movePreview }, actions: {
    close: closeMove, goal: chooseMoveGoal, module: chooseMoveModule, thing: chooseMoveThing,
    refresh: loadMovePreview, check: checkMove, retry: sendMove, submit: submitMove, showTip, hideTip,
  } });
}
function closeMove() {
  if (moveBusy) return;
  moveGeneration++;
  moveDrawer.close();
}
moveDrawer.addEventListener('cancel', e => { if (moveBusy) e.preventDefault(); else moveGeneration++; });
const moveHint = '请选择目标事情，核对迁移范围后确认。';
function resetMovePreview() { moveGeneration++; movePreview = null; }
function moveModuleRows(goal) { return db.items.filter(row => row.type === 'module' && row.parent === goal); }
function moveThingRows(module) {
  return db.items.filter(row => row.type === 'thing' && row.parent === module && row.id !== get(moveContext)?.parent && pending(row));
}
function moveThingHint(rows) {
  return rows.length ? moveHint : '此模块没有可接收的其他事情，请选择其他模块，或先新建、重开事情。';
}
function chooseMoveGoal(goal) {
  if (moveBusy || moveIntent) return;
  resetMovePreview();
  moveControls({ goal, modules: moveModuleRows(goal), module: '', things: [], thing: '', impact: moveThingHint([]), error: '' });
}
function chooseMoveModule(module) {
  if (moveBusy || moveIntent) return;
  resetMovePreview();
  const things = moveThingRows(module);
  moveControls({ module, things, thing: '', impact: moveThingHint(things), error: '' });
}
function chooseMoveThing(thing) {
  if (moveBusy || moveIntent) return;
  moveForm.thing = thing;
  return loadMovePreview();
}
async function openEventMove(id) {
  if (!moveReact) return;
  if (moveBusy || eventBusy || busy || pendingWrite || eventPending) { notify('请先完成或核对当前操作'); return; }
  moveContext = moveIntent?.id || id;
  if (!moveContext) return;
  movePreview = null;
  const run = ++moveGeneration;
  moveForm = {};
  moveControls({ name: get(moveContext)?.name || '事件迁移', from: '', error: '', goal: '', module: '', thing: '',
    impact: '正在读取可选位置…' });
  if (!moveDrawer.open) moveDrawer.showModal();
  try {
    const rows = await api('/items');
    if (run !== moveGeneration || !moveDrawer.open) return;
    db.items = rows;
    const current = get(moveContext), thing = get(current?.parent), module = get(thing?.parent);
    if (!current) throw Error('事件不存在或不可操作');
    const goalId = module?.parent || '', moduleId = module?.id || '';
    const things = moveThingRows(moduleId);
    moveControls({ name: current.name, from: '当前位置：' + itemPath(thing) + ($('#editor').open ? '。迁移不保存编辑中的字段。' : ''),
      goals: children('goal'), goal: goalId, modules: moveModuleRows(goalId), module: moduleId, things,
      impact: moveIntent
        ? '上次迁移结果待核对，目标：' + itemPath(get(moveIntent.body.target_id)) + '。请先查询结果；不会自动重试。'
        : moveThingHint(things),
    });
    $('#moveGoal').focus();
  } catch (e) { if (run === moveGeneration && moveDrawer.open) moveControls({ error: e.message }); }
}
async function loadMovePreview() {
  if (moveBusy || moveIntent) return;
  resetMovePreview();
  const target = moveForm.thing, id = moveContext, run = moveGeneration;
  moveControls({ impact: target ? '正在核对迁移影响…' : moveThingHint(moveForm.things || []), error: '' });
  if (!target) return;
  try {
    const result = await api('/events/' + id + '/move?target_id=' + encodeURIComponent(target));
    if (run !== moveGeneration || !moveDrawer.open) return;
    movePreview = result;
    moveControls({ impact: `将 ${result.moved_ids.length} 个事件迁至 ${result.target_path.join(' / ')}。` +
      (result.detached_parent ? '当前事件会脱离原父事件，作为目标事情下的独立事件。' : '') +
      `保留内容、状态和内部关系；暂停 ${result.documents} 个文档来源、${result.reminders} 条催办，作废 ${result.discarded_suggestions} 条待确认建议。` });
  } catch (e) {
    if (run === moveGeneration && moveDrawer.open) moveControls({ impact: '未完成核对，暂不能迁移。', error: e.message });
  }
}
async function submitMove() {
  if (moveBusy || moveIntent || !movePreview) return;
  try {
    persistMove({ id: moveContext, body: { target_id: moveForm.thing, snapshot: movePreview.snapshot, operation_id: crypto.randomUUID() } });
    await sendMove();
  } catch (e) { moveControls({ error: e.message }); }
}
async function moveSaved(result) {
  if (result.action !== 'move' || result.event_id !== moveIntent.id || result.target_id !== moveIntent.body.target_id) throw Error('回执与迁移不一致，请保留操作继续核对');
  db.items = await api('/items');
  const targetId = result.target_id;
  persistMove(null);
  moveGeneration++;
  moveDrawer.close();
  eventDialog.close();
  $('#editor').close();
  editing = null;
  await locateWorkbench(targetId);
  notify(selection.thing === targetId ? '事件已迁移，相关来源与催办已暂停' : '事件已迁移，页面定位未完成，请刷新后核对目标事情');
}
async function sendMove() {
  if (moveBusy || !moveIntent) return;
  moveBusy = true; moveControls({ error: '' });
  let committed = false;
  try {
    const result = await api('/events/' + moveIntent.id + '/move', 'POST', moveIntent.body);
    committed = true;
    await moveSaved(result);
  } catch (e) {
    if (!committed && e.status >= 400 && e.status < 500 && ![401, 403].includes(e.status)) { persistMove(null); movePreview = null; }
    moveControls({ error: e.message });
  } finally { moveBusy = false; moveControls(); }
}
async function checkMove() {
  if (moveBusy || !moveIntent) return;
  moveBusy = true; moveControls();
  try { await moveSaved(await api('/event-operations/' + moveIntent.body.operation_id)); }
  catch (e) { moveControls({ error: e.message }); }
  finally { moveBusy = false; moveControls(); }
}
