import { describe, it, expect } from "vitest";
import { SessionState } from "../src/session/state.js";

function sequentialIdGen(): () => string {
  let i = 0;
  return () => `id-${i++}`;
}

describe("SessionState", () => {
  it("generates session_id + task_id on construction with step=0", () => {
    const s = new SessionState({ newId: sequentialIdGen() });
    expect(s.peek()).toEqual({ sessionId: "id-0", taskId: "id-1", step: 0 });
  });

  it("consume() advances step monotonically", () => {
    const s = new SessionState({ newId: sequentialIdGen() });
    const a = s.consume();
    const b = s.consume();
    const c = s.consume();
    expect(a.step).toBe(0);
    expect(b.step).toBe(1);
    expect(c.step).toBe(2);
    expect(a.sessionId).toBe(b.sessionId);
    expect(b.taskId).toBe(c.taskId);
  });

  it("rotateSession() mints new session+task and resets step", () => {
    const gen = sequentialIdGen();
    const s = new SessionState({ newId: gen });
    s.consume();
    s.consume();
    const { sessionId, taskId } = s.rotateSession();
    expect(sessionId).toBe("id-2");
    expect(taskId).toBe("id-3");
    expect(s.peek().step).toBe(0);
    const next = s.consume();
    expect(next.sessionId).toBe("id-2");
    expect(next.taskId).toBe("id-3");
    expect(next.step).toBe(0);
  });

  it("rotateTask() keeps session, mints new task, resets step", () => {
    const s = new SessionState({ newId: sequentialIdGen() });
    const before = s.peek();
    s.consume();
    const rotated = s.rotateTask();
    expect(rotated.sessionId).toBe(before.sessionId);
    expect(rotated.taskId).not.toBe(before.taskId);
    expect(s.peek().step).toBe(0);
  });

  it("produces valid UUIDv4 by default", () => {
    const s = new SessionState();
    const peek = s.peek();
    const re = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
    expect(peek.sessionId).toMatch(re);
    expect(peek.taskId).toMatch(re);
  });
});
