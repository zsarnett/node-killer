const { app, Menu, Tray, nativeImage, Notification, dialog, BrowserWindow, ipcMain, shell } = require('electron');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile, exec } = require('child_process');
const { promisify } = require('util');
const prefs = require('./prefs');
const { REFRESH_CHOICES, DEFAULT_REFRESH_MS } = prefs;

const execAsync = promisify(exec);

/**
 * ⚡️ Node Killer: a minimal macOS menubar app that hunts down and kills your stray Node.js processes.
 */

const VITE_PATTERN = /(?:^|[=\/@\s"'`])vite(?:\.js)?(?=$|[\s"'`/:@])/;

function looksLikeViteProcess(commandLine = '') {
  if (!commandLine) return false;
  const normalized = commandLine.toLowerCase().replace(/\\/g, '/');
  return VITE_PATTERN.test(normalized);
}

const CLAUDE_PATTERNS = [/@anthropic/i, /claude-code/i, /(?:^|\s|\/)claude(?:\s|$)/];

function looksLikeClaudeProcess(commandLine = '') {
  if (!commandLine) return false;
  return CLAUDE_PATTERNS.some((p) => p.test(commandLine));
}

// Process type configuration
const PROCESS_TYPES = {
  node: {
    label: 'node',
    lsofCommand: 'node',
    classify: (commandLine) => {
      if (looksLikeClaudeProcess(commandLine)) return null;
      if (looksLikeViteProcess(commandLine)) return null;
      return 'node';
    }
  },
  vite: {
    label: 'vite',
    lsofCommand: 'node', // Vite runs as node process
    classify: (commandLine) => {
      if (looksLikeClaudeProcess(commandLine)) return null;
      if (looksLikeViteProcess(commandLine)) return 'vite';
      return null;
    }
  },
  bun: {
    label: 'bun',
    lsofCommand: 'bun',
    classify: (commandLine) => {
      if (looksLikeClaudeProcess(commandLine)) return null;
      return 'bun';
    }
  },
  claude: {
    label: 'claude',
    lsofCommand: 'node',
    classify: (commandLine) => {
      if (looksLikeClaudeProcess(commandLine)) return 'claude';
      return null;
    }
  },
  docker: {
    label: 'docker',
    lsofCommand: null,
    classify: () => 'docker'
  }
};

let tray = null;
let refreshTimeout = null;
let refreshInFlight = false;
let isQuitting = false;
let refreshQueued = false;
let latestProcesses = [];
let prefsWindow = null;

const isMac = process.platform === 'darwin';

const ICON_RELATIVE_PATH = path.join('assets', 'icons', 'node-killer.icns');

prefs.initPrefsFromEnvIfEmpty();

const ONE_BY_ONE_TRANSPARENT_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGNgYAAAAAMAAWgmWQ0AAAAASUVORK5CYII=';

const LIGHTNING_TEMPLATE_DATA_URL =
  'data:image/svg+xml;base64,PHN2ZyB4bWxucz0naHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmcnIHdpZHRoPScxNicgaGVpZ2h0PScxNicgdmlld0JveD0nMCAwIDE2IDE2Jz48cGF0aCBmaWxsPScjMDAwMDAwJyBkPSdNNy41IDBMMSAxMGg0bC0xIDYgNy0xMGgtNGwwLjUtNnonLz48L3N2Zz4=';

const transparentImage = nativeImage.createFromDataURL(ONE_BY_ONE_TRANSPARENT_PNG);
const lightningImage = nativeImage.createFromDataURL(LIGHTNING_TEMPLATE_DATA_URL);
if (!lightningImage.isEmpty()) {
  lightningImage.setTemplateImage(true);
}
if (!transparentImage.isEmpty()) {
  transparentImage.setTemplateImage(true);
}
const textOnlyImage = transparentImage.resize({ width: 18, height: 18, quality: 'best' });
if (!textOnlyImage.isEmpty()) {
  textOnlyImage.setTemplateImage(true);
}

let cachedTrayIcon = null;

function getTrayIconImage() {
  if (cachedTrayIcon && !cachedTrayIcon.isEmpty()) {
    return cachedTrayIcon;
  }
  const iconPath = getIconPath();
  if (!fs.existsSync(iconPath)) {
    cachedTrayIcon = null;
    return null;
  }
  const image = nativeImage.createFromPath(iconPath);
  if (!image.isEmpty()) {
    image.setTemplateImage(true);
    cachedTrayIcon = image;
    return cachedTrayIcon;
  }
  cachedTrayIcon = null;
  return null;
}

function loadDockIconImage() {
  const iconPath = getIconPath();
  if (!fs.existsSync(iconPath)) return null;
  const image = nativeImage.createFromPath(iconPath);
  if (image && !image.isEmpty()) {
    return image;
  }
  return null;
}

function getIconPath() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, ICON_RELATIVE_PATH);
  }
  return path.join(__dirname, '..', ICON_RELATIVE_PATH);
}

