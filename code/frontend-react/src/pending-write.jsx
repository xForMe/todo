import React from 'react';

const glyphs = { close: 'M6 6l12 12M18 6 6 18', refresh: 'M3 11a9 9 0 1 1 2.5 7M3 4v7h7', check: 'm5 12 4 4L19 6' };

function Action({ label, icon, onAction, actions, ...props }) {
  return <button type="button" className="iconButton" data-iconified="true" data-tip={label}
    aria-label={label} title={label} {...props}
    onMouseEnter={event => actions.showTip(event.currentTarget)} onFocus={event => actions.showTip(event.currentTarget)}
    onMouseLeave={actions.hideTip} onBlur={actions.hideTip} onClick={() => { actions.hideTip(); onAction(); }}>
    <svg viewBox="0 0 24 24" aria-hidden="true"><path d={glyphs[icon]} /></svg>
  </button>;
}

export function ConnectionTools({ actions }) {
  return <>
    <Action actions={actions} icon="refresh" label="刷新数据" onAction={actions.refresh} />
    <Action actions={actions} icon="check" label="核对待确认操作" onAction={actions.check} />
  </>;
}

export function PendingWrite({ model, actions }) {
  return <>
    <div className="drawerHead"><h2 id="pendingWriteTitle">核对待确认操作</h2>
      <Action id="pendingWriteClose" actions={actions} icon="close" label="关闭" onAction={actions.close} /></div>
    <p>尚未查到成功结果。可以保留操作标识继续核对；只有确认放弃后才允许重新提交。</p>
    <p id="pendingWriteError" className="error" role="alert" hidden={!model.error}>{model.error}</p>
    <div className="actions">
      <Action id="pendingWriteKeep" actions={actions} icon="check" label="保留并继续核对" onAction={actions.close} />
      <Action id="pendingWriteAbandon" actions={actions} icon="refresh" label="确认放弃并刷新"
        disabled={!model.canAbandon} onAction={actions.abandon} />
    </div>
  </>;
}
