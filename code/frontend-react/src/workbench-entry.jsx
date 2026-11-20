import React from 'react';
import { createRoot } from 'react-dom/client';
import { createPortal, flushSync } from 'react-dom';
import { WorkbenchIcon as Icon } from './workbench-icons.jsx';
import { WorkbenchPanels } from './workbench-panels.jsx';
import { Breadcrumb, WorkToolbar, WorkThings } from './work-selection.jsx';
import { WorkEvents } from './work-events.jsx';
import { WorkEditor } from './work-editor.jsx';
import { EventDrawerContent, EventDrawerFeedback, EventDrawerHeader } from './event-drawer.jsx';
import { PlanDrawer } from './plan-drawer.jsx';
import { DailyDrawer } from './daily-drawer.jsx';
import { PriorityDrawer } from './priority-drawer.jsx';
import { MoveDrawer } from './move-drawer.jsx';
import { DeleteDrawer } from './delete-drawer.jsx';
import { SourceDrawer } from './source-drawer.jsx';
import { FollowDrawer } from './follow-drawer.jsx';
import { RecognitionDrawer } from './recognition-drawer.jsx';
import { SuggestionDrawer } from './suggestion-drawer.jsx';
import { ImageDrawer, ImageViewer } from './image-drawer.jsx';
import { InlineImages } from './inline-images.jsx';
import { ImageStorage } from './image-storage.jsx';
import { ModelCatalog } from './model-catalog.jsx';
import { MatterPlanningTools, MatterPlanningSplit, MatterPlanningFooter } from './matter-planning.jsx';
import { MatterPrompts } from './matter-prompts.jsx';
import { WorkingMemory } from './working-memory.jsx';
import { ModuleMemory } from './module-memory.jsx';
import { MemoryCandidates } from './memory-candidates.jsx';
import { WorkbenchDrawer } from './workbench-drawer.jsx';
import { ConnectionTools, PendingWrite } from './pending-write.jsx';
import { WorkspaceBar, WorkspaceNavigation } from './workspace-shell.jsx';
import { SettingsChannels, SettingsTabs } from './settings-shell.jsx';

function Heading({ goals, scope, loading, onScope, onRefresh }) {
  return <div className="wbHeading">
    <div><h1>工作台</h1></div>
    <div className="wbControls">
      <label htmlFor="wbScope">目标范围</label>
      <select id="wbScope" value={scope} onChange={event => onScope(event.currentTarget.value)}>
        <option value="">全部目标</option>
        {scope && !goals.some(goal => goal.id === scope) &&
          <option value={scope} disabled>所选目标已不可用</option>}
        {goals.map(goal => <option key={goal.id} value={goal.id}>{goal.name}</option>)}
      </select>
      <button type="button" onClick={onRefresh} disabled={loading} aria-label="刷新工作台">
        <Icon name="refresh" />{loading ? '读取中…' : '刷新'}
      </button>
    </div>
  </div>;
}

function GoalOverview({ goals, scope, loading, onScope, onLocate, onOpenWork }) {
  return <>
    <div className="wbSectionTitle"><h2>目标概览</h2></div>
    <div className="wbOverview">
      {goals.map(({ id, name, modules, matters, completed }) => {
        const selected = scope === id;
        return <div className={`wbGoal${selected ? ' active' : ''}`} key={id}>
          <button type="button" className="wbGoalFilter" id={`wbGoalFilter-${id}`} value={id}
            aria-label={`筛选目标：${name}`} aria-pressed={selected}
            onClick={() => onScope(selected ? '' : id)}>
            <strong className="wbGoalTitle">{name}</strong>
            <span className="wbGoalStats">
              <span><b>{modules}</b> 模块</span><span><b>{matters}</b> 事情</span>
              <span><b>{completed}</b> 已完成事情</span>
            </span>
          </button>
          <button type="button" className="wbGoalLink" value={id} title="跳转到目标与事情"
            aria-label={`跳转到目标与事情：${name}`} onClick={() => onLocate(id)} disabled={loading}>
            <Icon name="arrow" />
          </button>
        </div>;
      })}
      {!goals.length && <div className="empty"><b>暂无目标</b>
        <button type="button" className="primary" onClick={onOpenWork}>前往目标与事情</button>
      </div>}
    </div>
  </>;
}

function Workbench({ heading, overview, warnings, message, panels, actions }) {
  return <>
    <Heading {...heading} />
    {warnings.follow && <div className="wbWarning" role="alert">跟进保存结果待核对。<button type="button" onClick={actions.recoverFollow}>核对跟进结果</button>{warnings.retryFollow && <button type="button" onClick={actions.retryFollow}>使用原操作标识重试</button>}</div>}
    {warnings.attention && <div className="wbWarning" role="alert">关注保存结果待核对，未自动重试。<button type="button" onClick={actions.recoverAttention}>核对关注结果</button></div>}
    {message ? <div className={message.error ? 'wbWarning' : 'empty'} role={message.error ? 'alert' : undefined}>{message.text}</div> : <>
      <GoalOverview {...heading} goals={overview} />
      <WorkbenchPanels view={panels} actions={actions} />
    </>}
  </>;
}

