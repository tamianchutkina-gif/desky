import { createRequire } from 'node:module';

import { OP, BUTTON, keyCodeFor } from '../shared/protocol.js';

const require = createRequire(import.meta.url);

/**
 * Native input injection.
 *
 * These are N-API addons, so the same prebuilt binary loads under both
 * Node and Electron with no rebuild step. Their calls are synchronous
 * and cost tens of microseconds, which is why input frames are injected
 * the moment they arrive rather than queued: a queue would add latency
 * to the one thing the operator feels most.
 *
 * The platform package is required directly rather than through the
 * `@nut-tree-fork/libnut` wrapper. The wrapper exports promise-returning
 * classes with a built-in per-event delay; the raw binding underneath it
 * is the synchronous API this file actually wants.
 */
const PLATFORM_BINDING = {
  darwin: '@nut-tree-fork/libnut-darwin',
  win32: '@nut-tree-fork/libnut-win32',
  linux: '@nut-tree-fork/libnut-linux',
};

let libnut = null;
let loadError = null;

try {
  const binding = PLATFORM_BINDING[process.platform];
  if (!binding) throw new Error(`Platform ${process.platform} is not supported`);
  libnut = require(binding);

  // Fail loudly here rather than at the first keystroke of a live
  // session, when the client is watching and nothing responds.
  for (const fn of ['moveMouse', 'mouseToggle', 'scrollMouse', 'keyToggle', 'typeString']) {
    if (typeof libnut[fn] !== 'function') {
      throw new Error(`The input module loaded without ${fn}()`);
    }
  }
} catch (err) {
  libnut = null;
  loadError = err;
  console.error('[input] control unavailable:', err.message);
}

const isMac = process.platform === 'darwin';
const isWindows = process.platform === 'win32';


/* ------------------------------------------------------------------ *
 * Key mapping
 * ------------------------------------------------------------------ */

const LETTERS = Object.fromEntries(
  [...'abcdefghijklmnopqrstuvwxyz'].map((c) => [`Key${c.toUpperCase()}`, c]),
);
const DIGITS = Object.fromEntries(
  [...'0123456789'].map((d) => [`Digit${d}`, d]),
);
const FUNCTION_KEYS = Object.fromEntries(
  Array.from({ length: 24 }, (_, i) => [`F${i + 1}`, `f${i + 1}`]),
);
const NUMPAD = Object.fromEntries(
  Array.from({ length: 10 }, (_, i) => [`Numpad${i}`, `numpad_${i}`]),
);

/**
 * The Meta key is the one mapping that genuinely differs per OS, and
 * getting it wrong means every shortcut the operator knows silently
 * does nothing on the client's machine.
 */
const META_LEFT = isMac ? 'cmd' : isWindows ? 'win' : 'meta';
const META_RIGHT = isMac ? 'right_cmd' : isWindows ? 'right_win' : 'right_meta';

const KEY_MAP = {
  ...LETTERS,
  ...DIGITS,
  ...FUNCTION_KEYS,
  ...NUMPAD,

  Escape: 'escape',
  Backspace: 'backspace',
  Tab: 'tab',
  Space: 'space',
  Enter: 'enter',
  Delete: 'delete',
  CapsLock: 'caps_lock',

  Minus: '-',
  Equal: '=',
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  Semicolon: ';',
  Quote: "'",
  Backquote: '`',
  Comma: ',',
  Period: '.',
  Slash: '/',
  IntlBackslash: '\\',

  PrintScreen: 'printscreen',
  ScrollLock: 'scroll_lock',
  NumLock: 'num_lock',
  Insert: 'insert',
  Home: 'home',
  End: 'end',
  PageUp: 'pageup',
  PageDown: 'pagedown',

  ArrowUp: 'up',
  ArrowDown: 'down',
  ArrowLeft: 'left',
  ArrowRight: 'right',

  NumpadDivide: 'divide',
  NumpadMultiply: 'multiply',
  NumpadSubtract: 'subtract',
  NumpadAdd: 'add',
  NumpadEnter: 'enter',
  NumpadDecimal: 'numpad_decimal',

  ShiftLeft: 'shift',
  ShiftRight: 'right_shift',
  ControlLeft: 'control',
  ControlRight: 'right_control',
  AltLeft: 'alt',
  AltRight: 'right_alt',
  MetaLeft: META_LEFT,
  MetaRight: META_RIGHT,
  ContextMenu: 'menu',

  AudioVolumeMute: 'audio_mute',
  AudioVolumeDown: 'audio_vol_down',
  AudioVolumeUp: 'audio_vol_up',
};

