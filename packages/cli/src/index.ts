/**
 * `metabot` — unified entry point. Sole CLI binary; legacy `mm` / `mh` / `mb`
 * bins have all been removed. The implementations still live in
 * `@xvirobotics/metamemory` and `@xvirobotics/skill-hub` as workspace
 * libraries — `metabot memory` and `metabot skills` import their `main(argv)`
 * exports directly.
 *
 *   metabot memory <…>   → @xvirobotics/metamemory  (former `mm`)
 *   metabot skills <…>   → @xvirobotics/skill-hub   (former `mh`)
 *   metabot agents <…>   → in-tree (./agents.js)
 *   metabot send <…>     → in-tree (./send.js); wraps /api/messages/*
 *   metabot teams <…>    → in-tree (./teams.js); wraps local bridge /api/agent-teams/*
 *   metabot t5t <…>      → in-tree (./t5t.js); wraps /api/t5t/cli/*
 *   metabot help         → top-level help (also: bare invocation, --help, -h)
 */

export async function main(argv: string[]): Promise<void> {
  const sub = argv[0];
  const rest = argv.slice(1);

  if (!sub || sub === 'help' || sub === '--help' || sub === '-h') {
    const { print } = await import('./help.js');
    print();
    return;
  }

  switch (sub) {
    case 'memory': {
      const m = await import('@xvirobotics/metamemory');
      await m.main(rest);
      return;
    }
    case 'skills':
    case 'skill': {
      const m = await import('@xvirobotics/skill-hub');
      await m.main(rest);
      return;
    }
    case 'agents': {
      const m = await import('./agents.js');
      await m.run(rest);
      return;
    }
    case 'send': {
      const m = await import('./send.js');
      await m.run(rest);
      return;
    }
    case 'teams': {
      const m = await import('./teams.js');
      await m.run(rest);
      return;
    }
    case 't5t': {
      const m = await import('./t5t.js');
      await m.run(rest);
      return;
    }
    default: {
      process.stderr.write(`metabot: unknown subcommand '${sub}'. Run 'metabot --help' for usage.\n`);
      process.exit(2);
    }
  }
}
