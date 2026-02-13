const prefsApi = window.nodeKillerPrefs;

const autoLaunchCheckbox = document.querySelector('#autoLaunch');
const autoLaunchHint = document.querySelector('#autoLaunchHint');
const allUsersCheckbox = document.querySelector('#allUsers');
const refreshRadios = Array.from(document.querySelectorAll('input[name="refreshMs"]'));
const displayModeRadios = Array.from(document.querySelectorAll('input[name="displayMode"]'));
const processNodeCheckbox = document.querySelector('#processNode');
const processViteCheckbox = document.querySelector('#processVite');
const processBunCheckbox = document.querySelector('#processBun');
const processClaudeCheckbox = document.querySelector('#processClaude');
const processDockerCheckbox = document.querySelector('#processDocker');
const closeButton = document.querySelector('#closeButton');
const repoLink = document.querySelector('#repoLink');

let state = {
  autoLaunch: false,
  refreshMs: 5000,
  allUsers: false,
  displayMode: 'number',
  processTypes: {
    node: true,
    vite: true,
    bun: true,
    claude: true,
  },
};
let meta = {
  autoLaunchEditable: false,
  refreshChoices: [1000, 5000, 10000, 'paused'],
};

function applyMeta() {
  const isEditable = Boolean(meta.autoLaunchEditable);
  autoLaunchCheckbox.disabled = !isEditable;
  if (autoLaunchHint) {
    if (isEditable) {
      autoLaunchHint.classList.add('hidden');
    } else {
      autoLaunchHint.classList.remove('hidden');
    }
  }
}

function applyState() {
  autoLaunchCheckbox.checked = Boolean(state.autoLaunch);
  allUsersCheckbox.checked = Boolean(state.allUsers);

  refreshRadios.forEach((radio) => {
    const value = radio.value === 'paused' ? 'paused' : Number(radio.value);
    radio.checked = value === state.refreshMs;
  });

  if (state.refreshMs === 'paused') {
    const pausedRadio = refreshRadios.find((radio) => radio.value === 'paused');
    if (pausedRadio) pausedRadio.checked = true;
  }

  displayModeRadios.forEach((radio) => {
    radio.checked = radio.value === state.displayMode;
  });

  // Apply process types state
  if (state.processTypes) {
    processNodeCheckbox.checked = state.processTypes.node !== false;
    processViteCheckbox.checked = state.processTypes.vite !== false;
    processBunCheckbox.checked = state.processTypes.bun !== false;
    processClaudeCheckbox.checked = state.processTypes.claude !== false;
    processDockerCheckbox.checked = state.processTypes.docker !== false;
  }
}

function updateFromPayload(payload) {
  if (!payload) return;
  state = payload.values || state;
  meta = payload.meta || meta;
  applyMeta();
  applyState();
}

async function handleToggleAutoLaunch(event) {
  try {
    const payload = await prefsApi.setAutoLaunch(event.target.checked);
    updateFromPayload(payload);
  } catch (error) {
    console.error('Failed to update auto-launch preference:', error);
    await init();
  }
}

async function handleToggleAllUsers(event) {
  try {
    const payload = await prefsApi.setAllUsers(event.target.checked);
    updateFromPayload(payload);
  } catch (error) {
    console.error('Failed to update all users preference:', error);
    await init();
  }
}

async function handleRefreshChange(event) {
  if (!event.target.checked) return;
  const raw = event.target.value;
  const value = raw === 'paused' ? 'paused' : Number(raw);
  try {
    const payload = await prefsApi.setRefresh(value);
    updateFromPayload(payload);
  } catch (error) {
    console.error('Failed to update refresh interval:', error);
    await init();
  }
}

async function handleDisplayModeChange(event) {
  if (!event.target.checked) return;
  try {
    const payload = await prefsApi.setDisplayMode(event.target.value);
    updateFromPayload(payload);
  } catch (error) {
    console.error('Failed to update display mode:', error);
    await init();
  }
}

async function handleProcessTypeChange(typeName, enabled) {
  try {
    const payload = await prefsApi.setProcessType(typeName, enabled);
    updateFromPayload(payload);
  } catch (error) {
    console.error(`Failed to update process type ${typeName}:`, error);
    await init();
  }
}

async function init() {
  try {
    const payload = await prefsApi.get();
    updateFromPayload(payload);
  } catch (error) {
    console.error('Failed to load preferences:', error);
  }
}

autoLaunchCheckbox.addEventListener('change', handleToggleAutoLaunch);
allUsersCheckbox.addEventListener('change', handleToggleAllUsers);
refreshRadios.forEach((radio) => {
  radio.addEventListener('change', handleRefreshChange);
});
displayModeRadios.forEach((radio) => {
  radio.addEventListener('change', handleDisplayModeChange);
});
processNodeCheckbox.addEventListener('change', (e) => handleProcessTypeChange('node', e.target.checked));
processViteCheckbox.addEventListener('change', (e) => handleProcessTypeChange('vite', e.target.checked));
processBunCheckbox.addEventListener('change', (e) => handleProcessTypeChange('bun', e.target.checked));
processClaudeCheckbox.addEventListener('change', (e) => handleProcessTypeChange('claude', e.target.checked));
processDockerCheckbox.addEventListener('change', (e) => handleProcessTypeChange('docker', e.target.checked));
closeButton.addEventListener('click', () => window.close());
repoLink.addEventListener('click', () => {
  prefsApi
    .openExternal('https://github.com/adolfoflores/node-killer')
    .catch((error) => console.error('Failed to open repository link:', error));
});
repoLink.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    prefsApi
      .openExternal('https://github.com/adolfoflores/node-killer')
      .catch((error) => console.error('Failed to open repository link:', error));
  }
});

document.addEventListener('DOMContentLoaded', init, { once: true });
