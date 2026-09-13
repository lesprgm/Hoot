const { contextBridge, ipcRenderer } = require("electron");

const listenerMap = new Map<string, Map<(payload: unknown) => void, (...args: unknown[]) => void>>();

contextBridge.exposeInMainWorld("__gazeIpc", {
    invoke: (channel: string, ...args: unknown[]): Promise<unknown> => ipcRenderer.invoke(channel, ...args),
    send: (channel: string, ...args: unknown[]): void => ipcRenderer.send(channel, ...args),
    on: (channel: string, listener: (payload: unknown) => void): void => {
      const wrapped = (_event: unknown, payload: unknown) => listener(payload);
      const channelListeners = listenerMap.get(channel) ?? new Map();
      channelListeners.set(listener, wrapped);
      listenerMap.set(channel, channelListeners);
      ipcRenderer.on(channel, wrapped);
    },
    removeListener: (channel: string, listener: (payload: unknown) => void): void => {
      const wrapped = listenerMap.get(channel)?.get(listener);
      if (wrapped) ipcRenderer.removeListener(channel, wrapped);
      listenerMap.get(channel)?.delete(listener);
    },
});
