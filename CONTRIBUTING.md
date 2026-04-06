# Contributing to DevPilot MCP

Thanks for your interest in contributing! DevPilot MCP is an open-source DevOps lifecycle server for AI coding agents.

## Getting Started

1. Fork the repository
2. Clone your fork: `git clone https://github.com/YOUR_USERNAME/devpilot-mcp.git`
3. Install dependencies: `npm install`
4. Run tests: `npm test`

## Development

- **Language:** TypeScript (strict mode)
- **Testing:** Vitest — run `npm test`
- **Build:** `npm run build` (TypeScript → dist/)
- **Type check:** `npm run typecheck`

## Adding a New Provider Adapter

1. Create `src/adapters/your-provider.ts` implementing the `DeployProvider`, `ErrorProvider`, `CIProvider`, or `HealthProvider` interface from `src/adapters/types.ts`
2. Export from `src/adapters/` as needed
3. Add tests in `tests/adapters/your-provider.test.ts`

## Adding a New Tool

1. Create `src/tools/your-tool.ts` (free) or `src/premium/your-tool.ts` (pro)
2. Pro tools must call `requirePro("tool_name")` at the start of the handler
3. Register in `src/index.ts` with a Zod input schema
4. Add tests for the tool handler

## Pull Requests

- Write tests for new features and bug fixes
- Ensure all tests pass: `npm test`
- TypeScript must compile without errors: `npm run build`
- One feature or fix per PR
- Update the README if adding or changing tools

## Reporting Issues

Use GitHub Issues. Include:
- Steps to reproduce
- Expected vs actual behavior
- Provider (Vercel / Railway / Sentry / GitHub Actions)
- Node.js version
- Redacted environment variable names (never include actual token values)

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
