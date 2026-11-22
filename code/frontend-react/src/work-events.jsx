import React from 'react';
import { WorkbenchIcon as Icon } from './workbench-icons.jsx';

const actionPaths = {
  add: 'M12 5v14M5 12h14',
  ai: 'm12 3 3 6 6 3-6 3-3 6-3-6-6-3 6-3z',
  detail: 'M5 3h14v18H5zM8 8h8M8 12h8M8 16h5',
  document: 'M5 3h9l5 5v13H5zM14 3v5h5M8 12h8M8 16h8',
  edit: 'm16 3 5 5-12 12-6 1 1-6L16 3Zm-3 3 5 5',
  split: 'M12 3v6M5 17v-4h14v4M12 9v4M2 17h6v4H2zM16 17h6v4h-6z',
  trash: 'M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7',
};

function PathIcon({ path, className = 'icon' }) {
  return <svg className={className} viewBox="0 0 24 24" aria-hidden="true"><path d={path} /></svg>;
}

function TippedButton({ actions, onAction, tip, children, ...props }) {
  const show = event => actions.showTip(event.currentTarget);
  const hide = () => actions.hideTip();
  return <button {...props} data-tip={tip} onMouseEnter={show} onFocus={show}
    onMouseLeave={hide} onBlur={hide} onClick={() => { onAction(); hide(); }}>{children}</button>;
}

function ActionButton({ actions, icon, label, onAction, className, ...props }) {
  return <TippedButton {...props} actions={actions} onAction={onAction} tip={label} type="button"
    className={className ? `${className} iconButton` : 'iconButton'} data-iconified="true"
    aria-label={label} title={label}>
    <svg viewBox="0 0 24 24" aria-hidden="true"><path d={actionPaths[icon]} /></svg>
  </TippedButton>;
}

function ImageButton({ id, label, actions }) {
  return <button type="button" className="imageIcon eventImagesEntry" title={label} aria-label={label}
    onClick={() => actions.images(id)}><PathIcon path="M3 3h18v18H3ZM3 20l12-12 6 6M7 7h.01" /></button>;
}

function HistoryMark({ id, count, actions }) {
  if (!(count > 0)) return null;
  return <button type="button" className="planMark" data-plan={id} title={`${count} 条时间变更记录`}
    aria-label={`查看 ${count} 条时间变更记录`} onClick={() => actions.plan(id, true)}>
    <Icon name="history" /><span>{count}</span>
  </button>;
}

function Status({ item }) {
  return <span className={`status ${item.status}`}>{item.statusLabel}</span>;
}

function PanelHeading({ children }) {
  return <h2><i><PathIcon path="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" /></i>{' '}{children}</h2>;
}

function ThingDetails({ thing, actions, watchDisabled }) {
  const { id, name, description, owner, start, end, history, watched } = thing;
  const watchLabel = watched ? '取消持续关注' : '持续关注';
  return <>
    <div className="panelHead">
      <PanelHeading>当前事情</PanelHeading>
      <div className="imageTools">
        <ImageButton id={id} label="事情图片" actions={actions} />
        <ActionButton actions={actions} icon="detail" label="关联云文档" onAction={() => actions.sources(id)} />
      </div>
    </div>
    <div className="detail">
      <div className="detailTitle">
        <div><h1>{name}</h1><HistoryMark id={id} count={history} actions={actions} />{description && <p>{description}</p>}</div>
        <ActionButton actions={actions} className="danger" icon="trash" label="删除事情" onAction={() => actions.delete(id)} />
        <ActionButton actions={actions} icon="edit" label="编辑事情" onAction={() => actions.openForm('thing', id)} />
        <span className="wbWatchSlot">
          <button type="button" className={watched ? 'wbWatch isWatched' : 'wbWatch'} title={watchLabel}
            aria-label={`${watchLabel}：${name}`} aria-pressed={watched} disabled={watchDisabled}
            onClick={() => actions.attention(id, !watched)}>
            <PathIcon path="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-2.9-5.6 2.9 1.1-6.2L3 9.6l6.2-.9L12 3Z" />
          </button>
        </span>
      </div>
      <div className="facts">
        <div><label><Icon name="calendar" />　计划开始日期</label><strong>{start}</strong></div>
        <div><label><Icon name="calendar" />　计划结束日期</label><strong>{end}</strong></div>
        <div><label><svg className="icon" viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="12" cy="8" r="4" /><path d="M4 21v-2a8 8 0 0 1 16 0v2" />
        </svg>　责任人</label><strong>{owner || '未指定'}</strong></div>
        <div><label><svg className="icon" viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="12" cy="12" r="9" /><circle cx="12" cy="12" r="4" />
        </svg>　状态</label><Status item={thing} /></div>
      </div>
    </div>
  </>;
}

function WaitingBadge({ name, reasons }) {
  if (!reasons.length) return null;
  // The existing document delegate opens the popover and updates the ARIA attributes.
  return <button type="button" className="dependencyWait" aria-label={`${name}：等待，查看原因`}
    data-wait-reasons={JSON.stringify(reasons)} aria-expanded="false">
    <svg className="icon" viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="8" /><path d="M12 7v5l3 2" />
    </svg>等待
  </button>;
}

