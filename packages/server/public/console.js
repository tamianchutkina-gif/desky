import {
  MSG,
  CTL,
  QUALITY,
  DEFAULT_QUALITY,
  computeProof,
  normalizeCode,
  normalizePassword,
  formatPassword,
  PASSWORD_LENGTH,
  formatCode,
  humanDuration,
  rejectionText,
  endedText,
  extractFingerprint,
  computeBinding,
  verifyBinding,
} from '/shared/protocol.js';

import { InputCapture, lockKeyboard, unlockKeyboard, COMBOS } from '/input.js';

/**
 * Operator console.
 *
 * Owns four views and one peer connection. The host agent is the
 * offerer — it holds the media and the data channels — so this side
 * answers and then mostly listens.
 */

const $ = (id) => document.getElementById(id);

const views = {
  connect: $('view-connect'),
  waiting: $('view-waiting'),
  session: $('view-session'),
  ended: $('view-ended'),
};

const video = $('screen');

let socket = null;
let socketReady = false;
let signalingRetryMs = 2000;
let session = null;
let pc = null;
let inputChannel = null;
let reliableInputChannel = null;
let controlChannel = null;
let capture = null;
let timerHandle = null;
let pingHandle = null;
let latency = null;
let pendingCandidates = [];

/**
 * ICE recovery state.
 *
 * `disconnected` is often transient — a few lost packets, a brief change
 * of route — so a restart is worth a short wait before being asked for.
 * `failed` is not transient and asks immediately. Either way it is asked
 * for exactly once per session: a restart loop against a network that is
 * genuinely gone would keep the operator staring at an overlay instead
 * of telling them plainly that the session is over.
 */
let recoveryTimer = null;
let recoveryAttempted = false;

/* ------------------------------------------------------------------ *
 * Views
 * ------------------------------------------------------------------ */

function show(name) {
  for (const [key, el] of Object.entries(views)) {
    el.hidden = key !== name;
  }
  // The stream usually arrives while this view is still hidden. See
  // startPlayback.
  if (name === 'session') startPlayback();
}

/**
 * Starts the video element, at both moments it can fail to start.
 *
 * `autoplay` on the element is not enough. The track arrives before the
 * operator is switched to the session view, so `srcObject` is assigned
 * while the element is still `hidden` — and Safari neither plays a
 * hidden element nor retries once it is shown. What the operator gets
 * is a black rectangle with a play button over it, a frame counter
 * stuck at single digits and a bitrate near zero, which reads as a
 * broken client rather than a paused video.
 *
 * Chromium starts it anyway, which is why this survived until the first
 * session run from Safari.
 */
function startPlayback() {
  if (!video.srcObject) return;

  const attempt = video.play();
  if (!attempt?.catch) return;

  attempt.catch(() => {
    // Refused for want of a user gesture. The element keeps its own
    // play control, so the operator is not stuck — but the next click
    // on the picture should start it, because that is what they will
    // try first.
    video.addEventListener('pointerdown', startPlayback, { once: true });
  });
}

function setError(message) {
  const el = $('connect-error');
  el.textContent = message ?? '';
  el.hidden = !message;
}

/* ------------------------------------------------------------------ *
 * Stock preference
 *
 * Carbon is the default because it is derived from the operator's
 * scene, but a bright room is a real thing and this is their tool.
 * ------------------------------------------------------------------ */

const savedStock = readStored('desky.stock');
if (savedStock === 'paper' || savedStock === 'carbon') {
  document.documentElement.dataset.stock = savedStock;
}

$('stock-toggle').addEventListener('click', () => {
  const next = document.documentElement.dataset.stock === 'carbon' ? 'paper' : 'carbon';
  document.documentElement.dataset.stock = next;
  writeStored('desky.stock', next);
});

const savedName = readStored('desky.operator');
if (savedName) $('operator').value = savedName;

/* ------------------------------------------------------------------ *
 * Field formatting
 * ------------------------------------------------------------------ */

$('code').addEventListener('input', (event) => {
  const input = event.target;
  const atEnd = input.selectionStart === input.value.length;
  const digits = normalizeCode(input.value);
  input.value = formatCode(digits);
  if (atEnd) input.setSelectionRange(input.value.length, input.value.length);
});

