import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import {
  createSnapshot,
  fetchPullRequests,
  listApprovers,
  listFailingChecks,
  summarizeMergeability,
  syncAggressiveRepos,
  type DashboardPullRequest,
  type DashboardSnapshot,
  type PullRequest,
  type ResolvedOptions,
  type ServerCommandOptions,
} from "./core";

type SnapshotStore = {
  snapshot: DashboardSnapshot;
  activeRepos: string[];
};

type Subscriber = {
  id: number;
  send: (event: string, data: DashboardSnapshot) => Promise<void>;
  close: () => void;
};

function renderHtml() {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>gh-mergeable</title>
    <style>
      :root { color-scheme: light; --bg: #f4f0e8; --card: #fffdf8; --ink: #1e1c19; --muted: #6d665c; --line: #d8cfbf; --ok: #1c7c54; --warn: #b7791f; --bad: #c53030; --info: #0f6fae; --draft: #4c51bf; }
      * { box-sizing: border-box; }
      body { margin: 0; font-family: "Iowan Old Style", "Palatino Linotype", serif; background: radial-gradient(circle at top, #fffaf0, #f1e8da 55%, #eadfce 100%); color: var(--ink); }
      main { max-width: 1100px; margin: 0 auto; padding: 24px; }
      .hero, .summary, .card { border: 1px solid var(--line); border-radius: 18px; background: rgba(255,253,248,.92); box-shadow: 0 12px 30px rgba(74,53,22,.08); }
      .hero { padding: 18px 20px; display:flex; justify-content:space-between; gap: 16px; align-items:flex-start; }
      .hero h1 { margin: 0; font-size: 28px; }
      .muted { color: var(--muted); }
      .summary { margin-top: 16px; padding: 14px 18px; display:grid; gap:10px; }
      .stats { display:flex; flex-wrap:wrap; gap: 14px; font-family: ui-monospace, SFMono-Regular, monospace; font-size: 14px; }
      .stats span { padding: 2px 8px; border-radius: 999px; background: #f7f1e5; }
      .list { margin-top: 18px; display:grid; gap: 14px; }
      .card { padding: 16px 18px; text-decoration:none; color:inherit; display:block; }
      .card:hover { transform: translateY(-1px); }
      .head { display:flex; justify-content:space-between; gap: 16px; align-items:flex-start; }
      .label { display:inline-block; min-width: 88px; font: 700 12px/1.8 ui-monospace, SFMono-Regular, monospace; letter-spacing:.08em; }
      .MERGEABLE { color: var(--ok); } .BLOCKED { color: var(--warn); } .FAILING, .CONFLICT { color: var(--bad); } .PENDING { color: var(--info); } .DRAFT { color: var(--draft); } .BEHIND { color: #7a4a1d; }
      h2 { margin: 10px 0 8px; font-size: 22px; }
      .meta, .sub { font-size: 14px; color: var(--muted); }
      .sub { margin-top: 6px; }
      .extra { margin-top: 8px; font-size: 14px; }
      .approvers { color: var(--ok); }
      .failing { color: var(--bad); }
      .error { margin-top: 16px; padding: 14px 18px; border-radius: 16px; border: 1px solid #f0b4b4; background: #fff4f4; color: var(--bad); }
      .group { margin-top: 18px; }
      .group summary { cursor: pointer; list-style: none; padding: 10px 16px; border-radius: 12px; background: rgba(255,253,248,.8); border: 1px solid var(--line); font: 700 15px/1.6 ui-monospace, SFMono-Regular, monospace; letter-spacing: .04em; display: flex; align-items: center; gap: 10px; user-select: none; }
      .group summary::-webkit-details-marker { display: none; }
      .group summary::before { content: "▶"; font-size: 11px; transition: transform .15s; }
      .group[open] summary::before { transform: rotate(90deg); }
      .group summary .count { font-weight: 400; color: var(--muted); font-size: 13px; }
      .group .group-list { display: grid; gap: 12px; margin-top: 12px; }
    </style>
  </head>
  <body>
    <main>
      <section class="hero">
        <div>
          <div class="muted">browser mode</div>
          <h1>gh-mergeable</h1>
          <div id="scope" class="muted">loading...</div>
        </div>
        <div class="muted" id="timestamps">loading...</div>
      </section>
      <section class="summary">
        <div class="stats" id="stats"></div>
        <div class="muted">This page updates via SSE from the local gh-mergeable server.</div>
        <button id="notif-btn" style="display:none; margin-top:8px; padding:6px 14px; border-radius:8px; border:1px solid var(--line); background:var(--card); cursor:pointer; font:inherit; font-size:13px;">🔔 Enable notifications</button>
      </section>
      <section id="error"></section>
      <section id="list" class="list"></section>
    </main>
    <script>
      const fmt = (iso) => iso ? new Intl.DateTimeFormat("ja-JP", { dateStyle: "medium", timeStyle: "medium" }).format(new Date(iso)) : "-";
      const statsOrder = ["mergeable","blocked","failing","behind","conflict","draft","pending"];
      const label = (key) => key.toUpperCase();

      const prevStatuses = new Map();
      let firstSnapshot = true;

      const notifBtn = document.getElementById("notif-btn");
      if ("Notification" in window) {
        if (Notification.permission === "default") {
          notifBtn.style.display = "inline-block";
          notifBtn.onclick = () => Notification.requestPermission().then((p) => {
            notifBtn.style.display = p === "default" ? "inline-block" : "none";
          });
        }
      }

      const notify = (title, body, url) => {
        if (Notification.permission !== "granted") return;
        const n = new Notification(title, { body, icon: "https://github.githubassets.com/favicons/favicon-dark.svg", tag: url });
        n.onclick = () => { window.open(url, "_blank"); n.close(); };
      };

      const detectChanges = (snapshot) => {
        if (firstSnapshot) {
          for (const pr of snapshot.prs) prevStatuses.set(pr.url, pr.status.label);
          firstSnapshot = false;
          return;
        }
        for (const pr of snapshot.prs) {
          const prev = prevStatuses.get(pr.url);
          const curr = pr.status.label;
          if (prev && prev !== curr) {
            if (curr === "MERGEABLE") {
              notify("✅ MERGEABLE", pr.repository.nameWithOwner + "#" + pr.number + " " + pr.title, pr.url);
            } else if (prev === "MERGEABLE") {
              notify("⚠️ " + curr, pr.repository.nameWithOwner + "#" + pr.number + " " + pr.title, pr.url);
            }
          }
          prevStatuses.set(pr.url, curr);
        }
      };

      const render = (snapshot) => {
        document.getElementById("scope").textContent = snapshot.repos.length > 0 ? snapshot.repos.join(", ") : "all repos";
        document.getElementById("timestamps").textContent = "updated " + fmt(snapshot.lastUpdated) + " / next " + fmt(snapshot.nextRefresh);
        document.getElementById("stats").innerHTML = statsOrder.map((key) => '<span>' + label(key) + " " + (snapshot.stats[key] ?? 0) + '</span>').join("");
        const errorEl = document.getElementById("error");
        errorEl.innerHTML = snapshot.error ? '<div class="error">' + snapshot.error + '</div>' : "";
        const list = document.getElementById("list");
        if (snapshot.prs.length === 0) {
          list.innerHTML = '<div class="card muted">No open PRs found.</div>';
          return;
        }
        const groups = new Map();
        const groupOrder = ["MERGEABLE","BLOCKED","FAILING","BEHIND","CONFLICT","DRAFT","PENDING"];
        for (const pr of snapshot.prs) {
          const key = pr.status.label;
          if (!groups.has(key)) groups.set(key, []);
          groups.get(key).push(pr);
        }
        const openState = {};
        list.querySelectorAll("details.group").forEach((d) => { openState[d.classList[1]] = d.open; });
        const renderCard = (pr) => {
          const approvers = (pr.approvers ?? []).join(", ");
          const failingChecks = (pr.failingChecks ?? []).join(", ");
          return '<a class="card" target="_blank" rel="noreferrer" href="' + pr.url + '">' +
            '<div class="head"><div><span class="label ' + pr.status.label + '">' + pr.status.label + '</span> ' + pr.repository.nameWithOwner + '#' + pr.number + '</div><div class="meta">' + fmt(pr.updatedAt) + '</div></div>' +
            '<h2>' + pr.title + '</h2>' +
            '<div class="sub">' + pr.headRefName + ' -> ' + pr.baseRefName + ' | review ' + (pr.reviewDecision ?? 'NONE') + ' | state ' + pr.mergeStateStatus + '</div>' +
            (approvers ? '<div class="extra approvers">approved by ' + approvers + '</div>' : '') +
            (failingChecks ? '<div class="extra failing">failing checks: ' + failingChecks + '</div>' : '') +
            '</a>';
        };
        list.innerHTML = groupOrder
          .filter((key) => groups.has(key))
          .map((key) => {
            const prs = groups.get(key);
            const isOpen = key in openState ? openState[key] : true;
            return '<details class="group ' + key + '"' + (isOpen ? ' open' : '') + '>' +
              '<summary><span class="' + key + '">' + key + '</span> <span class="count">(' + prs.length + ')</span></summary>' +
              '<div class="group-list">' + prs.map(renderCard).join("") + '</div>' +
              '</details>';
          }).join("");
        detectChanges(snapshot);
      };
      fetch('/api/state').then((r) => r.json()).then(render);
      const es = new EventSource('/events');
      es.addEventListener('snapshot', (event) => render(JSON.parse(event.data)));
      es.addEventListener('error', (event) => render(JSON.parse(event.data)));
    </script>
  </body>
</html>`;
}

function serializeSnapshot(snapshot: DashboardSnapshot) {
  return JSON.stringify(snapshot);
}

function enrichPullRequests(prs: PullRequest[]): DashboardPullRequest[] {
  return prs.map((pr) => ({
    ...pr,
    approvers: listApprovers(pr),
    failingChecks: listFailingChecks(pr),
    status: summarizeMergeability(pr),
  }));
}

export async function buildDashboardSnapshot(options: ResolvedOptions, activeRepos: string[], error?: string) {
  const prs = await fetchPullRequests({ repos: activeRepos, limit: options.limit });
  const lastUpdated = new Date();
  const enriched = await enrichPullRequests(prs);
  return createSnapshot({
    repos: activeRepos,
    prs: enriched,
    intervalMs: options.intervalMs,
    lastUpdated,
    error,
  });
}

export function createServerApp(
  getSnapshot: () => DashboardSnapshot,
  subscribe: (subscriber: Subscriber) => () => void
) {
  const app = new Hono();

  app.get("/", (c) => c.html(renderHtml()));
  app.get("/api/state", (c) => c.json(getSnapshot()));
  app.get("/events", (c) => {
    return streamSSE(c, async (stream) => {
      await stream.writeSSE({ event: "snapshot", data: serializeSnapshot(getSnapshot()) });

      let aborted = false;
      let waiting: ((value: { event: string; snapshot: DashboardSnapshot } | null) => void) | null = null;
      const pending: Array<{ event: string; snapshot: DashboardSnapshot }> = [];

      const unsubscribe = subscribe({
        id: Date.now() + Math.random(),
        send: async (event, snapshot) => {
          if (waiting) {
            const resolve = waiting;
            waiting = null;
            resolve({ event, snapshot });
          } else {
            pending.push({ event, snapshot });
          }
        },
        close: () => {},
      });

      stream.onAbort(() => {
        aborted = true;
        unsubscribe();
        if (waiting) {
          waiting(null);
          waiting = null;
        }
      });

      while (!aborted) {
        const item =
          pending.length > 0
            ? pending.shift()!
            : await new Promise<{ event: string; snapshot: DashboardSnapshot } | null>((resolve) => {
                waiting = resolve;
              });

        if (!item || aborted) break;
        await stream.writeSSE({ event: item.event, data: serializeSnapshot(item.snapshot) });
      }
    });
  });

  return app;
}

export async function startServer(command: ServerCommandOptions, options: ResolvedOptions) {
  const subscribers = new Map<number, Subscriber>();
  let activeRepos = options.repos;
  let snapshot = createSnapshot({ repos: activeRepos, prs: [], intervalMs: options.intervalMs });

  const broadcast = async (event: string, nextSnapshot: DashboardSnapshot) => {
    snapshot = nextSnapshot;
    await Promise.all(
      [...subscribers.values()].map(async (subscriber) => {
        try {
          await subscriber.send(event, nextSnapshot);
        } catch {
          subscribers.delete(subscriber.id);
          subscriber.close();
        }
      })
    );
  };

  const refresh = async () => {
    try {
      if (options.aggressiveMode) {
        const synced = await syncAggressiveRepos(options.configPath);
        if (synced.addedRepos.length > 0) {
          activeRepos = [...new Set([...activeRepos, ...synced.config.repos])];
        }
      }
      const nextSnapshot = await buildDashboardSnapshot(options, activeRepos);
      await broadcast("snapshot", nextSnapshot);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await broadcast(
        "error",
        createSnapshot({
          repos: activeRepos,
          prs: snapshot.prs,
          intervalMs: options.intervalMs,
          lastUpdated: snapshot.lastUpdated ? new Date(snapshot.lastUpdated) : undefined,
          error: message,
        })
      );
    }
  };

  await refresh();
  const timer = setInterval(() => {
    void refresh();
  }, options.intervalMs);

  const app = createServerApp(
    () => snapshot,
    (subscriber) => {
      subscribers.set(subscriber.id, subscriber);
      return () => {
        subscribers.delete(subscriber.id);
        subscriber.close();
      };
    }
  );

  const server = Bun.serve({
    hostname: command.host,
    port: command.port,
    idleTimeout: 255,
    fetch: app.fetch,
  });

  process.stdout.write(`Server running at http://${command.host}:${command.port}\n`);

  const shutdown = () => {
    clearInterval(timer);
    server.stop();
    for (const subscriber of subscribers.values()) {
      subscriber.close();
    }
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  return server;
}
