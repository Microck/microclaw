import type Database from 'better-sqlite3';
import type { ActivityCursor, ActivityEntry, ActivityInput, ActivitySnapshot, ProcessingAck } from '../types.js';

/** Read the existing mailboxes without changing ownership or provisioning storage. */
export function readActivitySnapshot(
  inbound: Database.Database,
  outbound: Database.Database,
  cursor?: ActivityCursor,
): ActivitySnapshot {
  const head = {
    inbound: (inbound.prepare('SELECT coalesce(max(seq),0) AS seq FROM messages_in').get() as { seq: number }).seq,
    outbound: (outbound.prepare('SELECT coalesce(max(seq),0) AS seq FROM messages_out').get() as { seq: number }).seq,
  };
  // Text only: attachments and arbitrary chat SDK metadata never enter the reviewer.
  const inputContent = `CASE WHEN json_valid(content) THEN json_object(
    'text',substr(coalesce(json_extract(content,'$.text'),json_extract(content,'$.content'),''),1,6000),
    'proactiveReview',json_extract(content,'$.proactiveReview'),
    'proactiveStop',json_extract(content,'$.proactiveStop')) ELSE substr(content,1,6000) END`;
  const origin = inbound
    .prepare(
      `SELECT id,seq AS sequence,timestamp,kind,${inputContent} AS content,
    platform_id AS platformId,channel_type AS channelType,thread_id AS threadId FROM messages_in
    WHERE trigger=1 AND kind IN ('chat','chat-sdk','webhook','task')
      AND (channel_type IS NULL OR channel_type NOT IN ('session-echo','agent'))
    ORDER BY seq DESC LIMIT 1`,
    )
    .get() as ActivityInput | undefined;
  const stop = inbound
    .prepare(
      `SELECT max(seq) AS seq FROM messages_in
    WHERE seq>? AND kind='system' AND json_valid(content) AND json_extract(content,'$.proactiveStop')=1`,
    )
    .get(origin?.sequence ?? 0) as { seq: number | null };
  const due = inbound
    .prepare(
      `SELECT 1 FROM messages_in WHERE trigger=1 AND status IN ('pending','processing')
    AND (process_after IS NULL OR julianday(process_after)<=julianday('now')) LIMIT 1`,
    )
    .get();
  const processing = outbound.prepare("SELECT 1 FROM processing_ack WHERE status='processing' LIMIT 1").get();
  const readEntries = (db: Database.Database, table: string, after: number, content: string): ActivityEntry[] =>
    db
      .prepare(
        `SELECT id,seq AS sequence,timestamp,kind,${content} AS content FROM ${table}
      WHERE seq>? AND seq<=? ORDER BY seq LIMIT 100`,
      )
      .all(after, table === 'messages_in' ? head.inbound : head.outbound) as ActivityEntry[];
  return {
    head,
    // An absent cursor baselines old records. The latest request remains context.
    inbound: cursor ? readEntries(inbound, 'messages_in', cursor.inbound, inputContent) : [],
    outbound: cursor ? readEntries(outbound, 'messages_out', cursor.outbound, 'substr(content,1,10000)') : [],
    origin,
    stopped: Boolean(stop.seq && (!origin || stop.seq > origin.sequence)),
    busy: Boolean(due || processing),
    outcomes: outbound
      .prepare(
        `SELECT message_id AS messageId,status,status_changed AS statusChanged
      FROM processing_ack WHERE status!='processing' ORDER BY status_changed DESC LIMIT 20`,
      )
      .all() as ProcessingAck[],
  };
}
