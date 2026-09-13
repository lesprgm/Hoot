interface IpcBridge {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  send(channel: string, ...args: unknown[]): void;
  on(channel: string, listener: (payload: unknown) => void): void;
  removeListener(channel: string, listener: (payload: unknown) => void): void;
}

export function bridge(): IpcBridge | null {
  const g = globalThis as unknown as { __gazeIpc?: IpcBridge };
  return g.__gazeIpc ?? null;
}

export function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  const ipc = bridge();
  if (!ipc) return Promise.resolve(undefined as T);
  return ipc.invoke(channel, ...args) as Promise<T>;
}

export function send(channel: string, ...args: unknown[]): void {
  const ipc = bridge();
  if (!ipc) return;
  ipc.send(channel, ...args);
}

export function subscribe<T>(channel: string, handler: (payload: T) => void): () => void {
  const ipc = bridge();
  if (!ipc) return () => {};
  const wrapper = (payload: unknown) => handler(payload as T);
  ipc.on(channel, wrapper);
  return () => ipc.removeListener(channel, wrapper);
}