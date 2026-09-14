import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  app,
  BrowserWindow,
  clipboard,
  desktopCapturer,
  dialog,
  globalShortcut,
  ipcMain,
  screen,
  session,
  shell,
  webContents,
} from 'electron';

import { Config, normalizeServerUrl } from './config.js';
import { Identity } from './identity.js';
import { InputInjector, activeWindowTitle } from './input.js';
import { SessionLog } from './session-log.js';
import { SignalingClient } from './signaling.js';
import {
  NEEDS_PERMISSIONS,
  checkPermissions,
  openPermissionPane,
  permissionCopy,
  relaunch,
  requestAccessibility,
} from './permissions.js';
import {
  MSG,
  REJECT,
  CTL,
  PROTOCOL_VERSION,
  DEFAULT_QUALITY,
  isQualityPreset,
  decodeInput,
  extractFingerprint,
  computeBinding,
  verifyBinding,
} from '../shared/protocol.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');

// Without this, user data lands in a folder named after the npm
// package ("@desky/host"), where nobody looking for their own session
// log would think to look. Must run before anything reads userData.
app.setName('Desky');

/*
 * Chromium aggressively throttles timers and rendering in windows it
 * believes nobody is looking at. The capture engine is a hidden window
 * by design, so without these the frame rate collapses the moment the
 * agent loses focus — which is always, since the client is working in
 * their own applications.
 */
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');

/* ------------------------------------------------------------------ *
 * State
 * ------------------------------------------------------------------ */

let config;
let identity;
let log;
let injector;
let signaling;

let panelWindow = null;
let engineWindow = null;
let borderWindow = null;

let engineReady = false;
let pendingEngineStart = null;
let pendingRequest = null;
let activeSession = null;
let selectedDisplayId = null;
let connectionStatus = 'offline';
let lastStats = null;
let consentTimer = null;

/**
 * How long this machine will hold a consent question open on its own.
 *
 * Deliberately longer than the server's own window, so in normal
 * operation the server still decides and this never fires. It exists for
 * the case where the server does not.
 */
const CONSENT_DEADLINE_MS = 3 * 60_000;

/**
 * Set when macOS refuses a capture despite the permission looking
 * granted — the stale-entry case. It survives until the next successful
 * session, so the panel can keep saying so.
 */
let captureDenied = false;

/* ------------------------------------------------------------------ *
 * Boot
 * ------------------------------------------------------------------ */

if (!app.requestSingleInstanceLock()) {
  // Normally this means a copy is already running, and focusing it is the
  // right answer. But Chromium's lock records the hostname that took it,
  // and it refuses to reclaim a lock whose hostname no longer matches —
  // which happens after an unclean exit on a machine with a DHCP-assigned
  // name. Quitting silently then leaves a client double-clicking an icon
  // that does nothing, so say what happened and how to clear it.
  const lockFile = path.join(app.getPath('userData'), 'SingletonLock');
  dialog.showErrorBox(
    'Desky is already running',
    'If you cannot find its window, the previous copy may not have shut down '
    + 'cleanly. Restart the computer, or delete this file and open Desky '
    + `again:\n\n${lockFile}`,
  );
  app.quit();
} else {
  app.on('second-instance', () => showPanel());
  app.whenReady().then(boot).catch((err) => {
    console.error('[main] startup failed:', err);
    app.quit();
  });
}

async function boot() {
  config = new Config();
  identity = new Identity();
  log = new SessionLog();
  // Windows scales each display independently, so a point in Electron's
  // device-independent pixels is not the point the injector must click:
  // dipToScreenPoint does that conversion per display, which hand-rolled
  // scaling cannot. It exists only on Windows — elsewhere the two spaces
  // are already the same and the injector is handed nothing, which it
  // reads as "use the point as given".
  //
  // Calling it unconditionally is not a harmless no-op: on macOS the
  // method is absent, so the first pointer move a session ever carried
  // took down the main process.
  injector = new InputInjector({
    dipToScreen: typeof screen.dipToScreenPoint === 'function'
      ? (point) => screen.dipToScreenPoint(point)
      : null,
  });

  selectedDisplayId = screen.getPrimaryDisplay().id;

  installDisplayMediaHandler();
  createEngineWindow();
  createPanelWindow();
  registerKillSwitch();

  applyLaunchAtLogin();

  signaling = new SignalingClient(config.get('serverUrl'));
  signaling.on('status', (status, detail) => {
    connectionStatus = status;
    pushPanelState({ detail });
  });
  signaling.on('open', () => registerWithServer());
  signaling.on('message', handleSignalingMessage);
  signaling.connect();

  app.on('activate', () => showPanel());
  watchPermissions();

  // A client changing resolution or unplugging a monitor mid-session is
  // ordinary — and it silently invalidates the injector target and the
  // border geometry, so both are rebuilt when it happens.
  for (const event of ['display-metrics-changed', 'display-added', 'display-removed']) {
    screen.on(event, () => onDisplaysChanged());
  }
}