const MOUSE_BUTTONS = {
  [BUTTON.LEFT]: 'left',
  [BUTTON.MIDDLE]: 'middle',
  [BUTTON.RIGHT]: 'right',
};

/* ------------------------------------------------------------------ *
 * Injector
 * ------------------------------------------------------------------ */

export class InputInjector {
  #target = null;
  #heldKeys = new Set();
  #heldButtons = new Set();
  #enabled = false;
  #counters = { moves: 0, clicks: 0, keys: 0, scrolls: 0 };
  #lastPointer = { x: 0, y: 0 };
  #dipToScreen = null;

  static get available() {
    return libnut !== null;
  }

  static get loadError() {
    return loadError;
  }

  /**
   * @param {{dipToScreen?: (point: {x:number,y:number}) => {x:number,y:number}}} [options]
   *   Supplied by the main process, which is the only place Electron's
   *   screen API exists.
   */
  constructor({ dipToScreen } = {}) {
    this.#dipToScreen = dipToScreen ?? null;
    if (libnut) {
      // Both default to a per-event sleep. For a remote session that
      // sleep is pure added latency on every keystroke and mouse move.
      libnut.setMouseDelay(0);
      libnut.setKeyboardDelay(0);
    }
  }

  /**
   * @param {{x:number,y:number,width:number,height:number,scaleFactor:number}} bounds
   *   The display being shared, in Electron's DIP coordinate space.
   */
  enable(bounds) {
    this.#target = bounds;
    this.#enabled = true;
    this.#counters = { moves: 0, clicks: 0, keys: 0, scrolls: 0 };
  }

  setTarget(bounds) {
    this.#target = bounds;
  }

  /**
   * Stops injection and releases everything still held down.
   *
   * This is the most important method in the file. If a session drops
   * while the operator is holding Cmd, the client is left with a
   * modifier stuck down on their own machine and no idea why nothing
   * works. Every path that ends a session goes through here.
   */
  disable() {
    this.#enabled = false;
    this.releaseAll();
    this.#target = null;
  }

  releaseAll() {
    if (!libnut) return;

    for (const button of this.#heldButtons) {
      try { libnut.mouseToggle('up', button); } catch { /* best effort */ }
    }
    this.#heldButtons.clear();

    for (const key of this.#heldKeys) {
      try { libnut.keyToggle(key, 'up', []); } catch { /* best effort */ }
    }
    this.#heldKeys.clear();
  }