function notify(title, body) {
  try {
    if (Notification.isSupported()) {
      new Notification({ title, body, silent: true }).show();
      return;
    }
  } catch (e) {
    // Fallback to dialog below
  }
  try {
    dialog.showMessageBox({ type: 'info', message: `${title}\n${body}` });
  } catch (e) {
    // As last resort
    console.log(`[Notification] ${title}: ${body}`);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // ESRCH: no such process; EPERM: no permission but exists
    if (err && (err.code === 'EPERM')) return true; // alive but unauthorized
    return false;
  }
}

async function killPid(pid) {
  // Try SIGTERM then SIGKILL
  try {
    process.kill(pid, 'SIGTERM');
  } catch (err) {
    return { pid, ok: false, step: 'SIGTERM', error: err.message || String(err) };
  }

  await sleep(500);
  if (!isPidAlive(pid)) {
    return { pid, ok: true, step: 'SIGTERM' };
  }

  try {
    process.kill(pid, 'SIGKILL');
  } catch (err) {
    return { pid, ok: false, step: 'SIGKILL', error: err.message || String(err) };
  }

  await sleep(300);
  if (!isPidAlive(pid)) {
    return { pid, ok: true, step: 'SIGKILL' };
  }

  return { pid, ok: false, step: 'SIGKILL', error: 'Process still alive after SIGKILL' };
}

async function stopContainer(containerId) {
  try {
    await execAsync(`docker stop ${containerId}`, { timeout: 15000 });
    return { containerId, ok: true, step: 'docker stop' };
  } catch (err) {
    return { containerId, ok: false, step: 'docker stop', error: err.message || String(err) };
  }
}

function parseLsofOutputHuman(stdout, processCommand) {
  const lines = stdout.split(/\r?\n/);
  const processes = new Map(); // pid -> { pid, ports: Set<number>, user, command }

  for (const line of lines) {
    if (!line || line.startsWith('COMMAND') || !/LISTEN/.test(line)) continue;

    const compact = line.trim().replace(/\s+/g, ' ');
    const parts = compact.split(' ');
    if (parts.length < 2) continue;

    const command = parts[0];
    const pidNum = Number(parts[1]);
    const user = parts[2] || '';

    // Keep processes based on the command filter
    if (processCommand === 'node') {
      if (!(command === 'node' || /\bnode(js)?\b/.test(command))) continue;
    } else if (processCommand === 'bun') {
      if (!(command === 'bun' || /\bbun\b/.test(command))) continue;
    }
    if (!Number.isFinite(pidNum)) continue;

    // Extract port(s)
    const m = line.match(/TCP [^\s]*:(\d+) \(LISTEN\)/);
    const port = m ? Number(m[1]) : null;

    if (!processes.has(pidNum)) {
      processes.set(pidNum, { pid: pidNum, user, ports: new Set(), command: processCommand });
    }
    if (port) processes.get(pidNum).ports.add(port);
  }

  return Array.from(processes.values()).map((p) => ({
    pid: p.pid,
    user: p.user,
    ports: Array.from(p.ports).sort((a, b) => a - b),
    command: p.command,
  }));
}

