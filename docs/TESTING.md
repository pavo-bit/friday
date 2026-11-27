# Testing Guide

## TypeScript / Node.js Suite

Run the full build and deterministic mocked test suite from `friday/`:

```powershell
cd friday
npm test
```

All CI tests use local HTTP mock servers (`tests/openrouterProvider.test.mjs`, `tests/programme2E2E.test.mjs`, `tests/prompt3Reliability.test.mjs`) so no live OpenRouter credits are consumed during normal test runs.

## Rust Claw Workspace

```powershell
cd rust
cargo test --workspace
```

Requires Visual Studio C++ Build Tools (`link.exe`) in `PATH` on Windows.
