import { formatCode, formatPassword, humanDuration } from '../shared/protocol.js';

/**
 * The client's panel.
 *
 * Renders whatever state the main process reports. It holds no session
 * logic of its own: consent, injection and logging all live in main, so
 * a bug in this file can never quietly grant access.
 */

const $ = (id) => document.getElementById(id);
const api = window.desky;

const views = {
  permissions: $('view-permissions'),
  ready: $('view-ready'),
  request: $('view-request'),
  session: $('view-session'),
  settings: $('view-settings'),
};

let state = null;
let showingSettings = false;
let tick = null;
let tickingFor = null;

/* ------------------------------------------------------------------ *
 * Render
 * ------------------------------------------------------------------ */

function show(name) {
  for (const [key, el] of Object.entries(views)) el.hidden = key !== name;
}

function render(next) {
  try {
    paint(next);
  } catch (err) {
    console.error('[panel] render failed:', err?.message ?? err, err?.stack);
  }
}

function paint(next) {
  state = next;

  // Every instruction that tells the client which row to look for names
  // the app as macOS lists it, which is not always "Desky" — see tccName
  // in main.js.
  if (state.tccName) {
    for (const el of document.querySelectorAll('.tcc-name')) el.textContent = state.tccName;
  }

  // Order is priority, not preference. A live session outranks
  // everything; an incoming request outranks the idle screen; missing
  // permissions outrank the credentials nobody can use without them.
  if (state.session) {
    showingSettings = false;
    renderSession();
    show('session');
  } else if (state.request) {
    showingSettings = false;
    renderRequest();
    show('request');
  } else if (showingSettings) {
    renderSettings();
    show('settings');
  } else if (state.permissionCopy?.blocking) {
    // Only a missing Screen Recording permission takes over the window.
    // A missing Accessibility permission is a downgrade, not a wall, so
    // it is reported inline rather than blocking the credentials the
    // client may be about to read out.
    renderPermissions();
    show('permissions');
  } else {
    renderReady();
    show('ready');
  }
}

/* ---- permissions -------------------------------------------------- */

function renderPermissions() {
  const copy = state.permissionCopy;
  if (copy) {
    $('perm-title').textContent = copy.title;
    $('perm-body').textContent = copy.body;
  }

  $('perm-screen').dataset.granted = String(state.permissions.screen);
  $('perm-accessibility').dataset.granted = String(state.permissions.accessibility);

  // Offered only when Screen Recording was granted after this process
  // started, which is the one case where a restart actually changes
  // anything.
  $('perm-relaunch').hidden = !state.permissions.needsRelaunch;
}

/* ---- ready -------------------------------------------------------- */

function renderReady() {
  $('ready-code').textContent = state.code ? formatCode(state.code) : '— — —';
  $('ready-password').textContent = state.password ? formatPassword(state.password) : '———— ————';

  const limited = $('ready-limited');
  const canControl = state.permissions.canControl && state.injectorAvailable;
  limited.hidden = canControl;
  if (!canControl) {
    $('ready-limited-text').textContent = state.permissionCopy?.body
      ?? 'They will only be able to watch: permission to control has not been given.';

    // The native module failing to load is not something a permission
    // can fix, so do not offer a button that cannot help.
    $('ready-grant').hidden = !state.injectorAvailable;
  }

  $('ready-capture-denied').hidden = !state.captureDenied;

  const locked = $('ready-locked');
  locked.hidden = !state.locked;
  if (state.locked) {
    const seconds = Math.ceil((state.lockRemainingMs ?? 0) / 1000);
    locked.textContent = 'Someone entered the wrong password several times, so their '
      + `connections are blocked for another ${seconds}s. `
      + 'Your password has not changed; if the person you are talking to is the one '
      + 'who mistyped it, read it out again once the block lifts.';
  }

  const el = $('ready-state');
  if (state.connection === 'connected' && state.code) {
    el.className = 'state state-ok';
    el.textContent = 'Ready to connect';
  } else if (state.connection === 'connecting') {
    el.className = 'state state-idle';
    el.textContent = 'Connecting to the server';
  } else {
    el.className = 'state state-warn';
    el.textContent = 'No connection to the server';
  }
}

/* ---- request ------------------------------------------------------ */

function renderRequest() {
  $('request-name').textContent = state.request.operatorName || 'Support';
  $('request-addr').textContent = state.request.operatorAddr || 'unknown';
  $('request-time').textContent = new Date(state.request.at).toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
  });

  const warning = $('request-warning');
  const accept = $('request-accept');

  if (!state.permissions.ok) {
    warning.hidden = false;
    warning.textContent = 'Screen Recording permission has not been given, so your screen cannot be shown. Open settings and turn it on.';
    accept.disabled = true;
  } else if (!state.permissions.canControl || !state.injectorAvailable) {
    warning.hidden = false;
    warning.textContent = 'They will see your screen but cannot click anything. You will be doing the clicking.';
    accept.disabled = false;
  } else {
    warning.hidden = true;
    accept.disabled = false;
  }
}

