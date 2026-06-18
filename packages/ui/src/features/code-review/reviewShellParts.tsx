import {
  ArrowSquareOut,
  CaretDown,
  CheckSquare,
  Square,
} from "@phosphor-icons/react";
import type { FileDiffMetadata } from "@pierre/diffs/react";
import type { ResolvedDiffSource } from "@posthog/core/code-review/resolveDiffSource";
import {
  type DeferredReason,
  getDeferredMessage,
  splitFilePath,
  sumHunkStats,
} from "@posthog/core/code-review/reviewShellGeometry";
import type { ChangedFile, Task } from "@posthog/shared/domain-types";
import { type ReactNode, useCallback, useMemo, useState } from "react";
import { FileIcon } from "../../primitives/FileIcon";
import { useThemeStore } from "../../shell/themeStore";
import { useDiffViewerStore } from "../code-editor/diffViewerStore";
import { computeDiffStats } from "../git-interaction/utils/diffStats";
import { useReviewViewedContext } from "./reviewViewedContext";
import { useReviewViewedStore } from "./reviewViewedStore";

export type { DeferredReason } from "@posthog/core/code-review/reviewShellGeometry";
export {
  buildItemIndex,
  splitFilePath,
} from "@posthog/core/code-review/reviewShellGeometry";

const STICKY_HEADER_CSS = `[data-diffs-header] { position: sticky; top: 0; z-index: 1; background: var(--gray-2); }`;

function useDiffOptions() {
  const viewMode = useDiffViewerStore((s) => s.viewMode);
  const wordWrap = useDiffViewerStore((s) => s.wordWrap);
  const loadFullFiles = useDiffViewerStore((s) => s.loadFullFiles);
  const wordDiffs = useDiffViewerStore((s) => s.wordDiffs);
  const isDarkMode = useThemeStore((s) => s.isDarkMode);

  return useMemo(
    () => ({
      diffStyle: viewMode as "split" | "unified",
      overflow: (wordWrap ? "wrap" : "scroll") as "wrap" | "scroll",
      expandUnchanged: loadFullFiles,
      lineDiffType: (wordDiffs ? "word-alt" : "none") as "word-alt" | "none",
      themeType: (isDarkMode ? "dark" : "light") as "dark" | "light",
      theme: { dark: "github-dark" as const, light: "github-light" as const },
      unsafeCSS: STICKY_HEADER_CSS,
    }),
    [viewMode, wordWrap, loadFullFiles, wordDiffs, isDarkMode],
  );
}

export function useReviewState(
  changedFiles: ChangedFile[],
  allPaths: string[],
  taskId: string,
) {
  const diffOptions = useDiffOptions();

  const { linesAdded, linesRemoved } = useMemo(
    () => computeDiffStats(changedFiles),
    [changedFiles],
  );

  const collapseState = useCollapseState(allPaths);
  const viewedState = useViewedState(taskId, collapseState.setFileCollapsed);

  return {
    diffOptions,
    linesAdded,
    linesRemoved,
    ...collapseState,
    ...viewedState,
  };
}

const EMPTY_VIEWED_RECORD: Record<string, string> = {};

function useViewedState(
  taskId: string,
  setFileCollapsed: (filePath: string, collapsed: boolean) => void,
) {
  const viewedRecord =
    useReviewViewedStore((s) => s.viewed[taskId]) ?? EMPTY_VIEWED_RECORD;
  const setViewed = useReviewViewedStore((s) => s.setViewed);

  // `nextSig` is the signature to store, or null to clear the read mark.
  // Marking a file read collapses it; un-marking expands it (mirrors GitHub).
  const toggleViewed = useCallback(
    (key: string, nextSig: string | null) => {
      setViewed(taskId, key, nextSig);
      setFileCollapsed(key, nextSig !== null);
    },
    [taskId, setViewed, setFileCollapsed],
  );

  return { viewedRecord, toggleViewed };
}