$('password').addEventListener('input', (event) => {
  // Grouped as the client reads it aloud, and caret-preserving at the
  // end the same way the number field is: the operator is typing from
  // a voice on the phone and cannot afford to look down.
  const input = event.target;
  const atEnd = input.selectionStart === input.value.length;
  input.value = formatPassword(input.value);
  if (atEnd) input.setSelectionRange(input.value.length, input.value.length);
});

/* ------------------------------------------------------------------ *
 * Signaling
 * ------------------------------------------------------------------ */

function signalingUrl() {
  const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${scheme}//${location.host}/signal`;
}

function connectSignaling() {
  socket = new WebSocket(signalingUrl());

  socket.addEventListener('open', () => {
    socketReady = true;
    signalingRetryMs = 2000;
    setServerState('ok', 'Server connected');
  });

  socket.addEventListener('message', (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }
    handleSignal(msg);
  });

  socket.addEventListener('close', () => {
    socketReady = false;
    setServerState('warn', 'No connection to the server');
    // A dropped signaling socket does not end a running session: media
    // is peer-to-peer and keeps flowing. Only reconnect for the next one,
    // and back off while the server stays away — a console left open on
    // a dead server should not knock every two seconds all night.
    setTimeout(connectSignaling, signalingRetryMs);
    signalingRetryMs = Math.min(signalingRetryMs * 2, 30_000);
  });

  socket.addEventListener('error', () => {
    setServerState('warn', 'No connection to the server');
  });
}

function setServerState(kind, text) {
  const el = $('server-state');
  el.className = `state state-${kind}`;
  el.textContent = text;
}

function sendSignal(msg) {
  if (socket?.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify(msg));
}

async function handleSignal(msg) {
  switch (msg.t) {
    case MSG.OP_CHALLENGE: {
      if (!session) return;
      session.id = msg.sessionId;

      const proof = await computeProof(
        session.password,
        msg.nonce,
        session.code,
        msg.sessionId,
      );
      sendSignal({
        t: MSG.OP_AUTH,
        sessionId: msg.sessionId,
        proof,
        operatorName: session.operatorName,
      });
      break;
    }

    case MSG.OP_PENDING:
      session.hostName = msg.hostName || session.hostName;
      $('waiting-host').textContent = session.hostName || 'Client\u2019s computer';
      show('waiting');
      break;

    case MSG.OP_ACCEPTED:
      if (!session || session.id !== msg.sessionId) break;
      session.displays = msg.displays ?? [];
      session.hostName = msg.hostName || session.hostName;
      session.canControl = msg.canControl !== false;
      await openPeer(msg.iceServers ?? []);
      break;

    case MSG.OP_REJECTED:
      if (msg.sessionId && session && msg.sessionId !== session.id) break;
      failConnect(rejectionText(msg.reason));
      break;

    case MSG.SIGNAL:
      if (session?.id === msg.sessionId) await handlePeerSignal(msg.payload);
      break;

    case MSG.OP_PEER_GONE:
      if (!session || session.id !== msg.sessionId) break;
      finishSession(endedText(msg.reason));
      break;

    default:
      break;
  }
}

/* ------------------------------------------------------------------ *
 * Connect
 * ------------------------------------------------------------------ */

$('connect-form').addEventListener('submit', (event) => {
  event.preventDefault();
  setError(null);

  const code = normalizeCode($('code').value);
  const password = normalizePassword($('password').value);
  const operatorName = $('operator').value.trim() || 'Operator';

  if (code.length !== 9) {
    setError('The computer number is nine digits. Ask the client to read it from the Desky window.');
    $('code').focus();
    return;
  }
  if (password.length !== PASSWORD_LENGTH) {
    setError('The session password is eight characters, shown on the client\u2019s screen under the number.');
    $('password').focus();
    return;
  }
  if (!socketReady) {
    setError('No connection to the server yet. Wait a couple of seconds and try again.');
    return;
  }

  writeStored('desky.operator', operatorName);

  session = { code, password, operatorName, id: null, hostName: null, displays: [] };
  $('connect-submit').disabled = true;
  sendSignal({ t: MSG.OP_LOOKUP, code });
});

