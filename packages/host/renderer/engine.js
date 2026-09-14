import {
  CTL,
  QUALITY,
  DEFAULT_QUALITY,
} from '../shared/protocol.js';

/**
 * The capture and transport engine.
 *
 * Runs in a hidden renderer because WebRTC and screen capture only
 * exist in Chromium, while input injection only exists in the main
 * process. This file owns the peer connection; main owns the decision
 * to open one.
 *
 * The host is deliberately the offerer: it is the side that has media
 * and both data channels, so it describes the session and the operator
 * simply answers.
 */

const api = window.desky;

let pc = null;
let stream = null;
let videoSender = null;
let inputChannel = null;
let reliableInputChannel = null;
let controlChannel = null;
let quality = QUALITY[DEFAULT_QUALITY];
let currentDisplay = null;
let statsTimer = null;
let lastStatsSample = null;

/**
 * Remote candidates that arrived before the answer did.
 *
 * `addIceCandidate` throws while `remoteDescription` is null, and the
 * console emits its first candidates the moment it calls
 * setLocalDescription — before the answer has been signed and sent. So
 * the operator's host candidates, the ones describing the direct path on
 * a shared LAN, routinely arrive first. Without this buffer they were
 * caught, warned about and dropped, and the fastest route to the client
 * was silently discarded: the session either relayed a connection that
 * had no business being relayed, or found nothing at all.
 *
 * The console has always had this buffer. This is its missing mirror.
 */
let pendingCandidates = [];

/**
 * Incremented by every teardown.
 *
 * `getDisplayMedia` takes a few hundred milliseconds on macOS, and a
 * session can end inside that window — the client hitting the kill
 * switch the instant after they accept is exactly the case. Without a
 * generation check, teardown finds no stream to stop, the capture
 * resolves afterwards, and the client is left recording their screen
 * with no border, no panel and no log entry saying so.
 */
let generation = 0;

api.onStart(async (payload) => {
  await teardown();
  try {
    await start(payload);
  } catch (err) {
    // A DOMException stringifies to "[object DOMException]", which tells
    // nobody anything. The name is what distinguishes "the OS refused to
    // record the screen" from "there is no display to capture".
    const name = err?.name ?? 'Error';
    const detail = err?.message || String(err);
    console.error(`[engine] could not start the session: ${name}: ${detail}`);

    api.state({
      state: 'failed',
      error: detail,
      // NotAllowedError is macOS refusing the capture, which in practice
      // always means Screen Recording is off for this exact build.
      captureDenied: name === 'NotAllowedError' || name === 'NotFoundError',
    });
  }
});

api.onSignal(async ({ payload }) => {
  if (!pc || !payload) return;
  try {
    if (payload.type === 'ice-restart') {
      // The operator's network moved under them. Gather again and send a
      // fresh offer; main signs it with the session password on the way
      // out, exactly as it signs the first one, so a restart cannot be
      // used to slip a different peer into a running session.
      const offer = await pc.createOffer({ iceRestart: true });
      offer.sdp = raiseBandwidthCeiling(offer.sdp, quality.bitrate);
      await pc.setLocalDescription(offer);
      api.signalOut({ type: 'offer', sdp: pc.localDescription.sdp });
      return;
    }

    if (payload.type === 'answer') {
      await pc.setRemoteDescription(new RTCSessionDescription(payload));

      // Everything that overtook the answer is still worth having, and
      // is added in arrival order now that there is a remote description
      // to attach it to.
      const queued = pendingCandidates;
      pendingCandidates = [];
      for (const candidate of queued) {
        await pc.addIceCandidate(candidate).catch(() => { /* stale candidate */ });
      }
    } else if (payload.candidate !== undefined) {
      const candidate = payload.candidate ? new RTCIceCandidate(payload.candidate) : null;

      // A null candidate is end-of-candidates and only means anything
      // once the description it belongs to has been applied.
      if (!pc.remoteDescription) {
        if (candidate) pendingCandidates.push(candidate);
        return;
      }
      await pc.addIceCandidate(candidate);
    }
  } catch (err) {
    console.warn('[engine] signal rejected:', err.message);
  }
});

api.onStop(() => { teardown(); });

api.onSetDisplay(async ({ display }) => {
  if (!pc || !display) return;
  try {
    await switchDisplay(display);
  } catch (err) {
    console.error('[engine] could not switch display:', err);
  }
});