function EventActions({ event, structured, actions }) {
  const { id, name, active, hasPredecessors, followTitle } = event;
  const quiet = structured ? undefined : 'quiet';
  const reminderTitle = followTitle || '自动催办';
  return <div className="eventActions">
    {structured && <>
      <ActionButton actions={actions} icon="split" label="拆分" onAction={() => actions.event(id, 'split')} />
      <ActionButton actions={actions} icon="detail" label="详情" onAction={() => actions.event(id)} />
    </>}
    <ActionButton actions={actions} className={quiet} icon="edit" label={structured ? '编辑事件' : '编辑'}
      onAction={() => actions.openForm('event', id)} />
    {structured && <>
      {active && <button type="button" className="dailyIcon dailyMark" data-daily-row={id} title="当日跟进"
        aria-label={`当日跟进：${name}`} onClick={() => actions.daily(id)}><Icon name="dailyDone" /></button>}
      <button type="button" className="planDelay" title="延期变更" aria-label={`延期变更：${name}`}
        onClick={() => actions.plan(id)}><Icon name="calendar" /></button>
      {(active || hasPredecessors) && <button type="button" className="dependencyShortcut" title="前置事件"
        aria-label="前置事件" data-dependency-event={id} data-dependency-settings=""><Icon name="link" /></button>}
      <ActionButton actions={actions} className="danger" icon="trash" label="删除事件" onAction={() => actions.delete(id)} />
    </>}
    <ActionButton actions={actions} className={quiet} icon="document" label="云文档" onAction={() => actions.sources(id)} />
    <TippedButton actions={actions} onAction={() => actions.follow(id)} tip={reminderTitle} type="button"
      className={structured ? 'followBell' : 'quiet followBell'} data-event={id}
      title={reminderTitle} aria-label="自动催办">
      <PathIcon path="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4" />
    </TippedButton>
    <ImageButton id={id} label={`事件图片：${name}`} actions={actions} />
  </div>;
}

function EventRow({ event, structured, actions }) {
  const { id, name, description, owner, start, end, status, history, depth, children, valid, done, waitReasons } = event;
  const completed = status === 'completed';
  const toggleLabel = `${completed ? '撤销完成' : '完成'}：${name}`;
  return <tr>
    <td><div className="eventName" style={structured ? { paddingLeft: Math.min(depth, 5) * 16 } : undefined}>
      <TippedButton actions={actions} onAction={() => actions.toggle(id)} tip={toggleLabel} type="button"
        className="check" aria-label={toggleLabel} disabled={status === 'cancelled'}>
        <PathIcon path={completed ? 'm5 12 4 4L19 6' : 'M5 5h14v14H5z'} />
      </TippedButton>
      {structured ? <div>
        <div className="eventTitleWrap" data-event={id}>
          <button type="button" className="eventTitle" onClick={() => actions.event(id)}>{name}</button>
          <HistoryMark id={id} count={history} actions={actions} />
          <WaitingBadge name={name} reasons={waitReasons} />
        </div>
        {depth > 0 && <small>第 {depth + 1} 层</small>}
        {children > 0 && <small>子级完成 {done}/{valid}{valid > 0 && done === valid && !completed ? ' · 父事件待确认' : ''}</small>}
      </div> : <div>{name}{description && <small>{description}</small>}</div>}
    </div></td>
    <td>{start}</td><td>{end}</td><td>{owner || '未指定'}</td><td><Status item={event} /></td>
    <td><EventActions event={event} structured={structured} actions={actions} /></td>
  </tr>;
}

export function WorkEvents({ thing, events, summary, pendingCount, structured, watchDisabled, actions }) {
  if (!thing) return <div className="empty"><b>未选择事情</b></div>;
  return <>
    <ThingDetails thing={thing} actions={actions} watchDisabled={watchDisabled} />
    <div className="panelHead">
      <PanelHeading>事件清单 <small>{pendingCount} 待完成</small></PanelHeading>
      <div className="matterPlanningActions" role="group" aria-label="事件操作">
        <ActionButton actions={actions} className="primary" icon="add" label="＋ 新建事件" onAction={() => actions.openForm('event')} />
        <ActionButton actions={actions} id="matterPlanningEntry" className="primary" icon="ai" label="智能拆解"
          disabled={!thing.active} onAction={() => actions.decompose(thing.id)} />
      </div>
    </div>
    <div className="progressSummary">{summary.text ?? <>
      事件完成率 <strong>{summary.rate}</strong> · 已完成 {summary.done} / 有效 {summary.valid} · 取消 {summary.cancelled}
    </>}</div>
    <div className="tableWrap">{events.length ? <table>
      <thead><tr><th>事件名称</th><th>计划开始日期</th><th>计划结束日期</th><th>责任人</th><th>状态</th><th>操作</th></tr></thead>
      <tbody>{events.map(event => <EventRow key={event.id} event={event} structured={structured} actions={actions} />)}</tbody>
    </table> : <div className="empty"><b>暂无事件</b></div>}</div>
  </>;
}