$('waiting-cancel').addEventListener('click', () => {
  if (session?.id) sendSignal({ t: MSG.OP_END, sessionId: session.id });
  resetToConnect();
});

$('ended-back').addEventListener('click', resetToConnect);

function failConnect(message) {
  teardownPeer();
  setError(message);
  $('connect-submit').disabled = false;
  session = null;
  show('connect');
}

function resetToConnect() {
  teardownPeer();
  session = null;
  $('connect-submit').disabled = false;
  $('password').value = '';
  setError(null);
  show('connect');
  $('code').focus();
}

/* ------------------------------------------------------------------ *
 * Peer connection
 * ------------------------------------------------------------------ */

/**
 * Asks the client's agent to gather ICE again.
 *
 * The agent is the offerer, so only it can produce a restart offer. The
 * request travels over the signaling socket rather than the control data
 * channel, because the channel rides the very connection being repaired.
 */
function restartIce() {
  if (!session?.id || recoveryAttempted) return;
  recoveryAttempted = true;
  clearRecovery();
  showOverlay('The connection dropped', 'Looking for a new route between your two computers.');
  sendSignal({ t: MSG.SIGNAL, sessionId: session.id, payload: { type: 'ice-restart' } });
}

function scheduleRecovery() {
  if (recoveryTimer || recoveryAttempted) return;
  recoveryTimer = setTimeout(() => {
    recoveryTimer = null;
    if (pc && pc.connectionState !== 'connected') restartIce();
  }, 3000);
}

function clearRecovery() {
  if (recoveryTimer) clearTimeout(recoveryTimer);
  recoveryTimer = null;
}

async function openPeer(iceServers) {
  pendingCandidates = [];
  recoveryAttempted = false;
  clearRecovery();

  pc = new RTCPeerConnection({
    iceServers,
    bundlePolicy: 'max-bundle',
    rtcpMuxPolicy: 'require',
  });

  pc.onicecandidate = (event) => {
    sendSignal({
      t: MSG.SIGNAL,
      sessionId: session.id,
      payload: { candidate: event.candidate ? event.candidate.toJSON() : null },
    });
  };

  pc.ontrack = (event) => {
    video.srcObject = event.streams[0] ?? new MediaStream([event.track]);
    startPlayback();

    // The default jitter buffer trades latency for smoothness, which is
    // the wrong trade when the "video" is a desktop someone is trying
    // to work on. Ask for the shortest buffer the stack will give.
    const receiver = event.receiver;
    try {
      if ('playoutDelayHint' in receiver) receiver.playoutDelayHint = 0;
      if ('jitterBufferTarget' in receiver) receiver.jitterBufferTarget = 0;
    } catch { /* not supported everywhere */ }
  };

  pc.ondatachannel = (event) => {
    const channel = event.channel;
    if (channel.label === 'input') {
      inputChannel = channel;
      inputChannel.binaryType = 'arraybuffer';
      startCapture();
    } else if (channel.label === 'input-reliable') {
      reliableInputChannel = channel;
      reliableInputChannel.binaryType = 'arraybuffer';
    } else if (channel.label === 'control') {
      controlChannel = channel;
      controlChannel.onmessage = (e) => handleControl(e.data);
      controlChannel.onopen = startPinging;
    }
  };

  pc.onconnectionstatechange = () => {
    switch (pc.connectionState) {
      case 'connected':
        hideOverlay();
        clearRecovery();
        break;
      case 'failed':
        // One restart before giving up. A laptop moving from Wi-Fi to a
        // hotspot changes its NAT binding and leaves ICE with no working
        // pair; a fresh gathering round finds one, and both signaling
        // sockets are still up to carry it. Without this, twenty minutes
        // of support work ended because someone walked out of range.
        if (!recoveryAttempted) restartIce();
        else finishSession('The connection between your two computers failed');
        break;
      case 'disconnected':
        showOverlay('The connection dropped', 'Looking for a new route between your two computers.');
        scheduleRecovery();
        break;
      default:
        break;
    }
  };

  show('session');
  showOverlay('Setting up a direct channel', 'Looking for the shortest path between your two computers.');
  startTimer();
  renderDisplays();
  markQuality(DEFAULT_QUALITY);
  $('session-host').textContent = session.hostName || 'Client\u2019s computer';
  $('session-code').textContent = formatCode(session.code);
}