/* ---- session ------------------------------------------------------ */

function renderSession() {
  const s = state.session;
  $('session-operator').textContent = s.operatorName || 'Support';
  $('session-window').textContent = s.focusedWindow || 'Not known';

  const display = state.displays.find((d) => d.id === s.displayId);
  $('session-display').textContent = display ? display.label : 'Main display';

  const path = $('session-path');
  if (state.stats?.path === 'direct') path.textContent = 'Direct, no relay';
  else if (state.stats?.path === 'relay') path.textContent = 'Through a relay';
  else path.textContent = 'Being established';

  $('session-mode').textContent = s.canControl
    ? 'Watch and control'
    : 'Watch only — cannot control';

  $('kill-hint').textContent = state.killSwitchLabel
    ? `Or press ${state.killSwitchLabel} in any app`
    : '';

  renderFeed(s);
  startTicking(s.startedAt);
}

function renderFeed(s) {
  const feed = $('session-feed');
  const items = [...(s.events ?? [])].reverse();

  if (items.length === 0) {
    feed.innerHTML = '<li class="feed-empty">Nothing has been done yet. Actions will appear here.</li>';
    return;
  }

  feed.replaceChildren(...items.map((event) => {
    const li = document.createElement('li');
    const time = document.createElement('span');
    time.className = 'feed-time';
    time.textContent = new Date(event.at).toLocaleTimeString(undefined, {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    const text = document.createElement('span');
    text.textContent = event.detail;
    li.append(time, text);
    return li;
  }));
}

function startTicking(startedAt) {
  // Restart whenever the session's start time changes, or a session
  // opening in the same second the last one closed inherits the old
  // interval and shows the previous session's elapsed time.
  if (tick && tickingFor === startedAt) return;
  clearInterval(tick);
  tickingFor = startedAt;
  tick = setInterval(() => {
    if (!state?.session) {
      clearInterval(tick);
      tick = null;
      tickingFor = null;
      return;
    }
    $('session-time').textContent = humanDuration(Date.now() - startedAt);
  }, 1000);
  $('session-time').textContent = humanDuration(Date.now() - startedAt);
}

/* ---- settings ----------------------------------------------------- */

function renderSettings() {
  if (document.activeElement !== $('set-name')) $('set-name').value = state.name ?? '';
  if (document.activeElement !== $('set-server')) $('set-server').value = state.serverUrl ?? '';

  const launch = $('set-launch');
  if (document.activeElement !== launch) launch.checked = Boolean(state.launchAtLogin);

  const error = $('set-server-error');
  error.hidden = !state.serverError;
  if (state.serverError) error.textContent = state.serverError;
}

/* ------------------------------------------------------------------ *
 * Events
 * ------------------------------------------------------------------ */

$('request-accept').addEventListener('click', () => api.accept());
$('request-decline').addEventListener('click', () => api.decline());
$('session-end').addEventListener('click', () => api.end());
$('rotate').addEventListener('click', () => api.rotatePassword());

$('open-settings').addEventListener('click', () => {
  showingSettings = true;
  render(state);
});

$('settings-back').addEventListener('click', () => {
  showingSettings = false;
  render(state);
});

$('set-name').addEventListener('change', (event) => api.setName(event.target.value));
$('set-server').addEventListener('change', (event) => api.setServer(event.target.value));
$('set-launch').addEventListener('change', (event) => api.setLaunchAtLogin(event.target.checked));
$('open-logs').addEventListener('click', () => api.openLogs());
$('quit').addEventListener('click', () => api.quit());

for (const button of document.querySelectorAll('[data-permission]')) {
  button.addEventListener('click', () => api.requestPermission(button.dataset.permission));
}

$('ready-grant').addEventListener('click', () => api.requestPermission('accessibility'));
$('ready-fix-capture').addEventListener('click', () => api.requestPermission('screen'));
$('perm-recheck').addEventListener('click', () => api.refresh());
$('perm-relaunch').addEventListener('click', () => api.relaunch());

api.onUpdate(render);
api.ready();

// Belt as well as braces: ask for state directly too, and say so loudly
// if that fails, because the failure mode is a silent blank window.
api.refresh().catch((err) => {
  console.error('[panel] could not load state:', err?.message ?? err);
});
