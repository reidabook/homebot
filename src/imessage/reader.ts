import { DatabaseSync } from 'node:sqlite';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const CHAT_DB = join(homedir(), 'Library', 'Messages', 'chat.db');

// Messages stores dates as nanoseconds since 2001-01-01 (Apple epoch). Queries divide to ms
// in SQL because node:sqlite throws on integers beyond Number.MAX_SAFE_INTEGER.
const APPLE_EPOCH_MS = Date.UTC(2001, 0, 1);

export interface ChatMessage {
  rowId: number;
  sender: string; // handle id (phone/email), or 'me' for messages sent by this account
  isFromMe: boolean;
  text: string;
  sentAt: Date;
}

export function openDb() {
  // Read-only; Messages.app keeps writing via WAL, which read-only readers still see.
  return new DatabaseSync(CHAT_DB, { readOnly: true });
}

/**
 * Newer macOS often leaves message.text NULL and stores the body only in
 * attributedBody (an NSArchiver "typedstream"). The string payload follows the
 * NSString class marker as: '+' then a length (1 byte, or 0x81 + uint16 LE,
 * or 0x82 + uint32 LE) then UTF-8 bytes.
 */
export function decodeAttributedBody(blob: Uint8Array | null): string | null {
  if (!blob) return null;
  const buf = Buffer.from(blob);
  const marker = buf.indexOf('NSString');
  if (marker < 0) return null;
  const plus = buf.indexOf(0x2b, marker + 8);
  if (plus < 0 || plus > marker + 16) return null;
  let pos = plus + 1;
  let len = buf[pos++];
  if (len === 0x81) {
    len = buf.readUInt16LE(pos);
    pos += 2;
  } else if (len === 0x82) {
    len = buf.readUInt32LE(pos);
    pos += 4;
  }
  return buf.subarray(pos, pos + len).toString('utf8');
}

type Row = {
  rowId: number;
  text: string | null;
  attributedBody: Uint8Array | null;
  isFromMe: number;
  sender: string | null;
  dateMs: number;
};

const BASE_SELECT = `
  SELECT m.ROWID AS rowId, m.text, m.attributedBody, m.is_from_me AS isFromMe,
         h.id AS sender, m.date / 1000000 AS dateMs
  FROM message m
  JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
  JOIN chat c ON c.ROWID = cmj.chat_id
  LEFT JOIN handle h ON h.ROWID = m.handle_id
  WHERE c.guid = ?
    AND m.associated_message_type = 0   -- skip tapbacks/reactions
    AND m.item_type = 0                  -- skip renames, member adds, etc.
`;

function toMessage(r: Row): ChatMessage | null {
  // U+FFFC is the attachment placeholder; strip it so photo-only messages drop out.
  const text = (r.text ?? decodeAttributedBody(r.attributedBody) ?? '').replace(/￼/g, '').trim();
  if (!text) return null;
  return {
    rowId: r.rowId,
    sender: r.isFromMe ? 'me' : (r.sender ?? 'unknown'),
    isFromMe: !!r.isFromMe,
    text,
    sentAt: new Date(APPLE_EPOCH_MS + r.dateMs),
  };
}

/** All messages in the chat after the checkpoint, oldest first. */
export function messagesSince(db: DatabaseSync, chatGuid: string, afterRowId: number): ChatMessage[] {
  const rows = db.prepare(`${BASE_SELECT} AND m.ROWID > ? ORDER BY m.ROWID ASC`).all(chatGuid, afterRowId) as Row[];
  return rows.map(toMessage).filter((m): m is ChatMessage => m !== null);
}

/** The most recent `limit` messages at or before a ROWID, oldest first (context window). */
export function recentMessages(db: DatabaseSync, chatGuid: string, upToRowId: number, limit: number): ChatMessage[] {
  const rows = db
    .prepare(`${BASE_SELECT} AND m.ROWID <= ? ORDER BY m.ROWID DESC LIMIT ?`)
    .all(chatGuid, upToRowId, limit) as Row[];
  return rows.map(toMessage).filter((m): m is ChatMessage => m !== null).reverse();
}

export function maxRowId(db: DatabaseSync, chatGuid: string): number {
  const row = db
    .prepare(
      `SELECT COALESCE(MAX(cmj.message_id), 0) AS id FROM chat_message_join cmj
       JOIN chat c ON c.ROWID = cmj.chat_id WHERE c.guid = ?`,
    )
    .get(chatGuid) as { id: number };
  return row.id;
}

export interface ChatSummary {
  guid: string;
  name: string | null;
  participants: string[];
  lastMessageAt: Date;
}

export function recentChats(db: DatabaseSync, limit = 15): ChatSummary[] {
  const rows = db
    .prepare(
      `SELECT c.guid, c.display_name AS name,
              (SELECT GROUP_CONCAT(h.id, ', ') FROM chat_handle_join chj JOIN handle h ON h.ROWID = chj.handle_id
               WHERE chj.chat_id = c.ROWID) AS participants,
              MAX(m.date) / 1000000 AS lastMs
       FROM chat c
       JOIN chat_message_join cmj ON cmj.chat_id = c.ROWID
       JOIN message m ON m.ROWID = cmj.message_id
       GROUP BY c.ROWID ORDER BY lastMs DESC LIMIT ?`,
    )
    .all(limit) as { guid: string; name: string | null; participants: string | null; lastMs: number }[];
  return rows.map((r) => ({
    guid: r.guid,
    name: r.name || null,
    participants: r.participants ? r.participants.split(', ') : [],
    lastMessageAt: new Date(APPLE_EPOCH_MS + r.lastMs),
  }));
}
