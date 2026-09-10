# Contributing to Jiabaixing

Thank you for your interest in contributing to Jiabaixing! We welcome contributions from everyone.

## Getting Started

1. **Fork** the repository on GitHub
2. **Clone** your fork locally:
   ```bash
   git clone https://github.com/YOUR_USERNAME/jiabaixing.git
   cd jiabaixing
   ```
3. **Install** dependencies:
   ```bash
   npm install
   ```
4. **Configure** your LLM provider:
   ```bash
   cp .env.example .env
   npm run setup
   ```

## Development Workflow

1. Create a feature branch: `git checkout -b feature/your-feature`
2. Make your changes
3. Run the full check suite before committing:
   ```bash
   npm run check:all
   ```
   This runs: lint + format check + tautology guard + schema guard + test coverage + build
4. Commit with a descriptive message
5. Push to your fork and open a Pull Request

## Code Standards

- **TypeScript**: All source code is TypeScript (ES2022, strict mode)
- **Linting**: ESLint with `@typescript-eslint/recommended-requiring-type-checking`
- **Formatting**: Prettier (2-space indent, single quotes, trailing commas)
- **Testing**: Jest — all new features must include tests
- **No `any`**: The `@typescript-eslint/no-explicit-any` rule is enforced
- **No floating promises**: All promises must be awaited or explicitly handled

## Project Structure

```
src/
├── core/              Core engine (JiabaixingCore, Scheduler)
├── harness/           E-T-C-S-L-V six-layer Harness system
│   ├── loop/          Execution loop
│   ├── tools/         33 tools across 8 categories
│   ├── context/       Context management
│   ├── evaluation/    Evaluation framework
│   ├── persistence/   State persistence
│   ├── verification/  Safety verification
│   └── orchestration/ Multi-agent orchestration
├── models/            LLM provider management
├── memory/            Three-layer memory system
├── evolution/         Self-evolution engine V2
├── security/          Security & audit
├── server/            Express + WebSocket server
├── frontend/          React 18 dashboard
└── main.ts            Entry point
```

## Adding a New Tool

Tools are registered in `src/harness/tools/`. Each tool needs:

1. Implementation file (e.g., `src/harness/tools/category/your_tool.ts`)
2. JSON Schema for input validation
3. Permission level (one of: `safe`, `readonly`, `destructive`, `system`)
4. Unit tests in `tests/unit/tools/`

See existing tools for reference patterns.

## Running Tests

```bash
npm test                 # All tests
npm run test:coverage    # With coverage report
npm run test:integration # Integration tests only
npm run check:ts         # TypeScript type check only
npm run lint             # ESLint only
npm run format:check     # Prettier check only
```

## Reporting Issues

- Use GitHub Issues for bug reports and feature requests
- Include: OS, Node.js version, steps to reproduce, expected vs actual behavior
- For security vulnerabilities, please email the maintainers directly (do not file public issues)

## Pull Request Guidelines

- Keep PRs focused — one feature or fix per PR
- Include tests for new functionality
- Update documentation if needed
- Ensure `npm run check:all` passes
- Write clear commit messages

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