async function handlePeerSignal(payload) {
  if (!pc || !payload) return;

  try {
    if (payload.type === 'offer') {
      // The server chose which offer reached this console. Only one
      // signed with the session password can be the client's, so a
      // server that substituted its own is rejected here rather than
      // silently becoming the other end of the connection.
      const genuine = await verifyBinding(
        session.password,
        'offer',
        session.id,
        payload.sdp,
        payload.bind,
      );
      if (!genuine) {
        finishSession('Could not confirm this is the client\u2019s computer');
        return;
      }

      await pc.setRemoteDescription(new RTCSessionDescription(payload));
      for (const candidate of pendingCandidates) {
        await pc.addIceCandidate(candidate).catch(() => {});
      }
      pendingCandidates = [];

      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);

      const fingerprint = extractFingerprint(pc.localDescription.sdp);
      if (!fingerprint) {
        finishSession('The answer carries no DTLS fingerprint');
        return;
      }

      sendSignal({
        t: MSG.SIGNAL,
        sessionId: session.id,
        payload: {
          type: 'answer',
          sdp: pc.localDescription.sdp,
          bind: await computeBinding(session.password, 'answer', session.id, fingerprint),
        },
      });
    } else if (payload.candidate !== undefined) {
      const candidate = payload.candidate ? new RTCIceCandidate(payload.candidate) : null;
      // Candidates can arrive before the offer; holding them avoids
      // discarding a path that might be the fastest one.
      if (!pc.remoteDescription && candidate) pendingCandidates.push(candidate);
      else await pc.addIceCandidate(candidate).catch(() => {});
    }
  } catch (err) {
    console.warn('[console] signal rejected:', err.message);
  }
}

function teardownPeer() {
  stopTimer();
  stopPinging();
  stopHeldSync();
  clearRecovery();
  capture?.stop();
  capture = null;
  unlockKeyboard();

  // Tell the other end we are gone.
  //
  // Only the explicit hang-up used to do this, so every failure path —
  // a rejected binding, a connection that never came up, the operator
  // pressing Back — left the client's agent believing the session was
  // still running: the red frame still around their screen and the
  // injector still armed, until its own ICE eventually timed out. The
  // server ignores this for a session it has already closed, so sending
  // it unconditionally is safe.
  if (session?.id && socketReady) {
    sendSignal({ t: MSG.OP_END, sessionId: session.id });
  }

  try { inputChannel?.close(); } catch { /* closed */ }
  try { reliableInputChannel?.close(); } catch { /* closed */ }
  try { controlChannel?.close(); } catch { /* closed */ }
  inputChannel = null;
  reliableInputChannel = null;
  controlChannel = null;

  if (pc) {
    pc.onicecandidate = null;
    pc.ontrack = null;
    pc.ondatachannel = null;
    pc.onconnectionstatechange = null;
    try { pc.close(); } catch { /* closed */ }
    pc = null;
  }

  if (video.srcObject) {
    video.srcObject.getTracks().forEach((t) => t.stop());
    video.srcObject = null;
  }

  closeAllPops();
  latency = null;
}

function finishSession(reason) {
  const elapsed = session?.startedAt ? Date.now() - session.startedAt : 0;
  const hostName = session?.hostName ?? 'Client\u2019s computer';

  teardownPeer();

  $('ended-title').textContent = reason;
  $('ended-summary').innerHTML = '';
  addSummary('Computer', hostName);
  if (session?.code) addSummary('Number', formatCode(session.code));
  if (elapsed) addSummary('Duration', humanDuration(elapsed));

  session = null;
  $('connect-submit').disabled = false;
  $('password').value = '';
  show('ended');
}

