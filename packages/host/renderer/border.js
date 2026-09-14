import { humanDuration } from '../shared/protocol.js';

/** Keeps the frame's label current. Nothing here can end or alter a session. */

const who = document.getElementById('who');
const time = document.getElementById('time');

let startedAt = null;

window.desky.onUpdate((state) => {
  who.textContent = state.operatorName || 'Support';
  startedAt = state.startedAt ?? null;
  paint();
});

function paint() {
  time.textContent = startedAt ? humanDuration(Date.now() - startedAt) : '00:00';
}

setInterval(paint, 1000);
