import { beforeEach, describe, expect, it } from "vitest";
import { useReviewViewedStore } from "./reviewViewedStore";

const { setViewed, clearTasks } = useReviewViewedStore.getState();
const viewed = () => useReviewViewedStore.getState().viewed;

describe("reviewViewedStore", () => {
  beforeEach(() => useReviewViewedStore.setState({ viewed: {} }));

  it("marks a file read at its signature", () => {
    setViewed("t1", "a.ts", "sig1");
    expect(viewed().t1).toEqual({ "a.ts": "sig1" });
  });

  it("unmarks a file and drops the task once it has no read files", () => {
    setViewed("t1", "a.ts", "sig1");
    setViewed("t1", "a.ts", null);
    expect(viewed().t1).toBeUndefined();
  });

  it("keeps other read files when unmarking one", () => {
    setViewed("t1", "a.ts", "s");
    setViewed("t1", "b.ts", "s");
    setViewed("t1", "a.ts", null);
    expect(viewed().t1).toEqual({ "b.ts": "s" });
  });

  it("clearTasks removes the given tasks only", () => {
    setViewed("t1", "a", "s");
    setViewed("t2", "a", "s");
    setViewed("t3", "a", "s");
    clearTasks(["t1", "t3"]);
    expect(Object.keys(viewed())).toEqual(["t2"]);
  });

  it("clearTasks is a no-op (same reference) when nothing matches", () => {
    setViewed("t1", "a", "s");
    const before = viewed();
    clearTasks(["unknown"]);
    expect(viewed()).toBe(before);
  });

  it("evicts least-recently-touched tasks past the entry cap", () => {
    for (let i = 0; i < 260; i++) setViewed(`t${i}`, "f", "s");
    expect(Object.keys(viewed()).length).toBe(250);
    expect(viewed().t0).toBeUndefined(); // oldest evicted
    expect(viewed().t259).toBeDefined(); // most recent kept
  });

  it("never evicts the task currently being marked, even past the cap", () => {
    for (let i = 0; i < 250; i++) setViewed(`old${i}`, "f", "s");
    for (let f = 0; f < 300; f++) setViewed("big", `f${f}`, "s");
    expect(Object.keys(viewed().big ?? {}).length).toBe(300);
  });
});
