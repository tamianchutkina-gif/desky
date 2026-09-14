import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Config } from '../packages/host/src/config.js';
import { DEFAULT_QUALITY, QUALITY } from '../shared/protocol.js';

/**
 * The agent's settings file.
 *
 * The protocol names balanced as the default and records why: the first
 * session between two homes ran at maximum and delivered 22 kbit/s and
 * four frames. The agent kept its own copy of that decision and it said
 * something else, so no clean install ever started where the protocol
 * said it would.
 */

const freshConfig = () => new Config(fs.mkdtempSync(path.join(os.tmpdir(), 'desky-config-')));

test('a fresh agent starts on the quality the protocol documents', () => {
  assert.equal(freshConfig().get('quality'), DEFAULT_QUALITY);
});

test('the default names a preset that exists', () => {
  assert.ok(QUALITY[freshConfig().get('quality')]);
});
