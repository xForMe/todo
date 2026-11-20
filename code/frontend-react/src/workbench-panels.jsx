import React from 'react';
import { WorkbenchIcon as Icon } from './workbench-icons.jsx';

const empty = {
  events: ['list', '暂无符合条件的行动'],
  attention: ['star', '暂无关注'],
  reviews: ['check', '暂无待评估事情'],
};

function Page({ kind, page, onPage, renderRow }) {
  const [icon, text] = empty[kind];
  const { rows, index, last, total, size } = page;
  const isActions = kind === 'events';
  const pageButtons = [
    <button type="button" key="previous" data-direction={isActions ? -1 : undefined}
      disabled={!index} onClick={() => onPage(kind, -1)}>上一页</button>,
    <button type="button" key="next" data-direction={isActions ? 1 : undefined}
      disabled={index === last} onClick={() => onPage(kind, 1)}>下一页</button>,
  ];
  return <>
    {total ? rows.map(renderRow) : <div className="empty wbEmpty"><Icon name={icon} /><b>{text}</b></div>}
    {isActions ? <nav className="wbPager" aria-label="行动清单分页">
      <span role="status">共 {total} 条 · 第 {total ? index * size + 1 : 0}–{Math.min((index + 1) * size, total)} 条 · 第 {index + 1}/{last + 1} 页</span>
      {pageButtons}
    </nav> : total > 0 ? <div className="wbPager">
      <span>共 {total} 条{total > size ? ` · 第 ${index + 1}/${last + 1} 页` : ''}</span>
      {total > size && pageButtons}
    </div> : null}
  </>;
}

function ActionRow({ row, followDisabled, onEdit, onPlan, onFollow }) {
  const { id, name, path, status, statusLabel, end, overdue, parent, followup, predecessors, history } = row;
  return <article className="wbRow wbActionRow">
    <div className="planTitleWrap">
      <button type="button" className="wbTitle" onClick={() => onEdit(id)}>{name}</button>
      {history > 0 && <button type="button" className="planMark" data-plan={id}
        title={`${history} 条时间变更记录`} aria-label={`查看 ${history} 条时间变更记录`}
        onClick={() => onPlan(id, true)}><Icon name="history" /><span>{history}</span></button>}
      {predecessors && <button type="button" className="dependencyShortcut" data-dependency-event={id}
        title="前置事件" aria-label="前置事件"><Icon name="link" /></button>}
    </div>
    <div className="wbMeta">
      <span className={`status ${status}`}>{statusLabel}</span>
      <span className={overdue ? 'wbOverdue' : undefined}>{end ? `${end} 截止` : '未排期'}</span>
      <button type="button" className="planDelay" title="延期变更" aria-label={`延期变更：${name}`}
        onClick={() => onPlan(id)}><Icon name="calendar" /></button>
      {parent && <span>父事件</span>}{followup && <span>后续跟进</span>}
    </div>
    <p className="wbPath" title={path}>{path}</p>
    <div className="dailyAction"><button type="button" className="dailyIcon dailyMark" title="当日跟进"
      aria-label={`当日跟进：${name}`} disabled={followDisabled} onClick={() => onFollow(id)}>
      <Icon name="dailyDone" />
    </button></div>
  </article>;
}

function MatterRow({ row, review, watchDisabled, onDetail, onAttention, onReview }) {
  const { id, name, path, priority, status, progress, watched } = row;
  const label = watched ? '取消持续关注' : '持续关注';
  return <article className="wbRow">
    <div>
      <button type="button" className="wbTitle" onClick={() => onDetail(id)}>{name}</button>
      <p className="wbPath">{path}</p>
      <div className="wbMeta"><span>{priority}</span><span>{review ? '本周待评估' : status}</span><span>{progress}</span></div>
    </div>
    {review ? <button type="button" className="wbLocate" onClick={() => onReview(id)}>去评估 <Icon name="arrow" /></button>
      : <button type="button" className={`wbWatch ${watched ? 'isWatched' : ''}`} title={label}
        aria-label={`${label}：${name}`} aria-pressed={watched} disabled={watchDisabled}
        onClick={() => onAttention(id, !watched)}><Icon name="watch" /></button>}
  </article>;
}

function Filters({ categories, daily, onCategory, onDaily }) {
  return <div className="dailyToolbar">
    <div className="wbTabs" role="group" aria-label="行动分类">
      {categories.map(({ key, label, count, selected }) => <button type="button" key={key}
        data-action-category={key} className={selected ? 'active' : ''} aria-pressed={selected}
        onClick={() => onCategory(key)}>{label} <span>{count}</span></button>)}
    </div>
    <div className="dailyFilters" role="group" aria-label="当日跟进筛选">
      {daily.map(({ key, count, selected }) => {
        const label = `当日${key === 'done' ? '已跟进' : '未跟进'} ${count} 项`;
        return <button type="button" key={key} className={`dailyIcon ${selected ? 'active' : ''}`}
          data-daily-filter={key} title={label} aria-label={label} aria-pressed={selected}
          onClick={() => onDaily(key)}><Icon name={key === 'done' ? 'dailyDone' : 'dailyPending'} /><span>{count}</span></button>;
      })}
    </div>
  </div>;
}

export function WorkbenchPanels({ view, actions }) {
  return <div className="wbLayout">
    <section className="wbPanel">
      <div className="wbPanelHead"><h2>行动清单 <span className="wbCount">{view.actionCount}</span></h2></div>
      <Filters categories={view.categories} daily={view.daily} onCategory={actions.category} onDaily={actions.daily} />
      <Page kind="events" page={view.events} onPage={actions.page} renderRow={row =>
        <ActionRow key={row.id} row={row} followDisabled={view.followDisabled}
          onEdit={actions.edit} onPlan={actions.plan} onFollow={actions.follow} />} />
    </section>
    <div className="wbStack">
      <section className="wbPanel">
        <div className="wbPanelHead"><h2>持续关注 <span className="wbCount">{view.attention.total}</span></h2>
          <label><input type="checkbox" checked={view.includeEnded}
            onChange={event => actions.includeEnded(event.currentTarget.checked)} /> 含已结束</label>
        </div>
        <Page kind="attention" page={view.attention} onPage={actions.page} renderRow={row =>
          <MatterRow key={row.id} row={row} watchDisabled={view.watchDisabled}
            onDetail={actions.detail} onAttention={actions.attention} />} />
      </section>
      <section className="wbPanel">
        <div className="wbPanelHead"><h2>本周待评估 <span className="wbCount">{view.reviews.total}</span></h2><small>{view.week} 起</small></div>
        <Page kind="reviews" page={view.reviews} onPage={actions.page} renderRow={row =>
          <MatterRow key={row.id} row={row} review onDetail={actions.detail} onReview={actions.review} />} />
      </section>
    </div>
  </div>;
}
