import React, { useRef } from 'react';
import { WorkbenchIcon } from './workbench-icons.jsx';
import { EventPredecessors } from './event-predecessors.jsx';

const actionPaths = {
  trash: 'M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7',
  split: 'M12 3v6M5 17v-4h14v4M12 9v4M2 17h6v4H2zM16 17h6v4h-6z',
  follow: 'M4 5v9h14m-5-5 5 5-5 5',
  move: 'M4 5h8M4 5v14h8M10 12h11m-5-5 5 5-5 5',
  reset: 'M3 11a9 9 0 1 1 2 7M3 4v7h7',
  check: 'm5 12 4 4L19 6',
  close: 'M6 6l12 12M18 6 6 18',
};

// Render the same markup that the legacy icon enhancer adds outside React hosts.
function EventAction({ actions, icon, label, onAction, className, type = 'button', ...props }) {
  const show = event => actions.showTip(event.currentTarget);
  const hide = () => actions.hideTip();
  return <button {...props} type={type} className={className ? `${className} iconButton` : 'iconButton'}
    aria-label={label} title={label} data-tip={label} data-iconified="true"
    onMouseEnter={show} onFocus={show} onMouseLeave={hide} onBlur={hide}
    onClick={() => { hide(); onAction?.(); }}>
    <svg viewBox="0 0 24 24" aria-hidden="true"><path d={actionPaths[icon]} /></svg>
  </button>;
}

export function EventDrawerHeader({ model, actions }) {
  return <><h2 id="eventTitle">{model.title}</h2>
    {model.imageId && <button type="button" className="imageIcon eventImagesEntry" title="事件图片" aria-label="事件图片"
      disabled={model.busy} onClick={() => actions.images(model.imageId)}>
      <svg className="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 3h18v18H3ZM3 20l12-12 6 6M7 7h.01" /></svg>
    </button>}
    <EventAction actions={actions} icon="close" label="关闭" onAction={actions.close} disabled={model.busy} />
  </>;
}

export function EventDrawerFeedback({ model, actions }) {
  return <><p id="eventError" className="error" role="alert">{model.error}</p>
    <div id="eventRecovery" hidden={!model.pending}>
      <EventAction actions={actions} icon="check" label="核对操作结果" onAction={actions.recover} disabled={model.busy} />{' '}
      <EventAction actions={actions} icon="reset" label="手动重试原操作" onAction={actions.retry} hidden={!model.canRetry} disabled={model.busy} />
    </div>
  </>;
}

function EventDetail({ event, parentName, session, predecessors, actions }) {
  const { id, status, statusLabel, owner, start, end, active } = event;
  return <>
    <div className="meta">
      <span className={`status ${status}`}>{statusLabel}</span>
      <span>责任人 · {owner || '未指定'}</span>
      <span>计划开始 · {start?.slice(0, 10) || '未设置'}</span>
      <span>计划结束 · {end?.slice(0, 10) || '未设置'}</span>
    </div>
    {parentName != null && <p>父事件：{parentName}</p>}
    <div className="eventDetailShortcuts" role="group" aria-label="事件操作">
      {active && <button type="button" data-event-shortcut="follow" title="当日跟进" aria-label="当日跟进"
        onClick={() => actions.daily(id)}><WorkbenchIcon name="dailyDone" />当日跟进</button>}
      <button type="button" data-event-shortcut="plan" title="延期变更" onClick={() => actions.plan(id)}>延期变更</button>
      <button type="button" data-event-shortcut="edit" onClick={() => actions.edit(id)}>编辑事件</button>
    </div>
    <div className="actions">
      <EventAction actions={actions} icon="trash" label="删除事件" className="danger" onAction={() => actions.remove(id)} />
      <EventAction actions={actions} icon="split" label="拆分" onAction={() => actions.openEvent(id, 'split')} />
      <EventAction actions={actions} icon="follow" label="新建后续跟进" onAction={() => actions.openEvent(id, 'followup')} />
      <EventAction actions={actions} icon="move" label="迁移事件" id="eventMoveEntry" onAction={() => actions.move(id)} />
    </div>
    <div id="eventDependencies" key={session}>
      {predecessors && <EventPredecessors model={predecessors} />}
    </div>
  </>;
}

