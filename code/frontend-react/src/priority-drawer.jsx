import React from 'react';

const paths = {
  close: 'M6 6l12 12M18 6 6 18', check: 'm5 12 4 4L19 6',
  refresh: 'M3 11a9 9 0 1 1 2 7M3 4v7h7',
};

function Action({ label, icon, actions, onClick, primary = false }) {
  const show = event => actions.showTip(event.currentTarget);
  return <button type="button" className={primary ? 'primary iconButton' : 'iconButton'}
    aria-label={label} title={label} data-tip={label} data-iconified="true"
    onMouseEnter={show} onMouseLeave={actions.hideTip} onFocus={show} onBlur={actions.hideTip}
    onClick={() => { onClick(); actions.hideTip(); }}>
    <svg viewBox="0 0 24 24" aria-hidden="true"><path d={paths[icon]} /></svg>
  </button>;
}

export function PriorityDrawer({ name, value, error, retry, labels, actions }) {
  return <>
    <div className="drawerHead"><h2 id="priorityTitle">事情优先级</h2>
      <Action label="关闭" icon="close" actions={actions} onClick={actions.close} />
    </div>
    <p id="priorityName">{name}</p>
    <label htmlFor="priorityValue">优先级</label>
    <select id="priorityValue" value={value} onChange={event => actions.select(Number(event.currentTarget.value))}>
      {labels.map((label, index) => <option value={index} key={index}>{label}</option>)}
    </select>
    <p className="muted">每周一重新评估。保存调整不会自动完成本周评估。</p>
    <p id="priorityError" className="error" role="alert">{error}{retry &&
      <Action label="使用原操作标识重试保存" icon="refresh" actions={actions} onClick={actions.retry} />}</p>
    <div className="actions">
      <Action label="保存调整" icon="check" actions={actions} onClick={() => actions.submit(false)} />
      <Action label="保存并确认本周评估" icon="check" actions={actions} onClick={() => actions.submit(true)} primary />
      <Action label="核对保存结果" icon="check" actions={actions} onClick={actions.recover} />
      <Action label="刷新后核对" icon="refresh" actions={actions} onClick={actions.refresh} />
    </div>
  </>;
}