function parseLsofOutputFields(stdout, processCommand) {
  // Parse output from: lsof -F pcPn ...
  const processes = new Map(); // pid -> { pid, ports: Set<number>, user?: string, command }
  let currentPid = null;
  const lines = stdout.split(/\r?\n/);
  for (const line of lines) {
    if (!line) continue;
    const key = line[0];
    const val = line.slice(1);
    if (key === 'p') {
      const pid = Number(val);
      if (!Number.isFinite(pid)) { currentPid = null; continue; }
      currentPid = pid;
      if (!processes.has(pid)) processes.set(pid, { pid, ports: new Set(), command: processCommand });
    } else if (key === 'n') {
      // In -F mode: "*:3000" or "127.0.0.1:5173" (no "(LISTEN)" suffix)
      // We already filter with -sTCP:LISTEN so all matches are listening sockets
      const m = val.match(/:(\d+)$/);
      const port = m ? Number(m[1]) : null;
      if (currentPid && port) {
        processes.get(currentPid).ports.add(port);
      }
    }
  }
  return Array.from(processes.values()).map((p) => ({
    pid: p.pid,
    ports: Array.from(p.ports).sort((a, b) => a - b),
    command: p.command,
  }));
}

function isNoProcessError(error) {
  return Boolean(error && (error.code === 1 || error.code === '1'));
}

// Batch-fetch CPU, RSS, and command line for multiple PIDs in one ps call
async function batchGetProcessStats(pids) {
  const stats = new Map();
  if (!pids.length) return stats;
  try {
    const pidList = pids.join(',');
    const { stdout } = await execAsync(`ps -p ${pidList} -o pid=,%cpu=,rss=,command=`, { timeout: 4000 });
    for (const line of stdout.split(/\r?\n/)) {
      if (!line.trim()) continue;
      const match = line.trim().match(/^(\d+)\s+([\d.]+)\s+(\d+)\s+(.*)$/);
      if (match) {
        stats.set(Number(match[1]), {
          cpu: parseFloat(match[2]),
          rss: parseInt(match[3], 10),
          commandLine: match[4]
        });
      }
    }
  } catch (_) {
    // If batch fails, return empty map — callers handle missing entries
  }
  return stats;
}

// Classify process type from command line string (synchronous)
function classifyFromCommandLine(commandLine, lsofCommand) {
  for (const [, typeConfig] of Object.entries(PROCESS_TYPES)) {
    if (typeConfig.lsofCommand === lsofCommand) {
      const classification = typeConfig.classify(commandLine);
      if (classification) return classification;
    }
  }
  return lsofCommand;
}

