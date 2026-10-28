import {fail} from './schema.js';

// Intent must be committed before host bytes change. WAL NORMAL can lose a
// committed intent on power loss even when the separate file write was synced.
export function requireDurableEffectJournal(db) {
  const level=db.prepare('PRAGMA synchronous').get()?.synchronous;
  if(!Number.isInteger(level)||level<2)fail('workspace_journal_not_durable','Workspace effects require SQLite synchronous FULL or EXTRA before dispatch');
}
