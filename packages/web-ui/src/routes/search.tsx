import { useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { api, ApiError, type SearchResult, type SkillSearchResult } from '../lib/api';
import { renderSafeSnippet } from '../lib/render-markdown';
import { contentTypeBadge, formatRelative } from '../lib/format';

interface Combined {
  docs: SearchResult[] | null;
  skills: SkillSearchResult[] | null;
  err: string | null;
  docsHasMore: boolean;
  docsLoadingMore: boolean;
  docsLoadError: string | null;
}

const EMPTY: Combined = {
  docs: null, skills: null, err: null, docsHasMore: false, docsLoadingMore: false, docsLoadError: null,
};
const PAGE_SIZE = 20;

export function Search() {
  const loc = useLocation();
  const q = new URLSearchParams(loc.search).get('q') || '';

  const [state, setState] = useState<Combined>(EMPTY);

  useEffect(() => {
    if (!q) { setState({ ...EMPTY, docs: [], skills: [] }); return; }
    let live = true;
    setState(EMPTY);
    Promise.allSettled([api.searchMemory(q, PAGE_SIZE), api.searchSkills(q)])
      .then(([m, s]) => {
        if (!live) return;
        const docs = m.status === 'fulfilled' ? m.value.results : [];
        const skills = s.status === 'fulfilled' ? s.value.skills : [];
        const err =
          m.status === 'rejected' && m.reason instanceof ApiError && m.reason.status !== 401
            ? `memory · ${m.reason.code}`
            : null;
        setState({ docs, skills, err, docsHasMore: docs.length === PAGE_SIZE, docsLoadingMore: false, docsLoadError: null });
      });
    return () => { live = false; };
  }, [q]);

  async function loadMore() {
    if (!q || !state.docs || !state.docsHasMore || state.docsLoadingMore) return;
    const offset = state.docs.length;
    setState((cur) => ({ ...cur, docsLoadingMore: true, docsLoadError: null }));
    try {
      const next = await api.searchMemory(q, PAGE_SIZE, offset);
      setState((cur) => ({ ...cur, docs: [...(cur.docs || []), ...next.results], docsHasMore: next.results.length === PAGE_SIZE, docsLoadingMore: false }));
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) return;
      setState((cur) => ({ ...cur, docsLoadingMore: false, docsLoadError: e instanceof Error ? e.message : String(e) }));
    }
  }

  return (
    <div className="main">
      <aside className="sidebar">
        <div className="sidebar-section">
          <span>query</span>
          <span className="count">{q ? '1' : '0'}</span>
        </div>
        <div style={{ padding: '0 18px', color: 'var(--bone-300)', fontSize: 11 }}>
          fts5 full-text across memory and skills.
        </div>
      </aside>
      <div className="content">
        <div className="page-head">
          <div>
            <div className="kicker">unified search</div>
            <h1>{q ? `"${q}"` : 'enter a query'}</h1>
          </div>
          <span className="crumbs">/ search</span>
        </div>

        {state.err && <div className="state err">{state.err}</div>}

        <section className="section">
          <h2>
            <span>memory</span>
            <span className="count">{state.docs ? state.docs.length : '—'}</span>
          </h2>
          {!state.docs ? (
            <div className="state"><span className="cursor">loading</span></div>
          ) : state.docs.length === 0 ? (
            <div className="state">no document matches</div>
          ) : (
            <>
            {state.docs.map((r) => (
              <Link key={r.id} to={`/memory${r.path}`} className="search-row">
                <div className="head">
                  <span className={r.content_type === 'text/html' ? 'badge html' : 'badge md'}>
                    {contentTypeBadge(r.content_type)}
                  </span>
                  <span className="title">{r.title}</span>
                  <span className="path">{r.path}</span>
                  <span style={{ marginLeft: 'auto', color: 'var(--bone-300)', fontSize: 11 }}>
                    {formatRelative(r.updated_at)}
                  </span>
                </div>
                <div
                  className="snippet"
                  dangerouslySetInnerHTML={{ __html: renderSafeSnippet(r.snippet || '') }}
                />
              </Link>
            ))}
            {state.docsLoadError && <div className="state err">{state.docsLoadError} · <button type="button" onClick={loadMore}>retry</button></div>}
            {state.docsHasMore && !state.docsLoadError && <div className="state"><button type="button" disabled={state.docsLoadingMore} onClick={loadMore}>{state.docsLoadingMore ? 'loading…' : 'load more'}</button></div>}
            </>
          )}
        </section>

        <section className="section">
          <h2>
            <span>skills</span>
            <span className="count">{state.skills ? state.skills.length : '—'}</span>
          </h2>
          {!state.skills ? (
            <div className="state"><span className="cursor">loading</span></div>
          ) : state.skills.length === 0 ? (
            <div className="state">no skill matches</div>
          ) : (
            state.skills.map((s) => (
              <Link key={s.id} to={`/skills/${encodeURIComponent(s.name)}`} className="search-row">
                <div className="head">
                  <span className={`badge vis-${s.visibility}`}>{s.visibility}</span>
                  <span className="title">{s.name}</span>
                  <span className="path">v{s.version}</span>
                  <span style={{ marginLeft: 'auto', color: 'var(--bone-300)', fontSize: 11 }}>
                    {formatRelative(s.updatedAt)}
                  </span>
                </div>
                <div
                  className="snippet"
                  dangerouslySetInnerHTML={{ __html: renderSafeSnippet(s.snippet || s.description || '') }}
                />
              </Link>
            ))
          )}
        </section>
      </div>
    </div>
  );
}