function SourceSuggestions({ rows, onDecide, onOpen }) {
  if (!rows.length) return null;
  return <section className="aiSuggestions sourceCard">
    <h3>来源进展与待确认行动</h3>
    {rows.map(row => <div key={row.id} className="sourceCard">
      <strong>{row.heading}</strong>
      <p>{row.fields}</p><p>{row.basis}</p>
      <div className="actions">
        <button type="button" className="iconButton" title={row.reject} aria-label={row.reject}
          data-tip={row.reject} data-iconified="true"
          onMouseEnter={event => row.showTip(event.currentTarget)} onMouseLeave={row.hideTip}
          onFocus={event => row.showTip(event.currentTarget)} onBlur={row.hideTip}
          onClick={() => { row.hideTip(); onDecide(row.id, false); }}>
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d={row.rejectIcon} /></svg>
        </button>
        {row.accept && <button type="button" className="iconButton" title={row.accept} aria-label={row.accept}
          data-tip={row.accept} data-iconified="true"
          onMouseEnter={event => row.showTip(event.currentTarget)} onMouseLeave={row.hideTip}
          onFocus={event => row.showTip(event.currentTarget)} onBlur={row.hideTip}
          onClick={() => { row.hideTip(); onOpen(row.id); }}>
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 4 4L19 6" /></svg>
        </button>}
      </div>
    </div>)}
  </section>;
}

// Increment with incompatible changes to the browser bundle handshake.
export const frontendContract = 1;

export function mountNotice(host) {
  const root = createRoot(host);
  host.dataset.reactOwned = '';
  return message => flushSync(() => root.render(message ? <span>{message}</span> : null));
}

function IconHint({ anchor, label, position }) {
  const place = React.useCallback(node => {
    if (node) position(node, anchor);
  }, [anchor, position]);
  return <div ref={place} className="iconTip" role="tooltip">{label}</div>;
}

export function mountIconHint(host) {
  const root = createRoot(host);
  host.dataset.reactOwned = '';
  return model => flushSync(() => root.render(model ? createPortal(<IconHint {...model} />, model.target) : null));
}

export function mountDependencyWaiting(host) {
  const root = createRoot(host);
  host.dataset.reactOwned = '';
  return details => flushSync(() => root.render(details ?
    <div id="dependencyWaitReason" className="dependencyWaitPopover" role="region" aria-label="等待原因">
      <strong>等待原因</strong><ul>{details.map((reason, index) => <li key={index}>{reason}</li>)}</ul>
    </div> : null));
}

export function mountWorkspaceNavigation(host) {
  const root = createRoot(host);
  host.dataset.reactOwned = '';
  return props => flushSync(() => root.render(<WorkspaceNavigation {...props} />));
}

export function mountWorkspaceBar(host) {
  const root = createRoot(host);
  host.dataset.reactOwned = '';
  return props => flushSync(() => root.render(<WorkspaceBar {...props} />));
}

export function mountPendingWrite(host) {
  const root = createRoot(host);
  host.dataset.reactOwned = '';
  return props => flushSync(() => root.render(<PendingWrite {...props} />));
}

export function mountConnectionTools(host, props) {
  const root = createRoot(host);
  host.dataset.reactOwned = '';
  flushSync(() => root.render(<ConnectionTools {...props} />));
}

export function mountWorkbenchDrawer(host) {
  const root = createRoot(host);
  host.dataset.reactOwned = '';
  return props => flushSync(() => root.render(<WorkbenchDrawer {...props} />));
}

export function mountMemoryCandidates(host) {
  const root = createRoot(host);
  host.dataset.reactOwned = '';
  return props => flushSync(() => root.render(<MemoryCandidates {...props} />));
}

export function mountModuleMemory(host) {
  const root = createRoot(host);
  host.dataset.reactOwned = '';
  return props => flushSync(() => root.render(<ModuleMemory {...props} />));
}

export function mountWorkingMemory(host) {
  const root = createRoot(host);
  host.dataset.reactOwned = '';
  return props => flushSync(() => root.render(<WorkingMemory {...props} />));
}

export function mountSettingsShell(tabs, channels, chrome, openSources) {
  const tabsRoot = createRoot(tabs);
  const channelRoot = createRoot(channels);
  for (const host of [tabs, channels, ...Object.values(chrome)]) host.dataset.reactOwned = '';
  flushSync(() => channelRoot.render(<SettingsChannels openSources={openSources} />));
  return props => flushSync(() => tabsRoot.render(<SettingsTabs {...props} chrome={chrome} />));
}

export function mountMatterPrompts(host) {
  const root = createRoot(host);
  host.dataset.reactOwned = '';
  return props => flushSync(() => root.render(<MatterPrompts {...props} />));
}

