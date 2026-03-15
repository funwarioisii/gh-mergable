import { describe, expect, test } from "bun:test";
import { createSnapshot, type DashboardPullRequest } from "./core";
import { createServerApp } from "./server";

const samplePr: DashboardPullRequest = {
  number: 1,
  title: "Example",
  url: "https://github.com/octo/repo/pull/1",
  isDraft: false,
  updatedAt: "2026-03-14T00:00:00Z",
  mergeable: "MERGEABLE",
  mergeStateStatus: "CLEAN",
  reviewDecision: "APPROVED",
  headRefName: "feature",
  baseRefName: "main",
  repository: {
    nameWithOwner: "octo/repo",
  },
  latestOpinionatedReviews: { nodes: [] },
  commits: { nodes: [] },
  approvers: ["alice"],
  failingChecks: [],
  status: { tone: "success", label: "MERGEABLE", sortRank: 0 },
};

describe("server app", () => {
  test("serves html shell", async () => {
    const snapshot = createSnapshot({
      repos: ["octo/repo"],
      prs: [samplePr],
      intervalMs: 10_000,
      lastUpdated: new Date("2026-03-14T00:00:00Z"),
    });
    const app = createServerApp(() => snapshot, () => () => {});

    const response = await app.request("/");
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("gh-mergeable");
  });

  test("serves snapshot json", async () => {
    const snapshot = createSnapshot({
      repos: ["octo/repo"],
      prs: [samplePr],
      intervalMs: 10_000,
      lastUpdated: new Date("2026-03-14T00:00:00Z"),
    });
    const app = createServerApp(() => snapshot, () => () => {});

    const response = await app.request("/api/state");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      repos: ["octo/repo"],
      prs: [{ title: "Example" }],
    });
  });
});
