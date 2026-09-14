const { contextBridge, ipcRenderer } = require('electron');

/**
 * Bridge for the client's panel.
 *
 * Every entry is a named verb with no arguments the renderer could use
 * to reach something else. In particular there is no generic "send"
 * and no way to name an IPC channel: the panel can ask to accept a
 * request, but it cannot ask main to do anything main did not offer.
 */

let onUpdate = () => {};

ipcRenderer.on('panel:update', (_event, state) => onUpdate(state));

contextBridge.exposeInMainWorld('desky', {
  onUpdate: (fn) => { onUpdate = fn; },

  /** Tells main the handler is installed and state can be pushed. */
  ready: () => ipcRenderer.send('panel:ready'),

  refresh: async () => { onUpdate(await ipcRenderer.invoke('panel:state')); },

  accept: () => ipcRenderer.send('panel:accept'),
  decline: () => ipcRenderer.send('panel:decline'),
  end: () => ipcRenderer.send('panel:end'),
  rotatePassword: () => ipcRenderer.send('panel:rotate-password'),

  setName: (name) => ipcRenderer.send('panel:set-name', name),
  setServer: (url) => ipcRenderer.send('panel:set-server', url),
  setLaunchAtLogin: (enabled) => ipcRenderer.send('panel:set-launch-at-login', enabled),

  openLogs: () => ipcRenderer.send('panel:open-logs'),
  history: () => ipcRenderer.invoke('panel:history'),

  requestPermission: (which) => ipcRenderer.send('panel:request-permission', which),
  relaunch: () => ipcRenderer.send('panel:relaunch'),
  quit: () => ipcRenderer.send('panel:quit'),
});
