const { contextBridge, ipcRenderer } = require('electron');
const methods = ['searchResourceMarket', 'resourceMarketDetail', 'createResource', 'listResources', 'previewResource', 'addResource', 'chooseResource', 'toggleResource', 'removeResource', 'reloadResources', 'state', 'listProjectSessions', 'copyText', 'openLink', 'chooseProject', 'openRecent', 'newSession', 'resume', 'setModel', 'setPermissions', 'setMode', 'updateSession', 'deleteSession', 'setPreferences', 'listFiles', 'readFile', 'run', 'steer', 'followUp', 'abort', 'history', 'changes', 'branch', 'saveKey', 'addModel', 'addPreset', 'updateModelLimits', 'importConfig'];
methods.push('sessionInfo','compactSession','exportSession','completePrompt','piAction');
methods.push('extensionCommand','extensionResponse');
const api = Object.fromEntries(methods.map(method => [method, async params => {
  const response = await ipcRenderer.invoke('agent:invoke', method, params);
  if (!response.ok) throw new Error(response.error); return response.result;
}]));
api.onNotification = callback => { const listener = (_, value) => callback(value); ipcRenderer.on('agent:notification', listener); return () => ipcRenderer.removeListener('agent:notification', listener); };
contextBridge.exposeInMainWorld('localAgent', api);
