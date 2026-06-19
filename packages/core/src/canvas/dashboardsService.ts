import type { AuthService } from "@posthog/core/auth/auth";
import { AUTH_SERVICE } from "@posthog/core/auth/auth.module";
import { inject, injectable } from "inversify";
import type { DashboardQueryService } from "./dashboardQueryService";
import type {
  DashboardDateRange,
  DashboardFileMeta,
  DashboardRecord,
  DashboardSummary,
} from "./dashboardSchemas";
import {
  DESKTOP_FS_CLIENT,
  type DesktopFsClient,
  type FsEntryBase,
} from "./desktopFsClient";
import { FREEFORM_TEMPLATE_ID, type FreeformVersion } from "./freeformSchemas";
import { DASHBOARD_QUERY_SERVICE } from "./identifiers";
import { fetchCurrentUser } from "./posthogApi";
import type { DashboardQuery, DashboardQueryShape } from "./querySchemas";

// Desktop file-system "type" tag for a dashboard entry. Channels are `folder`
// rows (depth 1); dashboards are these `dashboard` files nested beneath them.
const DASHBOARD_TYPE = "dashboard";

// Display name (canvas h1) of a channel's auto-created home canvas.
const HOME_CANVAS_NAME = "Home";

// Dashboard-specific shape on top of the shared FS row. Our payload rides in
// `meta` — see DashboardFileMeta for what that blob holds.
interface FsEntry extends FsEntryBase {
  meta?: DashboardFileMeta | null;
  // The backend's creator user (standard PostHog UserBasic shape). Absent on
  // rows the API returns without an expanded creator.
  created_by?: {
    first_name?: string | null;
    last_name?: string | null;
    email?: string | null;
  } | null;
}

/**
 * Dashboards backed by the PostHog desktop file system (not local files), so a
 * dashboard is a `dashboard`-typed row nested under its channel folder and its
 * name is the last path segment — i.e. the canvas h1. The json-render spec lives
 * in the row's `meta.spec`. This keeps dashboards (and their names) in sync with
 * the backend, the same surface that owns channel names.
 */
@injectable()
export class DashboardsService {
  // The current user's display label, fetched once and reused (the creator is
  // the same user for the app's lifetime). `undefined` = not fetched yet;
  // `null` = fetched but unavailable (don't refetch on every create).
  private userLabel: string | null | undefined;

  constructor(
    @inject(DESKTOP_FS_CLIENT)
    private readonly fs: DesktopFsClient,
    @inject(DASHBOARD_QUERY_SERVICE)
    private readonly dashboardQuery: DashboardQueryService,
    @inject(AUTH_SERVICE)
    private readonly authService: AuthService,
  ) {}

  // The signed-in user's display name (or email), for stamping `created by` onto
  // canvases. Cached after the first lookup; never throws (returns undefined).
  private async currentUserLabel(): Promise<string | undefined> {
    if (this.userLabel !== undefined) return this.userLabel ?? undefined;
    const user = await fetchCurrentUser(this.authService);
    this.userLabel = user?.label ?? null;
    return this.userLabel ?? undefined;
  }

  private getEntry(id: string): Promise<FsEntry | null> {
    return this.fs.getEntry<FsEntry>(id, "dashboard");
  }

  async list(channelId: string): Promise<DashboardSummary[]> {
    // Fetch only this channel's dashboards via a server-side filter
    // (`parent=<channelPath>&type=dashboard`) rather than walking the whole
    // project file system and filtering client-side. Dashboards are created as
    // direct children of the channel folder, so the parent filter matches them.
    const channelPath = await this.channelPath(channelId);
    const entries = await this.fs.listByQuery<FsEntry>(
      `parent=${encodeURIComponent(channelPath)}&type=${DASHBOARD_TYPE}`,
      "dashboards",
    );
    return entries
      .map((e) => toRecord(e))
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map(
        ({
          id,
          channelId: cid,
          name,
          templateId,
          kind,
          createdBy,
          updatedAt,
          spec,
          code,
        }) => ({
          id,
          channelId: cid,
          name,
          templateId,
          kind,
          createdBy,
          updatedAt,
          spec,
          code,
        }),
      );
  }

