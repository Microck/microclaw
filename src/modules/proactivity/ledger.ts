import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { ActivityCursor, ActivitySnapshot } from '../../mailbox/types.js';

export interface MailEnvelope {
  id: string;
  date: string;
  subject: string;
  from: { addr: string; name?: string };
}

export interface ReviewDecision {
  action: 'ignore' | 'digest' | 'investigate';
  reason: string;
  evidence: string[];
  followUpAfterSeconds: number | null;
}

export type ContinuationState =
  | 'admitted'
  | 'closed'
  | 'stopped'
  | 'superseded'
  | 'no_route'
  | 'waiting_for_user'
  | 'wake_limit'
  | 'duplicate'
  | 'busy'
  | 'cooldown'
  | 'mailbox_missing';

export interface QueuedEvent {
  id: string;
  payload: string;
  source: 'mail' | 'session';
  session_id: string | null;
  origin_id: string | null;
  attempts: number;
}

export function eventId(account: string, envelope: MailEnvelope): string {
  return createHash('sha256')
    .update(JSON.stringify([account, envelope.id, envelope.date, envelope.subject, envelope.from.addr]))
    .digest('hex');
}

/** Private durable queue. Only the host's serial worker writes this ledger. */
export class ReviewLedger {
  readonly db: Database.Database;

