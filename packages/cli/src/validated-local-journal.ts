import type { LocalJournalStorage } from "./local-journal-storage";

export type ValidatedLocalJournal<T> = {
  load: () => T;
  save: (state: T) => void;
  exclusively: <R>(callback: () => Promise<R>) => Promise<R>;
};

export function bindLocalJournal<T>(storage: LocalJournalStorage, options: {
  parse: (input: unknown) => T;
  assertIdentity: (state: T) => void;
  assertTransition: (previous: T, next: T) => void;
  lockMessage?: string;
}): ValidatedLocalJournal<T> {
  const load = (): T => {
    const state = options.parse(storage.read());
    options.assertIdentity(state);
    return state;
  };
  load();
  return {
    load,
    save: (input) => {
      storage.requireLock(options.lockMessage);
      const next = options.parse(input);
      const previous = load();
      options.assertTransition(previous, next);
      storage.replace(next);
    },
    exclusively: storage.exclusively,
  };
}