api.onSetQuality(async ({ preset }) => {
  quality = QUALITY[preset] ?? QUALITY[DEFAULT_QUALITY];

  // The encoder can never exceed the source. Without re-constraining the
  // track, dropping to a low preset capped the capture itself and coming
  // back up raised only the bitrate — the session stayed at the lower
  // frame rate for good, while both ends displayed the higher one.
  const track = stream?.getVideoTracks()[0];
  if (track) {
    try {
      await track.applyConstraints({
        frameRate: { ideal: quality.fps, max: quality.fps },
      });
    } catch (err) {
      console.warn('[engine] could not re-constrain the capture:', err.message);
    }
  }

  await applyEncoding();
  sendControl({ t: CTL.QUALITY, preset, ...quality });
});

api.onClipboardData(({ text }) => {
  sendControl({ t: CTL.CLIPBOARD_DATA, text });
});

// Main pushes state the operator must see immediately, such as the
// display list changing under a running session.
api.onControlOut((msg) => sendControl(msg));

/* ------------------------------------------------------------------ *
 * Session
 * ------------------------------------------------------------------ */

async function start({ iceServers, display, preset }) {
  const mine = generation;
  quality = QUALITY[preset] ?? QUALITY[DEFAULT_QUALITY];
  currentDisplay = display;

  const media = await capture(display);

  // The session may have ended while the capture prompt resolved.
  if (mine !== generation) {
    media.getTracks().forEach((t) => t.stop());
    return;
  }
  stream = media;

  pc = new RTCPeerConnection({
    iceServers,
    // Every candidate pair is worth trying: the whole point is to find
    // a direct path and fall back to the relay only when there is none.
    iceTransportPolicy: 'all',
    bundlePolicy: 'max-bundle',
    rtcpMuxPolicy: 'require',
  });

  pc.onicecandidate = (event) => {
    api.signalOut({ candidate: event.candidate ? event.candidate.toJSON() : null });
  };

  pc.onconnectionstatechange = () => {
    api.state({ state: pc.connectionState });
    if (pc.connectionState === 'connected') {
      // By now the track has delivered frames, so getSettings() reports
      // the true capture size. Re-applying costs nothing and corrects
      // the estimate the session had to open with.
      applyEncoding().catch(() => { /* best effort */ });
      startStats();
    }
    if (['failed', 'closed', 'disconnected'].includes(pc.connectionState)) stopStats();
  };

  // Unordered and unretransmitted, on purpose. A dropped mouse position
  // is worthless a frame later — resending it would only delay the
  // positions behind it and make the cursor stutter then jump.
  inputChannel = pc.createDataChannel('input', {
    ordered: false,
    maxRetransmits: 0,
  });
  inputChannel.binaryType = 'arraybuffer';
  inputChannel.onmessage = (event) => {
    api.input(event.data);
  };

  // Presses, releases and pasted text are state transitions, not
  // samples. A dropped mouse position is worthless a frame later, which
  // is why the channel above does not retransmit — but a dropped KEY_UP
  // leaves a modifier physically held down on this machine for the rest
  // of the session, and nothing downstream can tell it happened. So
  // those travel on their own channel, reliable and ordered, and
  // positions keep the unretransmitted one.
  reliableInputChannel = pc.createDataChannel('input-reliable', { ordered: true });
  reliableInputChannel.binaryType = 'arraybuffer';
  reliableInputChannel.onmessage = (event) => {
    api.input(event.data);
  };

  controlChannel = pc.createDataChannel('control', { ordered: true });
  controlChannel.onopen = () => {
    sendControl({
      t: CTL.HELLO,
      quality: preset ?? DEFAULT_QUALITY,
      display: currentDisplay,
    });
  };
  controlChannel.onmessage = (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }
    handleControl(msg);
  };

  const track = stream.getVideoTracks()[0];
  const transceiver = pc.addTransceiver(track, {
    direction: 'sendonly',
    streams: [stream],
    sendEncodings: [{
      maxBitrate: quality.bitrate,
      maxFramerate: quality.fps,
      scaleResolutionDownBy: scaleFor(quality.maxWidth),
    }],
  });
  videoSender = transceiver.sender;

  preferCodecs(transceiver);

  const offer = await pc.createOffer();
  offer.sdp = raiseBandwidthCeiling(offer.sdp, quality.bitrate);
  await pc.setLocalDescription(offer);

  await applyEncoding();

  api.signalOut({ type: 'offer', sdp: pc.localDescription.sdp });
  api.state({ state: 'offering' });
}

async function capture(display) {
  const media = await navigator.mediaDevices.getDisplayMedia({
    video: {
      frameRate: { ideal: quality.fps, max: quality.fps },
      width: { ideal: 4096 },
      height: { ideal: 2160 },
    },
    audio: false,
  });

  const track = media.getVideoTracks()[0];

  // Tells the encoder this is a desktop, not a video. Without it,
  // Chromium tunes for smooth motion and small text turns to mush the
  // moment anything on screen moves.
  track.contentHint = 'detail';

  track.addEventListener('ended', () => {
    api.state({ state: 'capture-ended' });
  });

  currentDisplay = display;
  return media;
}

