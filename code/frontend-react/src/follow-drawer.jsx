import React from 'react';

const icons = {
  close: 'M6 6l12 12M18 6 6 18', reset: 'M3 11a9 9 0 1 1 2 7M3 4v7h7',
  pause: 'M8 4v16M16 4v16', check: 'm5 12 4 4L19 6',
};

function FollowButton({ label, icon, actions, onClick, primary = false }) {
  const show = event => actions.showTip(event.currentTarget);
  return <button type="button" className={primary ? 'primary iconButton' : 'iconButton'}
    aria-label={label} title={label} data-tip={label} data-iconified="true"
    onMouseEnter={show} onFocus={show} onMouseLeave={actions.hideTip} onBlur={actions.hideTip}
    onClick={() => { onClick(); actions.hideTip(); }}>
    <svg viewBox="0 0 24 24" aria-hidden="true"><path d={icons[icon]} /></svg>
  </button>;
}

export function FollowDrawer({ model, actions }) {
  const { context, disabled, query, recipient, people, hint, at, cap, content, error, logs } = model;
  return <>
    <div className="drawerHead"><h2 id="followTitle">自动催办</h2>
      <FollowButton label="关闭" icon="close" actions={actions} onClick={actions.close} />
    </div>
    <p id="followContext">{context}</p>
    <p className="sourceHint">飞书 CLI 应用向责任人私聊发送。次日北京时间开始，每个自然日最多一次；后台进程关闭时不运行。事件变化或结果未知时暂停。</p>
    <label htmlFor="followPersonQuery">责任人姓名</label>
    <input id="followPersonQuery" placeholder="输入姓名或企业邮箱" maxLength={50} autoComplete="off"
      value={query} disabled={disabled} onChange={event => actions.query(event.currentTarget.value)}
      onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); actions.search(); } }} />
    <button type="button" id="followSearch" data-iconified="true" aria-label="查询人员" disabled={disabled} onClick={actions.search}>
      <svg className="icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="10" cy="10" r="4" /><path d="m15 15 5 5" /></svg>查询人员
    </button>
    <label htmlFor="followRecipient">选择负责人</label>
    <select id="followRecipient" value={recipient} onChange={event => actions.recipient(event.currentTarget.value)}>
      <option value="">请先查询并选择人员</option>
      {people.map(person => <option value={person.id} key={person.id}>{person.label}</option>)}
    </select>
    <p id="followPeopleHint" className="muted" role="status">{hint}</p>
    <label htmlFor="followAt">到期次日首次发送时间（北京时间）</label>
    <input id="followAt" type="time" value={at} onChange={event => actions.input('at', event.currentTarget.value)} />
    <label htmlFor="followCap">累计发送上限</label>
    <input id="followCap" type="number" min={1} max={10} value={cap} onChange={event => actions.input('cap', event.currentTarget.value)} />
    <label htmlFor="followContent">发送内容</label>
    <textarea id="followContent" maxLength={2000} rows={10} value={content} onChange={event => actions.input('content', event.currentTarget.value)} />
    <FollowButton label="按当前上下文重新整理" icon="reset" actions={actions} onClick={actions.regenerate} />
    <p id="followError" className="error" role="alert">{error}</p>
    <div className="actions">
      <FollowButton label="暂停" icon="pause" actions={actions} onClick={() => actions.save(false)} />
      <FollowButton label="保存催办配置" icon="check" actions={actions} onClick={() => actions.save(true)} primary />
    </div>
    <h3>发送记录</h3>
    <div id="followLogs">{Array.isArray(logs) ? logs.map((text, index) => <p key={index}>{text}</p>) : logs}</div>
  </>;
}