/**
 * Polls the OS permission state.
 *
 * macOS sends no notification when a permission is granted, so an agent
 * that only re-checks on other events sits there telling the client to
 * grant something they granted a minute ago. There is a "Check again"
 * button, but a client should not have to know that — the window should
 * simply catch up on its own.
 *
 * The check is two cheap system calls, and it stops mattering entirely
 * once both permissions are in place.
 */
let permissionSignature = null;

function watchPermissions() {
  const poll = setInterval(() => {
    const state = checkPermissions();
    const signature = `${state.screen}|${state.accessibility}|${state.needsRelaunch}`;
    if (signature === permissionSignature) return;

    permissionSignature = signature;
    pushPanelState();

    // A session running without control can gain it the moment the
    // client flips the switch, with no need to reconnect.
    if (activeSession && !activeSession.canControl && state.canControl && InputInjector.available) {
      const display = displayById(activeSession.displayId);
      activeSession.canControl = true;
      injector.enable({ ...display.bounds, scaleFactor: display.scaleFactor });
      noteActivity('permission', 'You granted control — they can now use the pointer');
      pushPanelState();
    }
  }, 2000);
  poll.unref?.();
}

/**
 * Applies the start-at-login preference to the OS.
 *
 * The setting existed in the config file and was read by nothing, so the
 * agent never started with the machine. For a support tool that is the
 * difference between "read me the number" and "first, find Desky in your
 * Applications folder and open it" — asked of someone whose computer is
 * already not working. It stays off until the client turns it on, and it
 * grants nobody access: a session still needs Allow.
 */
function applyLaunchAtLogin() {
  const wanted = Boolean(config.get('launchAtLogin'));
  try {
    // Never in development: this would register the Electron binary from
    // node_modules, which is not something a client ever has.
    if (!app.isPackaged) return;
    app.setLoginItemSettings({ openAtLogin: wanted, openAsHidden: true });
  } catch (err) {
    console.warn('[main] could not set start-at-login:', err.message);
  }
}

function onDisplaysChanged() {
  if (!activeSession) return;

  const display = displayById(activeSession.displayId);
  selectedDisplayId = display.id;
  activeSession.displayId = display.id;

  if (activeSession.canControl) {
    injector.setTarget({ ...display.bounds, scaleFactor: display.scaleFactor });
  }
  createBorderWindow(display);

  engineWindow?.webContents.send('engine:control-out', {
    t: CTL.DISPLAYS,
    active: display.id,
    displays: listDisplays(),
  });
  noteActivity('display', 'Your display settings changed');
}

// Deliberately empty. Electron quits on this event by default outside
// macOS, and the agent must keep running with its window closed —
// otherwise the client's ID goes offline the moment they tidy their
// desktop, and the next support call starts with "it says offline".
app.on('window-all-closed', () => {});

// Cmd+Q, the Dock menu, logout and shutdown all arrive here. Without
// this the panel's close handler calls preventDefault() and Electron
// reads the cancelled close as a cancelled quit: the app merely hid,
// will-quit never ran, and macOS told the client that Desky had
// stopped their shutdown.
app.on('before-quit', () => {
  app.isQuitting = true;
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  injector?.disable();
  signaling?.close();
  log?.close();
});

/* ------------------------------------------------------------------ *
 * Windows
 * ------------------------------------------------------------------ */

