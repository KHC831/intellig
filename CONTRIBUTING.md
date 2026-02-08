# Contributing to IntelliG

Thanks for your interest in contributing to IntelliG.

## Prerequisites

- Node.js 20+
- VS Code 1.85+
- Git installed and available on PATH

## Setup

```bash
npm install
```

## Build

```bash
# Compile TypeScript to JavaScript (output in out/)
npm run compile

# Watch mode — recompiles on file changes
npm run watch
```

## Lint & Format

```bash
npm run lint          # Run ESLint
npm run lint:fix      # ESLint with auto-fix
npm run format:check  # Check formatting (Prettier)
npm run format        # Fix formatting
```

## Tests

Unit tests use mocha with ts-node and run directly from TypeScript source. Property-based tests (fast-check) run from compiled JS.

```bash
# Unit tests (uses .mocharc.json — runs from src/)
npx mocha

# Unit tests — single file
npx mocha --grep "GitService"

# Property-based tests (compile first, run from out/)
npm run compile
npx mocha --no-config --require out/test/setup.js 'out/test/property/**/*.property.test.js' --timeout 60000 --exit

# Property-based tests — single file
npm run compile
npx mocha --no-config --require out/test/setup.js 'out/test/property/stashRoundTrip.property.test.js' --timeout 60000 --exit

# All tests together (unit + property)
npm run compile
npx mocha --timeout 60000
npx mocha --no-config --require out/test/setup.js 'out/test/property/**/*.property.test.js' --timeout 60000 --exit

# VS Code integration tests (launches Extension Host)
npm test
```

## Local Development

```bash
# 1. Compile the extension
npm run compile

# 2. Open this folder in VS Code, then press F5
#    This launches the Extension Development Host with the extension loaded.

# Or use watch mode for continuous compilation:
npm run watch
# Then press F5 in VS Code to launch the Extension Development Host.
```

## Packaging

```bash
# Install vsce if you don't have it
npm install -g @vscode/vsce

# Package as .vsix
npx vsce package

# Install the .vsix in VS Code:
#   Extensions panel → ⋯ → Install from VSIX...
```

## Project Structure

```
src/
├── commands/          # Command handlers (branch context menus, etc.)
├── services/          # Core service implementations
│   └── interfaces/    # TypeScript interfaces for all services
├── utils/             # Shared utilities (git CLI, parsers, cache, graphs)
├── extension.ts       # Extension entry point
└── test/
    ├── mocks/         # VS Code API mock for testing outside Extension Host
    ├── unit/          # Unit tests (mocha + assert)
    ├── property/      # Property-based tests (mocha + fast-check)
    └── suite/         # VS Code integration tests
```