async function switchDisplay(display) {
  const mine = generation;
  const next = await capture(display);
  let installed = false;

  try {
    if (mine !== generation || !videoSender) return;
    const nextTrack = next.getVideoTracks()[0];

    // replaceTrack swaps the source without renegotiating, so switching
    // monitors does not drop a frame of the session or reset the
    // connection the operator is working through.
    await videoSender.replaceTrack(nextTrack);
    if (mine !== generation) return;

    installed = true;
    stream?.getTracks().forEach((t) => { if (t !== nextTrack) t.stop(); });
    stream = next;

    await applyEncoding();
    sendControl({ t: CTL.DISPLAYS, active: display.id });
    api.state({ state: 'display-changed', display });
  } finally {
    // Whatever we captured but did not install must not keep recording.
    if (!installed) next.getTracks().forEach((t) => t.stop());
  }
}

/**
 * Raises the encoder's ceiling.
 *
 * Chromium caps screen shares near 2.5 Mbit/s by default. At that rate
 * a 4K desktop is unreadable while scrolling, so every preset sets its
 * own ceiling explicitly.
 */
/**
 * The capture's real pixel width.
 *
 * The track is asked first, because the capture is whatever
 * getDisplayMedia actually gave us — which is not always the screen's
 * own size. But `getSettings()` reports nothing until the first frame
 * has been delivered, and every caller here runs before that: the
 * transceiver is created and the encoding applied in the same tick the
 * capture resolves in. A zero there used to mean "no scaling", so a
 * 2880-wide desktop was encoded at 2880 under a preset asking for 1920
 * — 2.25 times the pixels, for the whole session, with the frame rate
 * collapsing to keep up. The display's own size is the fallback, and it
 * is known synchronously.
 */
function captureWidth() {
  const fromTrack = stream?.getVideoTracks()[0]?.getSettings?.().width ?? 0;
  if (fromTrack) return fromTrack;
  if (currentDisplay?.width) {
    return Math.round(currentDisplay.width * (currentDisplay.scaleFactor ?? 1));
  }
  return 0;
}

/** How far to divide the capture down to land at or under `maxWidth`. */
function scaleFor(maxWidth) {
  const width = captureWidth();
  if (!width || !maxWidth || width <= maxWidth) return 1;
  return width / maxWidth;
}

async function applyEncoding() {
  if (!videoSender) return;
  const params = videoSender.getParameters();
  if (!params.encodings || params.encodings.length === 0) {
    params.encodings = [{}];
  }
  params.encodings[0].maxBitrate = quality.bitrate;
  params.encodings[0].maxFramerate = quality.fps;
  params.encodings[0].scaleResolutionDownBy = scaleFor(quality.maxWidth);

  // Under congestion, drop resolution rather than frames.
  //
  // This said the opposite, and reasoned that illegible text at 60 fps
  // is useless while sharp text at 20 fps is still work. That is true
  // of watching a screen and false of driving one: the operator moves a
  // mouse and waits to see where it went, so a full-resolution slide
  // show is the one failure mode that makes the session unusable. It is
  // also self-correcting in the right direction — a still desktop costs
  // almost nothing to send, so the resolution comes back the moment the
  // operator stops moving, which is exactly when they want to read.
  params.degradationPreference = 'maintain-framerate';

  try {
    await videoSender.setParameters(params);
  } catch (err) {
    console.warn('[engine] could not apply encoding parameters:', err.message);
  }
}

/**
 * H.264 first: it is the codec with hardware encoders on essentially
 * every machine a client might be sitting at, and hardware encoding is
 * what keeps both latency and CPU low enough for an all-day session.
 */
function preferCodecs(transceiver) {
  if (typeof RTCRtpSender.getCapabilities !== 'function') return;
  if (typeof transceiver.setCodecPreferences !== 'function') return;

  const caps = RTCRtpSender.getCapabilities('video');
  if (!caps?.codecs) return;

  const rank = (codec) => {
    const name = codec.mimeType.toLowerCase();
    if (name.endsWith('/h264')) return 0;
    if (name.endsWith('/vp9')) return 1;
    if (name.endsWith('/vp8')) return 2;
    if (name.endsWith('/av1')) return 3;
    return 4;
  };

  const ordered = [...caps.codecs].sort((a, b) => rank(a) - rank(b));
  try {
    transceiver.setCodecPreferences(ordered);
  } catch (err) {
    console.warn('[engine] codec preferences rejected:', err.message);
  }
}

