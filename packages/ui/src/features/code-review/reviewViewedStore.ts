import { create } from "zustand";
import { persist } from "zustand/middleware";

// Keep the persisted store bounded: retain viewed state for the most recently
// touched tasks only, evicting the oldest once the cap is exceeded.
const MAX_TASKS = 200;

interface ReviewViewedStoreState {
  // taskId -> file key -> true (only viewed keys are stored)
  viewed: Record<string, Record<string, true>>;
}

interface ReviewViewedStoreActions {
  toggleViewed: (taskId: string, key: string) => void;
}

type ReviewViewedStore = ReviewViewedStoreState & ReviewViewedStoreActions;

export const useReviewViewedStore = create<ReviewViewedStore>()(
  persist(
    (set) => ({
      viewed: {},
      toggleViewed: (taskId, key) =>
        set((state) => {
          const taskViewed = { ...(state.viewed[taskId] ?? {}) };
          if (taskViewed[key]) delete taskViewed[key];
          else taskViewed[key] = true;

          // Re-insert the touched task last so it is evicted last. Drop the
          // task entirely once it has no viewed files left.
          const { [taskId]: _omit, ...rest } = state.viewed;
          const next =
            Object.keys(taskViewed).length > 0
              ? { ...rest, [taskId]: taskViewed }
              : rest;

          const taskIds = Object.keys(next);
          for (const stale of taskIds.slice(0, taskIds.length - MAX_TASKS)) {
            delete next[stale];
          }
          return { viewed: next };
        }),
    }),
    {
      name: "review-viewed-storage",
    },
  ),
);
