/* ── Temporal Constants ──
 *
 * Side-effect-free constants shared between the worker, the test client,
 * and (eventually) the crawler-jobs.mts handlers that start workflows.
 *
 * Importing from this file must NEVER trigger worker startup or any
 * other runtime behavior — keep it pure.
 */

export const APPLY_TASK_QUEUE = "apply";
