# Node Killer

macOS menubar app (Electron) that monitors and terminates Node.js, Vite, and Bun dev server processes.

- **Runtime**: Electron 38 + vanilla JavaScript (CommonJS)
- **Platform**: macOS only (Apple Silicon arm64)
- **Persistence**: electron-store for user preferences

## Commands

```bash
npm install          # Install dependencies
npm run dev          # Launch app in dev mode (electron .)
npm run build        # Build .app/.dmg with electron-builder (-m)
```

Build artifacts go to `dist/`.

## Architecture

```
src/
  main.js                    # Main process: tray, menus, process scanning, IPC handlers
  prefs.js                   # Preferences module (electron-store wrapper)
  preferences/
    index.html               # Preferences window UI
    preload.js               # Context bridge (exposes nodeKillerPrefs API)
    renderer.js              # Preferences window logic
assets/icons/                # App icon (.icns)
```

### Key Patterns

- **Process detection**: Uses `lsof -nP -iTCP -sTCP:LISTEN` to find listening processes, with field-format parsing (`-F pcPn`) as primary and human-readable fallback
- **Vite detection**: Vite runs as a `node` process — classified via regex on `ps -p <pid> -o command=` output
- **Process killing**: SIGTERM first, waits 500ms, then SIGKILL if still alive
- **IPC**: Main ↔ Preferences window communication via `ipcMain.handle` / `ipcRenderer.invoke` with `prefs:` prefixed channels
- **Tray display modes**: `number` (shows count), `icon-plus-number`, `icon-only`
- **Single instance lock**: `app.requestSingleInstanceLock()` prevents duplicate instances

### Preferences (stored via electron-store)

| Key | Type | Default |
|-----|------|---------|
| `autoLaunch` | boolean | false |
| `refreshMs` | number \| 'paused' | 5000 |
| `allUsers` | boolean | false |
| `displayMode` | string | 'number' |
| `processTypes` | {node, vite, bun} | all true |

## No Test Suite

There are no automated tests. Use the manual smoke test from README when verifying changes.