  async get(id: string): Promise<DashboardRecord | null> {
    const entry = await this.getEntry(id);
    return entry ? toRecord(entry) : null;
  }

  async create(input: {
    channelId: string;
    name: string;
    spec: Record<string, unknown> | null;
    templateId?: string;
  }): Promise<DashboardRecord> {
    const channelPath = await this.channelPath(input.channelId);
    const now = Date.now();
    const templateId = input.templateId ?? "dashboard";
    const meta: DashboardFileMeta = {
      spec: input.spec,
      channelId: input.channelId,
      templateId,
      // Freeform canvases store React code, not a spec; tag them so the render
      // path picks the sandboxed iframe instead of the json-render tree.
      kind: templateId === FREEFORM_TEMPLATE_ID ? "freeform" : "json-render",
      createdBy: await this.currentUserLabel(),
      createdAt: now,
      updatedAt: now,
    };
    const res = await this.fs.fetch("", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        path: `${channelPath}/${sanitizeSegment(input.name)}`,
        type: DASHBOARD_TYPE,
        meta,
      }),
    });
    if (!res.ok) throw new Error(`Failed to create dashboard (${res.status})`);
    return toRecord((await res.json()) as FsEntry);
  }

  async update(input: {
    id: string;
    name?: string;
    spec: Record<string, unknown> | null;
  }): Promise<DashboardRecord> {
    const entry = await this.getEntry(input.id);
    const now = Date.now();
    const prevMeta = entry?.meta ?? {};
    const meta: DashboardFileMeta = {
      ...prevMeta,
      spec: input.spec,
      updatedAt: now,
      createdAt: prevMeta.createdAt ?? toEpoch(entry?.created_at),
    };

    const body: Record<string, unknown> = { meta };
    // A new name renames the file: keep it under the same parent folder so the
    // canvas h1 stays the dashboard's name on the backend too.
    if (input.name && entry) {
      const parent = parentPath(entry.path);
      const next = sanitizeSegment(input.name);
      const newPath = parent ? `${parent}/${next}` : next;
      if (newPath !== entry.path) body.path = newPath;
    }

    const res = await this.fs.fetch(`${encodeURIComponent(input.id)}/`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`Failed to save dashboard (${res.status})`);
    return toRecord((await res.json()) as FsEntry);
  }

  // Persist a freeform canvas's source + edit history. Separate from update()
  // because freeform stores code/versions instead of a json-render spec.
  async saveFreeform(input: {
    id: string;
    name?: string;
    code: string;
    versions: FreeformVersion[];
    currentVersionId?: string;
  }): Promise<DashboardRecord> {
    const entry = await this.getEntry(input.id);
    const now = Date.now();
    const prevMeta = entry?.meta ?? {};
    const meta: DashboardFileMeta = {
      ...prevMeta,
      kind: "freeform",
      code: input.code,
      versions: input.versions,
      currentVersionId: input.currentVersionId,
      updatedAt: now,
      createdAt: prevMeta.createdAt ?? toEpoch(entry?.created_at),
    };

    const body: Record<string, unknown> = { meta };
    if (input.name && entry) {
      const parent = parentPath(entry.path);
      const next = sanitizeSegment(input.name);
      const newPath = parent ? `${parent}/${next}` : next;
      if (newPath !== entry.path) body.path = newPath;
    }

    const res = await this.fs.fetch(`${encodeURIComponent(input.id)}/`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`Failed to save canvas (${res.status})`);
    return toRecord((await res.json()) as FsEntry);
  }

  // Ensure the channel has a home canvas: the freeform board shown when the
  // channel name is clicked. Idempotent — if the channel folder's meta already
  // points at a live canvas, return it; otherwise create one, seed its source,
  // and record its id on the folder. Safe to call on channel create and lazily
  // on first open (backfills channels made before home canvases existed).
  async ensureHomeCanvas(channelId: string): Promise<DashboardRecord> {
    const folder = await this.getEntry(channelId);
    if (!folder) throw new Error("Channel not found");

    const existingId = folder.meta?.homeCanvasId;
    if (existingId) {
      const existing = await this.get(existingId);
      if (existing) return existing;
    }

    // Create the freeform canvas under the channel, then seed its source. The
    // canvas's own id is baked into the code so it can exclude itself from the
    // "Canvases" list; the channel id lets it resolve the (rename-safe) folder
    // path at runtime.
    const record = await this.create({
      channelId,
      name: HOME_CANVAS_NAME,
      spec: null,
      templateId: FREEFORM_TEMPLATE_ID,
    });
    const code = buildHomeCanvasCode(channelId, record.id);
    const version: FreeformVersion = {
      id: `home-${record.id}`,
      code,
      createdAt: Date.now(),
    };
    const saved = await this.saveFreeform({
      id: record.id,
      code,
      versions: [version],
      currentVersionId: version.id,
    });

    await this.setHomeCanvasId(channelId, record.id, folder);
    return saved;
  }

  // Point a channel folder at its home canvas by writing homeCanvasId onto the
  // folder's meta (preserving any existing meta keys).
  private async setHomeCanvasId(
    channelId: string,
    homeCanvasId: string,
    folder?: FsEntry | null,
  ): Promise<void> {
    const entry = folder ?? (await this.getEntry(channelId));
    const prevMeta = entry?.meta ?? {};
    const meta: DashboardFileMeta = { ...prevMeta, homeCanvasId };
    const res = await this.fs.fetch(`${encodeURIComponent(channelId)}/`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ meta }),
    });
    if (!res.ok) {
      throw new Error(`Failed to set channel home canvas (${res.status})`);
    }
  }

  async delete(id: string): Promise<void> {
    const res = await this.fs.fetch(`${encodeURIComponent(id)}/`, {
      method: "DELETE",
    });
    // Already gone is a successful delete; surface anything else.
    if (!res.ok && res.status !== 404) {
      throw new Error(`Failed to delete dashboard (${res.status})`);
    }
  }

  // Re-run the HogQL queries stored at spec.state.queries and write the fresh
  // values back into the spec props. `elementKeys` (a card's element) limits the
  // refresh to that card's subtree. Failures keep their prior literal.
  async refresh(input: {
    id: string;
    elementKeys?: string[];
    touchUpdatedAt?: boolean;
    dateRange?: DashboardDateRange;
    persistRange?: boolean;
  }): Promise<{
    updated: number;
    failures: { elementKey: string; error: string }[];
  }> {
    const entry = await this.getEntry(input.id);
    const spec = entry?.meta?.spec;
    if (!entry || !spec) return { updated: 0, failures: [] };

    // The window to query: the caller's (a rolled or freshly-picked range) wins;
    // otherwise reuse what's stored on the spec.
    const range = input.dateRange ?? storedRange(spec);

    const queries = collectQueries(spec, input.elementKeys).map((q) => ({
      ...q,
      query: substituteDateTokens(q.query, range),
    }));

    const results =
      queries.length > 0 ? await this.dashboardQuery.run({ queries }) : [];

    // Only an explicit user pick (persistRange) rewrites the stored range — an
    // auto-rolling refresh just substitutes, so polling doesn't churn the file.
    // Persisting is itself a change (even if no value moved) so the board reopens
    // on the picked window and the picker reflects it.
    let nextSpec =
      input.dateRange && input.persistRange
        ? withStoredRange(spec, input.dateRange)
        : spec;
    let updated =
      input.dateRange && input.persistRange && nextSpec !== spec ? 1 : 0;
    const failures: { elementKey: string; error: string }[] = [];
    for (const r of results) {
      if (r.ok) {
        const patched = patchProp(nextSpec, r.elementKey, r.propPath, r.value);
        if (patched !== nextSpec) {
          nextSpec = patched;
          updated++;
        }
      } else {
        failures.push({ elementKey: r.elementKey, error: r.error });
      }
    }

    // Only write when a value actually changed (the `updated > 0` guard already
    // skips no-op polls). This is still last-write-wins on `meta.spec`: a polling
    // refresh and a concurrent edit on another client can clobber each other. The
    // desktop FS rows carry no `base_version` for `meta` (unlike folder
    // instructions), so true optimistic concurrency is deferred — for now refresh
    // is UI-gated to view mode, which avoids self-clobber within one client.
    if (updated > 0) {
      const prevMeta = entry.meta ?? {};
      const meta: DashboardFileMeta = {
        ...prevMeta,
        spec: nextSpec,
        updatedAt:
          input.touchUpdatedAt === false
            ? (prevMeta.updatedAt ?? toEpoch(entry.created_at))
            : Date.now(),
      };
      await this.fs.fetch(`${encodeURIComponent(input.id)}/`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ meta }),
      });
    }
    return { updated, failures };
  }

  // Resolve a channel's folder path from its file-system id so child dashboards
  // can be created beneath it (paths are name-based, ids are not).
  private async channelPath(channelId: string): Promise<string> {
    const entry = await this.getEntry(channelId);
    if (!entry) throw new Error("Channel not found");
    return entry.path;
  }
}

