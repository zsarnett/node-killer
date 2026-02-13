# Docker Container Monitoring — Design

## Goal

Add Docker container monitoring to Node Killer so users can see running containers in the tray menu and stop them with a click. Containers group with their project alongside Node/Vite/Bun processes.

## Approach

**Docker CLI (Approach A):** Shell out to `docker ps`, `docker inspect`, `docker stats`, and `docker stop`. Consistent with the existing `lsof`/`ps` pattern. No new dependencies.

## Detection

- `docker ps --format '{{json .}}'` lists running containers (one JSON object per line)
- `docker inspect <id1> <id2> ...` extracts `com.docker.compose.project.working_dir` label for project mapping
- Pass Compose working directory to existing `findProjectName()` for project grouping
- Standalone containers (no Compose labels) use container name as group key
- `docker stats --no-stream --format '{{json .}}'` for CPU/memory in a single batch call
- Graceful degradation: if `docker` CLI not found or daemon not running, silently return empty array

## Data Model

Docker containers are added to `latestProcesses` with this shape:

```js
{
  pid: null,
  containerId: 'abc123',
  containerName: 'my-app-db',
  ports: [5432],
  type: 'docker',
  appName: 'my-app',       // from findProjectName() via Compose label
  cpu: 2.1,
  rss: 51200,              // KB, converted from docker stats
  isListening: true,
}
```

## Menu Integration

- Containers group with same-project processes via shared `appName`
- Menu item format: `    docker postgres — :5432, 2% CPU, 51MB`
- "Kill all" per group and global "Kill all" include Docker containers
- Docker containers count toward the tray process count

## Stopping Containers

- `docker stop <containerId>` (SIGTERM, 10s grace, then SIGKILL — Docker default)
- Menu click handler checks for `containerId` to choose kill path vs `killPid()`
- Error notification on failure, same pattern as process kill failures

## Preferences

New `docker: true` entry in `processTypes` preference object. Single checkbox added to Preferences UI. No other new preferences — Docker piggybacks on existing refresh interval, display mode, etc.

## Performance

- Docker CLI calls (~300-500ms total) run in parallel with existing `lsof`/`ps` calls
- Batch `docker inspect` for all containers instead of per-container calls
- All Docker CLI calls get 4000ms timeout
- No persistent cache of Docker availability — each refresh cycle checks if enabled

## Error Handling

- `docker` not on PATH: skip scanning silently
- Daemon not running: `docker ps` error → empty array, no retry
- `docker stop` failure: error notification to user
- Timeout: 4000ms per CLI call
