import { randomUUID } from "node:crypto";

export interface SessionSnapshot {
  sessionId: string;
  taskId: string;
  step: number;
}

export interface SessionRotation {
  sessionId: string;
  taskId: string;
}

/**
 * Client-side session state for the Hollow Connector.
 *
 * One session_id per connector process lifetime by default. Step counter is
 * monotonic within the session. Contract rotation triggers:
 *   - 410 session_expired   → rotate session_id AND task_id, step resets to 0
 *   - 400 step_out_of_order → rotate task_id only (same session_id), step resets
 *
 * The connector does not infer "task boundaries" from MCP call patterns in M1 —
 * every snapshot is attributed to the single running task_id until a rotation
 * trigger fires.
 */
export class SessionState {
  private sessionId: string;
  private taskId: string;
  private step: number;
  private readonly newId: () => string;

  constructor(opts: { newId?: () => string } = {}) {
    this.newId = opts.newId ?? (() => randomUUID());
    this.sessionId = this.newId();
    this.taskId = this.newId();
    this.step = 0;
  }

  /** Returns a snapshot of the current state AND advances the step counter. */
  consume(): SessionSnapshot {
    const snap: SessionSnapshot = {
      sessionId: this.sessionId,
      taskId: this.taskId,
      step: this.step,
    };
    this.step += 1;
    return snap;
  }

  /** Peek without advancing (useful for logs). */
  peek(): SessionSnapshot {
    return { sessionId: this.sessionId, taskId: this.taskId, step: this.step };
  }

  /** Rotate both session + task (contract §7.2 / 410 session_expired). */
  rotateSession(): SessionRotation {
    this.sessionId = this.newId();
    this.taskId = this.newId();
    this.step = 0;
    return { sessionId: this.sessionId, taskId: this.taskId };
  }

  /** Rotate task only (contract §7.2 / 400 step_out_of_order). */
  rotateTask(): SessionRotation {
    this.taskId = this.newId();
    this.step = 0;
    return { sessionId: this.sessionId, taskId: this.taskId };
  }
}
