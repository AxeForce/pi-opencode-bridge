import { randomBytes } from 'node:crypto';

type IDPrefix = 'ses' | 'msg' | 'prt' | 'pty' | 'cal' | 'usr' | 'per';

// OpenCode uses: {prefix}_{12 hex timestamp}{14 base62} — NO underscores/hyphens in the body
// nanoid's default alphabet includes _ and - which breaks desktop session lookup
const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

function randomBase62(length: number): string {
  const bytes = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) {
    out += BASE62[bytes[i] % 62];
  }
  return out;
}

function generateID(prefix: IDPrefix): string {
  const timestamp = Date.now().toString(16).padStart(12, '0');
  return `${prefix}_${timestamp}${randomBase62(14)}`;
}

export const newSessionID = () => generateID('ses');
export const newMessageID = () => generateID('msg');
export const newPartID = () => generateID('prt');
export const newPtyID = () => generateID('pty');
export const newCallID = () => generateID('cal');
export const newUserID = () => generateID('usr');
export const newPermissionID = () => generateID('per');

export function isValidID(id: string, prefix?: IDPrefix): boolean {
  if (!id || typeof id !== 'string') return false;
  if (prefix && !id.startsWith(`${prefix}_`)) return false;
  // Body after prefix_ must be alphanumeric only
  const body = id.slice(id.indexOf('_') + 1);
  return /^[0-9A-Za-z]+$/.test(body);
}
