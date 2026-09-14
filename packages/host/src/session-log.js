import fs from 'node:fs';
import path from 'node:path';

import { app, shell } from 'electron';

/**
 * Append-only session journal, stored on the client's own machine.
 *
 * The point is not audit compliance — it is that the person who granted
 * access can answer "what happened on my computer last Tuesday?"
 * without asking the operator. It lives in their user data directory,
 * is plain JSON Lines, and the agent can open the folder for them.
 *
 * Nothing here is uploaded anywhere.
 */
/** Size at which the journal rotates, keeping one previous file. */
const MAX_LOG_BYTES = 4 * 1024 * 1024;

/** How much of the tail `recent()` reads. */
const TAIL_BYTES = 256 * 1024;

/** Failed-password entries are collapsed within this window. */
const DECLINE_WINDOW_MS = 60_000;

export class SessionLog {
  #dir;
  #file;
  #stream = null;
  #written = 0;
  #lastDecline = 0;
  #suppressed = 0;

  constructor() {
    this.#dir = path.join(app.getPath('userData'), 'logs');
    fs.mkdirSync(this.#dir, { recursive: true });
    this.#file = path.join(this.#dir, 'sessions.jsonl');

    // Seed from what is already on disk, or the size cap would only ever
    // count the current run and a long-lived file would never rotate.
    try {
      this.#written = fs.statSync(this.#file).size;
    } catch {
      this.#written = 0;
    }
  }

  #write(record) {
    const line = `${JSON.stringify({ at: new Date().toISOString(), ...record })}\n`;
    try {
      this.#rotateIfLarge();

      if (!this.#stream) {
        this.#stream = fs.createWriteStream(this.#file, { flags: 'a', mode: 0o600 });
        this.#stream.on('error', (err) => {
          console.error('[log] writing stopped:', err.message);
          this.#stream = null;
        });
      }
      this.#stream.write(line);
      this.#written += line.length;
    } catch (err) {
      console.error('[log] could not write:', err.message);
    }
  }

  /**
   * Keeps one previous file and starts fresh past the size cap.
   *
   * Anyone who knows the nine-digit ID can drive failed-password entries
   * into this file from anywhere, so it cannot be allowed to grow
   * without bound on a client's disk.
   */
  #rotateIfLarge() {
    if (this.#written < MAX_LOG_BYTES) return;
    this.#stream?.end();
    this.#stream = null;
    this.#written = 0;
    try {
      fs.renameSync(this.#file, `${this.#file}.1`);
    } catch {
      /* nothing to rotate yet */
    }
  }

  requested({ sessionId, operatorName, operatorAddr }) {
    this.#write({ event: 'request', sessionId, operatorName, operatorAddr });
  }

  /**
   * Failed password attempts are coalesced.
   *
   * A person declining a request is worth a line every time. A remote
   * attempt with the wrong password is not — it can be driven at
   * whatever rate the network allows, so a burst becomes one line with a
   * count rather than thousands.
   */
  declined({ sessionId, operatorName, reason }) {
    if (reason !== 'bad_password') {
      this.#write({ event: 'declined', sessionId, operatorName, reason });
      return;
    }

    const now = Date.now();
    if (now - this.#lastDecline < DECLINE_WINDOW_MS) {
      this.#suppressed += 1;
      return;
    }

    this.#write({
      event: 'declined',
      sessionId,
      operatorName,
      reason,
      ...(this.#suppressed > 0 ? { alsoSuppressed: this.#suppressed } : {}),
    });
    this.#lastDecline = now;
    this.#suppressed = 0;
  }

  started({ sessionId, operatorName, operatorAddr, display }) {
    this.#write({ event: 'start', sessionId, operatorName, operatorAddr, display });
  }

  note({ sessionId, kind, detail }) {
    this.#write({ event: 'note', sessionId, kind, detail });
  }

  ended({ sessionId, operatorName, durationMs, counters, reason }) {
    this.#write({ event: 'end', sessionId, operatorName, durationMs, counters, reason });
  }

  /** Most recent entries, newest first, for the agent's history view. */
  recent(limit = 50) {
    try {
      // Read only the tail. The file is capped but can still be
      // megabytes, and the panel wants the last few dozen entries.
      const { size } = fs.statSync(this.#file);
      const start = Math.max(0, size - TAIL_BYTES);
      const handle = fs.openSync(this.#file, 'r');
      const buffer = Buffer.alloc(Math.min(size, TAIL_BYTES));
      fs.readSync(handle, buffer, 0, buffer.length, start);
      fs.closeSync(handle);

      const raw = buffer.toString('utf8');
      const lines = raw.split('\n').filter(Boolean);
      // The first line is probably a fragment when reading from an offset.
      if (start > 0) lines.shift();
      const parsed = [];
      for (let i = lines.length - 1; i >= 0 && parsed.length < limit; i -= 1) {
        try {
          parsed.push(JSON.parse(lines[i]));
        } catch {
          /* a torn final line from an unclean shutdown */
        }
      }
      return parsed;
    } catch {
      return [];
    }
  }

  async reveal() {
    try {
      // Ensure the file exists so the reveal does not silently no-op on
      // a machine that has never hosted a session.
      if (!fs.existsSync(this.#file)) fs.writeFileSync(this.#file, '', { mode: 0o600 });
      shell.showItemInFolder(this.#file);
    } catch (err) {
      console.error('[log] could not open the folder:', err.message);
    }
  }

  close() {
    this.#stream?.end();
    this.#stream = null;
  }
}