// Walk up from a directory to find the project root name
// Uses .git as the project boundary — the first directory with both package.json and .git is the root
// This groups monorepo sub-packages under the root project while respecting git repo boundaries
function findProjectName(dir) {
  const root = path.parse(dir).root;
  const home = os.homedir();
  let current = dir;
  let nearestName = null;
  let outermostProjectName = null;
  while (current && current !== root) {
    if (current === home) break;
    const hasGit = fs.existsSync(path.join(current, '.git'));
    const hasNodeModules = fs.existsSync(path.join(current, 'node_modules'));
    let pkgName = null;
    try {
      const pkgPath = path.join(current, 'package.json');
      const data = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      if (data.name) pkgName = data.name;
    } catch (_) {
      // no package.json here
    }
    if (pkgName && !nearestName) nearestName = pkgName;
    // Track the outermost directory that looks like an installed project
    if (pkgName && hasNodeModules) outermostProjectName = pkgName;
    // A .git directory marks a project boundary — use this name or the nearest we found
    if (hasGit) return pkgName || nearestName;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return outermostProjectName || nearestName;
}

// Get the app/project name for a process by looking up its working directory
async function getProcessAppName(pid) {
  try {
    const { stdout } = await execAsync(`lsof -a -d cwd -p ${pid} -Fn`, { timeout: 2000 });
    const lines = stdout.split(/\r?\n/);
    for (const line of lines) {
      if (line.startsWith('n') && line.length > 1) {
        const cwd = line.slice(1);
        return findProjectName(cwd) || path.basename(cwd);
      }
    }
  } catch (_) {
    // ignore
  }
  return null;
}

// Scan for a specific process command (node or bun)
function scanProcessCommand(processCommand) {
  return new Promise((resolve) => {
    const user = os.userInfo().username;
    const allUsers = prefs.getAllUsers();
    const onlyMine = !allUsers;
    // Use field format to drastically reduce output size
    const args = ['-nP', '-iTCP', '-sTCP:LISTEN', '-a', '-c', processCommand, '-F', 'pcPn'];
    if (onlyMine) {
      args.push('-u', user);
    }

    execFile('lsof', args, { timeout: 4000, maxBuffer: 10 * 1024 * 1024 }, (error, stdout) => {
      if (error) {
        if (isNoProcessError(error)) {
          // lsof exit code 1 == no matching processes
          resolve([]);
          return;
        }

        // Fallback to human parse without -F if field mode failed for any reason
        const humanArgs = ['-nP', '-iTCP', '-sTCP:LISTEN', '-a', '-c', processCommand];
        if (onlyMine) {
          humanArgs.push('-u', user);
        }

        execFile('lsof', humanArgs, { timeout: 3000, maxBuffer: 10 * 1024 * 1024 }, (e2, out2) => {
          if (e2) {
            if (isNoProcessError(e2)) {
              resolve([]);
              return;
            }
            console.debug(`[lsof ${processCommand}] error:`, e2.message || e2);
            resolve([]);
            return;
          }
          try {
            resolve(parseLsofOutputHuman(out2 || '', processCommand));
          } catch (e) {
            console.error(`[parseLsofOutputHuman ${processCommand}] failed:`, e);
            resolve([]);
          }
        });
        return;
      }
      try {
        const results = parseLsofOutputFields(stdout || '', processCommand);
        resolve(results);
      } catch (e) {
        console.error(`[parseLsofOutputFields ${processCommand}] failed:`, e);
        resolve([]);
      }
    });
  });
}

// Scan for non-listening Claude processes (CLI, MCP servers using stdio)
async function scanClaudeProcesses(seenPids) {
  const results = [];
  try {
    const { stdout } = await execAsync('ps -eo pid=,command=', { timeout: 4000 });
    for (const line of stdout.split(/\r?\n/)) {
      if (!line.trim()) continue;
      const match = line.trim().match(/^(\d+)\s+(.*)$/);
      if (!match) continue;
      const pid = Number(match[1]);
      const commandLine = match[2];
      if (pid === process.pid) continue;
      if (seenPids.has(pid)) continue;
      if (!looksLikeClaudeProcess(commandLine)) continue;
      results.push(pid);
    }
  } catch (_) {
    // ignore
  }
  return results;
}

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

// Main function to scan for all enabled process types
async function scanProcessListeners() {
  const enabledTypes = prefs.getProcessTypes();
  const allProcesses = [];
  const seenPids = new Set();

  // Determine which lsof commands we need to run
  const lsofCommands = new Set();
  for (const [typeName, enabled] of Object.entries(enabledTypes)) {
    if (enabled && PROCESS_TYPES[typeName] && PROCESS_TYPES[typeName].lsofCommand) {
      lsofCommands.add(PROCESS_TYPES[typeName].lsofCommand);
    }
  }
  // Claude also uses node as lsof command, ensure it's included if enabled
  if (enabledTypes.claude) {
    lsofCommands.add('node');
  }

  // Collect all raw processes from lsof
  const rawProcesses = [];
  for (const lsofCommand of lsofCommands) {
    const processes = await scanProcessCommand(lsofCommand);
    for (const p of processes) {
      if (!seenPids.has(p.pid)) {
        seenPids.add(p.pid);
        rawProcesses.push({ ...p, lsofCommand });
      }
    }
  }

  // Batch-fetch stats for all PIDs at once
  const allPids = rawProcesses.map((p) => p.pid);
  const stats = await batchGetProcessStats(allPids);

  // Classify each process using batched command line data
  for (const p of rawProcesses) {
    const stat = stats.get(p.pid);
    const commandLine = stat ? stat.commandLine : '';
    const processType = classifyFromCommandLine(commandLine, p.lsofCommand);

    if (enabledTypes[processType]) {
      const appName = await getProcessAppName(p.pid);
      allProcesses.push({
        ...p,
        type: processType,
        appName: appName || processType,
        cpu: stat ? stat.cpu : 0,
        rss: stat ? stat.rss : 0,
        isListening: true,
      });
    }
  }

  // Scan for non-listening Claude processes
  if (enabledTypes.claude) {
    const claudePids = await scanClaudeProcesses(seenPids);
    if (claudePids.length) {
      const claudeStats = await batchGetProcessStats(claudePids);
      for (const pid of claudePids) {
        seenPids.add(pid);
        const stat = claudeStats.get(pid);
        const claudeAppName = await getProcessAppName(pid);
        allProcesses.push({
          pid,
          ports: [],
          command: 'node',
          type: 'claude',
          appName: claudeAppName,
          cpu: stat ? stat.cpu : 0,
          rss: stat ? stat.rss : 0,
          isListening: false,
        });
      }
    }
  }

  // Scan Docker containers
  if (enabledTypes.docker) {
    const dockerContainers = await scanDockerContainers();
    for (const container of dockerContainers) {
      allProcesses.push(container);
    }
  }

  return allProcesses;
}

function formatMemory(rssKB) {
  if (rssKB >= 1048576) return `${(rssKB / 1048576).toFixed(1)}GB`;
  if (rssKB >= 1024) return `${Math.round(rssKB / 1024)}MB`;
  return `${rssKB}KB`;
}

function buildMenuAndUpdate(procs = []) {
  latestProcesses = Array.isArray(procs) ? procs : [];
  const count = latestProcesses.length;

  applyDisplayMode(count);
  tray?.setToolTip(`Node Killer — active processes: ${count}`);

  // Group processes by project name
  // Claude processes with a known project join that project group
  // Claude processes without a project name go into "Claude Code" fallback group
  const groups = new Map();
  for (const p of latestProcesses) {
    let groupKey;
    if (p.type === 'claude' && !p.appName) {
      groupKey = 'Claude Code';
    } else {
      groupKey = p.appName || p.type || 'node';
    }
    if (!groups.has(groupKey)) groups.set(groupKey, []);
    groups.get(groupKey).push(p);
  }

  // Sort groups alphabetically, "Claude Code" last
  const sortedKeys = Array.from(groups.keys()).sort((a, b) => {
    if (a === 'Claude Code') return 1;
    if (b === 'Claude Code') return -1;
    return a.localeCompare(b);
  });

  const items = [];

  for (const groupKey of sortedKeys) {
    const groupProcs = groups.get(groupKey);
    const groupRss = groupProcs.reduce((sum, p) => sum + (p.rss || 0), 0);
    const hasDocker = groupProcs.some((p) => p.type === 'docker');
    const hasClaude = groupProcs.some((p) => p.type === 'claude');
    let icon;
    if (groupKey === 'Claude Code') icon = '🤖';
    else if (hasDocker && hasClaude) icon = '📁🤖🐳';
    else if (hasDocker) icon = '📁🐳';
    else if (hasClaude) icon = '📁🤖';
    else icon = '📁';
    const procWord = groupProcs.length === 1 ? 'proc' : 'procs';

    // Group header
    items.push({
      label: `${icon} ${groupKey} — ${groupProcs.length} ${procWord}, ${formatMemory(groupRss)}`,
      enabled: false,
    });

    // Individual process items
    for (const p of groupProcs) {
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

      items.push({
        label: itemLabel,
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
      });
    }

    // Kill group button (if more than 1 process)
    if (groupProcs.length > 1) {
      items.push({
        label: `    Kill all ${groupKey} (${groupProcs.length})`,
        click: async () => {
          try {
            const { response } = await dialog.showMessageBox({
              type: 'warning',
              buttons: ['Cancel', 'Kill all'],
              defaultId: 1,
              cancelId: 0,
              message: `Kill ${groupProcs.length} ${groupKey} processes?`,
              detail: 'Each process will receive SIGTERM. If it survives, SIGKILL is sent next.',
            });
            if (response !== 1) return;
          } catch (e) {
            console.error('Kill group confirmation failed:', e);
            return;
          }
          let ok = 0;
          let fail = 0;
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
          if (fail === 0) {
            notify('✅ Killed group', `${ok} ${groupKey} processes terminated.`);
          } else {
            notify('⚠️ Kill group', `${ok} succeeded, ${fail} failed.`);
          }
          await performRefresh();
          scheduleNextRefresh();
        },
      });
    }

    items.push({ type: 'separator' });
  }

  items.push({
    label: `Kill all (${count})`,
    enabled: count > 0,
    click: async () => {
      if (count === 0) return;
      try {
        const { response } = await dialog.showMessageBox({
          type: 'warning',
          buttons: ['Cancel', 'Kill all'],
          defaultId: 1,
          cancelId: 0,
          message: count === 1 ? 'Kill 1 process?' : `Kill ${count} processes?`,
          detail: 'Each listed process will receive SIGTERM. If it survives, SIGKILL is sent next.',
        });
        if (response !== 1) return;
      } catch (e) {
        console.error('Kill all confirmation failed:', e);
        return;
      }
      let ok = 0;
      let fail = 0;
      const failed = [];
      const snapshot = [...latestProcesses];
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
      if (fail === 0) {
        notify('✅ Kill all', `${ok} processes terminated.`);
      } else {
        notify('⚠️ Kill all with issues', `${ok} succeeded, ${fail} failed — ${failed.join(', ')}`);
      }
      await performRefresh();
      scheduleNextRefresh();
    },
  });
  items.push({
    label: 'Refresh',
    click: async () => {
      await performRefresh();
      scheduleNextRefresh();
    },
  });
  items.push({
    label: 'Preferences…',
    click: () => {
      openPreferencesWindow();
    },
  });
  items.push({ label: 'Quit', role: 'quit' });

  const menu = Menu.buildFromTemplate(items);
  tray?.setContextMenu(menu);
}

function rebuildMenuFromCache() {
  buildMenuAndUpdate(latestProcesses);
}

function applyDisplayMode(count) {
  if (!tray) return;
  const mode = prefs.getDisplayMode();
  if (isMac) {
    if (mode === 'number') {
      tray.setTitle(` active: ${count} `);
    } else if (mode === 'icon-plus-number') {
      tray.setTitle(`⚡️ ${count}`);
    } else if (mode === 'icon-only') {
      tray.setTitle('');
    } else {
      tray.setTitle(` active: ${count} `);
    }
  }

  if (mode === 'icon-only') {
    const iconImage = getTrayIconImage();
    if (iconImage) {
      tray.setImage(iconImage);
    } else if (!lightningImage.isEmpty()) {
      tray.setImage(lightningImage);
    } else {
      tray.setImage(transparentImage);
      if (isMac) {
        tray.setTitle('⚡️');
      }
    }
  } else {
    tray.setImage(textOnlyImage);
  }
}

function applyAutoLaunchSetting(enabled) {
  if (!isAutoLaunchEditable()) {
    return;
  }
  try {
    app.setLoginItemSettings({
      openAtLogin: Boolean(enabled),
      path: app.getPath('exe'),
    });
  } catch (e) {
    console.error('Failed to update auto-launch setting:', e);
  }
}

function isAutoLaunchEditable() {
  return app.isPackaged && isMac && typeof app.setLoginItemSettings === 'function';
}

function createPreferencesWindow() {
  if (prefsWindow) {
    return prefsWindow;
  }

  const window = new BrowserWindow({
    width: 420,
    height: 750,
    title: 'Preferences',
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    autoHideMenuBar: true,
    show: false,
    backgroundColor: '#1c1f26',
    webPreferences: {
      preload: path.join(__dirname, 'preferences', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  window.once('ready-to-show', () => {
    window.show();
  });

  window.on('closed', () => {
    prefsWindow = null;
  });

  window.setMenu(null);
  window.loadFile(path.join(__dirname, 'preferences', 'index.html')).catch((err) => {
    console.error('Failed to load preferences window:', err);
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  prefsWindow = window;
  return window;
}

function openPreferencesWindow() {
  if (prefsWindow) {
    if (prefsWindow.isMinimized()) prefsWindow.restore();
    prefsWindow.show();
    prefsWindow.focus();
    return;
  }
  createPreferencesWindow();
}

async function performRefresh() {
  if (refreshInFlight) {
    refreshQueued = true;
    return false;
  }
  refreshInFlight = true;
  try {
    const procs = await scanProcessListeners();
    buildMenuAndUpdate(procs);
    return true;
  } catch (e) {
    console.error('Refresh failed:', e);
    return false;
  } finally {
    refreshInFlight = false;
    if (refreshQueued) {
      refreshQueued = false;
      await performRefresh();
    }
  }
}

function createTray() {
  const displayMode = prefs.getDisplayMode();
  let baseImage = textOnlyImage;
  if (displayMode === 'icon-only') {
    baseImage = getTrayIconImage() || (!lightningImage.isEmpty() ? lightningImage : transparentImage);
  }
  try {
    tray = new Tray(baseImage);
  } catch (e) {
    console.error('Failed to create Tray:', e);
    return;
  }
  tray.setToolTip('Node Killer');
  applyDisplayMode(latestProcesses.length);
}

function scheduleNextRefresh() {
  if (isQuitting) return;
  if (refreshTimeout) clearTimeout(refreshTimeout);
  refreshTimeout = null;

  const refreshPref = prefs.getRefreshMs();
  if (refreshPref === 'paused') {
    return;
  }

  let delay = Number(refreshPref);
  if (!Number.isFinite(delay) || delay <= 0) {
    delay = DEFAULT_REFRESH_MS;
    prefs.setRefreshMs(delay);
  }

  refreshTimeout = setTimeout(() => {
    if (isQuitting) return;
    performRefresh()
      .catch((e) => console.error('Auto-refresh failed:', e))
      .finally(() => {
        scheduleNextRefresh();
      });
  }, delay);
}

function buildPreferencesPayload() {
  return {
    values: prefs.getAllPreferences(),
    meta: {
      refreshChoices: REFRESH_CHOICES,
      defaultRefreshMs: DEFAULT_REFRESH_MS,
      autoLaunchEditable: isAutoLaunchEditable(),
      isPackaged: app.isPackaged,
      platform: process.platform,
    },
  };
}

ipcMain.handle('prefs:get', async () => {
  return buildPreferencesPayload();
});

ipcMain.handle('prefs:set-autoLaunch', async (_event, value) => {
  const next = prefs.setAutoLaunch(Boolean(value));
  applyAutoLaunchSetting(next);
  return buildPreferencesPayload();
});

ipcMain.handle('prefs:set-refresh', async (_event, value) => {
  prefs.setRefreshMs(value);
  await performRefresh();
  scheduleNextRefresh();
  rebuildMenuFromCache();
  return buildPreferencesPayload();
});

ipcMain.handle('prefs:set-allUsers', async (_event, value) => {
  const next = prefs.setAllUsers(Boolean(value));
  await performRefresh();
  scheduleNextRefresh();
  rebuildMenuFromCache();
  return buildPreferencesPayload();
});

ipcMain.handle('prefs:set-display', async (_event, value) => {
  prefs.setDisplayMode(value);
  applyDisplayMode(latestProcesses.length);
  rebuildMenuFromCache();
  return buildPreferencesPayload();
});

ipcMain.handle('prefs:set-processType', async (_event, typeName, enabled) => {
  prefs.setProcessType(typeName, enabled);
  await performRefresh();
  scheduleNextRefresh();
  rebuildMenuFromCache();
  return buildPreferencesPayload();
});

ipcMain.handle('prefs:set-processTypes', async (_event, types) => {
  prefs.setProcessTypes(types);
  await performRefresh();
  scheduleNextRefresh();
  rebuildMenuFromCache();
  return buildPreferencesPayload();
});

ipcMain.handle('prefs:openExternal', async (_event, url) => {
  if (typeof url !== 'string' || !url.trim()) {
    return false;
  }
  try {
    await shell.openExternal(url);
    return true;
  } catch (err) {
    console.error('Failed to open external link:', err);
    return false;
  }
});

app.on('window-all-closed', (e) => {
  // Prevent app from quitting (we are menubar-only)
  e.preventDefault();
});

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    notify('ℹ️ Node Killer', 'Node Killer is already running.');
  });
}

app.whenReady().then(async () => {
  if (isMac && app.dock) {
    const dockIcon = loadDockIconImage();
    if (dockIcon) {
      try {
        app.dock.setIcon(dockIcon);
      } catch (err) {
        if (!app.isPackaged) {
          console.debug('Failed to set dock icon:', err);
        }
      }
    }
    try {
      app.setActivationPolicy('accessory');
    } catch (_) {}
    try { app.dock.hide(); } catch (_) {}
  }

  createTray();
  applyAutoLaunchSetting(prefs.getAutoLaunch());
  await performRefresh();
  scheduleNextRefresh();
});

app.on('before-quit', () => {
  isQuitting = true;
  if (refreshTimeout) clearTimeout(refreshTimeout);
});
