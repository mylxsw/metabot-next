# Contributing to MetaBot

Thanks for your interest in contributing! This guide will help you get started.

## Development Setup

```bash
# 1. Clone the repo
git clone https://github.com/xvirobotics/metabot.git
cd metabot

# 2. Install dependencies
npm ci --include=dev

# 3. Copy environment config
cp .env.example .env
# Edit .env with your Feishu app credentials

# 4. Build
npm run build

# 5. Run the test suite and lint checks
npm test
npm run lint

# 6. Run in development
npm run dev
```

**Prerequisites:** Node.js >= 22.19 and Git. Install and authenticate only the
engine needed for engine-specific work: Codex CLI, Kimi Code 0.27+, or the
Claude Code compatibility CLI. Documentation and most unit tests do not
require an authenticated engine.

## Project Structure

```
src/
  bridge/        # Message routing & task management
  engines/       # Codex, Kimi Code, and Claude compatibility adapters
  feishu/        # Feishu API client & card builder
  telegram/      # Telegram integration
  wechat/        # WeChat/ClawBot integration
  memory/        # Memory server client
  utils/         # Logger, helpers
packages/        # Personal Core, Web UI, CLI, and shared packages
```

## How to Contribute

### Reporting Bugs

- Use the [Bug Report](https://github.com/xvirobotics/metabot/issues/new?template=bug_report.md) template
- Include logs (redact sensitive info) and steps to reproduce

### Suggesting Features

- Use the [Feature Request](https://github.com/xvirobotics/metabot/issues/new?template=feature_request.md) template
- Describe the use case, not just the solution

### Submitting Pull Requests

1. Fork the repo and create a branch from `main`
2. Make your changes with clear commit messages
3. Ensure `npm run build` passes with no errors
4. Run `npm test` and `npm run lint`
5. Open a PR with a clear description of what changed and why

## Code Style

- TypeScript strict mode
- Use `async/await` over raw promises
- Keep functions small and focused
- Add JSDoc comments for public APIs
- Use ESM imports with `.js` extensions

## Questions?

Open an issue or start a discussion — we're happy to help!