function addSummary(term, value) {
  const row = document.createElement('div');
  row.className = 'field-row';
  const dt = document.createElement('dt');
  dt.textContent = term;
  const dd = document.createElement('dd');
  dd.textContent = value;
  row.append(dt, dd);
  $('ended-summary').append(row);
}

/* ------------------------------------------------------------------ *
 * Input
 * ------------------------------------------------------------------ */

function startCapture() {
  // A client who granted screen sharing but not control gets a
  // watch-only session. Capturing input anyway would send frames the
  // agent silently drops, and the operator would spend a minute
  // wondering why their clicks do nothing.
  if (session?.canControl === false) {
    $('view-only').hidden = false;
    $('btn-keys').disabled = true;
    video.style.cursor = 'default';
    return;
  }

  $('view-only').hidden = true;
  capture = new InputCapture(video, (buffer, reliable) => {
    // An agent built before the reliable channel existed will not have
    // opened one. Falling back keeps that session working rather than
    // dropping its keystrokes entirely.
    const channel = reliable && reliableInputChannel?.readyState === 'open'
      ? reliableInputChannel
      : inputChannel;
    if (channel?.readyState === 'open') channel.send(buffer);
  });
  capture.start();
  startHeldSync();
}

/* ------------------------------------------------------------------ *
 * Control channel
 * ------------------------------------------------------------------ */

function sendControl(msg) {
  if (controlChannel?.readyState !== 'open') return;
  controlChannel.send(JSON.stringify(msg));
}

function handleControl(raw) {
  let msg;
  try {
    msg = JSON.parse(raw);
  } catch {
    return;
  }

  switch (msg.t) {
    case CTL.HELLO:
      markQuality(msg.quality ?? DEFAULT_QUALITY);
      // The agent names the screen it actually opened with. Without
      // this the monitor list shows nothing as current, and the
      // operator's first click looks like it did nothing because they
      // picked the screen already being shared.
      if (msg.display?.id != null) {
        session.activeDisplay = msg.display.id;
        renderDisplays();
      }
      if (!session.startedAt) session.startedAt = Date.now();
      break;

    case CTL.DISPLAYS:
      // The agent sends the whole list whenever it changes — a monitor
      // plugged in, unplugged, or resized mid-session. Reading only
      // `active` and discarding `displays` left the menu frozen at
      // whatever was attached when the session opened, so the second
      // screen the operator just asked the client to connect never
      // appeared and the only way to reach it was to reconnect.
      if (Array.isArray(msg.displays)) session.displays = msg.displays;
      if (msg.active != null) session.activeDisplay = msg.active;
      if (Array.isArray(msg.displays) || msg.active != null) renderDisplays();
      break;

    case CTL.PONG:
      latency = Math.round(performance.now() - msg.ts);
      break;

    case CTL.ACTIVITY:
      renderStats(msg);
      break;

    case CTL.CLIPBOARD_DATA:
      $('clip-text').value = msg.text ?? '';
      break;

    default:
      break;
  }
}

let heldTimer = null;

function startHeldSync() {
  stopHeldSync();
  heldTimer = setInterval(() => {
    if (!capture || controlChannel?.readyState !== 'open') return;
    const { keys, buttons } = capture.heldState;
    sendControl({ t: CTL.HELD, keys, buttons });
  }, 1000);
}

function stopHeldSync() {
  if (heldTimer) clearInterval(heldTimer);
  heldTimer = null;
}

function startPinging() {
  stopPinging();
  pingHandle = setInterval(() => {
    sendControl({ t: CTL.PING, ts: performance.now() });
  }, 2000);
}

function stopPinging() {
  if (pingHandle) clearInterval(pingHandle);
  pingHandle = null;
}

/* ------------------------------------------------------------------ *
 * Readouts
 * ------------------------------------------------------------------ */

