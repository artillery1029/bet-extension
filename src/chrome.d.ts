interface ChromeStorageArea {
  get(keys?: string | string[]): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string | string[]): Promise<void>;
}
declare const chrome: {
  runtime: {
    id: string;
    getURL(path: string): string;
    sendMessage(message: unknown): Promise<unknown>;
    onMessage: {
      addListener(listener: (message: unknown, sender: { id?: string; url?: string }, respond: (value: unknown) => void) => boolean | undefined): void;
    };
  };
  storage: {
    session: ChromeStorageArea & { setAccessLevel(options: { accessLevel: 'TRUSTED_CONTEXTS' }): Promise<void> };
    local: ChromeStorageArea & { setAccessLevel(options: { accessLevel: 'TRUSTED_CONTEXTS' }): Promise<void> };
  };
};
