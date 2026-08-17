/**
 * Dead Letter Queue consumer for permanently-failed DO jobs.
 *
 * Inserts alerts_log and audit_log entries. Actual telegram sending
 * is handled by the alert-check cron (Todo 6) which queries
 * alerts_log WHERE status='pending'.
 */

import type { JobMessage } from "./queue";

interface Env {
  DB: D1Database;
}

export async function handleDLQ(
  batch: MessageBatch<JobMessage>,
  env: Env,
  _ctx: ExecutionContext,
): Promise<void> {
  for (const message of batch.messages) {
    const { job_id, type } = message.body;

    const errorDetail = `Job #${job_id} (${type}) permanently failed after 3 retries`;

    // Insert pending alert — cron will pick it up and send Telegram
    await env.DB
      .prepare(
         `INSERT INTO alerts_log (rule_type, target_type, target_id, message, status, sent_at)
          VALUES ('dlq_stuck', 'job_queue', ?, ?, 'pending', datetime('now'))`,
      )
      .bind(job_id, errorDetail)
      .run();

    // Record in audit log
    await env.DB
      .prepare(
        `INSERT INTO audit_log (actor, action, target_type, target_id, payload_json, created_at)
         VALUES ('system', 'dlq_received', 'job_queue', ?, ?, datetime('now'))`,
      )
      .bind(job_id, JSON.stringify({ job_id, type, error: errorDetail }))
      .run();

    message.ack();
  }
}