function renderStats(stats) {
  $('m-fps').textContent = stats.fps ? String(stats.fps) : '—';
  $('m-bitrate').textContent = stats.bitrate ? formatBitrate(stats.bitrate) : '—';
  $('m-size').textContent = stats.width ? `${stats.width}×${stats.height}` : '—';

  const rtt = latency ?? stats.rtt;
  $('m-rtt').textContent = rtt != null ? `${rtt} ms` : '—';

  const path = $('m-path');
  if (stats.path === 'direct') {
    path.className = 'state state-ok';
    path.textContent = 'Direct connection';
  } else if (stats.path === 'relay') {
    path.className = 'state state-warn';
    path.textContent = 'Through a relay';
  } else {
    path.className = 'state state-idle';
    path.textContent = 'Channel being established';
  }
}

function formatBitrate(bits) {
  if (bits >= 1_000_000) return `${(bits / 1_000_000).toFixed(1)} Mbit/s`;
  return `${Math.round(bits / 1000)} kbit/s`;
}

function startTimer() {
  stopTimer();
  session.startedAt = session.startedAt ?? Date.now();
  timerHandle = setInterval(() => {
    if (!session?.startedAt) return;
    $('m-time').textContent = humanDuration(Date.now() - session.startedAt);
  }, 1000);
}

function stopTimer() {
  if (timerHandle) clearInterval(timerHandle);
  timerHandle = null;
}

function showOverlay(title, text) {
  $('overlay-title').textContent = title;
  $('overlay-text').textContent = text ?? '';
  $('session-overlay').hidden = false;
}

function hideOverlay() {
  $('session-overlay').hidden = true;
}

/* ------------------------------------------------------------------ *
 * Toolbar
 * ------------------------------------------------------------------ */

/*
 * The toolbar is a column beside the picture and is always visible, so
 * the reveal-on-approach behaviour that used to live here is gone.
 *
 * It hid itself after 2.6 seconds and slid back in whenever the pointer
 * rose above y=90 — which is the same gesture as reaching for the menu
 * bar or the close button on the client's screen. The operator got the
 * toolbar every time they wanted the thing underneath it.
 */

$('btn-hangup').addEventListener('click', () => {
  sendControl({ t: CTL.BYE });
  if (session?.id) sendSignal({ t: MSG.OP_END, sessionId: session.id });
  finishSession('You ended the session');
});

$('btn-fullscreen').addEventListener('click', async () => {
  const icon = $('btn-fullscreen').querySelector('use');
  if (document.fullscreenElement) {
    await document.exitFullscreen();
    unlockKeyboard();
    icon.setAttribute('href', '#ico-expand');
  } else {
    await views.session.requestFullscreen().catch(() => {});
    await lockKeyboard();
    icon.setAttribute('href', '#ico-collapse');
  }
});

/* ---- popovers ---------------------------------------------------- */

const pops = {
  displays: { el: $('pop-displays'), trigger: $('btn-displays') },
  quality: { el: $('pop-quality'), trigger: $('btn-quality') },
  clipboard: { el: $('pop-clipboard'), trigger: $('btn-clipboard') },
  keys: { el: $('pop-keys'), trigger: $('btn-keys') },
};

function anyPopOpen() {
  return Object.values(pops).some((p) => !p.el.hidden);
}

function closeAllPops(except) {
  for (const [name, pop] of Object.entries(pops)) {
    if (name === except) continue;
    pop.el.hidden = true;
    pop.trigger.setAttribute('aria-expanded', 'false');
  }
  if (capture) capture.paused = anyPopOpen();
}

function togglePop(name) {
  const pop = pops[name];
  const willOpen = pop.el.hidden;
  closeAllPops(name);

  pop.el.hidden = !willOpen;
  pop.trigger.setAttribute('aria-expanded', String(willOpen));

  if (willOpen) {
    // Measured while visible, because a hidden element has no size. The
    // rail puts its triggers against the right edge and well down the
    // window, so a popover placed naively runs off both.
    const rect = pop.trigger.getBoundingClientRect();
    const { offsetWidth: w, offsetHeight: h } = pop.el;
    const clamp = (value, limit) => Math.max(8, Math.min(value, limit - 8));
    pop.el.style.left = `${clamp(rect.right - w, window.innerWidth - w)}px`;
    pop.el.style.top = `${clamp(rect.bottom + 8, window.innerHeight - h)}px`;
  }

  // Keyboard and mouse belong to the popover while it is open, not to
  // the client's machine.
  if (capture) capture.paused = anyPopOpen();
}

