# Claw Currentthink Desktop

Claw Currentthink Desktop is a Currentthink-style Electron shell for running and continuing local `claw` CLI conversations. It keeps local task history, conversation state, OpenAI-compatible routing preferences, token counts, and REPL-backed task output in a desktop UI.

## Install

### macOS with Homebrew

```bash
brew tap molcurrent/claw-currentthink
brew install --cask claw-currentthink
```

### GitHub releases

Download the installer for your platform from:

<https://github.com/molcurrent/claw-currentthink-desktop/releases>

- macOS: `.dmg` or `.zip`
- Linux: `.AppImage` or `.deb`
- Windows: `.exe`

## Requirements

- Node.js 20+ for development
- A working `claw` executable on `PATH`, or a configured path in the desktop preferences
- macOS persistent REPL mode uses `/usr/bin/expect`

## Development

```bash
npm install
npm run dev
```

Build the renderer:

```bash
npm run build
```

Create local packages for the current platform:

```bash
npm run dist
```

Platform-specific package commands are also available:

```bash
npm run dist:mac
npm run dist:linux
npm run dist:win
```

Cross-platform release artifacts are built by GitHub Actions when a tag like `v0.1.0` is pushed.

## Source Map

- `src/App.tsx` - main UI, selected conversation, sidebar highlight, and bottom follow-up input
- `src/lib/desktopApi.ts` - frontend IPC entry points
- `src/lib/tokenCounter.ts` - token counting
- `src/types/electron.d.ts` - frontend/backend type definitions
- `electron/main.cjs` - local task database, persistence, task execution loop, output cleanup
- `electron/claw-repl.expect` - REPL launcher script
- `scripts/run-electron.cjs` - development Electron launcher wrapper
- `release/` - local packaging output, ignored by git

Related CLI/provider logic lives in the Claw Code Rust workspace:

- `rust/crates/rusty-claude-cli/src/main.rs`
- `rust/crates/api/src/providers/mod.rs`

## Acknowledgements

Special thanks to [haocenchen](https://github.com/haocenchen).

## License

MIT
