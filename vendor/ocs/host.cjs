'use strict';
const { app, BrowserWindow } = require('electron');
const { mkdirSync } = require('node:fs');
const { timingSafeEqual } = require('node:crypto');
const path = require('node:path');
const directory = process.env.SWU_OCS_DATA_DIR;
const token = process.env.SWU_OCS_HOST_TOKEN;
if (!directory || !path.isAbsolute(directory) || !/^[a-f0-9]{64}$/.test(token || '')) throw new Error('Invalid embedded OCS host configuration.');
mkdirSync(directory, { recursive: true });
mkdirSync(path.join(directory, 'logs'), { recursive: true });
app.setPath('userData', directory);
app.setPath('logs', path.join(directory, 'logs'));
exports.handle = (request, response) => {
  const supplied = request.headers['x-swu-ocs-host'];
  if (typeof supplied !== 'string' || !/^[a-f0-9]{64}$/.test(supplied) || !timingSafeEqual(Buffer.from(supplied), Buffer.from(token))) { response.sendStatus(403); return; }
  const command = request.body?.command;
  if (request.body?.protocol !== 1 || !['state', 'focus', 'stop'].includes(command)) { response.sendStatus(400); return; }
  const window = BrowserWindow.getAllWindows().find(value => !value.isDestroyed());
  if (command === 'focus' && window) { if (window.isMinimized()) window.restore(); window.show(); window.focus(); }
  response.json({ version: app.getVersion(), pid: process.pid, executable: process.execPath, ready: Boolean(window && window.isVisible() && !window.webContents.isLoadingMainFrame()), title: window?.getTitle() || '' });
  if (command === 'stop') setImmediate(() => { if (window && !window.isDestroyed()) window.close(); else app.quit(); });
};
