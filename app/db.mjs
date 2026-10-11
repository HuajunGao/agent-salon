// SQLite (data/chat.db): the schema, its migrations, and query helpers. The server is the only writer.
import { DatabaseSync } from 'node:sqlite';
import { chmodSync } from 'node:fs';
import { join } from 'node:path';
import { DATA, RUNAS } from './workspace.mjs';

export const db = new DatabaseSync(join(DATA, 'chat.db'));
if (RUNAS) chmodSync(join(DATA, 'chat.db'), 0o600); // agents can't read the database (incl. other discussions' sessions)
db.exec(`
CREATE TABLE IF NOT EXISTS chats(id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP, paused INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS messages(id INTEGER PRIMARY KEY AUTOINCREMENT, chat_id INTEGER, sender TEXT, kind TEXT, text TEXT,
  based_on INTEGER, reply_to INTEGER, latency_ms INTEGER, turn_no INTEGER, stale INTEGER DEFAULT 0,
  collapsed INTEGER DEFAULT 0, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS agent_sessions(chat_id INTEGER, agent TEXT, cli_session_id TEXT, last_seen_id INTEGER DEFAULT 0,
  turns INTEGER DEFAULT 0, status TEXT, updated_at TEXT, PRIMARY KEY(chat_id, agent));
-- Every scheduler decision, for comparing scheduler modes later.
CREATE TABLE IF NOT EXISTS decisions(id INTEGER PRIMARY KEY, chat_id INTEGER, at TEXT DEFAULT CURRENT_TIMESTAMP, mode TEXT,
  event TEXT, agent TEXT, score REAL, detail TEXT, based_on INTEGER, message_id INTEGER, latency_ms INTEGER);
CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT);
-- Members' background jobs ([JOB]: kind 'job', cmd = the command) and tasks ([TASK]: kind 'task', cmd = what to do,
-- branch = task/T<id> for [TASK shared]); status: running / done / failed / stopped / timeout / interrupted.
CREATE TABLE IF NOT EXISTS jobs(id INTEGER PRIMARY KEY, chat_id INTEGER, agent TEXT, cmd TEXT, msg_id INTEGER, status TEXT,
  code INTEGER, started_at TEXT DEFAULT CURRENT_TIMESTAMP, ended_at TEXT);`);
const addColumns = (t, cols) => {
  const have = db.prepare(`PRAGMA table_info(${t})`).all().map(c => c.name);
  for (const [col, def] of cols) if (!have.includes(col)) db.exec(`ALTER TABLE ${t} ADD COLUMN ${col} ${def}`);
};
addColumns('jobs', [['kind', "TEXT DEFAULT 'job'"], ['branch', 'TEXT']]);
db.exec(`CREATE TABLE IF NOT EXISTS members(name TEXT PRIMARY KEY, config TEXT NOT NULL);`);
// role: 'devil' | 'summary' for moderator-requested turns; mode: the discussion mode an agent message was written in;
// stance: JSON {t: position, c: confidence 0-100, changed?, evidence?: Jev's view of a change} from the reply's [STANCE] line.
// seat: the speaker's part in a debate (正方一辩, 评委); note_ops: the notes this reply changed ([{op, n}]).
// files: the user's attachments, JSON [{file: '<chat>/<stored name>', name, size, type}].
// dm: a private message (game mode): the member it is addressed to; only it and the sender's session ever see it.
// nick: the name the sender had given itself in this discussion when it wrote the message ([NAME]).
addColumns('messages', ['model', 'role', 'mode', 'stance', 'seat', 'note_ops', 'files', 'dm', 'nick'].map(c => [c, 'TEXT']));
// Discussion mode per chat: 'auto' (Jev classifies the first question into auto_mode) or a mode the user chose.
// state: JSON {notes: [{n, text, by, msg}], debate: {pro, con, judge, motion, script, at, done}}.
// share: the code of the discussion's read-only link (/s/<share>), made when the user first shares it.
addColumns('chats', [['mode', "TEXT DEFAULT 'auto'"], ['auto_mode', 'TEXT'], ['state', 'TEXT'], ['share', 'TEXT']]);
// Ids are never handed out again: deleting the newest discussion let a new one reuse its chat and message ids, and marks
// kept by message id (the round already wrapped up) then ended the new discussion after one round.
for (const t of ['chats', 'messages']) {
  const { sql } = db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name=?`).get(t);
  if (/AUTOINCREMENT/i.test(sql)) continue;
  const def = sql.replace(/^CREATE TABLE "?\w+"?/, `CREATE TABLE ${t}_new`).replace('id INTEGER PRIMARY KEY', 'id INTEGER PRIMARY KEY AUTOINCREMENT');
  db.exec(`BEGIN; ${def}; INSERT INTO ${t}_new SELECT * FROM ${t}; DROP TABLE ${t}; ALTER TABLE ${t}_new RENAME TO ${t}; COMMIT;`);
}
// Almost every query is per discussion, and the scheduler and the UI state run several every second: without these
// each was a scan of every message ever written.
db.exec(`CREATE INDEX IF NOT EXISTS messages_chat ON messages(chat_id, id);
CREATE INDEX IF NOT EXISTS messages_chat_sender ON messages(chat_id, sender, id);
CREATE INDEX IF NOT EXISTS decisions_chat ON decisions(chat_id, event);`);

export const q = (sql, ...a) => db.prepare(sql).all(...a);
export const q1 = (sql, ...a) => db.prepare(sql).get(...a);
export const run = (sql, ...a) => db.prepare(sql).run(...a);
export const getSetting = key => q1('SELECT value FROM settings WHERE key=?', key)?.value;
export const setSetting = (key, value) => run('INSERT OR REPLACE INTO settings VALUES(?, ?)', key, value);
