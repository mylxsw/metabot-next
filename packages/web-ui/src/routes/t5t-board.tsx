import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError, type BoardResponse } from '../lib/api';
import { formatRelative } from '../lib/format';
import { StatusPill } from '../components/t5t/StatusPill';
import { AnomalyZone } from '../components/t5t/AnomalyZone';
import { T5TTimeline } from '../components/t5t/T5TTimeline';
import { corePortfolioProjects } from '../components/t5t/board-utils';

export function T5tBoard() {
  const [board, setBoard] = useState<BoardResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [showKilled, setShowKilled] = useState(false);
  const [view, setView] = useState<'core' | 'all'>('core');

  useEffect(() => {
    let live = true;
    api.getT5tBoard()
      .then((b) => { if (live) setBoard(b); })
      .catch((e) => {
        if (e instanceof ApiError && e.status === 401) return;
        if (live) setErr(e instanceof Error ? e.message : 'failed');
      });
    return () => { live = false; };
  }, []);

  const killedCount = useMemo(() => {
    if (!board) return 0;
    return board.projects.filter((p) => p.status === 'killed').length;
  }, [board]);

  const projectsForView = useMemo(() => {
    if (!board) return [];
    const projects = view === 'core' ? corePortfolioProjects(board.projects) : board.projects;
    return showKilled ? projects : projects.filter((p) => p.status !== 'killed');
  }, [board, showKilled, view]);

  return (
    <div className="main">
      <aside className="sidebar">
        <div className="sidebar-section">
          <span>projects</span>
          <span className="count">{board?.projects.length ?? '—'}</span>
        </div>
        <div style={{ padding: '0 18px', color: 'var(--bone-300)', fontSize: 11, lineHeight: 1.6 }}>
          T5T board · read-only. Push entries with{' '}
          <code style={{ color: 'var(--amber)' }}>metabot t5t push</code>.
          <div style={{ marginTop: 10 }}>
            <button type="button" onClick={() => setView('core')} disabled={view === 'core'}>company core</button>{' '}
            <button type="button" onClick={() => setView('all')} disabled={view === 'all'}>all projects</button>
          </div>
        </div>
      </aside>
      <div className="content">
        <div className="page-head">
          <div>
            <div className="kicker">tracking</div>
            <h1>t5t board</h1>
          </div>
          <span className="crumbs">/ t5t</span>
        </div>

        {err && <div className="state err">{err}</div>}
        {!err && !board && (
          <div className="state"><span className="cursor">loading</span></div>
        )}

        {!err && board && (
          <>
            {board.anomalies.length > 0 && (
              <AnomalyZone items={board.anomalies} />
            )}

            <div className="section">
              <h2>
                {view === 'core' ? 'company core' : 'projects'} <span className="count">{projectsForView.length}</span>
                {killedCount > 0 && (
                  <button
                    type="button"
                    onClick={() => setShowKilled((v) => !v)}
                    style={{
                      marginLeft: 12,
                      fontSize: 11,
                      background: 'transparent',
                      color: 'var(--bone-300)',
                      border: '1px solid var(--bone-700, #444)',
                      borderRadius: 3,
                      padding: '2px 8px',
                      cursor: 'pointer',
                    }}
                  >
                    {showKilled ? `hide killed (${killedCount})` : `show killed (${killedCount})`}
                  </button>
                )}
              </h2>
              {projectsForView.length === 0 ? (
                <div className="t5t-card muted">尚无项目</div>
              ) : (
                projectsForView.map((p) => (
                  <Link
                    key={p.slug}
                    to={`/t5t/${encodeURIComponent(p.slug)}`}
                    className="t5t-proj"
                    style={p.status === 'killed' ? { opacity: 0.55 } : undefined}
                  >
                    <span className="title">
                      {p.name || p.slug}
                      {p.goal && <span className="goal">{p.goal}</span>}
                    </span>
                    <span className={`leader${p.leaderEmail ? '' : ' none'}`}>
                      {p.leaderEmail || '无 owner'}
                    </span>
                    <StatusPill status={p.status} />
                  </Link>
                ))
              )}
            </div>

            <div className="section">
              <h2>
                recent entries <span className="count">{board.recentEntries.length}</span>
              </h2>
              <T5TTimeline entries={board.recentEntries} />
            </div>

            <div className="state" style={{ padding: '24px 0', textAlign: 'left' }}>
              generated {formatRelative(board.generatedAt)}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
