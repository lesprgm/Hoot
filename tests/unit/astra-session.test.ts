import { describe, expect, it } from "vitest";
import { AstraSession } from "../../src/main/executor/AstraSession";

describe("AstraSession dispatch gate", () => {
  it("records completed and uncertain native actions", () => {
    const session = new AstraSession("task-1");
    const completed = session.beginAction("click");
    expect(completed).not.toBeNull();
    session.completeAction(completed!);
    const uncertain = session.beginAction("type");
    expect(uncertain).not.toBeNull();
    session.markUncertain(uncertain!);
    expect(session.ledger().map((entry) => entry.state)).toEqual(["completed", "uncertain"]);
  });

  it("closes the gate immediately and requires an explicit resume", () => {
    const session = new AstraSession("task-1");
    session.requestPause();
    expect(session.canDispatch()).toBe(false);
    expect(session.beginAction("click")).toBeNull();
    session.resume();
    expect(session.canDispatch()).toBe(true);
    session.close();
    expect(session.canDispatch()).toBe(false);
    expect(session.beginAction("click")).toBeNull();
  });
});
