import React from 'react';

export function DeleteDrawer({ model, actions }) {
  const { title, name, impact, hint, error, options, target, destination, requiresTarget,
    busy, uncertain, submitDisabled, submitLabel } = model;
  return <>
    <h2 id="deleteTitle">{title}</h2>
    <p id="deleteName" className="deleteName">{name}</p>
    <p id="deleteImpact" className="sourceHint" aria-live="polite">{impact}</p>
    <div id="deleteTargetGroup" hidden={!requiresTarget}>
      <label htmlFor="deleteTarget">将全部内容换绑到</label>
      <select id="deleteTarget" value={target} disabled={busy || uncertain}
        onChange={event => actions.select(event.currentTarget.value)}>
        <option value="">请选择接收位置</option>
        {options.map(option => <option value={option.id} key={option.id}>{option.label}</option>)}
      </select>
      <p id="deleteDestination" className="muted">{destination}</p>
    </div>
    <p id="deleteHint">{hint}</p>
    <p id="deleteError" className="error" role="alert">{error}</p>
    <div className="actions">
      <button id="reloadDelete" type="button" hidden={!error || uncertain} disabled={busy || uncertain} onClick={actions.reload}>刷新影响范围</button>
      <button id="checkDelete" type="button" hidden={!uncertain} disabled={busy} onClick={actions.check}>核对删除结果</button>
      <button id="closeDelete" type="button" disabled={busy} onClick={actions.close}>取消</button>
      <button id="submitDelete" className="danger" type="button" disabled={submitDisabled} onClick={actions.submit}>{submitLabel}</button>
    </div>
  </>;
}
