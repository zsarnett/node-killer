# Docker Container Monitoring — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add Docker container monitoring so running containers appear in the tray menu (grouped with their project) and can be stopped with a click.

**Architecture:** Shell out to Docker CLI (`docker ps`, `docker inspect`, `docker stats`, `docker stop`) during each refresh cycle, in parallel with existing `lsof`/`ps` scans. Docker containers merge into the existing `latestProcesses` array and group by project name using Compose labels + `findProjectName()`.

**Tech Stack:** Electron, Node.js `child_process`, Docker CLI

**Note:** This project has no automated test suite. Each task uses manual smoke testing via `npm run dev`.

---

### Task 1: Add Docker to preferences

**Files:**
- Modify: `src/prefs.js:7-17` (defaults), `src/prefs.js:105-113` (getProcessTypes), `src/prefs.js:116-125` (setProcessTypes)

**Step 1: Add `docker` to defaults and getter/setter**

In `src/prefs.js`, add `docker: true` to the `defaults.processTypes` object:

```js
const defaults = {
  autoLaunch: false,
  refreshMs: DEFAULT_REFRESH_MS,
  allUsers: false,
  displayMode: 'number',
  processTypes: {
    node: true,
    vite: true,
    bun: true,
    claude: true,
    docker: true
  }
};
```

Update `getProcessTypes()`:

```js
function getProcessTypes() {
  const stored = store.get('processTypes');
  return {
    node: stored?.node !== false,
    vite: stored?.vite !== false,
    bun: stored?.bun !== false,
    claude: stored?.claude !== false,
    docker: stored?.docker !== false
  };
}
```

Update `setProcessTypes()`:

```js
function setProcessTypes(types) {
  const sanitized = {
    node: Boolean(types?.node),
    vite: Boolean(types?.vite),
    bun: Boolean(types?.bun),
    claude: Boolean(types?.claude),
    docker: Boolean(types?.docker)
  };
  store.set('processTypes', sanitized);
  return sanitized;
}
```

**Step 2: Verify**

Run: `npm run dev`
Open Preferences. Confirm the app launches without errors. Close app.

**Step 3: Commit**

```bash
git add src/prefs.js
git commit -m "feat: add docker to processTypes preferences"
```

---

### Task 2: Add Docker checkbox to Preferences UI

**Files:**
- Modify: `src/preferences/index.html:145-163` (Process Types section)
- Modify: `src/preferences/renderer.js:11` (checkbox ref), `src/preferences/renderer.js:63-68` (applyState), `src/preferences/renderer.js:150-153` (event listeners)

**Step 1: Add checkbox to HTML**

In `src/preferences/index.html`, add after the Claude Code checkbox (line 161):

```html
<label>
  <input type="checkbox" id="processDocker" />
  Docker
</label>
```

**Step 2: Wire up in renderer.js**

Add the DOM reference near line 11 (after `processClaudeCheckbox`):

```js
const processDockerCheckbox = document.querySelector('#processDocker');
```

In `applyState()`, add after `processClaudeCheckbox.checked` (around line 67):

```js
processDockerCheckbox.checked = state.processTypes.docker !== false;
```

Add event listener after the Claude one (around line 153):

```js
processDockerCheckbox.addEventListener('change', (e) => handleProcessTypeChange('docker', e.target.checked));
```

**Step 3: Verify**

Run: `npm run dev`
Open Preferences. Confirm "Docker" checkbox appears in Process Types section, is checked by default, and toggling it works without errors.

**Step 4: Commit**

```bash
git add src/preferences/index.html src/preferences/renderer.js
git commit -m "feat: add Docker checkbox to preferences UI"
```

---

### Task 3: Implement Docker scanning functions

**Files:**
- Modify: `src/main.js` — add new functions after `scanClaudeProcesses()` (around line 436)

**Step 1: Add `stopContainer()` function**

Add after the `killPid()` function (around line 197):

```js
async function stopContainer(containerId) {
  try {
    await execAsync(`docker stop ${containerId}`, { timeout: 15000 });
    return { containerId, ok: true, step: 'docker stop' };
  } catch (err) {
    return { containerId, ok: false, step: 'docker stop', error: err.message || String(err) };
  }
}
```

**Step 2: Add `scanDockerContainers()` function**

Add after `scanClaudeProcesses()` (around line 436):

