const { contextBridge, ipcRenderer } = require('electron');

/** Bridge for the click-through frame. Receives only; sends nothing. */

let onUpdate = () => {};

ipcRenderer.on('border:update', (_event, state) => onUpdate(state));

contextBridge.exposeInMainWorld('desky', {
  onUpdate: (fn) => { onUpdate = fn; },
});
