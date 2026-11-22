import React from 'react';

const paths = {
  brand:'M5 5v14h14M10 5v9h9M15 5v4h4',
  settings:'M12 2v2m0 16v2M2 12h2m16 0h2',
  person:'M4 21v-2a8 8 0 0 1 16 0v2',
  recognition:'M18 8a6 6 0 0 0-12 0c0 5-3 7-3 9h18c0-2-3-4-3-9M10 21h4',
  move:'M4 5h8M4 5v14h8M10 12h11m-5-5 5 5-5 5',
  trash:'M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7',
};
function Icon({ name, inline=false }) {
  return <svg className={inline?'icon':undefined} viewBox="0 0 24 24" aria-hidden="true">
    {name==='grid' && <><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/>
      <rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></>}
    {(name==='target'||name==='settings') && <><circle cx="12" cy="12" r={name==='target'?9:8}/><circle cx="12" cy="12" r="4"/></>}
    {name==='person' && <circle cx="12" cy="8" r="4"/>}
    {paths[name] && <path d={paths[name]}/>}
  </svg>;
}

export function WorkspaceNavigation({ view, navigate, settings }) {
  return <>
    <div className="brand"><span className="brandMark"><Icon name="brand" inline/></span><div><strong>行间</strong><small>目标与行动</small></div></div>
    <p className="navCaption">工作空间</p>
    <nav className="navGroup" aria-label="主导航">
      <button type="button" id="workbenchHomeNav" data-workbench-view="home" title="查看全部目标的行动与关注"
        className={view==='home'?'active':undefined} aria-current={view==='home'?'page':undefined}
        onClick={()=>navigate('home')}><Icon name="grid" inline/> 工作台</button>
      <button type="button" id="workbenchWorkNav" data-workbench-view="work"
        className={view==='work'?'active':undefined} aria-current={view==='work'?'page':undefined}
        onClick={()=>navigate('work')}><Icon name="target" inline/> 目标与事情</button>
    </nav>
    <div className="sidebarBottom">
      <nav className="navGroup" aria-label="系统导航"><button type="button" id="workspaceSettings" title="设置" onClick={settings}><Icon name="settings" inline/> 设置</button></nav>
      <div className="workspaceIdentity"><Icon name="person" inline/><div><strong>个人工作空间</strong></div></div>
    </div>
  </>;
}

function Entry({ entry, showTip, hideTip }) {
  const { id, kind, status, label, count, error, pending, expanded, hidden, icon, onClick }=entry;
  if (kind==='recognition') return <button type="button" id={id}
    className={`eventRecognitionTrigger${pending?' hasPending':''}${error?' hasError':''}`}
    aria-haspopup="dialog" aria-controls="eventRecognitionDrawer" aria-expanded={expanded}
    aria-label={`事件识别，${status}`} title={`事件识别通知 · ${status}`} data-count={count} onClick={onClick}>
    <span className="recognitionLabel"><Icon name="recognition" inline/>事件识别</span><span id="eventRecognitionStatus" className="recognitionStatus">{status}</span>
  </button>;
  if (kind==='icon') return <button type="button" id={id} className="iconButton" data-iconified="true"
    hidden={hidden} aria-label={label} title={label} data-tip={label}
    onMouseEnter={event=>showTip(event.currentTarget)} onMouseLeave={hideTip} onFocus={event=>showTip(event.currentTarget)}
    onBlur={hideTip} onClick={()=>{hideTip();onClick()}}><Icon name={icon}/></button>;
  return <button type="button" id={id} hidden={hidden} onClick={onClick}>{label}</button>;
}
export function WorkspaceBar({ date, entries, showTip, hideTip }) {
  const row=entry=><Entry key={entry.id} entry={entry} showTip={showTip} hideTip={hideTip}/>;
  return <>
    <span><Icon name="grid" inline/> 个人工作空间 <span aria-hidden="true">/</span> 目标与行动</span>
    {entries.filter(entry=>entry.beforeDate).map(row)}
    <span id="workspaceDate">{date}</span>
    {entries.filter(entry=>!entry.beforeDate).map(row)}
  </>;
}