function createEngineWindow() {
  engineWindow = new BrowserWindow({
    show: false,
    width: 480,
    height: 320,
    webPreferences: {
      preload: path.join(here, 'preload-engine.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      // This renderer is the one exposed to remote SDP and remote
      // DataChannel traffic, on a machine that has just been granted
      // Screen Recording and Accessibility. It gets the OS sandbox.
      sandbox: true,
      backgroundThrottling: false,
    },
  });

  watchRenderer(engineWindow, 'engine');
  engineWindow.loadFile(path.join(ROOT, 'renderer', 'engine.html'));
  engineWindow.on('closed', () => { engineWindow = null; engineReady = false; });
}

function createPanelWindow() {
  panelWindow = new BrowserWindow({
    width: 460,
    height: 640,
    minWidth: 420,
    minHeight: 560,
    show: false,
    title: 'Desky',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    backgroundColor: '#f4f1ea',
    webPreferences: {
      preload: path.join(here, 'preload-panel.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  watchRenderer(panelWindow, 'panel');
  panelWindow.loadFile(path.join(ROOT, 'renderer', 'panel.html'));
  panelWindow.once('ready-to-show', () => panelWindow.show());

  // Also push on load, so a reload repaints without waiting for the
  // next state change.
  panelWindow.webContents.on('did-finish-load', () => pushPanelState());

  // Closing the window hides the agent rather than stopping it.
  panelWindow.on('close', (event) => {
    if (app.isQuitting) return;
    event.preventDefault();
    panelWindow.hide();
  });

  panelWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
}

/**
 * A click-through frame around the shared display.
 *
 * This is the product's central promise made physical: while anyone is
 * connected, the client's own screen is visibly bordered, and no
 * arrangement of windows can cover it. It ignores mouse events so it
 * never interferes with the work being done.
 */
function createBorderWindow(display) {
  destroyBorderWindow();

  borderWindow = new BrowserWindow({
    ...display.bounds,
    frame: false,
    transparent: true,
    hasShadow: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    focusable: false,
    show: false,
    webPreferences: {
      preload: path.join(here, 'preload-border.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  });

  borderWindow.setIgnoreMouseEvents(true, { forward: false });
  borderWindow.setAlwaysOnTop(true, 'screen-saver');

  // Without this the frame vanishes the moment the client switches to a
  // fullscreen app — exactly when they most need to see it.
  if (process.platform === 'darwin') {
    borderWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  }

  watchRenderer(borderWindow, 'border');
  borderWindow.loadFile(path.join(ROOT, 'renderer', 'border.html'));
  borderWindow.once('ready-to-show', () => {
    borderWindow?.showInactive();
    pushBorderState();
  });
}

function destroyBorderWindow() {
  if (!borderWindow) return;
  const win = borderWindow;
  borderWindow = null;
  try { win.destroy(); } catch { /* already gone */ }
}

/**
 * Surfaces renderer failures in the agent's own log.
 *
 * Without this a broken renderer script simply leaves a blank window:
 * every section starts hidden and the script that reveals one never
 * runs. On a client's machine that is indistinguishable from a hang, so
 * the error has to reach somewhere a person can read it.
 */
function watchRenderer(win, label) {
  win.webContents.on('will-navigate', (event, url) => {
    if (url !== win.webContents.getURL()) {
      console.error('[%s] navigation blocked: %s', label, url);
      event.preventDefault();
    }
  });

  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  // Electron changed this event's shape: older versions pass
  // (event, level, message, line, sourceId) as positional arguments, newer
  // ones pass a single object. Reading only the object form meant every
  // renderer error was swallowed — which is why a blank window looked
  // like it had no error at all.
  win.webContents.on('console-message', (...args) => {
    const [first, level, message, line, sourceId] = args;
    const detail = typeof first === 'object' && first !== null && 'message' in first
      ? {
        level: String(first.level ?? 'log'),
        message: first.message,
        source: `${first.sourceId ?? '?'}:${first.lineNumber ?? '?'}`,
      }
      : {
        level: level === 3 ? 'error' : level === 2 ? 'warning' : String(level),
        message,
        source: `${sourceId ?? '?'}:${line ?? '?'}`,
      };

    if (detail.level === 'error' || detail.level === 'warning') {
      console.error('[%s] %s (%s)', label, detail.message, detail.source);
    }
  });

  win.webContents.on('did-fail-load', (_e, code, description, url) => {
    console.error('[%s] failed to load: %s (%s) %s', label, description, code, url);
  });

  win.webContents.on('render-process-gone', (_e, details) => {
    console.error('[%s] renderer process gone: %s', label, details.reason);
    if (win === engineWindow) {
      engineReady = false;
      if (activeSession) endSession('engine_crashed');

      // A crashed window is not a destroyed one, so nothing downstream
      // rebuilds it: acceptRequest's guard tests isDestroyed(), which is
      // still false, and would arm the injector and draw the border for
      // a session whose engine can never report ready. Bring it back now,
      // while nobody is waiting on it.
      if (!win.isDestroyed()) win.reload();
    }
  });
}

function showPanel() {
  if (!panelWindow) {
    createPanelWindow();
    return;
  }
  panelWindow.show();
  panelWindow.focus();
}

/**
 * Puts the consent request in front of whatever the client is doing.
 *
 * `show()` and `focus()` are not enough: macOS will not let a
 * background app take the foreground on its own, so the window comes up
 * silently behind everything and the request expires unanswered. That
 * is a broken support tool — the operator says "press Allow" on the
 * phone and the client sees nothing.
 *
 * So: steal focus, float above other windows for as long as the
 * question is open, and bounce the dock icon until it is answered. All
 * of it is dropped again the moment the request resolves, because a
 * window that stays on top after that would be the tool making itself
 * a nuisance.
 */
function demandAttention() {
  if (!panelWindow || panelWindow.isDestroyed()) return;

  panelWindow.show();
  panelWindow.setAlwaysOnTop(true, 'floating');
  panelWindow.focus();

  app.focus({ steal: true });

  if (process.platform === 'darwin') {
    // 'critical' keeps bouncing until the app is brought forward.
    dockBounceId = app.dock?.bounce('critical') ?? null;
  }
}

function releaseAttention() {
  if (dockBounceId != null) {
    app.dock?.cancelBounce(dockBounceId);
    dockBounceId = null;
  }
  if (panelWindow && !panelWindow.isDestroyed()) {
    panelWindow.setAlwaysOnTop(false);
  }
}

let dockBounceId = null;

/* ------------------------------------------------------------------ *
 * Screen capture source selection
 * ------------------------------------------------------------------ */

function installDisplayMediaHandler() {
  session.defaultSession.setDisplayMediaRequestHandler(async (request, callback) => {
    // Capture is only ever legitimate for the engine, during a session a
    // person on this machine agreed to. Anything else is refused.
    //
    // The frame is matched by the webContents it belongs to, not by
    // object identity: Electron does not guarantee that `request.frame`
    // is the very same WebFrameMain instance as `mainFrame`, and when it
    // is not, the agent silently refuses its own capture and the session
    // dies one second after the client pressed Allow.
    if (!activeSession) {
      console.error('[main] screen capture refused: no session is running');
      callback({});
      return;
    }

    const asking = request.frame ? webContents.fromFrame(request.frame) : null;
    if (!engineWindow || engineWindow.isDestroyed() || asking !== engineWindow.webContents) {
      console.error('[main] screen capture refused: request came from outside the engine');
      callback({});
      return;
    }

    try {
      const sources = await desktopCapturer.getSources({
        types: ['screen'],
        fetchWindowIcons: false,
        thumbnailSize: { width: 0, height: 0 },
      });

      const wanted = String(selectedDisplayId);
      const chosen = sources.find((s) => s.display_id === wanted) ?? sources[0];


      if (!chosen) {
        callback({});
        return;
      }
      callback({ video: chosen });
    } catch (err) {
      console.error('[main] could not get a screen source:', err);
      callback({});
    }
  }, { useSystemPicker: false });

  // Nothing here needs a camera, a microphone, notifications or the
  // clipboard-read permission, so none of them are granted.
  //
  // `media` is the one exception, and refusing it blanket-style is a
  // trap worth spelling out: Chromium runs this request past the page
  // before the handler above is ever consulted, so a flat `false`
  // refuses the agent its own screen capture. The session then dies a
  // second after the client pressed Allow, and the failure arrives as
  // NotAllowedError — indistinguishable from macOS withholding Screen
  // Recording, which sends everyone digging through System Settings for
  // a permission that was never the problem.
  //
  // So it is granted on exactly the terms the display-media handler
  // above already demands: the engine's own frame, during a session a
  // person at this machine agreed to. Nothing else, at no other time.
  session.defaultSession.setPermissionRequestHandler((contents, permission, callback) => {
    if (permission !== 'media') return callback(false);
    if (!activeSession) return callback(false);
    if (!engineWindow || engineWindow.isDestroyed()) return callback(false);
    callback(contents === engineWindow.webContents);
  });
  session.defaultSession.setPermissionCheckHandler(() => false);
}

function listDisplays() {
  const primaryId = screen.getPrimaryDisplay().id;
  return screen.getAllDisplays().map((display, index) => ({
    id: display.id,
    label: display.id === primaryId ? 'Main display' : `Display ${index + 1}`,
    width: display.size.width,
    height: display.size.height,
    scaleFactor: display.scaleFactor,
    bounds: display.bounds,
    primary: display.id === primaryId,
  }));
}

function displayById(id) {
  return screen.getAllDisplays().find((d) => d.id === id) ?? screen.getPrimaryDisplay();
}

/* ------------------------------------------------------------------ *
 * Signaling
 * ------------------------------------------------------------------ */

function registerWithServer() {
  // A reconnect means the server has forgotten anything it had not
  // finished. A consent question left over from before the drop can no
  // longer be answered — pressing Allow would arm the injector and start
  // capturing for a session id the server would discard — so it is
  // withdrawn rather than left on screen.
  //
  // A session that is already running is left alone on purpose: its
  // media is peer-to-peer and unaffected by this socket.
  if (pendingRequest) {
    console.warn('[main] dropping a consent request that did not survive the reconnect');
    pendingRequest = null;
    clearTimeout(consentTimer);
    consentTimer = null;
    releaseAttention();
    identity.rotatePassword();
    pushPanelState();
  }

  signaling.send({
    t: MSG.HOST_REGISTER,
    protocol: PROTOCOL_VERSION,
    code: identity.code,
    token: identity.token,
    name: identity.name,
    platform: process.platform,
  });
}

async function handleSignalingMessage(msg) {
  switch (msg.t) {
    case MSG.HOST_REGISTERED:
      identity.adopt({ code: msg.code, token: msg.token });
      pushPanelState();
      break;

    case MSG.HOST_REQUEST:
      await handleIncomingRequest(msg);
      break;

    case MSG.HOST_PEER_GONE:
      if (activeSession?.id === msg.sessionId) {
        endSession(msg.reason || 'operator_gone');
      } else if (pendingRequest?.sessionId === msg.sessionId) {
        pendingRequest = null;
        clearTimeout(consentTimer);
        consentTimer = null;
        releaseAttention();
        // The request expired or the operator walked away; the password
        // has already been spoken, so it does not get a second life.
        identity.rotatePassword();
        pushPanelState();
      }
      break;

    case MSG.SIGNAL: {
      if (activeSession?.id !== msg.sessionId || !msg.payload) break;

      // An answer decides who this machine encrypts to for the rest of
      // the session, so it is only accepted from someone who can prove
      // they hold the password by signing their own fingerprint.
      if (msg.payload.type === 'answer') {
        const ok = await verifyBinding(
          activeSession.password,
          'answer',
          activeSession.id,
          msg.payload.sdp,
          msg.payload.bind,
        );
        if (!ok) {
          console.error('[main] the answer is not signed with the session password — ending');
          noteActivity('security', 'Connection stopped: could not confirm who was connecting');
          endSession('binding_failed');
          break;
        }
      }

      engineWindow?.webContents.send('engine:signal', { payload: msg.payload });
      break;
    }

    case MSG.ERROR:
      console.warn('[main] server says:', msg.message);

      // Two copies of the agent on one machine would otherwise fight
      // forever: the server hands the ID to whichever registered last,
      // the displaced one reconnects and takes it back, and neither ever
      // settles. The copy that was displaced stands down instead.
      if (msg.reason === REJECT.DISPLACED) {
        signaling.close();
        connectionStatus = 'displaced';
        pushPanelState();
        dialog.showErrorBox(
          'Another copy of Desky is running',
          'This window has stopped connecting so the two copies do not fight '
          + 'over the same computer number. Quit the other copy, then reopen '
          + 'Desky.',
        );
      }
      break;

    default:
      break;
  }
}

/**
 * An operator wants in.
 *
 * Two gates, in this order: the machine checks the password proof
 * itself, and only then does a human get asked. Reversing that order
 * would turn the consent dialog into a doorbell anyone on the internet
 * could ring.
 */
async function handleIncomingRequest(msg) {
  if (activeSession || pendingRequest) {
    signaling.send({ t: MSG.HOST_DECISION, sessionId: msg.sessionId, accept: false, reason: REJECT.BUSY });
    return;
  }

  const valid = await identity.verify({
    proof: msg.proof,
    nonce: msg.nonce,
    sessionId: msg.sessionId,
    source: msg.operatorAddr,
  });

  if (!valid) {
    // "Wrong password" for a correct password is worse than unhelpful:
    // the operator retries, and the server counts every retry against
    // their address. REJECT.LOCKED has console copy and was never sent.
    const reason = identity.lockedFor(msg.operatorAddr) ? REJECT.LOCKED : REJECT.BAD_PASSWORD;

    log.declined({
      sessionId: msg.sessionId,
      operatorName: msg.operatorName,
      reason,
    });
    startLockCountdown();
    signaling.send({
      t: MSG.HOST_DECISION,
      sessionId: msg.sessionId,
      accept: false,
      reason,
    });
    pushPanelState();
    return;
  }

  const permissions = checkPermissions();

  pendingRequest = {
    sessionId: msg.sessionId,
    operatorName: msg.operatorName,
    operatorAddr: msg.operatorAddr,
    iceServers: msg.iceServers ?? [],
    at: Date.now(),
    permissions,
  };

  // The consent deadline used to live only on the server. A server that
  // never sent the expiry — hostile, restarted, or simply unreachable —
  // left the question on screen indefinitely, floating above every other
  // window with the dock icon bouncing, while the machine refused every
  // other request as busy. A dialog that will not go away is also how a
  // person ends up pressing Allow to be rid of it, so the machine keeps
  // its own clock.
  clearTimeout(consentTimer);
  consentTimer = setTimeout(() => {
    if (pendingRequest?.sessionId !== msg.sessionId) return;
    console.warn('[main] nobody answered the request and the server never expired it');
    declineRequest(REJECT.TIMEOUT);
  }, CONSENT_DEADLINE_MS);
  consentTimer.unref?.();

  log.requested(pendingRequest);

  pushPanelState();
  demandAttention();
}

/* ------------------------------------------------------------------ *
 * Session lifecycle
 * ------------------------------------------------------------------ */

function acceptRequest() {
  if (!pendingRequest) return;

  const permissions = checkPermissions();
  if (!permissions.ok) {
    // Without Screen Recording there is nothing to send, so the request
    // stays open and the panel says exactly what is missing rather than
    // opening a session that shows a black rectangle.
    pendingRequest.permissions = permissions;
    pushPanelState();
    return;
  }

  const request = pendingRequest;
  pendingRequest = null;
  clearTimeout(consentTimer);
  consentTimer = null;
  releaseAttention();

  const display = displayById(selectedDisplayId);
  const canControl = permissions.canControl && InputInjector.available;

  activeSession = {
    id: request.sessionId,
    operatorName: request.operatorName,
    operatorAddr: request.operatorAddr,
    startedAt: Date.now(),
    displayId: display.id,
    quality: config.get('quality') || DEFAULT_QUALITY,
    password: identity.password,
    canControl,
    events: [],
  };

  captureDenied = false;

  if (canControl) {
    injector.enable({ ...display.bounds, scaleFactor: display.scaleFactor });
  }
  createBorderWindow(display);

  log.started({
    sessionId: activeSession.id,
    operatorName: activeSession.operatorName,
    operatorAddr: activeSession.operatorAddr,
    display: display.id,
  });
  noteActivity('start', canControl
    ? `Session started: ${activeSession.operatorName}`
    : `Session started: ${activeSession.operatorName} — view only`);

  signaling.send({
    t: MSG.HOST_DECISION,
    sessionId: activeSession.id,
    accept: true,
    displays: listDisplays(),
    canControl,
  });

  // The engine window is created at boot and normally long since ready.
  // If its renderer died at some point, rebuild it rather than sending
  // a start command into nothing and leaving the client staring at an
  // accepted request that never becomes a session. A crashed renderer
  // leaves the window very much alive, so isDestroyed() alone missed it.
  if (!engineWindow || engineWindow.isDestroyed() || engineWindow.webContents.isCrashed()) {
    engineReady = false;
    if (engineWindow && !engineWindow.isDestroyed()) engineWindow.destroy();
    createEngineWindow();
  }

  const startedId = activeSession.id;
  const startEngine = () => {
    // The session can end between accepting and the engine reporting
    // ready. Starting then would capture the screen for a session that
    // no longer exists.
    if (activeSession?.id !== startedId) return;
    engineWindow?.webContents.send('engine:start', {
      sessionId: startedId,
      iceServers: request.iceServers ?? [],
      display: {
          id: display.id,
          width: display.size.width,
          height: display.size.height,
          scaleFactor: display.scaleFactor,
        },
      preset: activeSession.quality,
    });
  };

  if (engineReady) {
    startEngine();
  } else {
    pendingEngineStart = () => { engineReady = true; startEngine(); };
    ipcMain.once('engine:ready', pendingEngineStart);
  }

  pushPanelState();
}

function declineRequest(reason = REJECT.DECLINED) {
  if (!pendingRequest) return;
  clearTimeout(consentTimer);
  consentTimer = null;
  log.declined({
    sessionId: pendingRequest.sessionId,
    operatorName: pendingRequest.operatorName,
    reason,
  });
  signaling.send({
    t: MSG.HOST_DECISION,
    sessionId: pendingRequest.sessionId,
    accept: false,
    reason,
  });
  pendingRequest = null;
  releaseAttention();
  identity.rotatePassword();
  pushPanelState();
}

function endSession(reason = 'client_ended') {
  if (!activeSession) return;

  const finished = activeSession;
  activeSession = null;

  if (pendingEngineStart) {
    ipcMain.removeListener('engine:ready', pendingEngineStart);
    pendingEngineStart = null;
  }

  // Order matters: release held keys before anything else, so a dropped
  // session can never leave a modifier stuck down on the client's own
  // keyboard.
  injector.disable();
  destroyBorderWindow();

  engineWindow?.webContents.send('engine:stop', { sessionId: finished.id });
  signaling.send({ t: MSG.HOST_END, sessionId: finished.id, reason });

  log.ended({
    sessionId: finished.id,
    operatorName: finished.operatorName,
    durationMs: Date.now() - finished.startedAt,
    counters: injector.counters,
    reason,
  });

  // A new password for the next caller: the one just used has been read
  // aloud over the phone and should not open a second session.
  identity.rotatePassword();
  lastStats = null;

  // Nothing from this session carries into the next one: not the
  // monitor the last operator picked, not the window title cache that
  // would suppress the first activity line.
  selectedDisplayId = screen.getPrimaryDisplay().id;
  lastWindowTitle = null;

  pushPanelState();
  showPanel();
}

/**
 * Repaints the panel once a second while the machine is locked out.
 *
 * Nothing else pushes state during a lockout, so without this the
 * client sees a frozen countdown — on the one screen that has to
 * explain why the password they just read out has changed.
 */
let lockTimer = null;

function startLockCountdown() {
  if (lockTimer || !identity.locked) {
    pushPanelState();
    return;
  }
  lockTimer = setInterval(() => {
    pushPanelState();
    if (!identity.locked) {
      clearInterval(lockTimer);
      lockTimer = null;
    }
  }, 1000);
  lockTimer.unref?.();
  pushPanelState();
}

function noteActivity(kind, detail) {
  if (!activeSession) return;
  const entry = { at: Date.now(), kind, detail };
  activeSession.events.push(entry);
  if (activeSession.events.length > 200) activeSession.events.shift();
  log.note({ sessionId: activeSession.id, kind, detail });
  pushPanelState();
  pushBorderState();
}

function registerKillSwitch() {
  const accelerator = config.get('killSwitch');
  try {
    globalShortcut.register(accelerator, () => {
      if (activeSession) endSession('kill_switch');
      else if (pendingRequest) declineRequest();
      showPanel();
    });
  } catch (err) {
    console.warn('[main] could not register the hotkey:', err.message);
  }
}

/* ------------------------------------------------------------------ *
 * Engine IPC
 * ------------------------------------------------------------------ */

ipcMain.on('engine:ready', () => { engineReady = true; });

/**
 * Signs this machine's own DTLS fingerprint with the session password
 * before the offer leaves for the server.
 *
 * The server decides whose description reaches whom, so without this it
 * could hand the operator its own offer and this agent its own answer,
 * and sit in the middle of a session both ends believe is direct. It
 * never learns the password, so it cannot sign a fingerprint it owns.
 */
ipcMain.on('engine:signal-out', async (_event, payload) => {
  if (!activeSession || !payload) return;
  const sessionId = activeSession.id;

  if (payload.type === 'offer') {
    const fingerprint = extractFingerprint(payload.sdp);
    if (!fingerprint) {
      console.error('[main] the offer carries no DTLS fingerprint, ending the session');
      endSession('no_fingerprint');
      return;
    }
    payload.bind = await computeBinding(
      activeSession.password,
      'offer',
      sessionId,
      fingerprint,
    );
  }

  // The session can end while the binding is being computed.
  if (activeSession?.id !== sessionId) return;
  signaling.send({ t: MSG.SIGNAL, sessionId, payload });
});

ipcMain.on('engine:state', (_event, payload) => {
  if (payload?.state === 'capture-ended' && activeSession) {
    endSession('capture_ended');
    return;
  }
  if (payload?.state === 'failed' && activeSession) {
    // Distinguish "the OS would not let us record" from a network
    // failure. They look identical from the outside — the session simply
    // vanishes a second after the client pressed Allow — and only one of
    // them is something they can fix.
    if (payload.captureDenied) {
      console.error('[main] screen capture denied by macOS for this build');
      noteActivity('permission', 'macOS refused to record the screen — check Screen Recording for Desky');
      endSession('capture_denied');
      captureDenied = true;
      pushPanelState();
      return;
    }
    endSession('connection_failed');
    return;
  }
  pushPanelState({ engineState: payload?.state });
});

ipcMain.on('engine:stats', (_event, stats) => {
  lastStats = stats;
  pushPanelState();
  pushBorderState();
});

/**
 * Input frames arrive here as raw bytes and are injected immediately.
 *
 * No queue, no batching: this is the path the operator feels, and every
 * millisecond spent here is a millisecond of lag on their cursor.
 */
ipcMain.on('engine:input', (_event, buffer) => {
  if (!activeSession) return;
  const frame = decodeInput(buffer);
  if (!frame) return;
  const tag = injector.apply(frame);
  if (tag) markActivity(tag);
});

ipcMain.on('engine:control', (_event, msg) => {
  if (!activeSession || !msg) return;

  switch (msg.t) {
    case CTL.SELECT_DISPLAY: {
      const display = displayById(msg.id);
      selectedDisplayId = display.id;
      activeSession.displayId = display.id;
      injector.setTarget({ ...display.bounds, scaleFactor: display.scaleFactor });
      createBorderWindow(display);
      engineWindow?.webContents.send('engine:set-display', {
        display: {
          id: display.id,
          width: display.size.width,
          height: display.size.height,
          scaleFactor: display.scaleFactor,
        },
      });
      noteActivity('display', 'They switched to another display');
      break;
    }

    case CTL.QUALITY:
      // SELECT_DISPLAY and CLIPBOARD_PUSH both check what they are
      // handed; this one did not, and it is the one that writes to disk.
      if (!isQualityPreset(msg.preset)) break;
      activeSession.quality = msg.preset;
      config.set('quality', msg.preset);
      engineWindow?.webContents.send('engine:set-quality', { preset: msg.preset });
      break;

    case CTL.HELD:
      // The operator's browser says what it believes is down. Anything
      // this machine is holding that is not on that list gets released.
      // Without this a lost release, a cancelled touch gesture, or a
      // letter released under Command on macOS leaves a key physically
      // down for the rest of the session.
      if (activeSession.canControl) {
        injector.reconcileHeld({
          keys: Array.isArray(msg.keys) ? msg.keys : [],
          buttons: Array.isArray(msg.buttons) ? msg.buttons : [],
        });
      }
      break;

    case CTL.CLIPBOARD_PULL:
      // Reading the client's clipboard is exactly the kind of thing they
      // deserve to see named, so it is logged and shown, not silent.
      noteActivity('clipboard', 'They read your clipboard');
      engineWindow?.webContents.send('engine:clipboard-data', {
        text: clipboard.readText().slice(0, 100_000),
      });
      break;

    case CTL.CLIPBOARD_PUSH:
      if (typeof msg.text === 'string') {
        clipboard.writeText(msg.text.slice(0, 100_000));
        noteActivity('clipboard', 'They put text on your clipboard');
      }
      break;

    case CTL.BYE:
      endSession('operator_ended');
      break;

    default:
      break;
  }
});

ipcMain.handle('engine:list-displays', () => listDisplays());

/**
 * Coalesced activity signal.
 *
 * Clicks and keystrokes arrive faster than any interface should redraw,
 * so the panel and the border learn about them at a fixed low rate
 * instead of once per event.
 */
let activityDirty = false;
let activityTimer = null;
let lastWindowTitle = null;

function markActivity(tag) {
  if (!activeSession) return;
  activeSession.lastAction = tag;
  activeSession.lastActionAt = Date.now();
  activityDirty = true;

  if (activityTimer) return;
  activityTimer = setInterval(() => {
    if (!activeSession) {
      clearInterval(activityTimer);
      activityTimer = null;
      return;
    }
    if (!activityDirty) return;
    activityDirty = false;

    const title = activeWindowTitle();
    if (title && title !== lastWindowTitle) {
      lastWindowTitle = title;
      activeSession.focusedWindow = title;
    }

    pushPanelState();
    pushBorderState();
  }, 500);
}

/* ------------------------------------------------------------------ *
 * Panel IPC
 * ------------------------------------------------------------------ */

// The renderer says when it can receive. Pushing before that races the
// script and leaves every section hidden — a blank window that looks
// exactly like a hang.
ipcMain.on('panel:ready', () => pushPanelState());

ipcMain.handle('panel:state', () => panelState());
ipcMain.on('panel:accept', () => acceptRequest());
ipcMain.on('panel:decline', () => declineRequest());
ipcMain.on('panel:end', () => endSession('client_ended'));
ipcMain.on('panel:rotate-password', () => {
  identity.rotatePassword();
  pushPanelState();
});
ipcMain.on('panel:set-name', (_event, name) => {
  identity.setName(name);
  if (signaling.connected) registerWithServer();
  pushPanelState();
});
ipcMain.on('panel:set-server', (_event, value) => {
  const url = normalizeServerUrl(value);
  if (!url) {
    const plaintext = /^(ws|http):\/\//i.test(String(value ?? '').trim());
    pushPanelState({
      serverError: plaintext
        ? 'That address is not encrypted. Use https:// or wss:// — anything else would send this session over the internet in the clear.'
        : 'That does not look like a server address',
    });
    return;
  }
  config.set('serverUrl', url);
  signaling.setUrl(url);
  pushPanelState();
});
ipcMain.on('panel:set-launch-at-login', (_event, enabled) => {
  config.set('launchAtLogin', Boolean(enabled));
  applyLaunchAtLogin();
  pushPanelState();
});
ipcMain.on('panel:open-logs', () => log.reveal());
ipcMain.handle('panel:history', () => log.recent(40));
ipcMain.on('panel:request-permission', async (_event, which) => {
  if (which === 'accessibility') requestAccessibility();
  await openPermissionPane(which);
  pushPanelState();
});
ipcMain.on('panel:relaunch', () => relaunch());
ipcMain.on('panel:quit', () => {
  app.isQuitting = true;
  if (activeSession) endSession('agent_quit');
  app.quit();
});

function panelState() {
  const permissions = checkPermissions();
  return {
    code: identity.code,
    password: identity.password,
    name: identity.name,
    serverUrl: config.get('serverUrl'),
    launchAtLogin: Boolean(config.get('launchAtLogin')),
    connection: connectionStatus,
    permissions,
    permissionCopy: permissionCopy(permissions),

    // What this app is actually called in the System Settings list.
    //
    // macOS keys those permissions to the binary that asked for them, and
    // when the agent runs from a checkout that binary is the installed
    // Electron — so the row reads "Electron" while every instruction here
    // said to look for "Desky". Someone then scrolls a list that does not
    // contain the app they were told to find, with the one they need
    // sitting in plain sight under another name.
    tccName: app.isPackaged ? app.getName() : 'Electron',
    needsPermissions: NEEDS_PERMISSIONS,
    injectorAvailable: InputInjector.available,
    captureDenied,
    killSwitchLabel: humanAccelerator(config.get('killSwitch')),
    locked: identity.locked,
    lockRemainingMs: identity.lockRemainingMs,
    displays: listDisplays(),
    selectedDisplayId,
    request: pendingRequest && {
      operatorName: pendingRequest.operatorName,
      operatorAddr: pendingRequest.operatorAddr,
      at: pendingRequest.at,
    },
    session: activeSession && {
      operatorName: activeSession.operatorName,
      operatorAddr: activeSession.operatorAddr,
      startedAt: activeSession.startedAt,
      displayId: activeSession.displayId,
      quality: activeSession.quality,
      canControl: activeSession.canControl,
      counters: injector.counters,
      focusedWindow: activeSession.focusedWindow ?? null,
      events: activeSession.events.slice(-12),
      lastAction: activeSession.lastAction ?? null,
      lastActionAt: activeSession.lastActionAt ?? null,
    },
    stats: lastStats,
  };
}

/** Turns an Electron accelerator into something a person can be told out loud. */
function humanAccelerator(accelerator) {
  if (!accelerator) return null;
  const mac = process.platform === 'darwin';
  return accelerator
    .replace('CommandOrControl', mac ? '⌘' : 'Ctrl')
    .replace('Command', '⌘')
    .replace('Control', 'Ctrl')
    .replace('Alt', mac ? '⌥' : 'Alt')
    .replace('Shift', mac ? '⇧' : 'Shift')
    .split('+')
    .join(mac ? ' ' : ' + ');
}

function pushPanelState(extra = {}) {
  // A window can be alive while its render frame is already disposed —
  // during a reload, or just after a crash — and sending to it throws.
  if (!panelWindow || panelWindow.isDestroyed()) return;
  if (panelWindow.webContents.isDestroyed()) return;
  try {
    panelWindow.webContents.send('panel:update', { ...panelState(), ...extra });
  } catch {
    /* frame went away between the check and the send */
  }
}

function pushBorderState() {
  if (!borderWindow || borderWindow.isDestroyed()) return;
  if (borderWindow.webContents.isDestroyed()) return;
  try {
    borderWindow.webContents.send('border:update', {
      operatorName: activeSession?.operatorName ?? null,
      startedAt: activeSession?.startedAt ?? null,
      lastAction: activeSession?.lastAction ?? null,
      lastActionAt: activeSession?.lastActionAt ?? null,
      path: lastStats?.path ?? null,
    });
  } catch {
    /* frame went away between the check and the send */
  }
}