function useCollapseState(filePaths: string[]) {
  const [collapsedFiles, setCollapsedFiles] = useState<Set<string>>(
    () => new Set(),
  );

  const toggleFile = useCallback((filePath: string) => {
    setCollapsedFiles((prev) => {
      const next = new Set(prev);
      if (next.has(filePath)) next.delete(filePath);
      else next.add(filePath);
      return next;
    });
  }, []);

  const uncollapseFile = useCallback((filePath: string) => {
    setCollapsedFiles((prev) => {
      if (!prev.has(filePath)) return prev;
      const next = new Set(prev);
      next.delete(filePath);
      return next;
    });
  }, []);

  const setFileCollapsed = useCallback(
    (filePath: string, collapsed: boolean) => {
      setCollapsedFiles((prev) => {
        if (collapsed === prev.has(filePath)) return prev;
        const next = new Set(prev);
        if (collapsed) next.add(filePath);
        else next.delete(filePath);
        return next;
      });
    },
    [],
  );

  const expandAll = useCallback(() => setCollapsedFiles(new Set()), []);

  const collapseAll = useCallback(
    () => setCollapsedFiles(new Set(filePaths)),
    [filePaths],
  );

  return {
    collapsedFiles,
    toggleFile,
    uncollapseFile,
    setFileCollapsed,
    expandAll,
    collapseAll,
  };
}

export interface ReviewShellProps {
  task: Task;
  fileCount: number;
  linesAdded: number;
  linesRemoved: number;
  isLoading: boolean;
  isEmpty: boolean;
  items: ReviewListItem[];
  itemIndexByFilePath: Map<string, number>;
  viewedRecord: Record<string, string>;
  onToggleViewed: (key: string, sig: string | null) => void;
  onUncollapseFile?: (filePath: string) => void;
  allExpanded: boolean;
  onExpandAll: () => void;
  onCollapseAll: () => void;
  onRefresh?: () => void;
  effectiveSource?: ResolvedDiffSource;
  branchSourceAvailable?: boolean;
  prSourceAvailable?: boolean;
  defaultBranch?: string | null;
}

export interface ReviewListItem {
  key: string;
  scrollKey?: string;
  // Signature of the file's current diff; absent for non-file rows.
  sig?: string;
  node: ReactNode;
}

export function FileHeaderRow({
  dirPath,
  fileName,
  additions,
  deletions,
  collapsed,
  onToggle,
  trailing,
  viewedKey,
}: {
  dirPath: string;
  fileName: string;
  additions: number;
  deletions: number;
  collapsed: boolean;
  onToggle: () => void;
  trailing?: ReactNode;
  viewedKey?: string;
}) {
  return (
    // The toggle target is a button; the open-file / read controls sit
    // alongside it (not nested inside it, which would be invalid HTML).
    <div className="flex w-full items-center gap-[6px] border-b border-b-(--gray-5) px-[12px] py-[6px] font-[var(--code-font-family)] text-xs">
      <button
        type="button"
        onClick={onToggle}
        className="flex min-w-0 flex-1 cursor-pointer items-center gap-[6px] border-0 bg-transparent p-0 text-left"
      >
        <CaretDown
          size={12}
          color="var(--gray-9)"
          style={{
            transform: collapsed ? "rotate(-90deg)" : "rotate(0deg)",
            transition: "transform 0.15s",
          }}
          className="shrink-0"
        />
        <FileIcon filename={fileName} size={14} />
        <span
          title={dirPath + fileName}
          className="flex min-w-0 flex-1 gap-[6px]"
        >
          <span className="shrink-0 whitespace-nowrap font-semibold">
            {fileName}
          </span>
          <span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-(--gray-9)">
            {dirPath}
          </span>
        </span>
        <span className="font-mono text-[10px]">
          {additions > 0 && (
            <span className="mr-[2px] text-(--green-9)">+{additions}</span>
          )}
          {deletions > 0 && (
            <span className="text-(--red-9)">-{deletions}</span>
          )}
        </span>
      </button>
      {trailing}
      {viewedKey !== undefined && <ViewedCheckbox viewedKey={viewedKey} />}
    </div>
  );
}

// A file is read when its stored signature matches the current diff signature;
// a stored signature that no longer matches means the diff changed since.
export function isFileRead(
  storedSig: string | undefined,
  currentSig: string,
): boolean {
  return storedSig === currentSig;
}