```js
async function scanDockerContainers() {
  const results = [];
  let containerList;

  // List running containers
  try {
    const { stdout } = await execAsync('docker ps --format \'{{json .}}\'', { timeout: 4000 });
    const lines = stdout.split(/\r?\n/).filter(Boolean);
    containerList = [];
    for (const line of lines) {
      try {
        containerList.push(JSON.parse(line));
      } catch (_) {
        // skip malformed lines
      }
    }
  } catch (_) {
    // docker not available or daemon not running
    return [];
  }

  if (!containerList.length) return [];

  const containerIds = containerList.map((c) => c.ID);

  // Batch inspect for Compose labels
  let inspectData = [];
  try {
    const { stdout } = await execAsync(`docker inspect ${containerIds.join(' ')}`, { timeout: 4000 });
    inspectData = JSON.parse(stdout);
  } catch (_) {
    // Fall back to no labels
  }

  const inspectMap = new Map();
  for (const info of inspectData) {
    if (info.Id) {
      inspectMap.set(info.Id.slice(0, 12), info);
    }
  }

  // Batch stats for CPU/memory
  const statsMap = new Map();
  try {
    const { stdout } = await execAsync('docker stats --no-stream --format \'{{json .}}\'', { timeout: 4000 });
    for (const line of stdout.split(/\r?\n/).filter(Boolean)) {
      try {
        const stat = JSON.parse(line);
        statsMap.set(stat.ID, stat);
      } catch (_) {
        // skip
      }
    }
  } catch (_) {
    // stats not available
  }

  for (const container of containerList) {
    const shortId = container.ID;
    const inspect = inspectMap.get(shortId) || {};
    const labels = inspect.Config?.Labels || {};
    const stat = statsMap.get(shortId);

    // Parse ports from docker ps Ports field (e.g. "0.0.0.0:5432->5432/tcp")
    const ports = [];
    if (container.Ports) {
      const portMatches = container.Ports.matchAll(/(?:\d+\.\d+\.\d+\.\d+:)?(\d+)->/g);
      for (const m of portMatches) {
        const port = Number(m[1]);
        if (port && !ports.includes(port)) ports.push(port);
      }
    }

    // Project mapping via Compose labels
    const composeWorkDir = labels['com.docker.compose.project.working_dir'];
    const composeService = labels['com.docker.compose.service'];
    let appName = null;
    if (composeWorkDir) {
      appName = findProjectName(composeWorkDir);
    }
    if (!appName) {
      appName = container.Names || shortId;
    }

    // Parse CPU percentage from stats (e.g. "2.31%")
    let cpu = 0;
    if (stat?.CPUPerc) {
      cpu = parseFloat(stat.CPUPerc.replace('%', '')) || 0;
    }

    // Parse memory from stats (e.g. "51.2MiB")
    let rss = 0;
    if (stat?.MemUsage) {
      const memMatch = stat.MemUsage.match(/([\d.]+)\s*(KiB|MiB|GiB|B)/i);
      if (memMatch) {
        const val = parseFloat(memMatch[1]);
        const unit = memMatch[2].toLowerCase();
        if (unit === 'gib') rss = Math.round(val * 1048576);
        else if (unit === 'mib') rss = Math.round(val * 1024);
        else if (unit === 'kib') rss = Math.round(val);
        else rss = Math.round(val / 1024); // bytes to KB
      }
    }

    const containerName = composeService || container.Names || shortId;

    results.push({
      pid: null,
      containerId: shortId,
      containerName,
      ports: ports.sort((a, b) => a - b),
      type: 'docker',
      appName,
      cpu,
      rss,
      isListening: true,
    });
  }

  return results;
}
```

**Step 3: Verify**

Run: `npm run dev`
If Docker is running with containers, they should not appear yet (not wired into scan loop). Confirm app still launches without errors.

**Step 4: Commit**

```bash
git add src/main.js
git commit -m "feat: implement Docker container scanning and stop functions"
```

---

### Task 4: Integrate Docker scanning into refresh cycle

**Files:**
- Modify: `src/main.js:439-515` (`scanProcessListeners()` function)

**Step 1: Add Docker scanning call**

At the end of `scanProcessListeners()`, before the `return allProcesses;` line, add:

```js
// Scan Docker containers
if (enabledTypes.docker) {
  const dockerContainers = await scanDockerContainers();
  for (const container of dockerContainers) {
    allProcesses.push(container);
  }
}
```

**Step 2: Verify**

Run: `npm run dev`
If Docker is running with containers, they should now appear in the tray menu grouped by project. If Docker is not running, the app should still work normally with no errors.

**Step 3: Commit**

```bash
git add src/main.js
git commit -m "feat: integrate Docker scanning into refresh cycle"
```

---

### Task 5: Update menu handlers for Docker containers

**Files:**
- Modify: `src/main.js:523-691` (`buildMenuAndUpdate()` function)

**Step 1: Update individual process click handler**

In `buildMenuAndUpdate()`, the individual process menu item click handler (around line 581) currently calls `killPid(p.pid)`. Update it to handle Docker containers:

```js
click: async () => {
  let res;
  if (p.containerId) {
    res = await stopContainer(p.containerId);
    if (res.ok) {
      notify('✅ Container stopped', `${p.containerName} (${p.containerId})`);
    } else {
      notify('❌ Could not stop container', `${p.containerName} — ${res.error || ''}`);
    }
  } else {
    res = await killPid(p.pid);
    if (res.ok) {
      notify('✅ Process terminated', `PID ${p.pid} (${res.step})`);
    } else {
      notify('❌ Could not terminate', `PID ${p.pid} — ${res.step} — ${res.error || ''}`);
    }
  }
  await performRefresh();
  scheduleNextRefresh();
},
```

**Step 2: Update "Kill all group" handler**

In the group kill handler (around line 598), update the kill loop:

