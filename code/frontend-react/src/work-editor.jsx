import React from 'react';

// Match the iconized legacy buttons, including the fallback icon for history.
const paths = {
  cancel: 'M6 6l12 12M18 6 6 18',
  save: 'm5 12 4 4L19 6',
  history: 'M12 5v14M5 12h14',
  move: 'M4 5h8M4 5v14h8M10 12h11m-5-5 5 5-5 5',
  trash: 'M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7',
};
const statusValues = ['notStarted', 'working', 'completed', 'cancelled'];

function EditorButton({ icon, label, onShowTip, onHideTip, onAction, type = 'button', className, ...props }) {
  const show = event => onShowTip(event.currentTarget);
  const hide = () => onHideTip();
  return <button {...props} type={type} className={className ? `${className} iconButton` : 'iconButton'}
    aria-label={label} title={label} data-tip={label} data-iconified="true"
    onMouseEnter={show} onFocus={show} onMouseLeave={hide} onBlur={hide}
    onClick={() => { hide(); onAction?.(); }}>
    <svg viewBox="0 0 24 24" aria-hidden="true"><path d={paths[icon]} /></svg>
  </button>;
}

export function WorkEditor({ session, title, context, fields, work, error, busy, plan, labels, actions, onCancel, onHistory, onShowTip, onHideTip }) {
  const tips = { onShowTip, onHideTip };
  // Inputs remount on open; the attachment root stays stable.
  return <>
    <h2 id="formTitle">{title}</h2>
    <p id="formContext">{context}</p>
    <label htmlFor="name">名称 <span className="error">*</span></label>
    <input id="name" key={`name:${session}`} maxLength={120} autoComplete="off" defaultValue={fields.name} />
    <label htmlFor="description">说明 <span className="muted">（可选）</span></label>
    <textarea id="description" key={`description:${session}`} defaultValue={fields.description} />
    <div id="editorImageSlot" style={{ display: 'contents' }} />
    <div id="workFields" hidden={!work}>
      <div className="fieldGrid">
        <div>
          <label htmlFor="planStart">计划开始日期</label>
          <input id="planStart" key={session} type="date" defaultValue={fields.planStart} />
        </div>
        <div>
          <label htmlFor="planEnd">计划结束日期</label>
          <input id="planEnd" key={session} type="date" defaultValue={fields.planEnd} />
        </div>
        <div>
          <label htmlFor="owner">责任人</label>
          <input id="owner" key={session} placeholder="填写姓名" maxLength={80} defaultValue={fields.owner} />
        </div>
        <div>
          <label htmlFor="status">状态</label>
          <select id="status" key={session} defaultValue={fields.status}>
            {statusValues.map(value => <option key={value} value={value}>{labels[value]}</option>)}
          </select>
        </div>
      </div>
      {work && plan != null && <section id="planEditorFields">
        <label htmlFor="editorPlanReason">调整原因（改期必填，首次排期可选）</label>
        <textarea id="editorPlanReason" key={session} maxLength={500} rows={2} />
        <EditorButton {...tips} icon="history" label="查看时间变更记录" onAction={() => onHistory(plan)} />
        <small>已结束的事情或事件，请先单独保存重开状态再改期。</small>
      </section>}
    </div>
    <div id="formError" className="error" role="alert">{error}</div>
    <div className="actions">
      {actions.map(({ id, label, icon, className, hidden, run }) => icon ?
        <EditorButton key={id} {...tips} id={id} icon={icon} label={label} className={className} hidden={hidden} onAction={run} /> :
        <button key={id} type="button" id={id} hidden={hidden} onClick={run}>{label}</button>)}
      <EditorButton {...tips} icon="cancel" label="取消" onAction={onCancel} />
      <EditorButton {...tips} icon="save" label="保存" className="primary" id="save" type="submit" disabled={busy} />
    </div>
  </>;
}