// The seeded React source for a channel's home canvas. It runs in the freeform
// sandbox (null-origin iframe), so its only data avenue is `window.ph.query`
// (HogQL). It reads three lists from the `system.file_system` HogQL table:
//   - Canvases: this channel's `dashboard` rows (excluding the home canvas).
//   - Inbox / to-dos: stubbed (no data source yet) with an assignee filter.
//   - Tasks: this channel's filed `task` rows, newest first.
// Each list shows a page at a time and loads more as its own box is scrolled.
// The "New" buttons are intentionally no-ops until the host wires them up.
// channelId is baked in (the path is resolved at runtime so renames are safe);
// homeCanvasId lets the Canvases list exclude this board.
function buildHomeCanvasCode(channelId: string, homeCanvasId: string): string {
  const cid = JSON.stringify(channelId);
  const hid = JSON.stringify(homeCanvasId);
  return `import { useCallback, useEffect, useRef, useState } from "react";

const CHANNEL_ID = ${cid};
const HOME_CANVAS_ID = ${hid};
const PAGE_SIZE = 10;

const ph = (window as any).ph;

// Single-quote a value for inlining into a HogQL string literal.
function sql(v: string): string {
  return "'" + String(v).replace(/'/g, "''") + "'";
}

function lastSegment(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? path : path.slice(i + 1);
}

// Resolve the channel folder's current path from its stable id, so renaming the
// channel doesn't break the lists (the path, not the id, scopes child rows).
async function resolveChannelPath(): Promise<string> {
  const res = await ph.query(
    "SELECT path FROM system.file_system WHERE id = " + sql(CHANNEL_ID) + " LIMIT 1",
  );
  const rows = (res && res.results) || [];
  return rows.length ? String(rows[0][0]) : "";
}

type Row = { id: string; title: string; ref: string | null; createdAt: string };

// Paginated reader for the channel's filesystem rows of a given type, newest
// first. Resolves the channel path once, then walks pages by offset.
function useChannelRows(kind: "dashboard" | "task") {
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);
  const offsetRef = useRef(0);
  const pathRef = useRef<string | null>(null);
  const busyRef = useRef(false);

  const loadMore = useCallback(async () => {
    if (busyRef.current || done) return;
    busyRef.current = true;
    setLoading(true);
    try {
      if (pathRef.current === null) pathRef.current = await resolveChannelPath();
      const prefix = pathRef.current + "/";
      const exclude =
        kind === "dashboard" ? " AND id != " + sql(HOME_CANVAS_ID) : "";
      const query =
        "SELECT id, path, ref, created_at FROM system.file_system" +
        " WHERE type = " + sql(kind) +
        " AND surface = 'desktop'" +
        " AND startsWith(path, " + sql(prefix) + ")" +
        exclude +
        " ORDER BY created_at DESC LIMIT " + PAGE_SIZE +
        " OFFSET " + offsetRef.current;
      const res = await ph.query(query);
      const batch: Row[] = ((res && res.results) || []).map((r: any[]) => ({
        id: String(r[0]),
        title: lastSegment(String(r[1])),
        ref: r[2] == null ? null : String(r[2]),
        createdAt: String(r[3]),
      }));
      offsetRef.current += batch.length;
      setRows((prev) => prev.concat(batch));
      if (batch.length < PAGE_SIZE) setDone(true);
    } catch (err) {
      // Stop paging on error (e.g. the system table isn't available yet) rather
      // than spinning; the section just shows what it has.
      setDone(true);
    } finally {
      busyRef.current = false;
      setLoading(false);
    }
  }, [kind, done]);

  useEffect(() => {
    void loadMore();
    // Load the first page once on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { rows, loadMore, loading, done };
}

// A fixed-height, scrollable section card. A sentinel at the bottom (observed
// against THIS box, not the page) fires onLoadMore as the user scrolls near the
// end. Styled to match the PostHog Code app: greenish-gray neutrals, soft
// shadow, ~16px radius, a per-section accent dot.
function Section(props: {
  title: string;
  accent: string;
  onNew: () => void;
  loading: boolean;
  done: boolean;
  onLoadMore: () => void;
  children: any;
}) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const sentinelRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const root = scrollRef.current;
    const target = sentinelRef.current;
    if (!root || !target) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) props.onLoadMore();
      },
      { root, rootMargin: "120px" },
    );
    io.observe(target);
    return () => io.disconnect();
  }, [props.onLoadMore]);

  return (
    <section
      style={{
        flex: "1 1 0",
        minWidth: 0,
        maxWidth: 380,
        height: 460,
        display: "flex",
        flexDirection: "column",
        background: "#ffffff",
        border: "1px solid #e4e5de",
        borderRadius: 16,
        overflow: "hidden",
        boxShadow:
          "0 1px 2px rgba(13,13,13,0.04), 0 12px 32px rgba(13,13,13,0.06)",
      }}
    >
      <header
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "14px 16px",
          borderBottom: "1px solid #eceee8",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span
            style={{
              width: 8,
              height: 8,
              borderRadius: 999,
              background: props.accent,
              boxShadow: "0 0 0 3px " + props.accent + "22",
            }}
          />
          <h2
            style={{
              margin: 0,
              fontSize: 15,
              fontWeight: 600,
              color: "#0d0d0d",
              letterSpacing: "-0.01em",
            }}
          >
            {props.title}
          </h2>
        </div>
        <button
          type="button"
          className="ph-btn"
          onClick={props.onNew}
          style={{
            fontSize: 12,
            fontWeight: 500,
            padding: "4px 10px",
            borderRadius: 8,
            border: "1px solid #d8dbd1",
            background: "#f2f3ee",
            color: "#3a4036",
            cursor: "pointer",
          }}
        >
          + New
        </button>
      </header>
      <div ref={scrollRef} style={{ flex: 1, overflowY: "auto", padding: 8 }}>
        {props.children}
        {!props.done ? (
          <div ref={sentinelRef} style={{ height: 1 }} />
        ) : null}
        {props.loading ? (
          <div style={{ padding: 8, fontSize: 12, color: "#93998a" }}>Loading…</div>
        ) : null}
      </div>
    </section>
  );
}

function ListRow(props: { title: string; meta?: string }) {
  return (
    <div
      className="ph-row"
      style={{
        padding: "8px 10px",
        borderRadius: 8,
        fontSize: 13,
        color: "#3a4036",
        display: "flex",
        justifyContent: "space-between",
        gap: 8,
      }}
    >
      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {props.title}
      </span>
      {props.meta ? (
        <span style={{ color: "#93998a", fontSize: 11, flexShrink: 0 }}>{props.meta}</span>
      ) : null}
    </div>
  );
}

function Empty(props: { label: string }) {
  return (
    <div
      style={{
        display: "flex",
        height: "100%",
        minHeight: 120,
        alignItems: "center",
        justifyContent: "center",
        textAlign: "center",
        padding: 16,
        fontSize: 12,
        color: "#a9af9f",
      }}
    >
      {props.label}
    </div>
  );
}

function CanvasesSection() {
  const { rows, loadMore, loading, done } = useChannelRows("dashboard");
  return (
    <Section
      title="Canvases"
      accent="#f54d00"
      onNew={() => {}}
      loading={loading}
      done={done}
      onLoadMore={loadMore}
    >
      {rows.length === 0 && done ? <Empty label="No canvases yet." /> : null}
      {rows.map((r) => (
        <ListRow key={r.id} title={r.title} />
      ))}
    </Section>
  );
}

function TasksSection() {
  const { rows, loadMore, loading, done } = useChannelRows("task");
  return (
    <Section
      title="Tasks"
      accent="#f8be2a"
      onNew={() => {}}
      loading={loading}
      done={done}
      onLoadMore={loadMore}
    >
      {rows.length === 0 && done ? <Empty label="No tasks yet." /> : null}
      {rows.map((r) => (
        <ListRow key={r.id} title={r.title} meta={r.createdAt.slice(0, 10)} />
      ))}
    </Section>
  );
}

// Inbox / to-dos: there's no data source for these yet, so this is a stub. The
// assignee toggle and "New" button are placeholders the host will wire up later.
function InboxSection() {
  const [scope, setScope] = useState<"me" | "team">("me");
  const accent = "#1d4aff";
  return (
    <Section title="Inbox" accent={accent} onNew={() => {}} loading={false} done={true} onLoadMore={() => {}}>
      <div style={{ display: "flex", gap: 6, padding: "2px 2px 10px" }}>
        {(["me", "team"] as const).map((s) => {
          const active = scope === s;
          return (
            <button
              key={s}
              type="button"
              className="ph-btn"
              onClick={() => setScope(s)}
              style={{
                fontSize: 12,
                fontWeight: 500,
                padding: "4px 10px",
                borderRadius: 8,
                border: "1px solid " + (active ? accent : "#d8dbd1"),
                background: active ? accent + "14" : "#f2f3ee",
                color: active ? accent : "#3a4036",
                cursor: "pointer",
              }}
            >
              {s === "me" ? "Assigned to me" : "Teammates"}
            </button>
          );
        })}
      </div>
      <Empty label={"No " + (scope === "me" ? "items assigned to you" : "teammate items") + " yet."} />
    </Section>
  );
}

const STYLE_TEXT =
  ".ph-btn{transition:background .15s ease,border-color .15s ease,color .15s ease}" +
  ".ph-btn:hover{background:#eceee8;border-color:#cbd0c3}" +
  ".ph-row{transition:background .12s ease}" +
  ".ph-row:hover{background:#f2f3ee}" +
  "*::-webkit-scrollbar{width:10px;height:10px}" +
  "*::-webkit-scrollbar-thumb{background:#cbd0c3;border-radius:8px;border:2px solid transparent;background-clip:padding-box}" +
  "*::-webkit-scrollbar-thumb:hover{background:#a9af9f;background-clip:padding-box}";

export default function ChannelHome() {
  return (
    <div
      style={{
        minHeight: "100vh",
        boxSizing: "border-box",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 40,
        background: "linear-gradient(180deg, #f4f5f0 0%, #eceee8 100%)",
        fontFamily:
          '"Open Runde", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
        color: "#3a4036",
      }}
    >
      <style>{STYLE_TEXT}</style>
      <div
        style={{
          display: "flex",
          alignItems: "stretch",
          justifyContent: "center",
          gap: 20,
          width: "100%",
          maxWidth: 1200,
          flexWrap: "wrap",
        }}
      >
        <CanvasesSection />
        <InboxSection />
        <TasksSection />
      </div>
    </div>
  );
}
`;
}