```js
for (const gp of groupProcs) {
  let res;
  if (gp.containerId) {
    res = await stopContainer(gp.containerId);
  } else {
    res = await killPid(gp.pid);
  }
  if (res.ok) ok++;
  else fail++;
}
```

**Step 3: Update global "Kill all" handler**

In the global "Kill all" handler (around line 656), update the kill loop:

```js
for (const processInfo of snapshot) {
  let res;
  if (processInfo.containerId) {
    res = await stopContainer(processInfo.containerId);
  } else {
    res = await killPid(processInfo.pid);
  }
  if (res.ok) ok++;
  else {
    fail++;
    const id = processInfo.containerId || processInfo.pid;
    failed.push(`${id} (${res.step})`);
  }
}
```

**Step 4: Update menu item label for Docker containers**

In the individual process menu item (around line 579), update to show container info:

Replace the label construction block with logic that checks for Docker:

```js
let itemLabel;
if (p.containerId) {
  const ports = Array.isArray(p.ports) ? p.ports : [];
  let portLabel = '';
  if (ports.length === 1) portLabel = ` :${ports[0]}`;
  else if (ports.length > 1) portLabel = ` :${ports.join(', :')}`;
  const cpuStr = `${(p.cpu || 0).toFixed(0)}% CPU`;
  const memStr = formatMemory(p.rss || 0);
  itemLabel = `    🐳 ${p.containerName}${portLabel} — ${cpuStr}, ${memStr}`;
} else {
  const ports = Array.isArray(p.ports) ? p.ports : [];
  let portLabel = '';
  if (ports.length === 1) portLabel = ` :${ports[0]}`;
  else if (ports.length > 1) portLabel = ` :${ports.join(', :')}`;
  const pidLabel = !portLabel ? ` (pid ${p.pid})` : '';
  const cpuStr = `${(p.cpu || 0).toFixed(0)}% CPU`;
  const memStr = formatMemory(p.rss || 0);
  const typeLabel = p.type || 'node';
  itemLabel = `    ${typeLabel}${portLabel}${pidLabel} — ${cpuStr}, ${memStr}`;
}
```

Then use `itemLabel` in the menu item: `label: itemLabel`.

**Step 5: Update group header icon for Docker**

In the group header (around line 558), update the icon logic to include Docker:

```js
const hasDocker = groupProcs.some((p) => p.type === 'docker');
const hasClaude = groupProcs.some((p) => p.type === 'claude');
let icon;
if (groupKey === 'Claude Code') icon = '🤖';
else if (hasDocker && hasClaude) icon = '📁🤖🐳';
else if (hasDocker) icon = '📁🐳';
else if (hasClaude) icon = '📁🤖';
else icon = '📁';
```

**Step 6: Verify**

Run: `npm run dev`
With Docker containers running:
- Containers appear in menu grouped with their project
- Clicking a container stops it and shows notification
- "Kill all" buttons work for groups that include containers
- Group header shows whale emoji when Docker containers present

Without Docker:
- App works normally, no errors

**Step 7: Commit**

```bash
git add src/main.js
git commit -m "feat: update menu handlers to support Docker containers"
```

---

### Task 6: Add Docker entry to PROCESS_TYPES config

**Files:**
- Modify: `src/main.js:32-67` (PROCESS_TYPES object)

**Step 1: Add docker entry**

Add to the `PROCESS_TYPES` object (this is used for labeling, not lsof-based scanning):

```js
docker: {
  label: 'docker',
  lsofCommand: null, // Docker uses its own scanning, not lsof
  classify: () => 'docker'
},
```

**Step 2: Guard against null lsofCommand in scan loop**

In `scanProcessListeners()` where `lsofCommands` is built (around line 446), the existing check `typeName !== 'claude'` should be expanded. Update to skip types with no lsofCommand:

```js
if (enabled && PROCESS_TYPES[typeName] && PROCESS_TYPES[typeName].lsofCommand) {
  lsofCommands.add(PROCESS_TYPES[typeName].lsofCommand);
}
```

This replaces the `typeName !== 'claude'` check. Claude's lsofCommand is `'node'` so it still gets added via the dedicated check below.

**Step 3: Verify**

Run: `npm run dev`
Confirm everything still works — existing process types scan normally, Docker containers appear if running.

**Step 4: Commit**

```bash
git add src/main.js
git commit -m "feat: add docker to PROCESS_TYPES config"
```

---

### Task 7: Final smoke test and cleanup commit

**Step 1: Full smoke test**

Run: `npm run dev`

Test matrix:
- [ ] App launches without errors
- [ ] Docker checkbox appears in Preferences and toggles correctly
- [ ] With Docker containers running: containers appear in tray menu
- [ ] Containers group with same-project Node/Vite/Bun processes
- [ ] Clicking a container stops it, shows notification
- [ ] "Kill all" per group works with mixed process types
- [ ] Global "Kill all" works with Docker containers
- [ ] Disabling Docker in preferences hides containers on next refresh
- [ ] Without Docker installed/running: app works normally, no errors
- [ ] Tray count includes Docker containers

**Step 2: Commit any cleanup**

```bash
git add -A
git commit -m "chore: final cleanup for Docker container monitoring"
```
