'use strict';

const { fork } = require('child_process');

function createWorkerService({
  isWorker,
  scriptPath,
  onEvent,
  processRef = process,
  forkProcess = fork,
  logger = console,
}) {
  let child = null;
  let requestId = 0;
  const pending = new Map();
  let ipcConnected = !isWorker || Boolean(processRef.connected);

  if (isWorker) {
    processRef.on('disconnect', () => {
      ipcConnected = false;
    });
  }

  function sendFromWorker(message) {
    if (!isWorker || typeof processRef.send !== 'function' || !processRef.connected || !ipcConnected) return false;
    try {
      processRef.send(message, error => {
        if (!error) return;
        if (error.code === 'EPIPE' || error.code === 'ERR_IPC_CHANNEL_CLOSED') {
          ipcConnected = false;
          return;
        }
        logger.error(error);
      });
      return true;
    } catch (error) {
      if (error.code === 'EPIPE' || error.code === 'ERR_IPC_CHANNEL_CLOSED') {
        ipcConnected = false;
        return false;
      }
      throw error;
    }
  }

  function handleParentMessage(message) {
    if (!message || typeof message !== 'object') return;
    if (message.type === 'response') {
      const request = pending.get(message.id);
      if (!request) return;
      pending.delete(message.id);
      if (message.ok) request.resolve(message.payload);
      else request.reject(new Error(message.error || 'Worker command failed.'));
      return;
    }
    if (message.type === 'event') onEvent(message);
  }

  function ensureChild() {
    if (isWorker) return null;
    if (child && child.connected) return child;
    child = forkProcess(scriptPath, [], {
      env: { ...processRef.env, SIMPLE_GALLERY_ROLE: 'worker' },
      stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
    });
    child.on('message', handleParentMessage);
    child.on('exit', () => {
      child = null;
      for (const request of pending.values()) request.reject(new Error('Worker exited.'));
      pending.clear();
    });
    return child;
  }

  function request(command, payload = {}) {
    const activeChild = ensureChild();
    if (!activeChild) return Promise.reject(new Error('Worker unavailable.'));
    const id = ++requestId;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      activeChild.send({ type: 'command', id, command, payload });
    });
  }

  function notifyForeground(at) {
    if (!child?.connected) return false;
    try {
      child.send({ type: 'event', event: 'foreground-activity', payload: { at } });
      return true;
    } catch {
      return false;
    }
  }

  function startProcess(commandHandlers, onForegroundActivity) {
    if (!isWorker) return;
    processRef.on('message', async message => {
      if (!message) return;
      if (message.type === 'event' && message.event === 'foreground-activity') {
        onForegroundActivity(Number(message.payload?.at || Date.now()));
        return;
      }
      if (message.type !== 'command') return;
      const handler = commandHandlers[message.command];
      if (!handler) {
        sendFromWorker({ type: 'response', id: message.id, ok: false, error: 'Unknown worker command.' });
        return;
      }
      try {
        const payload = await handler(message.payload || {});
        sendFromWorker({ type: 'response', id: message.id, ok: true, payload });
      } catch (error) {
        sendFromWorker({ type: 'response', id: message.id, ok: false, error: error.message || 'Worker command failed.' });
      }
    });
  }

  function stop() {
    if (child) {
      try {
        child.kill('SIGTERM');
      } catch {
        // Ignore worker shutdown failures.
      }
      child = null;
    }
    for (const request of pending.values()) request.reject(new Error('Worker stopped.'));
    pending.clear();
    ipcConnected = false;
  }

  return { sendFromWorker, request, notifyForeground, startProcess, stop };
}

module.exports = { createWorkerService };