/** Belt-and-braces alongside setParameters, for stacks that honour b=AS. */
function raiseBandwidthCeiling(sdp, bitrate) {
  const kbps = Math.round(bitrate / 1000);
  return sdp.replace(/(m=video .*\r?\n)/g, (match) => `${match}b=AS:${kbps}\r\nb=TIAS:${bitrate}\r\n`);
}

/* ------------------------------------------------------------------ *
 * Control channel
 * ------------------------------------------------------------------ */

function handleControl(msg) {
  switch (msg.t) {
    case CTL.PING:
      sendControl({ t: CTL.PONG, ts: msg.ts });
      break;

    case CTL.SELECT_DISPLAY:
    case CTL.QUALITY:
    case CTL.HELD:
    case CTL.CLIPBOARD_PUSH:
    case CTL.CLIPBOARD_PULL:
    case CTL.BYE:
      // Anything with a side effect on the client's machine is decided
      // by the main process, which owns consent, the clipboard and the
      // activity log. The engine only carries it.
      api.control(msg);
      break;

    default:
      break;
  }
}

function sendControl(msg) {
  if (controlChannel?.readyState !== 'open') return;
  try {
    controlChannel.send(JSON.stringify(msg));
  } catch {
    /* channel closing */
  }
}

/* ------------------------------------------------------------------ *
 * Stats
 * ------------------------------------------------------------------ */

function startStats() {
  stopStats();
  statsTimer = setInterval(collectStats, 1000);
}

function stopStats() {
  if (statsTimer) clearInterval(statsTimer);
  statsTimer = null;
  lastStatsSample = null;
}

async function collectStats() {
  if (!pc) return;
  try {
    const report = await pc.getStats();
    const sample = { bytes: 0, frames: 0, at: performance.now() };
    let width = 0;
    let height = 0;
    let fps = 0;
    let rtt = null;
    let path = 'unknown';
    let localCandidateId = null;

    report.forEach((entry) => {
      if (entry.type === 'outbound-rtp' && entry.kind === 'video') {
        sample.bytes = entry.bytesSent ?? 0;
        sample.frames = entry.framesEncoded ?? 0;
        width = entry.frameWidth ?? 0;
        height = entry.frameHeight ?? 0;
        fps = entry.framesPerSecond ?? 0;
      }
      if (entry.type === 'candidate-pair' && entry.state === 'succeeded' && entry.nominated) {
        rtt = entry.currentRoundTripTime != null
          ? Math.round(entry.currentRoundTripTime * 1000)
          : null;
        localCandidateId = entry.localCandidateId ?? null;
      }
    });

    // Only the candidate the nominated pair actually uses says how this
    // session travels. Scanning every local candidate instead reported
    // "relay" whenever a TURN server was merely configured — a relay
    // candidate is always gathered — so a perfect direct connection was
    // labelled relayed on both screens, permanently. Direct-vs-relay is
    // a privacy claim in this product; a wrong one is worse than none.
    if (localCandidateId) {
      const local = report.get(localCandidateId);
      if (local?.candidateType) {
        path = local.candidateType === 'relay' ? 'relay' : 'direct';
      }
    }

    let bitrate = 0;
    if (lastStatsSample) {
      const seconds = (sample.at - lastStatsSample.at) / 1000;
      if (seconds > 0) {
        bitrate = Math.round(((sample.bytes - lastStatsSample.bytes) * 8) / seconds);
      }
    }
    lastStatsSample = sample;

    api.stats({ bitrate, fps: Math.round(fps), width, height, rtt, path });
    sendControl({ t: CTL.ACTIVITY, bitrate, fps: Math.round(fps), width, height, rtt, path });
  } catch {
    /* stats are best-effort */
  }
}

/* ------------------------------------------------------------------ *
 * Teardown
 * ------------------------------------------------------------------ */

async function teardown() {
  generation += 1;
  stopStats();
  pendingCandidates = [];

  try { inputChannel?.close(); } catch { /* already closed */ }
  try { reliableInputChannel?.close(); } catch { /* already closed */ }
  try { controlChannel?.close(); } catch { /* already closed */ }
  inputChannel = null;
  reliableInputChannel = null;
  controlChannel = null;

  if (pc) {
    pc.onicecandidate = null;
    pc.onconnectionstatechange = null;
    try { pc.close(); } catch { /* already closed */ }
    pc = null;
  }

  // Stopping the tracks is what actually turns the client's screen
  // capture off. It must happen on every exit path, including failures.
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
  videoSender = null;

  api.state({ state: 'idle' });
}

api.ready();
