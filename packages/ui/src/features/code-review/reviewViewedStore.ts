import { create } from "zustand";
import { persist } from "zustand/middleware";

interface ReviewViewedStoreState {
  // taskId -> file key -> true (only viewed keys are stored)
  viewed: Record<string, Record<string, true>>;
}

interface ReviewViewedStoreActions {
  toggleViewed: (taskId: string, key: string) => void;
  clearTask: (taskId: string) => void;
}

type ReviewViewedStore = ReviewViewedStoreState & ReviewViewedStoreActions;

export const useReviewViewedStore = create<ReviewViewedStore>()(
  persist(
    (set) => ({
      viewed: {},
      toggleViewed: (taskId, key) =>
        set((state) => {
          const taskViewed = state.viewed[taskId] ?? {};
          const next = { ...taskViewed };
          if (next[key]) delete next[key];
          else next[key] = true;
          return { viewed: { ...state.viewed, [taskId]: next } };
        }),
      clearTask: (taskId) =>
        set((state) => {
          if (!state.viewed[taskId]) return state;
          const { [taskId]: _removed, ...rest } = state.viewed;
          return { viewed: rest };
        }),
    }),
    {
      name: "review-viewed-storage",
    },
  ),
);