export function mountMatterPlanningSplit(tools, split, footer) {
  const hosts = [tools, split, footer];
  const [toolsRoot, splitRoot, footerRoot] = hosts.map(host => {
    host.dataset.reactOwned = '';
    return createRoot(host);
  });
  return props => flushSync(() => {
    toolsRoot.render(<MatterPlanningTools {...props} />);
    splitRoot.render(<MatterPlanningSplit {...props} />);
    footerRoot.render(<MatterPlanningFooter {...props} />);
  });
}

export function mountModelCatalog(host) {
  const root = createRoot(host);
  host.dataset.reactOwned = '';
  return props => flushSync(() => root.render(<ModelCatalog {...props} />));
}

export function mountImageStorage(host) {
  const root = createRoot(host);
  host.dataset.reactOwned = '';
  return props => flushSync(() => root.render(<ImageStorage {...props} />));
}

export function mountInlineImages(host) {
  const root = createRoot(host);
  return props => flushSync(() => root.render(props ? <InlineImages {...props} /> : null));
}

export function mountImageDrawer(host) {
  const root = createRoot(host);
  host.dataset.reactOwned = '';
  return props => flushSync(() => root.render(<ImageDrawer {...props} />));
}

export function mountImageViewer(host) {
  const root = createRoot(host);
  host.dataset.reactOwned = '';
  return props => flushSync(() => root.render(<ImageViewer {...props} />));
}

export function mountRecognitionDrawer(host) {
  const root = createRoot(host);
  host.dataset.reactOwned = '';
  return props => flushSync(() => root.render(<RecognitionDrawer {...props} />));
}

export function mountSuggestionDrawer(host) {
  const root = createRoot(host);
  host.dataset.reactOwned = '';
  return props => flushSync(() => root.render(<SuggestionDrawer {...props} />));
}

export function mountFollowDrawer(host) {
  const root = createRoot(host);
  host.dataset.reactOwned = '';
  return props => flushSync(() => root.render(<FollowDrawer {...props} />));
}

export function mountSourceDrawer(host) {
  const root = createRoot(host);
  host.dataset.reactOwned = '';
  return props => flushSync(() => root.render(<SourceDrawer {...props} />));
}

export function mountDeleteDrawer(host) {
  const root = createRoot(host);
  host.dataset.reactOwned = '';
  return props => flushSync(() => root.render(<DeleteDrawer {...props} />));
}

export function mountMoveDrawer(host) {
  const root = createRoot(host);
  host.dataset.reactOwned = '';
  return props => flushSync(() => root.render(<MoveDrawer {...props} />));
}

export function mountPriorityDrawer(host) {
  const root = createRoot(host);
  host.dataset.reactOwned = '';
  return props => flushSync(() => root.render(<PriorityDrawer {...props} />));
}

export function mountDailyDrawer(host) {
  const root = createRoot(host);
  host.dataset.reactOwned = '';
  return props => flushSync(() => root.render(<DailyDrawer {...props} />));
}

export function mountPlanDrawer(host) {
  const root = createRoot(host);
  host.dataset.reactOwned = '';
  return props => flushSync(() => root.render(<PlanDrawer {...props} />));
}

export function mountEventDrawer(host, header, feedback) {
  const root = createRoot(host);
  for (const part of [host, header, feedback]) part.dataset.reactOwned = '';
  return props => flushSync(() => root.render(<>
    {props.model.session != null && <EventDrawerContent {...props} />}
    {createPortal(<EventDrawerHeader model={props.chrome} actions={props.actions} />, header)}
    {createPortal(<EventDrawerFeedback model={props.chrome} actions={props.actions} />, feedback)}
  </>));
}

export function mountEditor(host) {
  const root = createRoot(host);
  host.dataset.reactOwned = '';
  return props => flushSync(() => root.render(<WorkEditor {...props} />));
}

export function mountEvents(host) {
  const root = createRoot(host);
  host.dataset.eventsUi = 'react';
  host.dataset.reactOwned = '';
  return (props, suggestions) => flushSync(() => root.render(<>
    <WorkEvents {...props} />
    <SourceSuggestions {...suggestions} />
  </>));
}

export function mountSelection(page) {
  const breadcrumb = page.querySelector('#crumb');
  const toolbar = page.querySelector('.toolbar');
  const things = page.querySelector('.workspace > .panel:first-child');
  const breadcrumbRoot = createRoot(breadcrumb);
  const toolbarRoot = createRoot(toolbar);
  const thingsRoot = createRoot(things);
  page.dataset.selectionUi = 'react';
  for (const host of [breadcrumb, toolbar, things]) host.dataset.reactOwned = '';
  return {
    draw(props) {
      flushSync(() => {
        breadcrumbRoot.render(<Breadcrumb {...props.breadcrumb} />);
        toolbarRoot.render(<WorkToolbar {...props.toolbar} />);
        thingsRoot.render(<WorkThings {...props.things} />);
      });
    },
    drawThings(props) { flushSync(() => thingsRoot.render(<WorkThings {...props} />)); },
  };
}

export function mount(host) {
  const root = createRoot(host);
  host.dataset.goalUi = 'react';
  host.dataset.panelsUi = 'react';
  return props => flushSync(() => root.render(<Workbench {...props} />));
}