// Build the renderer-facing record from a file-system row. The name is the last
// path segment (the canvas h1); spec + timestamps ride in `meta`.
function toRecord(entry: FsEntry): DashboardRecord {
  const meta = entry.meta ?? {};
  const createdAt = meta.createdAt ?? toEpoch(entry.created_at);
  return {
    id: entry.id,
    channelId: meta.channelId ?? "",
    name: lastSegment(entry.path),
    spec: meta.spec ?? null,
    templateId: meta.templateId ?? "dashboard",
    kind: meta.kind ?? "json-render",
    code: meta.code,
    versions: meta.versions,
    currentVersionId: meta.currentVersionId,
    // Prefer our stamped meta; fall back to the FS row's creator if present.
    createdBy: meta.createdBy ?? creatorName(entry.created_by),
    createdAt,
    updatedAt: meta.updatedAt ?? createdAt,
  };
}

// Human-readable creator from the backend's `created_by` user: full name when
// present, else email, else undefined (we don't render an id).
function creatorName(createdBy?: FsEntry["created_by"]): string | undefined {
  if (!createdBy) return undefined;
  const name = [createdBy.first_name, createdBy.last_name]
    .filter(Boolean)
    .join(" ")
    .trim();
  return name || createdBy.email || undefined;
}

// Path segments are "/"-separated on the backend, so a name can't contain one.
function sanitizeSegment(name: string): string {
  const cleaned = name.replace(/\//g, " ").replace(/\s+/g, " ").trim();
  return cleaned || "Untitled dashboard";
}

function parentPath(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? "" : path.slice(0, i);
}

function lastSegment(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? path : path.slice(i + 1);
}

function toEpoch(iso?: string): number {
  if (!iso) return Date.now();
  const t = Date.parse(iso);
  return Number.isNaN(t) ? Date.now() : t;
}

type SpecElements = Record<string, { children?: string[]; props?: unknown }>;
type StoredQuery = { query?: unknown; column?: unknown; shape?: unknown };

const QUERY_SHAPES = new Set<DashboardQueryShape>([
  "scalar",
  "column",
  "labels",
  "matrix",
  "pairs",
  "retention",
]);

// The spec's stored time window, if any (written under state.dateRange).
function storedRange(
  spec: Record<string, unknown>,
): DashboardDateRange | undefined {
  const state = spec.state as Record<string, unknown> | undefined;
  const r = state?.dateRange as Record<string, unknown> | undefined;
  if (r && typeof r.from === "number" && typeof r.to === "number") {
    return {
      name: typeof r.name === "string" ? r.name : "Custom",
      from: r.from,
      to: r.to,
    };
  }
  return undefined;
}

// Immutably set spec.state.dateRange (creating state if absent). No-op (same
// ref) when the range already matches.
function withStoredRange(
  spec: Record<string, unknown>,
  range: DashboardDateRange,
): Record<string, unknown> {
  const prev = storedRange(spec);
  if (
    prev &&
    prev.name === range.name &&
    prev.from === range.from &&
    prev.to === range.to
  ) {
    return spec;
  }
  const state = (spec.state as Record<string, unknown> | undefined) ?? {};
  return { ...spec, state: { ...state, dateRange: range } };
}

// Replace the window placeholders in a query with HogQL datetime literals for the
// active window. Besides `{date_from}`/`{date_to}`, the `_prev` pair spans the
// equal-length window immediately before it (for prior-period comparison series)
// so the comparison tracks the window length instead of a hardcoded interval. No
// range or no tokens → the query is returned as-is.
function substituteDateTokens(
  query: string,
  range: DashboardDateRange | undefined,
): string {
  if (!range || !/\{date_(from|to)(_prev)?\}/.test(query)) return query;
  const length = range.to - range.from;
  return query
    .replaceAll("{date_from_prev}", toHogQLDateTime(range.from - length))
    .replaceAll("{date_to_prev}", toHogQLDateTime(range.from))
    .replaceAll("{date_from}", toHogQLDateTime(range.from))
    .replaceAll("{date_to}", toHogQLDateTime(range.to));
}

// An epoch-ms instant as a `toDateTime(<unix seconds>)` literal — the integer
// form is an unambiguous UTC instant, unlike a bare 'YYYY-MM-DD HH:MM:SS' string
// (which HogQL would parse in the PROJECT timezone, shifting the window by the
// project's UTC offset). Drops straight into a comparison: `timestamp >= {date_from}`.
function toHogQLDateTime(epochMs: number): string {
  return `toDateTime(${Math.floor(epochMs / 1000)})`;
}

// Collect refreshable queries from spec.state.queries, optionally limited to the
// subtree(s) of `elementKeys` and skipping queries whose element no longer exists.
function collectQueries(
  spec: Record<string, unknown>,
  elementKeys?: string[],
): DashboardQuery[] {
  const state = spec.state as Record<string, unknown> | undefined;
  const queriesMap = state?.queries as
    | Record<string, Record<string, StoredQuery>>
    | undefined;
  if (!queriesMap) return [];

  const elements = spec.elements as SpecElements | undefined;
  const allowed =
    elementKeys && elements ? descendantKeys(elements, elementKeys) : null;

  const out: DashboardQuery[] = [];
  for (const [elementKey, props] of Object.entries(queriesMap)) {
    if (allowed && !allowed.has(elementKey)) continue;
    if (elements && !elements[elementKey]) continue; // stale key
    for (const [propPath, stored] of Object.entries(props)) {
      if (stored && typeof stored.query === "string") {
        const shape =
          typeof stored.shape === "string" &&
          QUERY_SHAPES.has(stored.shape as DashboardQueryShape)
            ? (stored.shape as DashboardQueryShape)
            : "scalar";
        out.push({
          elementKey,
          propPath,
          query: stored.query,
          column: typeof stored.column === "string" ? stored.column : undefined,
          shape,
        });
      }
    }
  }
  return out;
}

// Keys reachable from any of `roots` via `children` (inclusive of the roots).
function descendantKeys(elements: SpecElements, roots: string[]): Set<string> {
  const seen = new Set<string>();
  const stack = [...roots];
  while (stack.length > 0) {
    const key = stack.pop();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const children = elements[key]?.children;
    if (children) stack.push(...children);
  }
  return seen;
}

// Immutably set a value at `propPath` (a JSON pointer, e.g. "/value" or
// "/series/0/data") within spec.elements[elementKey].props; no-op (same ref)
// when the element is absent or the value is unchanged. Nested paths let one
// chart's series fill from separate queries (`/series/0/data`, `/series/1/data`).
function patchProp(
  spec: Record<string, unknown>,
  elementKey: string,
  propPath: string,
  value: unknown,
): Record<string, unknown> {
  const elements = spec.elements as
    | Record<string, { props?: Record<string, unknown> }>
    | undefined;
  const el = elements?.[elementKey];
  if (!elements || !el) return spec;
  const segments = propPath.split("/").filter(Boolean);
  if (segments.length === 0) return spec;
  // Skip when the value is unchanged (same ref) so a poll on stable data doesn't
  // rewrite meta.spec every tick — `refresh` only persists when something moved.
  if (deepEqual(getAtPointer(el.props ?? {}, segments), value)) return spec;
  const nextProps = setAtPointer(el.props ?? {}, segments, value);
  return {
    ...spec,
    elements: {
      ...elements,
      [elementKey]: { ...el, props: nextProps },
    },
  };
}

// Read the value at a pointer path, or undefined if any segment is missing.
function getAtPointer(container: unknown, segments: string[]): unknown {
  let cur: unknown = container;
  for (const seg of segments) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

// Structural equality for the scalar/array/plain-object values refresh writes.
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (typeof a !== "object") return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
      return false;
    }
    return a.every((x, i) => deepEqual(x, b[i]));
  }
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const ak = Object.keys(ao);
  const bk = Object.keys(bo);
  return ak.length === bk.length && ak.every((k) => deepEqual(ao[k], bo[k]));
}

// Immutable set at a pointer path, cloning containers along the way. A numeric
// segment indexes (and grows, if needed) an array; otherwise it's an object key.
function setAtPointer(
  container: unknown,
  segments: string[],
  value: unknown,
): Record<string, unknown> {
  const [head, ...rest] = segments;
  const index = /^\d+$/.test(head) ? Number(head) : null;

  if (index !== null) {
    const arr = Array.isArray(container) ? [...container] : [];
    arr[index] =
      rest.length === 0 ? value : setAtPointer(arr[index], rest, value);
    return arr as unknown as Record<string, unknown>;
  }

  const obj =
    container && typeof container === "object" && !Array.isArray(container)
      ? { ...(container as Record<string, unknown>) }
      : {};
  obj[head] = rest.length === 0 ? value : setAtPointer(obj[head], rest, value);
  return obj;
}