function ChildForm({ followup = false, actions }) {
  function submit(event) {
    event.preventDefault();
    const fields = event.currentTarget.elements;
    actions.submitChildren([{
      name: fields.namedItem('childName').value,
      description: fields.namedItem('childDescription').value,
      owner: fields.namedItem('childOwner').value,
      planStart: fields.namedItem('childStart').value,
      planEnd: fields.namedItem('childEnd').value,
    }], followup ? 'followup' : 'children');
  }

  return <form id="childForm" onSubmit={submit}>
    <h3>{followup ? '手动创建跟进' : '手动添加子事件'}</h3>
    <label>事件名称<input id="childName" maxLength={120} required /></label>
    <label>说明<textarea id="childDescription" maxLength={10000} /></label>
    <div className="fieldGrid">
      <label>责任人<input id="childOwner" maxLength={80} /></label>
      <label>开始日期<input id="childStart" type="date" /></label>
      <label>结束日期<input id="childEnd" type="date" /></label>
    </div>
    <div className="actions">
      <EventAction actions={actions} icon="check" label="确认创建" className="primary" type="submit" />
    </div>
  </form>;
}

function SplitCandidate({ proposal, index }) {
  return <article className="splitCandidate sourceCard">
    <label><input className="splitPick" type="checkbox" defaultChecked /> 采用建议 {index + 1}</label>
    <label>子事件名称<input className="splitName" maxLength={120} defaultValue={proposal.name} /></label>
    <label>说明<textarea className="splitDescription" maxLength={10000} defaultValue={proposal.description} /></label>
    <p className="muted">建议理由：{proposal.reason}</p>
    <div className="fieldGrid">
      <label>责任人<input className="splitOwner" maxLength={80} placeholder="待指定" /></label>
      <label>开始日期<input className="splitStart" type="date" /></label>
      <label>结束日期<input className="splitEnd" type="date" /></label>
    </div>
  </article>;
}

function SplitSuggestions({ session, generation, split, actions }) {
  const candidates = useRef(null);
  function accept() {
    const rows = [...candidates.current.querySelectorAll('.splitCandidate')]
      .filter(card => card.querySelector('.splitPick').checked)
      .map(card => ({
        name: card.querySelector('.splitName').value,
        description: card.querySelector('.splitDescription').value,
        owner: card.querySelector('.splitOwner').value,
        planStart: card.querySelector('.splitStart').value,
        planEnd: card.querySelector('.splitEnd').value,
      }));
    actions.submitChildren(rows, 'children');
  }

  const { loading, message, proposals } = split;
  return <section className="sourceCard">
    <h3>AI 拆分建议</h3>
    <p>建议可编辑，确认前不会创建子事件或影响进度。</p>
    <p className="muted">打开后自动结合当前事件与已有子事件生成建议。</p>
    <div id="splitCandidates" aria-live="polite" ref={candidates}>
      {loading ? (message || '正在自动生成拆分建议…') : proposals.length > 0 ? (
        <React.Fragment key={generation}>
          {proposals.map((proposal, index) => <SplitCandidate key={index} proposal={proposal} index={index} />)}
          <div className="actions">
            <EventAction actions={actions} icon="check" label="确认创建所选子事件" className="primary" onAction={accept} />
          </div>
        </React.Fragment>
      ) : message}
    </div>
    <details key={session}>
      <summary>补充要求（可选）</summary>
      <label>补充要求<textarea id="splitInstructions" maxLength={2000} placeholder="需要调整建议时再补充" /></label>
    </details>
    <div className="actions">
      <EventAction actions={actions} icon="reset" label="重新生成建议" id="generateSplit"
        disabled={loading} onAction={() => actions.generate(true)} />
    </div>
  </section>;
}

export function EventDrawerContent({ model, actions }) {
  const { session, mode, event, matterName, parentName, generation, split, predecessors } = model;
  if (model.loading || !event) return '正在加载…';

  const detail = mode === 'detail';
  const canSplit = event.status !== 'completed' && event.status !== 'cancelled';
  return <>
    <h3>{event.name}</h3>
    {event.description && <p>{event.description}</p>}
    <p className="muted">{!detail && `${event.statusLabel} · `}所属事情：{matterName}</p>
    {detail && <EventDetail event={event} parentName={parentName} session={session}
      predecessors={predecessors} actions={actions} />}
    {mode === 'followup' && <ChildForm key={session} followup actions={actions} />}
    {mode === 'split' && (canSplit ? <>
      <SplitSuggestions session={session} generation={generation} split={split} actions={actions} />
      <details key={session}>
        <summary>手动添加子事件</summary>
        <ChildForm actions={actions} />
      </details>
    </> : <p className="error">请先通过编辑手动重开当前事件，再拆分。</p>)}
  </>;
}
