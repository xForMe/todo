import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';

const PAGE_SIZE = 10;
const base = '/dsh-captures';
const pathFor = id => `${base}/${encodeURIComponent(id)}`;
const recoveryKey = 'todo.dsh-capture.confirm.v1';
const uuid = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i;
const active = row => row.status === 'notStarted' || row.status === 'working';

function recoverToken() {
  try {
    const saved = JSON.parse(sessionStorage.getItem(recoveryKey));
    return saved && uuid.test(saved.capture) && uuid.test(saved.operation) ? saved : null;
  } catch { return null; }
}

function remember(token) {
  if (token) sessionStorage.setItem(recoveryKey, JSON.stringify(token));
  else sessionStorage.removeItem(recoveryKey);
}

function initialFields(candidate, items) {
  const { path } = candidate;
  const found = (id, type, parent) => items.some(row => row.id === id && row.type === type && row.parent === parent);
  const goal = found(path.goal_id, 'goal', null) ? path.goal_id : '';
  const module = goal && found(path.module_id, 'module', goal) ? path.module_id : '';
  const thing = module && found(path.matter_id, 'thing', module) ? path.matter_id : '';
  return { title: candidate.title, owner: candidate.owner || '', date: candidate.planned_date || '',
    goal, module: goal && path.kind === 'new_module' ? 'new' : module,
    thing: (module && path.kind === 'new_matter') || (goal && path.kind === 'new_module') ? 'new' : thing,
    moduleName: path.kind === 'new_module' ? path.module_name || '' : '',
    thingName: ['new_matter', 'new_module'].includes(path.kind) ? path.matter_name || '' : '' };
}

function CaptureForm({ review, busy, submit, back, error }) {
  const { draft, items } = review;
  const [fields, setFields] = useState(() => initialFields(draft.candidate, items));
  const [preview, setPreview] = useState(false);
  const heading = useRef(null);
  useLayoutEffect(() => { heading.current?.focus(); }, [preview]);
  const change = patch => setFields(previous => ({ ...previous, ...patch }));
  const { goal, module, thing, title, date, owner, moduleName, thingName } = fields;
  const goals = items.filter(row => row.type === 'goal' && row.parent === null);
  const modules = items.filter(row => row.type === 'module' && row.parent === goal);
  const things = items.filter(row => row.type === 'thing' && row.parent === module);
  const selected = [goals.find(row => row.id === goal), modules.find(row => row.id === module), things.find(row => row.id === thing)];
  const valid = title.trim() && selected[0] && (module === 'new' ? moduleName.trim() : selected[1]) &&
    (thing === 'new' ? thingName.trim() : selected[2]);
  const names = [selected[0]?.name, module === 'new' ? `${moduleName.trim()}（新建模块）` : selected[1]?.name,
    thing === 'new' ? `${thingName.trim()}（新建事情）` : selected[2]?.name];
  function onSubmit(event) {
    event.preventDefault();
    if (!valid || busy) return;
    if (!preview) { setPreview(true); return; }
    submit({ expected_revision: draft.revision, title: title.trim(), owner: owner.trim(), planned_date: date,
      placement: { goal_id: goal, module_id: module === 'new' ? '' : module,
        thing_id: thing === 'new' ? '' : thing, new_module_name: module === 'new' ? moduleName.trim() : '',
        new_thing_name: thing === 'new' ? thingName.trim() : '',
        versions: Object.fromEntries(selected.filter(Boolean).map(row => [row.id, row.version])) } });
  }
  return <form className="dshCaptureForm" onSubmit={onSubmit}>
    <h3 ref={heading} tabIndex={-1}>{preview ? '确认创建事件' : '核对 DSH 草稿'}</h3>
    {!preview ? <fieldset disabled={busy}>
      <label>事件名称<input required maxLength={120} value={title} onChange={event => change({ title:event.target.value })} /></label>
      <div className="dshCaptureFields">
        <label>截止日期<input type="date" value={date} onChange={event => change({ date:event.target.value })} /></label>
        <label>责任人<input maxLength={80} value={owner} onChange={event => change({ owner:event.target.value })} /></label>
      </div>
      <p className="chatScope">{draft.candidate.reason}</p>
      <div className="dshCaptureField"><label htmlFor="dshCaptureGoal">目标</label><select id="dshCaptureGoal" required value={goal} onChange={event => change({ goal:event.target.value, module:'', thing:'' })}>
        <option value="">选择目标</option>{goals.map(row => <option key={row.id} value={row.id}>{row.name}</option>)}
      </select></div>
      <div className="dshCaptureField"><label htmlFor="dshCaptureModule">模块</label><select id="dshCaptureModule" required disabled={!goal} value={module} onChange={event => change({ module:event.target.value, thing:event.target.value === 'new' ? 'new' : '' })}>
        <option value="">选择模块</option>{modules.map(row => <option key={row.id} value={row.id}>{row.name}</option>)}<option value="new">新建模块</option>
      </select></div>
      {module === 'new' && <label>新模块名称<input required maxLength={120} value={moduleName} onChange={event => change({ moduleName:event.target.value })} /></label>}
      {module !== 'new' && <div className="dshCaptureField"><label htmlFor="dshCaptureThing">事情</label><select id="dshCaptureThing" required disabled={!module} value={thing} onChange={event => change({ thing:event.target.value })}>
        <option value="">选择事情</option>{things.map(row => <option key={row.id} value={row.id}>{row.name}</option>)}<option value="new">新建事情</option>
      </select></div>}
      {thing === 'new' && <label>新事情名称<input required maxLength={120} value={thingName} onChange={event => change({ thingName:event.target.value })} /></label>}
      <details><summary>原文依据</summary><p>{draft.candidate.evidence}</p></details>
    </fieldset> : <dl className="dshCaptureSummary">
      <dt>事件</dt><dd>{title.trim()}</dd><dt>归属</dt><dd>{names.join(' → ')}</dd>
      <dt>截止日期</dt><dd>{date || '未设置'}</dd><dt>责任人</dt><dd>{owner.trim() || '未指定'}</dd>
    </dl>}
    {error && <p role="alert" className="error">{error}</p>}
    <div className="chatActions">
      <button type="button" disabled={busy} onClick={preview ? () => setPreview(false) : back}>{preview ? '返回修改' : '稍后处理'}</button>
      <button key={preview ? 'confirm' : 'preview'} type="submit" className="primary" disabled={!valid || busy}>{busy ? '正在保存…' : preview ? '确认创建' : '核对并准备确认'}</button>
    </div>
  </form>;
}