  constructor(directory: string) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const file = path.join(directory, 'events.db');
    this.db = new Database(file);
    fs.chmodSync(file, 0o600);
    this.db.pragma('busy_timeout = 5000');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY, payload TEXT NOT NULL, source TEXT NOT NULL,
        session_id TEXT, origin_id TEXT, wake_state TEXT, received_at TEXT NOT NULL,
        state TEXT NOT NULL, decision TEXT, attempts INTEGER NOT NULL DEFAULT 0,
        retry_after TEXT NOT NULL, completed_at TEXT
      );
      CREATE INDEX IF NOT EXISTS events_pending ON events(state,retry_after);
      CREATE INDEX IF NOT EXISTS events_session ON events(session_id,state);
      CREATE TABLE IF NOT EXISTS watches (
        session_id TEXT PRIMARY KEY, cursor TEXT NOT NULL, stamp TEXT NOT NULL,
        origin_id TEXT, due_at TEXT, timer_reviews INTEGER NOT NULL DEFAULT 0,
        wakes INTEGER NOT NULL DEFAULT 0, last_wake TEXT, fingerprint TEXT
      );
      CREATE TABLE IF NOT EXISTS attempts (
        id INTEGER PRIMARY KEY, event_id TEXT NOT NULL, started_at TEXT NOT NULL,
        finished_at TEXT, input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0, error TEXT
      );
    `);
    this.db.prepare('INSERT OR IGNORE INTO metadata VALUES (?,?)').run('activityStartedAt', new Date().toISOString());
    // An interrupted attempt still counts against the budget. Its event stays queued.
    this.db
      .prepare("UPDATE attempts SET finished_at = ?, error = 'interrupted' WHERE finished_at IS NULL")
      .run(new Date().toISOString());
    this.db.prepare("UPDATE events SET state = 'failed' WHERE state = 'pending' AND attempts >= 3").run();
  }

  hasBaseline(): boolean {
    return Boolean(this.db.prepare("SELECT 1 FROM metadata WHERE key = 'startedAt'").get());
  }

  /** Record a complete snapshot atomically, including the first empty inbox. */
  ingest(account: string, envelopes: MailEnvelope[], now: string): number {
    return this.db.transaction(() => {
      const source = this.db.prepare("SELECT value FROM metadata WHERE key = 'account'").get() as
        | { value: string }
        | undefined;
      if (source && source.value !== account) throw new Error('mail_source_changed');
      this.db.prepare('INSERT OR IGNORE INTO metadata VALUES (?, ?)').run('account', account);
      const saved = this.db.prepare("SELECT value FROM metadata WHERE key = 'startedAt'").get() as
        | { value: string }
        | undefined;
      const startedAt = saved?.value ?? now;
      const insert = this.db.prepare(`INSERT OR IGNORE INTO events
        (id, payload, source, received_at, state, retry_after) VALUES (?, ?, 'mail', ?, ?, ?)`);
      let queued = 0;
      for (const envelope of envelopes) {
        // Sender Date is not arrival time. Delayed messages are still new events.
        const fresh = Boolean(saved);
        const inserted = insert.run(
          eventId(account, envelope),
          JSON.stringify(envelope),
          now,
          fresh ? 'pending' : 'historical',
          now,
        );
        if (fresh) queued += inserted.changes;
      }
      this.db.prepare('INSERT OR REPLACE INTO metadata VALUES (?, ?)').run('startedAt', startedAt);
      return queued;
    })();
  }

  get(id: string): QueuedEvent | undefined {
    return this.db.prepare('SELECT * FROM events WHERE id=?').get(id) as QueuedEvent | undefined;
  }

  activityStartedAt(): string {
    return (this.db.prepare("SELECT value FROM metadata WHERE key='activityStartedAt'").get() as { value: string })
      .value;
  }

  watch(sessionId: string): Watch | undefined {
    return this.db.prepare('SELECT * FROM watches WHERE session_id=?').get(sessionId) as Watch | undefined;
  }

  /** Level-triggered collection: busy sessions retain their cursor until idle. */
  collectSession(sessionId: string, snapshot: ActivitySnapshot, now: string): boolean {
    return this.db.transaction(() => {
      let watch = this.watch(sessionId);
      const origin = snapshot.origin?.id ?? null;
      const stamp = JSON.stringify([snapshot.head, snapshot.outcomes]);
      if (!watch) {
        const fresh = snapshot.inbound.length > 0 || snapshot.outbound.length > 0;
        this.db
          .prepare('INSERT INTO watches(session_id,cursor,stamp,origin_id) VALUES (?,?,?,?)')
          .run(
            sessionId,
            JSON.stringify(fresh ? { inbound: 0, outbound: 0 } : snapshot.head),
            fresh ? '' : stamp,
            origin,
          );
        if (!fresh) return false;
        watch = this.watch(sessionId)!;
      }
      if (watch.origin_id !== origin) {
        this.db
          .prepare(
            `UPDATE watches SET origin_id=?,due_at=NULL,timer_reviews=0,wakes=0,last_wake=NULL,fingerprint=NULL WHERE session_id=?`,
          )
          .run(origin, sessionId);
        this.db
          .prepare(
            "UPDATE events SET state='superseded',wake_state='cancelled' WHERE session_id=? AND (state='pending' OR wake_state='pending')",
          )
          .run(sessionId);
        watch = this.watch(sessionId)!;
      }
      if (snapshot.stopped) {
        if (watch.stamp === stamp && watch.due_at === null) return false;
        this.db
          .prepare('UPDATE watches SET cursor=?,stamp=?,due_at=NULL WHERE session_id=?')
          .run(JSON.stringify(snapshot.head), stamp, sessionId);
        this.db
          .prepare(
            "UPDATE events SET state='stopped',wake_state='cancelled' WHERE session_id=? AND (state='pending' OR wake_state='pending')",
          )
          .run(sessionId);
        return false;
      }
      if (snapshot.busy || !origin) return false;
      const timer = Boolean(watch.due_at && watch.due_at <= now && watch.timer_reviews < 3);
      if (watch.stamp === stamp && !timer) return false;
      // Never replace a pending batch; it retains retry and budget accounting.
      if (this.db.prepare("SELECT 1 FROM events WHERE session_id=? AND state='pending'").get(sessionId)) return false;
      const cursor = {
        inbound: snapshot.inbound.at(-1)?.sequence ?? JSON.parse(watch.cursor).inbound,
        outbound: snapshot.outbound.at(-1)?.sequence ?? JSON.parse(watch.cursor).outbound,
      };
      const caughtUp = cursor.inbound === snapshot.head.inbound && cursor.outbound === snapshot.head.outbound;
      const previous = timer
        ? (this.db
            .prepare(
              "SELECT payload,decision FROM events WHERE session_id=? AND state='reviewed' ORDER BY rowid DESC LIMIT 1",
            )
            .get(sessionId) as { payload: string; decision: string } | undefined)
        : undefined;
      const id = createHash('sha256')
        .update(JSON.stringify([sessionId, origin, cursor, snapshot.outcomes, timer ? watch.timer_reviews + 1 : 0]))
        .digest('hex');
      this.db
        .prepare(
          `INSERT OR IGNORE INTO events
        (id,payload,source,session_id,origin_id,received_at,state,retry_after) VALUES (?,?,'session',?,?,?,'pending',?)`,
        )
        .run(
          id,
          JSON.stringify({
            origin: snapshot.origin
              ? { ...snapshot.origin, content: snapshot.origin.content.slice(0, 3000) }
              : undefined,
            activity: [...snapshot.inbound, ...snapshot.outbound]
              .sort((a, b) => a.timestamp.localeCompare(b.timestamp))
              .slice(-8)
              .map((entry) => ({ ...entry, content: entry.content.slice(0, 1600) })),
            outcomes: snapshot.outcomes.slice(0, 5),
            timer,
            observedAt: now,
            previous: previous
              ? {
                  event: JSON.parse(previous.payload).activity,
                  decision: {
                    reason: JSON.parse(previous.decision).reason.slice(0, 1000),
                    evidence: JSON.parse(previous.decision)
                      .evidence.slice(0, 3)
                      .map((entry: string) => entry.slice(0, 500)),
                  },
                }
              : undefined,
          }),
          sessionId,
          origin,
          now,
          now,
        );
      this.db
        .prepare('UPDATE watches SET cursor=?,stamp=?,due_at=NULL,timer_reviews=timer_reviews+? WHERE session_id=?')
        .run(JSON.stringify(cursor), caughtUp ? stamp : '', timer ? 1 : 0, sessionId);
      return true;
    })();
  }

  pendingWakes(): Array<QueuedEvent & { decision: string }> {
    return this.db
      .prepare("SELECT * FROM events WHERE wake_state='pending' ORDER BY received_at LIMIT 100")
      .all() as Array<QueuedEvent & { decision: string }>;
  }

  settleWake(event: QueuedEvent, state: ContinuationState, now: string, fingerprint?: string): void {
    this.db.transaction(() => {
      this.db.prepare('UPDATE events SET wake_state=? WHERE id=?').run(state, event.id);
      if (state === 'admitted')
        this.db
          .prepare(`UPDATE watches SET wakes=wakes+1,last_wake=?,fingerprint=? WHERE session_id=?`)
          .run(now, fingerprint, event.session_id);
    })();
  }

  discard(id: string, state: 'closed' | 'stopped' | 'superseded'): void {
    this.db.prepare("UPDATE events SET state=?,wake_state='cancelled' WHERE id=?").run(state, id);
  }

  defer(id: string, now: string): void {
    this.db
      .prepare('UPDATE events SET retry_after=? WHERE id=?')
      .run(new Date(Date.parse(now) + 15_000).toISOString(), id);
  }

  next(now: string): QueuedEvent | undefined {
    return this.db
      .prepare(
        `SELECT id, payload, source, session_id, origin_id, attempts FROM events
      WHERE state = 'pending' AND retry_after <= ? AND attempts < 3
      ORDER BY received_at, rowid LIMIT 1`,
      )
      .get(now) as QueuedEvent | undefined;
  }

  /** Reserve the daily budget before launching a process, even when inference fails. */
  begin(id: string, now: string, dailyLimit: number): number | undefined {
    return this.db.transaction(() => {
      const { count } = this.db
        .prepare('SELECT count(*) AS count FROM attempts WHERE started_at >= ?')
        .get(now.slice(0, 10)) as { count: number };
      if (count >= dailyLimit) return undefined;
      const updated = this.db
        .prepare(
          `UPDATE events SET attempts = attempts + 1, retry_after = ?
        WHERE id = ? AND state = 'pending' AND attempts < 3`,
        )
        .run(new Date(Date.parse(now) + 15 * 60_000).toISOString(), id);
      if (!updated.changes) return undefined;
      return Number(
        this.db.prepare('INSERT INTO attempts (event_id, started_at) VALUES (?, ?)').run(id, now).lastInsertRowid,
      );
    })();
  }

  finish(
    id: string,
    attempt: number,
    decision: ReviewDecision,
    usage: { inputTokens: number; outputTokens: number },
    now: string,
  ): void {
    this.db.transaction(() => {
      this.db
        .prepare('UPDATE events SET state = ?, decision = ?, completed_at = ? WHERE id = ?')
        .run('reviewed', JSON.stringify(decision), now, id);
      const event = this.get(id)!;
      if (event.session_id) {
        this.db
          .prepare(`UPDATE watches SET due_at=? WHERE session_id=? AND origin_id IS ?`)
          .run(
            decision.followUpAfterSeconds === null
              ? null
              : new Date(Date.parse(now) + decision.followUpAfterSeconds * 1000).toISOString(),
            event.session_id,
            event.origin_id,
          );
      }
      this.db
        .prepare(
          `UPDATE events SET wake_state='pending' WHERE id=? AND json_extract(decision,'$.action')='investigate' AND json_extract(decision,'$.followUpAfterSeconds') IS NULL`,
        )
        .run(id);
      this.db
        .prepare(`UPDATE attempts SET finished_at = ?, input_tokens = ?, output_tokens = ? WHERE id = ?`)
        .run(now, usage.inputTokens, usage.outputTokens, attempt);
    })();
  }

  fail(id: string, attempt: number, category: string, now: string): void {
    this.db.transaction(() => {
      this.db.prepare('UPDATE attempts SET finished_at = ?, error = ? WHERE id = ?').run(now, category, attempt);
      this.db.prepare("UPDATE events SET state = 'failed' WHERE id = ? AND attempts >= 3").run(id);
    })();
  }

  /** Related metadata can connect orders without loading another chat's transcript. */
  related(envelope: MailEnvelope): string {
    const rows = this.db
      .prepare("SELECT payload FROM events WHERE source='mail' ORDER BY rowid DESC LIMIT 100")
      .all() as Array<{
      payload: string;
    }>;
    const words = envelope.subject.toLowerCase().match(/[\p{L}\p{N}]{4,}/gu) ?? [];
    return rows
      .map((row) => JSON.parse(row.payload) as MailEnvelope)
      .filter(
        (other) =>
          other.id !== envelope.id &&
          (other.from.addr === envelope.from.addr || words.some((word) => other.subject.toLowerCase().includes(word))),
      )
      .slice(0, 10)
      .map((other) => JSON.stringify(other))
      .join('\n')
      .slice(0, 6000);
  }

  summary(now: string): Record<string, unknown> {
    const attempts = this.db
      .prepare(
        `SELECT count(*) AS attempts,
      coalesce(sum(input_tokens), 0) AS inputTokens, coalesce(sum(output_tokens), 0) AS outputTokens
      FROM attempts WHERE started_at >= ?`,
      )
      .get(now.slice(0, 10));
    const states = this.db.prepare('SELECT state, count(*) AS count FROM events GROUP BY state').all();
    const decisions = this.db
      .prepare(
        `SELECT json_extract(decision, '$.action') AS action, count(*) AS count
      FROM events WHERE state = 'reviewed' GROUP BY action`,
      )
      .all();
    const continuations = this.db
      .prepare(
        'SELECT wake_state AS state,count(*) AS count FROM events WHERE wake_state IS NOT NULL GROUP BY wake_state',
      )
      .all();
    return {
      daily: attempts,
      states,
      decisions,
      continuations,
      watchedSessions: (this.db.prepare('SELECT count(*) AS count FROM watches').get() as { count: number }).count,
    };
  }

  close(): void {
    this.db.close();
  }
}

export interface Watch {
  session_id: string;
  cursor: string;
  stamp: string;
  origin_id: string | null;
  due_at: string | null;
  timer_reviews: number;
  wakes: number;
  last_wake: string | null;
  fingerprint: string | null;
}

export function activityCursor(watch: Watch | undefined): ActivityCursor | undefined {
  return watch ? (JSON.parse(watch.cursor) as ActivityCursor) : undefined;
}
