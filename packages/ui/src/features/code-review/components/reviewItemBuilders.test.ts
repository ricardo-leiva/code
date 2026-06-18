import type { ChangedFile } from "@posthog/shared/domain-types";
import { describe, expect, it } from "vitest";
import { changedFileSignature, patchFileSignature } from "./reviewItemBuilders";

const changedFile = (over: Partial<ChangedFile>): ChangedFile => ({
  path: "a.ts",
  status: "modified",
  ...over,
});

describe("changedFileSignature", () => {
  it("differs when the patch content differs", () => {
    const a = changedFileSignature(
      changedFile({ patch: "@@ -1 +1 @@\n-x\n+y" }),
    );
    const b = changedFileSignature(
      changedFile({ patch: "@@ -1 +1 @@\n-x\n+z" }),
    );
    expect(a).not.toBe(b);
  });

  it("falls back to status + line counts when there is no patch", () => {
    const a = changedFileSignature(
      changedFile({ linesAdded: 1, linesRemoved: 2 }),
    );
    const b = changedFileSignature(
      changedFile({ linesAdded: 1, linesRemoved: 2 }),
    );
    const c = changedFileSignature(
      changedFile({ linesAdded: 3, linesRemoved: 2 }),
    );
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});

describe("patchFileSignature", () => {
  // biome-ignore lint/suspicious/noExplicitAny: minimal pierre FileDiff stub
  const fileDiff = (over: Record<string, unknown>): any => ({
    hunks: [],
    ...over,
  });

  it("uses git blob object ids and ignores hunk content (whitespace-stable)", () => {
    // Same blob ids, different parsed hunks (as the hide-whitespace toggle
    // would produce) must yield the same signature.
    const a = patchFileSignature(
      fileDiff({ prevObjectId: "aaa", newObjectId: "bbb", hunks: [{ x: 1 }] }),
    );
    const b = patchFileSignature(
      fileDiff({
        prevObjectId: "aaa",
        newObjectId: "bbb",
        hunks: [{ x: 2, y: 3 }],
      }),
    );
    expect(a).toBe("aaa:bbb");
    expect(b).toBe("aaa:bbb");
  });

  it("changes when the new blob id changes", () => {
    const a = patchFileSignature(
      fileDiff({ prevObjectId: "aaa", newObjectId: "bbb" }),
    );
    const b = patchFileSignature(
      fileDiff({ prevObjectId: "aaa", newObjectId: "ccc" }),
    );
    expect(a).not.toBe(b);
  });

  it("falls back to hashing hunks when object ids are absent", () => {
    const a = patchFileSignature(fileDiff({ hunks: [{ additionLines: 1 }] }));
    const b = patchFileSignature(fileDiff({ hunks: [{ additionLines: 2 }] }));
    expect(a).not.toBe(b);
  });
});
