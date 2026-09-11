import { describe, expect, it } from 'vitest';
import { corePortfolioProjects, CORE_PORTFOLIO_SLUGS } from '../src/components/t5t/board-utils';
import type { ProjectSummary } from '../src/lib/api';

function project(slug: string): ProjectSummary {
  return {
    slug,
    name: slug,
    leaderEmail: null,
    allowedUsers: [],
    status: 'unknown',
    killCriteria: null,
    goal: null,
    bottleneck: null,
    evaluators: [],
    lastPush: null,
    lastAuthor: null,
  };
}

describe('T5T company core projection', () => {
  it('selects known anchors in stable portfolio order', () => {
    const input = [project('scratch'), project('metabot'), project('wbc'), project('vlm-brain')];
    expect(corePortfolioProjects(input).map((p) => p.slug)).toEqual(['wbc', 'vlm-brain', 'metabot']);
    expect(CORE_PORTFOLIO_SLUGS).toContain('g1-wuji-teleoperation');
  });
});