function ViewedCheckbox({ viewedKey }: { viewedKey: string }) {
  const ctx = useReviewViewedContext();
  if (!ctx) return null;

  const current = ctx.currentSignatures.get(viewedKey);
  if (current === undefined) return null;

  const stored = ctx.viewedRecord[viewedKey];
  const read = isFileRead(stored, current);
  const changed = stored !== undefined && !read;

  return (
    <button
      type="button"
      aria-pressed={read}
      aria-label="Read"
      title={
        changed
          ? "Changed since you marked it read — click to mark read again"
          : read
            ? "Mark as unread"
            : "Mark as read"
      }
      onClick={(e) => {
        e.stopPropagation();
        ctx.toggleViewed(viewedKey, read ? null : current);
      }}
      className="ml-[6px] flex shrink-0 cursor-pointer items-center gap-[3px] border-0 bg-transparent p-0 text-(--gray-9) hover:text-(--gray-11)"
    >
      {read ? (
        <CheckSquare size={14} weight="fill" color="var(--accent-9)" />
      ) : (
        <Square size={14} color={changed ? "var(--amber-9)" : undefined} />
      )}
      <span
        className={changed ? "text-(--amber-11) text-[10px]" : "text-[10px]"}
      >
        {changed ? "Changed" : "Read"}
      </span>
    </button>
  );
}

export function DiffFileHeader({
  fileDiff,
  collapsed,
  onToggle,
  onOpenFile,
  viewedKey,
}: {
  fileDiff: FileDiffMetadata;
  collapsed: boolean;
  onToggle: () => void;
  onOpenFile?: () => void;
  viewedKey?: string;
}) {
  const fullPath =
    fileDiff.prevName && fileDiff.prevName !== fileDiff.name
      ? `${fileDiff.prevName} → ${fileDiff.name}`
      : fileDiff.name;
  const { dirPath, fileName } = splitFilePath(fullPath ?? "");
  const { additions, deletions } = sumHunkStats(fileDiff.hunks);

  return (
    <FileHeaderRow
      dirPath={dirPath}
      fileName={fileName}
      additions={additions}
      deletions={deletions}
      collapsed={collapsed}
      onToggle={onToggle}
      viewedKey={viewedKey}
      trailing={
        onOpenFile && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onOpenFile();
            }}
            className="ml-auto inline-flex cursor-pointer rounded-[3px] border-0 bg-transparent p-[2px] text-(--gray-9) hover:bg-gray-4"
          >
            <ArrowSquareOut size={14} />
          </button>
        )
      }
    />
  );
}

export function DeferredDiffPlaceholder({
  filePath,
  linesAdded,
  linesRemoved,
  reason,
  collapsed,
  onToggle,
  onShow,
  externalUrl,
  viewedKey,
}: {
  filePath: string;
  linesAdded: number;
  linesRemoved: number;
  reason: DeferredReason;
  collapsed: boolean;
  onToggle: () => void;
  onShow?: () => void;
  externalUrl?: string;
  viewedKey?: string;
}) {
  const { dirPath, fileName } = splitFilePath(filePath);

  return (
    <div>
      <FileHeaderRow
        dirPath={dirPath}
        fileName={fileName}
        additions={linesAdded}
        deletions={linesRemoved}
        collapsed={collapsed}
        onToggle={onToggle}
        viewedKey={viewedKey}
      />
      {!collapsed && (
        <div className="w-full border-b border-b-(--gray-5) bg-(--gray-2) p-[16px] text-center text-(--gray-9) text-xs">
          {getDeferredMessage(reason)}
          {onShow ? (
            <>
              {" "}
              <button
                type="button"
                onClick={onShow}
                style={{
                  fontSize: "inherit",
                }}
                className="cursor-pointer border-0 bg-transparent p-0 text-(--accent-9) underline"
              >
                Load diff
              </button>
            </>
          ) : externalUrl ? (
            <>
              {" "}
              <a
                href={externalUrl}
                target="_blank"
                rel="noopener noreferrer"
                style={{
                  fontSize: "inherit",
                }}
                className="text-(--accent-9) underline"
              >
                View on GitHub
              </a>
            </>
          ) : null}
        </div>
      )}
    </div>
  );
}
