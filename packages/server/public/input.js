import {
  BUTTON,
  MOD,
  encodeMouseMove,
  encodeMouseButton,
  encodeWheel,
  encodeKey,
  encodeText,
  keyIdFor,
} from '/shared/protocol.js';

/**
 * Captures the operator's mouse and keyboard and turns them into wire
 * frames.
 *
 * Everything here is sent the instant it happens. There is no batching
 * and no animation-frame coalescing: a mouse frame is nine bytes, and
 * holding one back for even a single frame is latency the operator
 * feels directly in the cursor.
 */
export class InputCapture {
  #video;
  #send;
  #active = false;
  #held = new Set();
  #onBlur;

  /** Where the pointer was last seen, so a release never invents a position. */
  #lastPoint = { x: 0.5, y: 0.5 };

  constructor(video, send) {
    this.#video = video;
    this.#send = send;
    this.#onBlur = () => this.releaseAll();
  }

  start() {
    if (this.#active) return;
    this.#active = true;

    const v = this.#video;
    v.addEventListener('pointermove', this.#pointerMove, { passive: true });
    v.addEventListener('pointerdown', this.#pointerDown);
    v.addEventListener('pointerup', this.#pointerUp);
    v.addEventListener('pointercancel', this.#pointerCancel);
    v.addEventListener('lostpointercapture', this.#pointerCancel);
    v.addEventListener('contextmenu', this.#preventDefault);
    v.addEventListener('wheel', this.#wheel, { passive: false });
    v.addEventListener('dragstart', this.#preventDefault);

    window.addEventListener('keydown', this.#keyDown, { capture: true });
    window.addEventListener('keyup', this.#keyUp, { capture: true });

    // Losing focus with keys still down would strand a modifier on the
    // client's machine, so any interruption releases everything.
    window.addEventListener('blur', this.#onBlur);
    document.addEventListener('visibilitychange', this.#onBlur);
  }

  stop() {
    if (!this.#active) return;
    this.#active = false;
    this.releaseAll();

    const v = this.#video;
    v.removeEventListener('pointermove', this.#pointerMove);
    v.removeEventListener('pointerdown', this.#pointerDown);
    v.removeEventListener('pointerup', this.#pointerUp);
    v.removeEventListener('pointercancel', this.#pointerCancel);
    v.removeEventListener('lostpointercapture', this.#pointerCancel);
    v.removeEventListener('contextmenu', this.#preventDefault);
    v.removeEventListener('wheel', this.#wheel);
    v.removeEventListener('dragstart', this.#preventDefault);

    window.removeEventListener('keydown', this.#keyDown, { capture: true });
    window.removeEventListener('keyup', this.#keyUp, { capture: true });
    window.removeEventListener('blur', this.#onBlur);
    document.removeEventListener('visibilitychange', this.#onBlur);
  }

  /**
   * What this console believes is currently down, so the client can
   * release anything else. Releases can be lost, a pointercancel
   * produces none at all, and macOS does not deliver keyup for a letter
   * released while Command is held — so the client cannot derive this
   * from the event stream alone.
   */
  get heldState() {
    const keys = [];
    const buttons = [];
    for (const entry of this.#held) {
      const id = Number(entry.slice(2));
      if (entry.startsWith('k:')) keys.push(id);
      else buttons.push(id);
    }
    return { keys, buttons };
  }

  /** Suspends capture while a popover has focus, without tearing down. */
  set paused(value) {
    this.#paused = value;
    if (value) this.releaseAll();
  }

  #paused = false;

  /** Releases held mouse buttons where the pointer last was, leaving keys alone. */
  releaseButtons() {
    const { x, y } = this.#lastPoint;
    for (const entry of [...this.#held]) {
      if (!entry.startsWith('m:')) continue;
      this.#send(encodeMouseButton(false, Number(entry.slice(2)), x, y), true);
      this.#held.delete(entry);
    }
  }

  releaseAll() {
    // Release where the pointer actually is. Releasing at a hardcoded
    // centre moved the client's cursor across their screen every time
    // the operator alt-tabbed mid-drag.
    const { x, y } = this.#lastPoint;
    for (const entry of this.#held) {
      if (entry.startsWith('m:')) {
        this.#send(encodeMouseButton(false, Number(entry.slice(2)), x, y), true);
      } else {
        this.#send(encodeKey(false, Number(entry.slice(2)), 0), true);
      }
    }
    this.#held.clear();
  }

  /** Types a literal string, bypassing the client's keyboard layout. */
  typeText(text) {
    if (!text) return;
    this.#send(encodeText(text), true);
  }

  /** Presses and releases a named combination the browser will not pass through. */
  sendCombo(codes) {
    const ids = codes.map(keyIdFor).filter(Boolean);
    for (const id of ids) this.#send(encodeKey(true, id, 0), true);
    for (const id of [...ids].reverse()) this.#send(encodeKey(false, id, 0), true);
  }

  /* ---------------------------------------------------------------- *
   * Pointer
   * ---------------------------------------------------------------- */

  /**
   * Clamped rather than refused, so the edges of the client's screen are
   * reachable.
   *
   * Dropping every position outside the picture meant the client's
   * cursor stopped a row short of the boundary and could never push
   * against it — which is how macOS reveals an auto-hidden Dock, and how
   * the menu bar is hit. The operator saw their own pointer leave the
   * video and nothing happen. Clamping pins the client's cursor to the
   * edge the operator is pressing toward, which is what they meant.
   */
  #pointerMove = (event) => {
    if (this.#paused) return;
    const point = this.#clamped(event.clientX, event.clientY);
    if (!point) return;
    this.#send(encodeMouseMove(point.x, point.y));
  };

  #pointerDown = (event) => {
    if (this.#paused) return;
    event.preventDefault();
    this.#video.focus?.();
    const point = this.#clamped(event.clientX, event.clientY);
    if (!point) return;
    const button = mapButton(event.button);
    if (button === null) return;

    // Capture the pointer for the whole drag. Without it, a release over
    // the toolbar — which slides into view under the cursor whenever the
    // operator drags toward the top — never reached the video, so no
    // mouse-up was ever sent and the client's button stayed physically
    // down, selecting everything it crossed until the session ended.
    try { this.#video.setPointerCapture?.(event.pointerId); } catch { /* not capturable */ }

    this.#held.add(`m:${button}`);
    this.#send(encodeMouseButton(true, button, point.x, point.y), true);
  };

  /**
   * The browser reclaimed the gesture for panning or zooming, so no
   * pointerup is coming and the client is left mid-drag, selecting
   * everything the next moves cross.
   *
   * Buttons only, not `releaseAll`. `lostpointercapture` also fires at
   * the end of every ordinary drag, when #pointerUp releases the
   * capture it took — so releasing keys here would drop a held Shift
   * every time the operator finished a shift-drag. Keys that genuinely
   * strand are handled by the held-state reconciliation instead.
   */
  #pointerCancel = () => {
    if (this.#paused) return;
    this.releaseButtons();
  };

  #pointerUp = (event) => {
    if (this.#paused) return;
    event.preventDefault();
    try { this.#video.releasePointerCapture?.(event.pointerId); } catch { /* never captured */ }

    const point = this.#clamped(event.clientX, event.clientY);
    if (!point) return;
    const button = mapButton(event.button);
    if (button === null) return;
    this.#held.delete(`m:${button}`);
    this.#send(encodeMouseButton(false, button, point.x, point.y), true);
  };

  #wheel = (event) => {
    if (this.#paused) return;
    event.preventDefault();

    // Browsers report wheel deltas in pixels, lines or pages depending
    // on the device; the client's OS expects notches. Normalising here
    // keeps a trackpad and a wheel mouse scrolling at comparable rates.
    const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 400 : 1;
    const dx = -(event.deltaX * unit) / 40;
    const dy = -(event.deltaY * unit) / 40;
    this.#send(encodeWheel(dx, dy));
  };

  #preventDefault = (event) => { event.preventDefault(); };

  /**
   * Maps a viewport point onto the shared display.
   *
   * The video is letterboxed by `object-fit: contain`, so the element's
   * box and the picture inside it are different rectangles. Using the
   * element's box directly is the classic bug that makes a remote
   * cursor drift further off the further you move from centre.
   *
   * Always clamped, never refused. A button press and its release must
   * carry a position, and the letterbox bars belong to the video
   * element, so a release a few pixels into the black used to fall back
   * to a hardcoded { 0.5, 0.5 } — the client's cursor jumped to the
   * middle of their screen and dropped whatever was being dragged
   * there. Clamping keeps it where the operator actually let go.
   */
  #clamped(clientX, clientY) {
    const video = this.#video;
    const rect = video.getBoundingClientRect();
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (!vw || !vh || !rect.width || !rect.height) return this.#lastPoint;

    const scale = Math.min(rect.width / vw, rect.height / vh);
    const shownW = vw * scale;
    const shownH = vh * scale;
    const originX = rect.left + (rect.width - shownW) / 2;
    const originY = rect.top + (rect.height - shownH) / 2;

    const point = {
      x: snapToEdge((clientX - originX) / shownW, shownW),
      y: snapToEdge((clientY - originY) / shownH, shownH),
    };
    this.#lastPoint = point;
    return point;
  }

  /* ---------------------------------------------------------------- *
   * Keyboard
   * ---------------------------------------------------------------- */

  #keyDown = (event) => {
    if (this.#paused) return;
    if (event.target instanceof HTMLElement && isEditable(event.target)) return;

    const id = keyIdFor(event.code);
    if (!id) return;

    event.preventDefault();
    event.stopPropagation();
    if (event.repeat) {
      this.#send(encodeKey(true, id, modsOf(event)), true);
      return;
    }
    this.#held.add(`k:${id}`);
    this.#send(encodeKey(true, id, modsOf(event)), true);
  };

  #keyUp = (event) => {
    if (this.#paused) return;
    if (event.target instanceof HTMLElement && isEditable(event.target)) return;

    const id = keyIdFor(event.code);
    if (!id) return;

    event.preventDefault();
    event.stopPropagation();
    this.#held.delete(`k:${id}`);
    this.#send(encodeKey(false, id, modsOf(event)), true);
  };
}

/**
 * Asks the browser to stop intercepting system-level combinations.
 *
 * Only works in fullscreen and only in Chromium, and even then it does
 * not cover everything — Ctrl+Alt+Delete never reaches a web page on
 * any platform. That gap is why the toolbar offers those combinations
 * as explicit controls rather than pretending they pass through.
 */
export async function lockKeyboard() {
  if (!('keyboard' in navigator) || !navigator.keyboard?.lock) return false;
  try {
    await navigator.keyboard.lock();
    return true;
  } catch {
    return false;
  }
}

export function unlockKeyboard() {
  try { navigator.keyboard?.unlock?.(); } catch { /* not supported */ }
}

/**
 * Combinations the operator's own Mac takes before the page sees them,
 * sent as explicit key events instead.
 *
 * Mac only, because every machine this supports is a Mac. Windows
 * equivalents were written and removed: naming shortcuts for a system
 * nobody here supports is a longer menu and one more thing to read past
 * in the middle of a call.
 *
 * Every code here is already in KEY_TABLE, so nothing on the client
 * needs to change for these to work.
 */
export const COMBOS = {
  language: ['ControlLeft', 'Space'],
  'shot-area': ['MetaLeft', 'ShiftLeft', 'Digit4'],
  'shot-screen': ['MetaLeft', 'ShiftLeft', 'Digit3'],
  copy: ['MetaLeft', 'KeyC'],
  paste: ['MetaLeft', 'KeyV'],
  'select-all': ['MetaLeft', 'KeyA'],
  undo: ['MetaLeft', 'KeyZ'],
  spotlight: ['MetaLeft', 'Space'],
  'switch-app': ['MetaLeft', 'Tab'],
  quit: ['MetaLeft', 'KeyQ'],
  escape: ['Escape'],
};


/**
 * How close to the picture's edge counts as being on it, in the
 * operator's own pixels.
 *
 * Without this the outermost row of the client's screen was reachable
 * only in theory. The console is a browser window, so the bottom of the
 * picture is wherever that window happens to end — the operator pushes
 * their mouse down, it leaves the window, pointermove stops firing, and
 * the client's cursor is left parked a pixel or two short of the
 * boundary. Which is exactly the pixel that reveals an auto-hidden
 * Dock, and the one that holds the menu bar and a window's close
 * button. Landing on it demanded precision nobody has.
 *
 * Four pixels is small enough that it cannot spoil an ordinary click —
 * at the scales this runs at it is a dozen or so pixels on the client's
 * side, well inside a Dock icon — and large enough that pushing toward
 * an edge arrives there.
 */
const EDGE_SNAP_PX = 4;

/** Clamps to 0..1, treating anything within the snap margin as the edge. */
function snapToEdge(value, extent) {
  const margin = extent > 0 ? EDGE_SNAP_PX / extent : 0;
  if (value <= margin) return 0;
  if (value >= 1 - margin) return 1;
  return value;
}

function mapButton(domButton) {
  switch (domButton) {
    case 0: return BUTTON.LEFT;
    case 1: return BUTTON.MIDDLE;
    case 2: return BUTTON.RIGHT;
    default: return null;
  }
}

function modsOf(event) {
  return (event.shiftKey ? MOD.SHIFT : 0)
    | (event.ctrlKey ? MOD.CTRL : 0)
    | (event.altKey ? MOD.ALT : 0)
    | (event.metaKey ? MOD.META : 0);
}

function isEditable(el) {
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
}
