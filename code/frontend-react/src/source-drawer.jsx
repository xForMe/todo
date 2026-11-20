import React from 'react';

const paths = {
  close: 'M6 6l12 12M18 6 6 18', reset: 'M3 11a9 9 0 1 1 2 7M3 4v7h7',
  add: 'M12 5v14M5 12h14', pause: 'M8 4v16M16 4v16', play: 'm6 3 15 9-15 9V3',
  unlink: 'M3 3l18 18M9 15l-3 3M15 9l3-3M3 14l-1 1a5 5 0 0 0 7 7l1-1M14 3l1-1a5 5 0 0 1 7 7l-1 1',
};

function SourceButton({ title, icon, actions, onClick, className = '', ...props }) {
  const show = event => actions.showTip(event.currentTarget);
  return <button type="button" {...props} className={`${className ? `${className} ` : ''}iconButton`}
    title={title} aria-label={title} data-tip={title} data-iconified="true"
    onMouseEnter={show} onFocus={show} onMouseLeave={actions.hideTip} onBlur={actions.hideTip}
    onClick={() => { onClick?.(); actions.hideTip(); }}>
    <svg viewBox="0 0 24 24" aria-hidden="true"><path d={paths[icon]} /></svg>
  </button>;
}

function SourceCard({ row, busy, actions }) {
  return <section className="sourceCard">
    <strong>{row.address}</strong>
    <p>{row.enabled ? '运行中' : '已暂停'} · {row.status}</p>
    <small>{row.stamp}</small>
    <div className="actions">
      <SourceButton actions={actions} title={row.enabled ? '暂停' : '恢复读取'} icon={row.enabled ? 'pause' : 'play'}
        disabled={busy} onClick={() => actions.change(row.id, !row.enabled, false)} />
      <SourceButton actions={actions} title="移除关联" icon="unlink" disabled={busy}
        onClick={() => actions.change(row.id, false, true)} />
    </div>
    <details><summary>查看读取内容（原文依据）</summary><pre>{row.content || '暂无读取结果'}</pre></details>
  </section>;
}

export function SourceDrawer({ model, actions }) {
  const { chat, context, session, interval, records, error, busy, saveDisabled } = model;
  const title = chat ? '设置 · 聊天来源' : '云文档与跟进依据';
  return <>
    <div className="drawerHead"><h2 id="sourceTitle">{title}</h2>
      <SourceButton actions={actions} title="关闭" icon="close" onClick={actions.close} />
    </div>
    <p id="sourceContext" hidden={chat}>{context}</p>
    <form id="sourceForm" onSubmit={event => { event.preventDefault(); actions.submit(); }}>
      <label htmlFor="sourceAddress" id="sourceAddressLabel">{chat ? '群聊会话 ID' : '飞书云文档链接'}</label>
      <input id="sourceAddress" key={`address:${session}`} required maxLength={2048}
        placeholder={chat ? 'oc_…' : 'https://…feishu.cn/wiki/…'} />
      <label htmlFor="sourceInterval">读取周期</label>
      <select id="sourceInterval" defaultValue={interval}>
        <option value="900">15 分钟</option><option value="1800">30 分钟</option><option value="3600">1 小时</option>
      </select>
      <label><input id="sourceConsent" key={`read:${session}`} type="checkbox" required /> 允许按以上范围周期读取（不包含外部发送）</label>
      <label><input id="aiConsent" key={`ai:${session}`} type="checkbox" /> 允许将此来源及范围内工作标题提交 UAIAPI，自动识别行动与进展</label>
      <p id="sourceError" role="alert" className="error">{error}</p>
      <div className="actions">
        <SourceButton actions={actions} title="刷新 / 核对结果" icon="reset" onClick={actions.refresh} />
        <SourceButton actions={actions} id="saveSource" type="submit" title="关联并启用读取" icon="add" className="primary" disabled={saveDisabled} />
      </div>
    </form>
    <div id="sourceList">{records.length ? records.map(row => <SourceCard key={row.id} row={row} busy={busy} actions={actions} />)
      : '当前上下文尚未关联来源'}</div>
  </>;
}
