import React from 'react';
import { WorkbenchIcon as Icon } from './workbench-icons.jsx';

const actionPaths = {
  add: 'M12 5v14M5 12h14',
  edit: 'm16 3 5 5-12 12-6 1 1-6L16 3Zm-3 3 5 5',
};
const emptyNames = { thing: '事情', module: '模块', goal: '目标' };

function ActionButton({ icon, label, onAction, onShowTip, onHideTip, className, ...props }) {
  const show = event => onShowTip(event.currentTarget);
  const hide = () => onHideTip();
  return <button {...props} type="button" className={className ? `${className} iconButton` : 'iconButton'}
    aria-label={label} title={label} data-tip={label} data-iconified="true"
    onMouseEnter={show} onFocus={show} onMouseLeave={hide} onBlur={hide}
    onClick={() => { onAction(); hide(); }}>
    <svg viewBox="0 0 24 24" aria-hidden="true"><path d={actionPaths[icon]} /></svg>
  </button>;
}

export function Breadcrumb({ text }) {
  return text;
}

// Stable radio nodes preserve native arrow-key focus. If a refresh changes the selected
// module while focus is in the group, move focus to the new selection (or the goal select).
class ModuleChoices extends React.Component {
  choices = React.createRef();

  getSnapshotBeforeUpdate() {
    const group = this.choices.current;
    return group.contains(group.ownerDocument.activeElement);
  }

  componentDidUpdate(_previousProps, _previousState, hadFocus) {
    if (!hadFocus) return;
    const group = this.choices.current;
    const target = group.querySelector(':checked') || this.props.goalSelect.current;
    if (target && target !== group.ownerDocument.activeElement) target.focus({ preventScroll: true });
  }

  render() {
    const { modules, goalId, moduleId, onSelect } = this.props;
    return <div className="moduleChoices" id="moduleChoices" role="group" aria-label="模块" ref={this.choices}>
      {modules.length ? modules.map(({ id, name }) => <label className="moduleChoice" key={id}>
        <input type="radio" name="workspaceModule" value={id} checked={moduleId === id}
          onChange={() => onSelect('module', id)} />
        <span>{name}</span>
      </label>) : <span className="muted">{goalId ? '暂无模块' : '请先选择目标'}</span>}
    </div>;
  }
}

export function WorkToolbar({ goals, modules, goalId, moduleId, onSelect, onOpen, onShowTip, onHideTip }) {
  const tips = { onShowTip, onHideTip };
  const goalSelect = React.useRef(null);
  return <>
    <div className="toolbarGoal">
      <label htmlFor="goalSelect">目标</label>
      <select id="goalSelect" ref={goalSelect} value={goalId} onChange={event => onSelect('goal', event.currentTarget.value)}>
        <option value="" disabled>请选择目标</option>
        {goals.map(({ id, name }) => <option key={id} value={id}>{name}</option>)}
      </select>
      <ActionButton {...tips} id="editGoal" className="quiet" icon="edit" label="编辑当前目标"
        disabled={!goalId} onAction={() => onOpen('goal', goalId)} />
    </div>
    <div className="toolbarModules">
      <ModuleChoices modules={modules} goalId={goalId} moduleId={moduleId} onSelect={onSelect} goalSelect={goalSelect} />
      <ActionButton {...tips} id="editModule" className="quiet" icon="edit" label="编辑当前模块"
        disabled={!moduleId} onAction={() => onOpen('module', moduleId)} />
    </div>
    <div className="toolbarActions" role="group" aria-label="新增目标或模块">
      <ActionButton {...tips} className="primary" icon="add" label="＋ 新建目标" onAction={() => onOpen('goal')} />
      <ActionButton {...tips} id="newModule" icon="add" label="＋ 新建模块"
        disabled={!goalId} onAction={() => onOpen('module')} />
    </div>
  </>;
}

function ThingRow({ row, watchDisabled, onSelect, onPriority, onAttention }) {
  const { id, name, description, owner, start, end, status, statusLabel, selected,
    priorityLabel, priorityDisabled, assessment, watched, hidden } = row;
  const watchLabel = watched ? '取消持续关注' : '持续关注';
  return <>
    <div className="priorityTags" hidden={hidden}>
      <button type="button" className="priorityLabel" disabled={priorityDisabled}
        onClick={() => onPriority(id)}>{priorityLabel}</button>
      {assessment && <span className="muted">{assessment}</span>}
      <span className="wbWatchSlot">
        <button type="button" className={watched ? 'wbWatch isWatched' : 'wbWatch'} title={watchLabel}
          aria-label={`${watchLabel}：${name}`} aria-pressed={watched} disabled={watchDisabled}
          onClick={() => onAttention(id, !watched)}><Icon name="watch" /></button>
      </span>
    </div>
    <button type="button" className={selected ? 'thing active' : 'thing'} hidden={hidden}
      onClick={() => onSelect('thing', id)}>
      <div className="cardTitle"><strong>{name}</strong><span className={`status ${status}`}>{statusLabel}</span></div>
      {description && <p>{description}</p>}
      <div className="cardMeta">
        <span><svg className="icon" viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="12" cy="8" r="4" /><path d="M4 21v-2a8 8 0 0 1 16 0v2" />
        </svg>　责任人</span><b>{owner}</b>
        <span><Icon name="calendar" />　计划开始</span><b>{start}</b>
        <span><Icon name="calendar" />　计划结束</span><b>{end}</b>
      </div>
    </button>
  </>;
}

export function WorkThings({ rows, emptyType, canAddThing, priorityAvailable, dueOnly, watchedOnly, watchError,
  watchDisabled, onDueOnly, onWatchedOnly, onSelect, onOpen, onPriority, onAttention, onShowTip, onHideTip }) {
  const tips = { onShowTip, onHideTip };
  const emptyName = emptyNames[emptyType];
  return <>
    <div className="panelHead">
      <h2><i><svg className="icon" viewBox="0 0 24 24" aria-hidden="true">
        <path d="m12 3 10 6-10 6L2 9l10-6Zm-10 12 10 6 10-6M2 12l10 6 10-6" />
      </svg></i> 事情 <small id="thingCount">{rows.length}</small></h2>
      <ActionButton {...tips} id="addThing" icon="add" label="＋ 新建事情"
        disabled={!canAddThing} onAction={() => onOpen('thing')} />
    </div>
    <div id="priorityNotice">
      {!priorityAvailable && '优先级读取失败，请刷新页面重试'}
      <label><input type="checkbox" checked={dueOnly}
        onChange={event => onDueOnly(event.currentTarget.checked)} /> 仅本周待评估</label>
      <label id="wbOnlyLabel"><input type="checkbox" checked={watchedOnly}
        onChange={event => onWatchedOnly(event.currentTarget.checked)} /> {`仅关注${watchError ? '（关注读取失败）' : ''}`}</label>
    </div>
    <div id="things">
      {emptyName ? <div className="empty">
        <b>暂无{emptyName}</b>
        <ActionButton {...tips} className="primary" icon="add" label={`新建${emptyName}`}
          onAction={() => onOpen(emptyType)} />
      </div> : rows.map(row => <ThingRow key={row.id} row={row} watchDisabled={watchDisabled}
        onSelect={onSelect} onPriority={onPriority} onAttention={onAttention} />)}
    </div>
  </>;
}
