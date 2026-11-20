import React, { useState } from 'react';

const paths = {
  close: 'M6 6l12 12M18 6 6 18',
  verify: 'm5 12 4 4L19 6',
  reload: 'M3 11a9 9 0 1 1 2 7M3 4v7h7',
};
const dateRange = (start, end) => `${start || '未设置'} → ${end || '未设置'}`;

function PlanButton({ label, icon, tips, onClick, type = 'button', className, ...props }) {
  const show = event => tips.show(event.currentTarget);
  return <button {...props} type={type} className={`${className ? `${className} ` : ''}iconButton`}
    aria-label={label} title={label} data-tip={label} data-iconified="true"
    onMouseEnter={show} onFocus={show} onMouseLeave={tips.hide} onBlur={tips.hide}
    onClick={() => { onClick?.(); tips.hide(); }}>
    <svg viewBox="0 0 24 24" aria-hidden="true"><path d={paths[icon]} /></svg>
  </button>;
}

function PlanHistory({ records, incomplete }) {
  return <details id="planRecords" open>
    <summary tabIndex={-1}>时间变更记录 · {records.length}</summary>
    {records.length ? records.map((record, index) => <article className="planRecord"
      key={record.operation_id || index}>
      <small>{record.displayTime} · {record.account}</small>
      <p>原：{dateRange(record.old_start, record.old_end)}</p>
      <p>现：{dateRange(record.new_start, record.new_end)}</p>
      <p>调整原因：{record.reason || '首次排期，未填写原因'}</p>
    </article>) : <p className="muted">暂无时间变更记录{incomplete ? '，此前历史无法还原' : ''}。</p>}
  </details>;
}

function PlanFields({ view, operation, actions, tips }) {
  const { item, baseline, records, typeLabel, statusLabel, ended } = view;
  const { busy, unknown, error } = operation;
  const [start, setStart] = useState(item.planStart || '');
  const [end, setEnd] = useState(item.planEnd || '');
  const changed = start !== (item.planStart || '') || end !== (item.planEnd || '');
  const baselineLabel = baseline.incomplete ? '开始记录时的计划（历史不完整）' : baseline.scheduled ? '初始计划' : '尚未排期';
  function submit(event) {
    event.preventDefault();
    if (ended || !changed || busy || unknown) return;
    actions.save(start, end, event.currentTarget.elements.namedItem('planReason').value.trim());
  }
  return <>
    <p>{typeLabel} · {statusLabel}</p>
    <h3>当前计划</h3><p>{dateRange(item.planStart, item.planEnd)}</p>
    <p className="muted">{baselineLabel}{baseline.scheduled && `：${dateRange(baseline.start, baseline.end)}`}</p>
    {ended && <p>已结束，请先通过状态编辑保存重开，再调整日期。</p>}
    <form id="planForm" onSubmit={submit}>
      <div className="fieldGrid">
        <label>计划开始<input id="newPlanStart" type="date" value={start} disabled={ended}
          onChange={event => setStart(event.currentTarget.value)} /></label>
        <label>计划结束<input id="newPlanEnd" type="date" value={end} disabled={ended}
          onChange={event => setEnd(event.currentTarget.value)} /></label>
      </div>
      <p id="planDiff" className="muted">{changed ? `调整为：${dateRange(start, end)}` : ''}</p>
      <label htmlFor="planReason">{baseline.scheduled ? '调整原因（必填）' : '首次排期原因（可选）'}</label>
      <textarea id="planReason" maxLength={500} rows={3} disabled={ended} required={baseline.scheduled} />
      <small>最多500字。仅调整当前项；如有催办，请检查旧日期文案并重新保存配置。</small>
      <p id="planError" className="error" role="alert">{error}</p>
      <div className="actions">
        <PlanButton id="planVerify" hidden={!unknown} label="核对保存结果" icon="verify" tips={tips} onClick={actions.verify} />
        <PlanButton label="取消" icon="close" tips={tips} onClick={actions.close} />
        <PlanButton id="planSave" type="submit" label="保存调整" className="primary" icon="verify"
          tips={tips} disabled={!changed || ended || busy || unknown} />
      </div>
    </form>
    <PlanHistory records={records} incomplete={baseline.incomplete} />
  </>;
}

export function PlanDrawer({ model, actions }) {
  const tips = { show: actions.showTip, hide: actions.hideTip };
  return <>
    <div className="drawerHead"><h2 id="planTitle">{model.view?.item.name || '延期变更'}</h2>
      <PlanButton label="关闭" icon="close" tips={tips} onClick={actions.close} />
    </div>
    <div id="planBody">
      {model.view ? <PlanFields key={model.session} view={model.view} operation={model} actions={actions} tips={tips} />
        : model.readError ? <>读取失败：{model.readError}<PlanButton label="重新读取" icon="reload" tips={tips} onClick={actions.reload} /></>
          : <p>正在读取最新计划…</p>}
    </div>
  </>;
}
