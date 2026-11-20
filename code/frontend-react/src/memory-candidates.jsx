import React from 'react';

function Candidate({ candidate, locked, actions }) {
  const descId = `candidateDescription-${candidate.id}`;
  const aliasesId = `candidateAliases-${candidate.id}`;
  return <article className="memoryCandidateCard">
    <h3>{candidate.path}</h3><p className="muted">{candidate.status}</p>
    {candidate.usable && <>
      <p>{candidate.draft.kind === 'alias' ? '简称候选' : '模块职责候选'}</p>
      <p>提取理由：{candidate.draft.reason}</p>
      <details><summary>来源原文</summary><blockquote>{candidate.draft.evidence}</blockquote></details>
      <details><summary>当前记忆 · 第{candidate.current.version}版</summary>
        <p>{candidate.current.description || '尚未配置职责'}</p><p>{candidate.current.aliases.join('、') || '暂无简称'}</p>
      </details>
    </>}
    <form data-candidate-id={candidate.id} onSubmit={event => {
      event.preventDefault();
      if (!candidate.usable || locked) return;
      const form = event.currentTarget;
      actions.save(candidate.id, form.elements.description.value, form.elements.aliases.value);
    }}>
      {candidate.usable && <>
        <label htmlFor={descId}>确认后的模块职责</label>
        <textarea id={descId} name="description" maxLength={2000} rows={3} defaultValue={candidate.description} disabled={locked} />
        <label htmlFor={aliasesId}>确认后的简称（每行一个，最多20个）</label>
        <textarea id={aliasesId} name="aliases" maxLength={1620} rows={2}
          defaultValue={candidate.aliases.join('\n')} disabled={locked} />
        <button className="primary" type="submit" disabled={locked}>确认更新记忆</button>
      </>}
      <button type="button" disabled={locked} onClick={() => actions.reject(candidate.id)}>拒绝候选</button>
    </form>
  </article>;
}

export function MemoryCandidates({ model, actions }) {
  const { status, error, items, generation, busy, pending } = model;
  return <>
    <div className="drawerHead"><h2 id="memoryCandidatesTitle">记忆候选</h2>
      <button type="button" id="memoryCandidatesClose" onClick={actions.close}>关闭</button></div>
    <p className="sourceHint">核对来源和模块记忆，确认后用于辅助归属。</p>
    <p id="memoryCandidatesStatus" role="status">{status}</p>
    <div id="memoryCandidatesList">
      {items?.length === 0 && <p>暂无待确认记忆候选。仅处理后续已授权来源的识别结果。</p>}
      {items?.map(candidate => <Candidate key={`${generation}:${candidate.id}`} candidate={candidate} locked={busy || pending} actions={actions} />)}
    </div>
    <p id="memoryCandidatesError" role="alert">{error}</p>
    <div className="actions"><button type="button" id="memoryCandidatesRefresh" disabled={busy} onClick={actions.refresh}>刷新候选</button>
      <button type="button" id="memoryCandidatesRecover" hidden={!pending} disabled={busy} onClick={actions.recover}>核对保存结果</button></div>
  </>;
}

export function SuggestionMemoryBasis({ basis }) {
  if (!basis) return null;
  return <section id="suggestionMemoryBasis" key={basis.ticket}>
    <h3>记忆引用</h3><p>{basis.state}</p>
    {basis.items.map(ref => <details key={`${ref.module_id}:${ref.revision}`}>
      <summary>{ref.valid ? ref.path : '已失效引用'} · 第{ref.revision}版</summary>
      <p>{ref.status}</p>
      {ref.valid && <><p>{ref.description}</p><p>{ref.aliases.join('、')}</p></>}
    </details>)}
  </section>;
}