export function DshCapturePanel({ api, onSaved, refreshKey }) {
  const [page, setPage] = useState(0);
  const [reload, setReload] = useState(0);
  const [list, setList] = useState(null);
  const [review, setReview] = useState(null);
  const [pending, setPending] = useState(recoverToken);
  const [feedback, setFeedback] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const alive = useRef(false);
  const readSequence = useRef(0);
  const locked = useRef(false);
  const pendingHeading = useRef(null);
  useLayoutEffect(() => { if (pending) pendingHeading.current?.focus(); }, [pending]);

  useEffect(() => { alive.current = true; return () => { alive.current = false; readSequence.current++; }; }, []);
  useEffect(() => {
    let current = true;
    setList(null);
    api(`${base}?offset=${page * PAGE_SIZE}&limit=${PAGE_SIZE}`).then(result => {
      if (!current) return;
      if (page && !result.drafts.length) setPage(Math.max(0, Math.ceil(result.total / PAGE_SIZE) - 1));
      else setList(result);
    }).catch(() => { if (current) setList({ error:true }); });
    return () => { current = false; };
  }, [api, page, reload, refreshKey]);

  async function open(id) {
    const sequence = ++readSequence.current;
    setBusy(true); setError(''); setFeedback('');
    try {
      const [draft, items] = await Promise.all([api(pathFor(id)), api('/items')]);
      if (!draft.candidate || draft.operation_id !== id) throw Error('这条草稿已不可核对');
      if (sequence === readSequence.current) setReview({ draft, items:items.filter(active) });
    } catch (reason) {
      if (sequence === readSequence.current) setError(`${reason.message}。请刷新后再核对。`);
    } finally { if (sequence === readSequence.current) setBusy(false); }
  }

  async function reconcile(token) {
    const receipt = await api(`${pathFor(token.capture)}/operations/${encodeURIComponent(token.operation)}`);
    if (receipt?.event?.type !== 'event' || !receipt.event.id) throw Error('回执无法核对');
    await onSaved(receipt.event.id);
    remember(null);
    if (alive.current) {
      setPending(null); setReview(null); setError(''); setReload(value => value + 1);
      setFeedback(`已创建并核对：${receipt.event.name}`);
    }
  }

  async function checkPending() {
    if (locked.current || !pending) return;
    locked.current = true; setBusy(true); setError('');
    try { await reconcile(pending); }
    catch { if (alive.current) setError('暂未核对到保存结果。可稍后再查原操作，请勿重新提交。'); }
    finally { locked.current = false; if (alive.current) setBusy(false); }
  }

  async function submit(fields) {
    if (locked.current || recoverToken() || !review) return;
    const token = { capture:review.draft.operation_id, operation:crypto.randomUUID() };
    try { remember(token); }
    catch { setError('无法记录操作标识，本次未提交。请允许本站会话存储后再试。'); return; }
    locked.current = true; setBusy(true); setError(''); setFeedback('');
    try {
      try {
        await api(`${pathFor(token.capture)}/confirm`, 'POST', { ...fields, operation_id:token.operation });
      } catch (reason) {
        if ([400, 401, 403, 404, 409, 422].includes(reason.status)) {
          remember(null);
          if (alive.current) {
            setPending(null); setError(reason.message);
            if ([404, 409].includes(reason.status)) { setReview(null); setReload(value => value + 1); }
          }
          return;
        }
        throw reason;
      }
      await reconcile(token);
    } catch {
      if (alive.current) { setPending(token); setError('保存结果待核对。不会重新提交。'); }
    } finally { locked.current = false; if (alive.current) setBusy(false); }
  }

  if (pending) return <section className="dshCapturePanel">
    <h3 ref={pendingHeading} tabIndex={-1}>保存结果待核对</h3><p>使用原操作查询，不会再次创建事件。</p>
    {error && <p className="error" role="alert">{error}</p>}
    <button type="button" className="primary" disabled={busy} onClick={checkPending}>{busy ? '正在核对…' : '核对原操作'}</button>
  </section>;
  if (review) return <CaptureForm key={`${review.draft.operation_id}:${review.draft.revision}`} review={review}
    busy={busy} error={error} back={() => { setReview(null); setError(''); }} submit={submit} />;
  const pages = list?.total ? Math.ceil(list.total / PAGE_SIZE) : 0;
  return <section className="dshCapturePanel" aria-label="DSH 待确认草稿">
    <p className="chatScope">在 DeepSeek Harness 里记下的待办，确认后才进入行动清单。</p>
    {feedback && <p role="status">{feedback}</p>}
    {error && <p className="error" role="alert">{error}</p>}
    {!list ? <p role="status">正在读取 DSH 草稿…</p> : list.error ?
      <p className="error" role="alert">DSH 草稿暂不可用，请刷新重试。</p> : list.drafts.length === 0 ?
      <p>暂无待确认的 DSH 草稿</p> : list.drafts.map(({ operation_id:id, candidate }) => {
        const path = [candidate.path.goal_name, candidate.path.module_name, candidate.path.matter_name].filter(Boolean);
        return <article className="wbRow chatResult dshCaptureRow" key={id}>
          <strong>{candidate.title}</strong><p className="wbPath">{path.join(' → ') || '归属待确认'}</p>
          <p>{candidate.planned_date || '日期未设置'} · {candidate.owner || '责任人未指定'}</p>
          <div className="chatActions"><button type="button" disabled={busy} onClick={() => open(id)}>核对草稿</button></div>
        </article>;
      })}
    {pages > 1 && <div className="wbPager"><span>第 {page + 1}/{pages} 页</span>
      <button type="button" disabled={busy || page === 0} onClick={() => setPage(page - 1)}>上一页</button>
      <button type="button" disabled={busy || page >= pages - 1} onClick={() => setPage(page + 1)}>下一页</button>
    </div>}
  </section>;
}
