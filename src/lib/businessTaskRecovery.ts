export const ADMISSION_BLOCKED_TASK_ERROR_PREFIX =
  "enrichment subprocess admission unavailable:";

export const BUSINESS_TASK_RECOVERY_MIN_AGE_MS = 60_000;

export type BusinessTaskRecoveryCandidate = {
  kind: string;
  status: string;
  error: string | null;
  created_at: string;
};

/**
 * Only retry durable tasks that were left queued by the known transient
 * PID-admission guard. Other task errors are deliberately excluded so this
 * recovery sweep cannot turn permanent failures into an endless retry loop.
 */
export function isRecoverableAdmissionBlockedTask(
  task: BusinessTaskRecoveryCandidate,
  nowMs = Date.now(),
): boolean {
  if (task.kind !== "enrich" && task.kind !== "score") return false;
  if (task.status !== "queued") return false;
  if (!task.error?.startsWith(ADMISSION_BLOCKED_TASK_ERROR_PREFIX)) return false;

  const createdAtMs = Date.parse(task.created_at);
  if (!Number.isFinite(createdAtMs)) return false;

  return nowMs - createdAtMs >= BUSINESS_TASK_RECOVERY_MIN_AGE_MS;
}