  get counters() {
    return { ...this.#counters };
  }

  get pointer() {
    return { ...this.#lastPointer };
  }

  /**
   * Releases anything this machine is holding that the operator does not
   * claim to be holding. The operator's browser is the authority here:
   * it knows what its user is physically pressing, and this process only
   * knows what arrived.
   */
  reconcileHeld({ keys, buttons }) {
    if (!this.#enabled || !libnut) return;

    const wantedKeys = new Set();
    for (const id of keys) {
      const key = KEY_MAP[keyCodeFor(id)];
      if (key) wantedKeys.add(key);
    }
    for (const key of [...this.#heldKeys]) {
      if (wantedKeys.has(key)) continue;
      try { libnut.keyToggle(key, 'up', []); } catch { /* not a key here */ }
      this.#heldKeys.delete(key);
    }

    const wantedButtons = new Set();
    for (const id of buttons) {
      const button = MOUSE_BUTTONS[id];
      if (button) wantedButtons.add(button);
    }
    for (const button of [...this.#heldButtons]) {
      if (wantedButtons.has(button)) continue;
      try { libnut.mouseToggle('up', button); } catch { /* already up */ }
      this.#heldButtons.delete(button);
    }
  }

  /** Applies one decoded input frame. Returns a short activity tag, or null. */
  apply(frame) {
    if (!this.#enabled || !libnut || !frame) return null;

    switch (frame.op) {
      case OP.MOUSE_MOVE:
        this.#move(frame.x, frame.y);
        this.#counters.moves += 1;
        return null;

      case OP.MOUSE_DOWN: {
        this.#move(frame.x, frame.y);
        const button = MOUSE_BUTTONS[frame.button];
        if (!button) return null;
        libnut.mouseToggle('down', button);
        this.#heldButtons.add(button);
        return null;
      }

      case OP.MOUSE_UP: {
        // Double-clicks need no special handling. The native layer
        // tracks click state against a double-click interval and stamps
        // it onto each event, so two plain down/up pairs arriving close
        // together coalesce into a real double-click on the client's
        // machine — the same way a physical mouse would.
        this.#move(frame.x, frame.y);
        const button = MOUSE_BUTTONS[frame.button];
        if (!button) return null;
        libnut.mouseToggle('up', button);
        this.#heldButtons.delete(button);
        this.#counters.clicks += 1;
        return 'click';
      }

      case OP.MOUSE_WHEEL:
        libnut.scrollMouse(frame.dx, frame.dy);
        this.#counters.scrolls += 1;
        return null;

      case OP.KEY_DOWN: {
        const key = KEY_MAP[keyCodeFor(frame.keyId)];
        if (!key) return null;
        // The binding resolves a single character through the client's
        // own ASCII-capable layout with no modifiers, so '[' is "not a
        // key" on a German keyboard and this throws. Uncaught, it takes
        // the main process down mid-session.
        try {
          libnut.keyToggle(key, 'down', []);
        } catch {
          return null;
        }
        this.#heldKeys.add(key);
        this.#counters.keys += 1;
        return 'key';
      }

      case OP.KEY_UP: {
        const key = KEY_MAP[keyCodeFor(frame.keyId)];
        if (!key) return null;
        try { libnut.keyToggle(key, 'up', []); } catch { /* never went down */ }
        this.#heldKeys.delete(key);
        return null;
      }

      case OP.TEXT:
        // Typing by physical key code produces whatever character the
        // client's own keyboard layout maps it to. When the operator
        // needs a specific string regardless of layout — a password, a
        // Cyrillic name typed on a Latin layout — this path carries the
        // characters themselves.
        if (typeof frame.text === 'string' && frame.text.length > 0) {
          libnut.typeString(frame.text.slice(0, 4096));
          this.#counters.keys += frame.text.length;
          return 'text';
        }
        return null;

      default:
        return null;
    }
  }

  /**
   * Normalized 0..1 coordinates become absolute screen coordinates here.
   *
   * Sending normalized values rather than pixels means a monitor switch
   * or a resolution change needs no renegotiation, and the operator's
   * window size never has to match the client's screen.
   *
   * The DIP-to-physical conversion is delegated to Electron rather than
   * done with the display's own scale factor. Multiplying the whole
   * point by one display's scale is only correct when every display
   * shares that scale: on a 200% 4K primary beside a 100% 1080p
   * secondary, it puts every click on the wrong monitor.
   */
  #move(nx, ny) {
    const bounds = this.#target;
    if (!bounds) return;

    const clampedX = Math.min(1, Math.max(0, nx));
    const clampedY = Math.min(1, Math.max(0, ny));

    // Kept a pixel inside the display. `bounds.y + height` is the first
    // row of whatever sits below this screen, so an operator pushing at
    // the bottom edge — reaching for the Dock — was aiming their cursor
    // at the display underneath.
    const dip = {
      x: bounds.x + Math.min(clampedX * bounds.width, bounds.width - 1),
      y: bounds.y + Math.min(clampedY * bounds.height, bounds.height - 1),
    };

    const point = this.#dipToScreen ? this.#dipToScreen(dip) : dip;

    const px = Math.round(point.x);
    const py = Math.round(point.y);
    this.#lastPointer = { x: px, y: py };
    libnut.moveMouse(px, py);
  }
}

/** Foreground window title, used only to tell the client what is focused. */
export function activeWindowTitle() {
  if (!libnut) return null;
  try {
    const handle = libnut.getActiveWindow();
    if (handle == null) return null;
    const title = libnut.getWindowTitle(handle);
    return typeof title === 'string' && title.trim() ? title.trim().slice(0, 80) : null;
  } catch {
    return null;
  }
}

/** Main-display size in the coordinate space libnut expects. */
export function nativeScreenSize() {
  if (!libnut) return null;
  try {
    return libnut.getScreenSize();
  } catch {
    return null;
  }
}
