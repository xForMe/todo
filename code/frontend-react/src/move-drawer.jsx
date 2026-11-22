import React from 'react';

const icons = {
  close: 'M6 6l12 12M18 6 6 18',
  refresh: 'M3 11a9 9 0 1 1 2 7M3 4v7h7',
  move: 'M4 5h8M4 5v14h8M10 12h11m-5-5 5 5-5 5',
  verify: 'm5 12 4 4L19 6',
};

function MoveButton({ id, label, icon, actions, onClick, className, ...props }) {
  const show = event => actions.showTip(event.currentTarget);
  return <button {...props} type="button" id={id} className={className ? `${className} iconButton` : 'iconButton'}
    aria-label={label} title={label} data-tip={label} data-iconified="true"
    onMouseEnter={show} onFocus={show} onMouseLeave={actions.hideTip} onBlur={actions.hideTip}
    onClick={() => { onClick(); actions.hideTip(); }}>
    <svg viewBox="0 0 24 24" aria-hidden="true"><path d={icons[icon]} /></svg>
  </button>;
}

function Destination({ id, label, value, rows, locked, onChange }) {
  return <>
    <label htmlFor={id}>{label}</label>
    <select id={id} value={value || ''} disabled={locked} onChange={event => onChange(event.currentTarget.value)}>
      {rows && <>
        <option value="">请选择{label}</option>
        {rows.map(row => <option value={row.id} key={row.id}>{row.name}</option>)}
      </>}
    </select>
  </>;
}

export function MoveDrawer({ model, actions }) {
  const { name, from, impact, error, goals, modules, things, goal, module, thing, busy, pending, preview } = model;
  const locked = busy || pending;
  return <>
    <div className="drawerHead"><h2 id="moveTitle">迁移事件</h2>
      <MoveButton id="closeMove" label="取消" icon="close" actions={actions} onClick={actions.close} disabled={busy} />
    </div>
    <h3 id="moveName">{name}</h3><p id="moveFrom" className="muted">{from}</p>
    <Destination id="moveGoal" label="目标" rows={goals} value={goal} locked={locked} onChange={actions.goal} />
    <Destination id="moveModule" label="模块" rows={modules} value={module} locked={locked} onChange={actions.module} />
    <Destination id="moveThing" label="事情" rows={things} value={thing} locked={locked} onChange={actions.thing} />
    <p id="moveImpact" className="sourceHint" aria-live="polite">{impact}</p>
    <p id="moveError" className="error" role="alert">{error}</p>
    <div className="actions">
      <MoveButton id="refreshMove" label="刷新影响范围" icon="refresh" actions={actions} onClick={actions.refresh} disabled={locked} />
      <MoveButton id="checkMove" label="核对迁移结果" icon="move" actions={actions} onClick={actions.check} disabled={busy} hidden={!pending} />
      <MoveButton id="retryMove" label="手动重试原迁移" icon="move" actions={actions} onClick={actions.retry} disabled={busy} hidden={!pending} />
      <MoveButton id="submitMove" label="确认迁移" icon="move" className="primary" actions={actions} onClick={actions.submit}
        disabled={locked || !preview} />
    </div>
  </>;
}
