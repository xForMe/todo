/* Current work is a factual projection. Never edit business state from this drawer. */
const todoWorkingMemory = (() => {
  const drawer = document.createElement('dialog');
  drawer.id = 'workingMemoryDrawer';
  drawer.setAttribute('aria-labelledby', 'workingMemoryTitle');
  document.body.append(drawer);
  let target = '', sequence = 0, summaryReact = null;
  let model = { status:'', error:'', summary:null, busy:false };
  function enableReact(mount) { summaryReact = mount(drawer); paint(); }
  function close() { drawer.close(); }
  async function locate(id) { close(); await locateWorkbench(id); }
  function paint(patch) {
    model = {...model, ...patch};
    summaryReact?.({model, actions:{close, locate, refresh}});
  }
  async function refresh() {
    if (!target || !drawer.open || model.busy) return;
    const ticket = ++sequence, id = target;
    const isCurrent = () => ticket === sequence && target === id && drawer.open;
    paint({summary:null, error:'', status:'正在整理当前工作…', busy:true});
    try {
      const result = await api('/memory/working/' + encodeURIComponent(id) + '/refresh', 'POST');
      if (!isCurrent()) return;
      if (result.state === 'inactive') {
        paint({status:'事情已结束，已退出当前摘要。业务记录保留。'});
      } else {
        const summary = result.summary;
        if (!summary?.counts || !Array.isArray(summary.actions)) throw Error('无法读回当前工作摘要');
        paint({summary, status:result.state === 'capacity_uncached'
          ? '当前摘要容量已满，以下为实时结果，未缓存。' : '已按当前业务记录整理'});
      }
    } catch (error) {
      if (!isCurrent()) return;
      paint({summary:null, status:'摘要未更新', error:error.message + '；可手动刷新，未自动重试'});
    } finally {
      if (isCurrent()) paint({busy:false});
    }
  }
  function open(id) {
    const item = get(id);
    if (!summaryReact || item?.type !== 'thing' || drawer.open) return;
    target = item.id;
    if ($('#editor').open) $('#editor').close();
    paint({status:'', error:'', summary:null, busy:false});
    drawer.showModal(); void refresh(); drawer.querySelector('#workingMemoryClose').focus();
  }
  drawer.addEventListener('close', () => {
    if (drawer.open) return;
    sequence++; target = '';
    paint({status:'', error:'', summary:null, busy:false});
    $('#editThing')?.focus();
  });
  return { enableReact, open };
})();
