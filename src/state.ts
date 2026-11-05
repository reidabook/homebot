import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const STATE_DIR = join(import.meta.dirname, '..', 'state');

export function readJson<T>(name: string, fallback: T): T {
  const path = join(STATE_DIR, name);
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

/** Atomic write (tmp + rename) so a crash never leaves a half-written file. */
export function writeJson(name: string, data: unknown, mode = 0o644) {
  const path = join(STATE_DIR, name);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2), { mode });
  chmodSync(tmp, mode);
  renameSync(tmp, path);
}

export interface Checkpoint {
  /** Highest message ROWID fully handled in the group chat. */
  lastRowId: number;
  /** The same, for each direct-message chat, keyed by chat guid. */
  dms?: Record<string, number>;
}

export const loadCheckpoint = () => readJson<Checkpoint | null>('checkpoint.json', null);
export const saveCheckpoint = (c: Checkpoint) => writeJson('checkpoint.json', c);
