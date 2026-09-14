const { contextBridge, ipcRenderer } = require('electron');

/**
 * Bridge for the capture engine renderer.
 *
 * The engine window has no UI and never loads remote content, but it is
 * still the process that touches the network, so it runs with context
 * isolation on and reaches the main process only through this fixed
 * surface. Nothing here accepts a channel name from the caller.
 */
contextBridge.exposeInMainWorld('desky', {
  ready: () => ipcRenderer.send('engine:ready'),

  onStart: (fn) => ipcRenderer.on('engine:start', (_e, payload) => fn(payload)),
  onSignal: (fn) => ipcRenderer.on('engine:signal', (_e, payload) => fn(payload)),
  onStop: (fn) => ipcRenderer.on('engine:stop', (_e, payload) => fn(payload)),
  onSetDisplay: (fn) => ipcRenderer.on('engine:set-display', (_e, payload) => fn(payload)),
  onSetQuality: (fn) => ipcRenderer.on('engine:set-quality', (_e, payload) => fn(payload)),
  onClipboardData: (fn) => ipcRenderer.on('engine:clipboard-data', (_e, payload) => fn(payload)),
  onControlOut: (fn) => ipcRenderer.on('engine:control-out', (_e, payload) => fn(payload)),

  signalOut: (payload) => ipcRenderer.send('engine:signal-out', payload),
  state: (payload) => ipcRenderer.send('engine:state', payload),
  stats: (payload) => ipcRenderer.send('engine:stats', payload),
  input: (buffer) => ipcRenderer.send('engine:input', buffer),
  control: (payload) => ipcRenderer.send('engine:control', payload),

  listDisplays: () => ipcRenderer.invoke('engine:list-displays'),
});
