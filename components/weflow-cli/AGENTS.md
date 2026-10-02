# Agent Maintenance Guide

Read this file and [docs/PROJECT_STATE.md](docs/PROJECT_STATE.md) before changing the project. Read [docs/DECISIONS.md](docs/DECISIONS.md) before revisiting an established design choice.

## Working Rules

- Treat local WeChat databases, exports, wxid values, API keys, tokens, paths, logs, screenshots, and assistant memory as sensitive. Never put them in source code, documentation, fixtures, issues, commits, or public command output.
- Keep work scoped and preserve existing user changes. Do not reset, discard, or overwrite unrelated files.
- Use placeholders in examples: `联系人A`, `示例群`, `YOUR_API_KEY`, and `YYYY-MM-DD`.
- Do not present local processing as a legal, account-safety, or platform-compatibility guarantee. Follow [SECURITY.md](SECURITY.md).
- Do not expand process-memory, key-extraction, or platform-automation details in public documentation without a security review.
- For future architecture-diagram visual assets, use GPT-image-2 as requested by the project owner, while keeping a maintainable source representation when practical and checking text, dimensions, and repository references after generation.

## Project Map

- `bin/weflow-cli.ts`: CLI entry point and command wiring.
- `src/core/`: database, key, native-library, and WeChat-client integrations.
- `src/services/`: configuration, chat access, exports, assistant, privacy, whitelist, and message workflows.
- `scripts/`: Python workflows for NT databases, daily reading, HTML generation, knowledge processing, and reports.
- `mcp-server/`: stdio MCP server.
- `test/`: Node built-in regression tests for pure utilities and privacy boundaries.
- Evidence packages and legal notes stay local; never commit real evidence or personal data.

## Verification

Run the narrowest relevant check first. TypeScript changes require `npm run build`; run `npm test` for the regression suite. For Python changes, compile or run the affected script's focused check. Before handoff, run `git diff --check` and inspect the staged diff for sensitive information.

## Documentation Protocol

- Update `docs/PROJECT_STATE.md` when a feature, supported platform, known limitation, active issue, or verification status changes.
- Add an entry to `docs/DECISIONS.md` when a decision affects security, data flow, compatibility, public API, or future implementation direction.
- Update `CHANGELOG.md` only for user-visible release notes; do not use it as an engineering diary.
- Keep architecture and operations documentation aligned when a behavior changes their stated contracts.
