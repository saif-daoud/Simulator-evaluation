import { DurableObject } from "cloudflare:workers";

import api from "./index.js";

const STUDY_SCHEMA = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS participants (
  participant_code TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS studies (
  id TEXT PRIMARY KEY,
  participant_code TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'completed')),
  created_at TEXT NOT NULL,
  completed_at TEXT,
  UNIQUE (participant_code, profile_id),
  FOREIGN KEY (participant_code) REFERENCES participants(participant_code)
);

CREATE TABLE IF NOT EXISTS simulator_sessions (
  id TEXT PRIMARY KEY,
  study_id TEXT NOT NULL,
  simulator_key TEXT NOT NULL,
  anonymous_label TEXT NOT NULL,
  display_order INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('locked', 'ready', 'active', 'rating', 'completed')),
  state_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  started_at TEXT,
  ended_at TEXT,
  completed_at TEXT,
  UNIQUE (study_id, display_order),
  UNIQUE (study_id, simulator_key),
  FOREIGN KEY (study_id) REFERENCES studies(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS session_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('therapist', 'patient')),
  content TEXT NOT NULL,
  client_message_id TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (session_id, client_message_id),
  FOREIGN KEY (session_id) REFERENCES simulator_sessions(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_messages_session
  ON session_messages(session_id, id);

CREATE TABLE IF NOT EXISTS simulator_ratings (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL UNIQUE,
  participant_code TEXT NOT NULL,
  coherence INTEGER NOT NULL CHECK (coherence BETWEEN 1 AND 5),
  disclosure INTEGER NOT NULL CHECK (disclosure BETWEEN 1 AND 5),
  resistance INTEGER NOT NULL CHECK (resistance BETWEEN 1 AND 5),
  emotional INTEGER NOT NULL CHECK (emotional BETWEEN 1 AND 5),
  realism INTEGER NOT NULL CHECK (realism BETWEEN 1 AND 5),
  comments TEXT NOT NULL DEFAULT '',
  submitted_at TEXT NOT NULL,
  FOREIGN KEY (session_id) REFERENCES simulator_sessions(id) ON DELETE CASCADE,
  FOREIGN KEY (participant_code) REFERENCES participants(participant_code)
);
`;

class DurableStatement {
  constructor(sql, query, bindings = []) {
    this.sql = sql;
    this.query = query;
    this.bindings = bindings;
  }

  bind(...bindings) {
    return new DurableStatement(this.sql, this.query, bindings);
  }

  execute() {
    const cursor = this.sql.exec(this.query, ...this.bindings);
    const results = cursor.toArray();
    return { results, rowsWritten: cursor.rowsWritten };
  }

  async first() {
    return this.execute().results[0] ?? null;
  }

  async all() {
    return { results: this.execute().results };
  }

  async run() {
    const result = this.execute();
    return { success: true, meta: { changes: result.rowsWritten } };
  }
}

class DurableDatabase {
  constructor(storage) {
    this.storage = storage;
    this.sql = storage.sql;
  }

  prepare(query) {
    return new DurableStatement(this.sql, query);
  }

  async batch(statements) {
    return this.storage.transactionSync(() => statements.map(statement => {
      const result = statement.execute();
      return { success: true, results: result.results, meta: { changes: result.rowsWritten } };
    }));
  }
}

export class StudyStore extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.database = new DurableDatabase(ctx.storage);
    ctx.blockConcurrencyWhile(async () => {
      ctx.storage.sql.exec(STUDY_SCHEMA).toArray();
    });
  }

  async fetch(request) {
    return api.fetch(request, { ...this.env, DB: this.database });
  }
}

export default {
  async fetch(request, env) {
    return env.STUDY_STORE.getByName("simulator-evaluation-study").fetch(request);
  }
};
