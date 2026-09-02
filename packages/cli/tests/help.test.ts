import { describe, expect, it, vi, afterEach } from 'vitest';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('metabot top-level help', () => {
  it('keeps minimal send as the primary communication surface and hides compatibility wrappers', async () => {
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const mod = await import('../src/help.js');

    mod.print();

    const output = stdout.mock.calls.map((call) => String(call[0])).join('');
    expect(output).toContain('Primary subcommands:');
    expect(output).toContain('send <agentId> "message"  minimal point-to-point Agent Bus send');
    expect(output).toContain('Use metabot send for all point-to-point Agent Bus communication.');
    expect(output).not.toContain('Compatibility / local orchestration:');
    expect(output).not.toContain('agents <cmd> [args]');
    expect(output).not.toContain('inbox <cmd> [args]');
    expect(output).not.toContain('teams <cmd> [args]');
    expect(output).not.toContain('metabot agents --help');
    expect(output).not.toContain('metabot inbox --help');
    expect(output).not.toContain('metabot teams --help');
    expect(output).toContain('chat/inbox/agents-talk CLI surfaces are no longer shipped');
    expect(output).not.toContain('metabot chat');
  });
});
