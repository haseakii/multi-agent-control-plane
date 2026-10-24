type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
export interface DraftValue {
  text: string | null;
  persisted: boolean;
}

/** Storage is optional UI convenience, never part of task submission success. */
export function createComposerDrafts(getStore: () => Store) {
  const memory = new Map<string, DraftValue>();
  return {
    read(key: string): DraftValue {
      const current = memory.get(key);
      if (current) return current;
      let value: DraftValue;
      try {
        value = { text: getStore().getItem(key), persisted: true };
      } catch {
        value = { text: null, persisted: false };
      }
      memory.set(key, value);
      return value;
    },
    write(key: string, text: string): DraftValue {
      const value = { text, persisted: false };
      memory.set(key, value);
      try {
        getStore().setItem(key, text);
        value.persisted = true;
      } catch {
        // Discard a stale browser copy when possible; keep the newest input in memory.
        try {
          getStore().removeItem(key);
        } catch {
          /* storage unavailable */
        }
      }
      return value;
    },
    clear(key: string): void {
      // A tombstone prevents an old browser copy from reappearing during this page session.
      const value: DraftValue = { text: null, persisted: false };
      memory.set(key, value);
      try {
        getStore().removeItem(key);
        value.persisted = true;
      } catch {
        /* A successful send must stay successful. */
      }
    },
  };
}

export const composerDrafts = createComposerDrafts(() => sessionStorage);