for (const [name, pop] of Object.entries(pops)) {
  pop.trigger.addEventListener('click', (event) => {
    event.stopPropagation();
    togglePop(name);
  });
}

document.addEventListener('click', (event) => {
  if (event.target.closest('.pop') || event.target.closest('.toolbar-actions')) return;
  closeAllPops();
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && anyPopOpen()) {
    event.stopPropagation();
    closeAllPops();
  }
}, { capture: true });

/* ---- displays ---------------------------------------------------- */

function renderDisplays() {
  const el = $('pop-displays');
  el.innerHTML = '';
  const displays = session?.displays ?? [];

  if (displays.length === 0) {
    const note = document.createElement('p');
    note.className = 'pop-note';
    note.textContent = 'The client did not report a list of displays.';
    el.append(note);
    return;
  }

  for (const display of displays) {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'pop-item';
    item.setAttribute('role', 'menuitemradio');
    item.setAttribute('aria-checked', String(display.id === session.activeDisplay));

    const name = document.createElement('span');
    name.textContent = display.label;
    const size = document.createElement('span');
    size.className = 'pop-hint num';
    size.textContent = `${display.width}×${display.height}`;
    item.append(name, size);

    item.addEventListener('click', () => {
      session.activeDisplay = display.id;
      sendControl({ t: CTL.SELECT_DISPLAY, id: display.id });
      renderDisplays();
      closeAllPops();
    });

    el.append(item);
  }
}

/* ---- quality ----------------------------------------------------- */

function markQuality(preset) {
  for (const item of $('pop-quality').querySelectorAll('[data-quality]')) {
    item.setAttribute('aria-checked', String(item.dataset.quality === preset));
  }
}

for (const item of $('pop-quality').querySelectorAll('[data-quality]')) {
  item.addEventListener('click', () => {
    const preset = item.dataset.quality;
    if (!QUALITY[preset]) return;
    sendControl({ t: CTL.QUALITY, preset });
    markQuality(preset);
    closeAllPops();
  });
}

/* ---- clipboard --------------------------------------------------- */

$('clip-pull').addEventListener('click', () => sendControl({ t: CTL.CLIPBOARD_PULL }));
$('clip-push').addEventListener('click', () => {
  sendControl({ t: CTL.CLIPBOARD_PUSH, text: $('clip-text').value });
  closeAllPops();
});

/* ---- system combinations ----------------------------------------- */

for (const item of $('pop-keys').querySelectorAll('[data-combo]')) {
  item.addEventListener('click', () => {
    const combo = COMBOS[item.dataset.combo];
    if (combo && capture) capture.sendCombo(combo);
    closeAllPops();
  });
}

/* ------------------------------------------------------------------ *
 * Storage helpers
 *
 * A private window or blocked site data makes these throw rather than
 * return null, so every access is guarded.
 * ------------------------------------------------------------------ */

function readStored(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}

function writeStored(key, value) {
  try { localStorage.setItem(key, value); } catch { /* storage unavailable */ }
}

/* ------------------------------------------------------------------ */

window.addEventListener('beforeunload', () => {
  if (session?.id) sendSignal({ t: MSG.OP_END, sessionId: session.id });
});

connectSignaling();
show('connect');
$('code').focus();

/*
 * The password proof is an HMAC computed with Web Crypto, and browsers
 * hand out `crypto.subtle` only in a secure context: HTTPS, or
 * http://localhost. Opened over plain HTTP from another device — the
 * first thing anyone tries on their own network — the page looks
 * entirely healthy. The socket connects, the fields accept input, and
 * the button goes dead at the first proof with nothing said, because
 * the failure happens where no handler is looking.
 *
 * So refuse up front and name the reason, rather than letting someone
 * spend an evening deciding their password is wrong.
 */
if (!window.isSecureContext) {
  setError(
    'This page is open over plain HTTP, so the browser withholds the cryptography '
    + 'that checks the session password. Open it at https://, or at '
    + 'http://localhost on the machine running the server.',
  );
  $('connect-submit').disabled = true;
}
