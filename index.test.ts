import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir } from "node:fs/promises";
import path from "node:path";
import {
  buildSearchQueries,
  buildSearchQuery,
  clampSelectedIndex,
  comparePullRequests,
  getEditorCommand,
  getDefaultConfigDir,
  getOpenCommand,
  listApprovers,
  listFailingChecks,
  normalizeConfig,
  parseArgs,
  renderConfigTemplate,
  resolveOptions,
  summarizeMergeability,
} from "./core";

const basePr = {
  number: 1,
  title: "Example",
  url: "https://github.com/octo/repo/pull/1",
  isDraft: false,
  updatedAt: "2026-03-12T00:00:00Z",
  mergeable: "MERGEABLE" as const,
  mergeStateStatus: "CLEAN" as const,
  reviewDecision: null,
  headRefName: "feature",
  baseRefName: "main",
  repository: {
    nameWithOwner: "octo/repo",
  },
  latestOpinionatedReviews: {
    nodes: [],
  },
  commits: {
    nodes: [],
  },
};

describe("parseArgs", () => {
  test("uses watch defaults", () => {
    expect(parseArgs([])).toEqual({
      command: "watch",
      intervalMs: undefined,
      once: false,
      repos: [],
      limit: undefined,
      configPath: undefined,
    });
  });

  test("parses watch flags", () => {
    expect(
      parseArgs(["--once", "--interval", "30", "--repo", "octo/repo", "--limit=10", "--config", "./custom.ts"])
    ).toEqual({
      command: "watch",
      intervalMs: 30_000,
      once: true,
      repos: ["octo/repo"],
      limit: 10,
      configPath: "./custom.ts",
    });
  });

  test("parses setup command", () => {
    expect(parseArgs(["setup", "--config", "./custom.ts"])).toEqual({
      command: "setup",
      configPath: "./custom.ts",
    });
  });

  test("parses config command", () => {
    expect(parseArgs(["config", "--config", "./custom.ts"])).toEqual({
      command: "config",
      configPath: "./custom.ts",
    });
  });
});

describe("config", () => {
  test("normalizes config defaults", () => {
    expect(normalizeConfig({ repos: ["octo/repo", "octo/repo"] }, "config.ts")).toEqual({
      repos: ["octo/repo"],
      intervalSec: 10,
      limit: 30,
    });
  });

  test("merges config repos with cli repos and applies config defaults", async () => {
    const dir = await mkdtemp("/tmp/gh-mergeable-test-");
    const configPath = path.join(dir, "config.ts");
    await Bun.write(
      configPath,
      `export default {
  repos: ["octo/repo", "octo/another"],
  intervalSec: 42,
  limit: 12,
};
`
    );

    await expect(
      resolveOptions({
        command: "watch",
        intervalMs: undefined,
        once: false,
        repos: ["octo/repo", "octo/third"],
        limit: undefined,
        configPath,
      })
    ).resolves.toEqual({
      command: "watch",
      intervalMs: 42_000,
      once: false,
      repos: ["octo/repo", "octo/another", "octo/third"],
      limit: 12,
      configPath,
    });
  });

  test("renders config template with repo", () => {
    expect(renderConfigTemplate(["octo/repo"])).toContain('"octo/repo"');
  });

  test("uses xdg config directory when present", () => {
    const original = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = "/tmp/xdg-home";
    expect(getDefaultConfigDir()).toBe("/tmp/xdg-home/gh-mergeable");
    process.env.XDG_CONFIG_HOME = original;
  });
});

describe("buildSearchQuery", () => {
  test("builds author query", () => {
    expect(buildSearchQuery([])).toBe("is:open is:pr archived:false author:@me");
  });

  test("adds repo filters", () => {
    expect(buildSearchQuery(["octo/repo", "octo/another"])).toBe(
      "is:open is:pr archived:false author:@me repo:octo/repo repo:octo/another"
    );
  });

  test("builds author and assignee queries", () => {
    expect(buildSearchQueries(["octo/repo"])).toEqual([
      "is:open is:pr archived:false author:@me repo:octo/repo",
      "is:open is:pr archived:false assignee:@me repo:octo/repo",
    ]);
  });
});

describe("summarizeMergeability", () => {
  test("reports mergeable PRs", () => {
    expect(summarizeMergeability(basePr)).toEqual({ tone: "success", label: "MERGEABLE", sortRank: 0 });
  });

  test("reports blocked PRs", () => {
    expect(
      summarizeMergeability({
        ...basePr,
        mergeStateStatus: "BLOCKED",
        reviewDecision: "REVIEW_REQUIRED",
      })
    ).toEqual({ tone: "blocked", label: "BLOCKED", sortRank: 1 });
  });

  test("reports conflicts", () => {
    expect(
      summarizeMergeability({
        ...basePr,
        mergeStateStatus: "DIRTY",
        mergeable: "CONFLICTING",
      })
    ).toEqual({ tone: "danger", label: "CONFLICT", sortRank: 4 });
  });

  test("reports failing checks before pending", () => {
    expect(
      summarizeMergeability({
        ...basePr,
        mergeStateStatus: "UNSTABLE",
        commits: {
          nodes: [
            {
              commit: {
                statusCheckRollup: {
                  state: "FAILURE",
                  contexts: {
                    nodes: [{ __typename: "CheckRun", name: "backend-test / test", status: "COMPLETED", conclusion: "FAILURE" }],
                  },
                },
              },
            },
          ],
        },
      })
    ).toEqual({ tone: "danger", label: "FAILING", sortRank: 3 });
  });
});

describe("comparePullRequests", () => {
  test("sorts mergeable before blocked before draft", () => {
    const prs = [
      { ...basePr, url: "draft", isDraft: true, updatedAt: "2026-03-12T00:00:00Z" },
      { ...basePr, url: "blocked", mergeStateStatus: "BLOCKED" as const, updatedAt: "2026-03-12T00:01:00Z" },
      { ...basePr, url: "mergeable", updatedAt: "2026-03-12T00:02:00Z" },
    ];

    const sorted = [...prs].sort(comparePullRequests);
    expect(sorted.map((pr) => pr.url)).toEqual(["mergeable", "blocked", "draft"]);
  });
});

describe("listApprovers", () => {
  test("collects unique approved reviewer logins", () => {
    expect(
      listApprovers({
        ...basePr,
        latestOpinionatedReviews: {
          nodes: [
            { state: "APPROVED", author: { login: "alice" } },
            { state: "COMMENTED", author: { login: "bob" } },
            { state: "APPROVED", author: { login: "alice" } },
            { state: "APPROVED", author: { login: "carol" } },
          ],
        },
      })
    ).toEqual(["alice", "carol"]);
  });
});

describe("listFailingChecks", () => {
  test("collects failed check names", () => {
    expect(
      listFailingChecks({
        ...basePr,
        commits: {
          nodes: [
            {
              commit: {
                statusCheckRollup: {
                  state: "FAILURE",
                  contexts: {
                    nodes: [
                      { __typename: "CheckRun", name: "backend-test / test", status: "COMPLETED", conclusion: "FAILURE" },
                      { __typename: "CheckRun", name: "format", status: "COMPLETED", conclusion: "SUCCESS" },
                      { __typename: "StatusContext", context: "ci/custom", state: "ERROR" },
                    ],
                  },
                },
              },
            },
          ],
        },
      })
    ).toEqual(["backend-test / test", "ci/custom"]);
  });
});

describe("selection helpers", () => {
  test("clamps selected index into range", () => {
    expect(clampSelectedIndex(-1, 3)).toBe(0);
    expect(clampSelectedIndex(1, 3)).toBe(1);
    expect(clampSelectedIndex(10, 3)).toBe(2);
    expect(clampSelectedIndex(10, 0)).toBe(0);
  });

  test("builds open command per platform", () => {
    expect(getOpenCommand("https://example.com", "darwin")).toEqual(["open", "https://example.com"]);
    expect(getOpenCommand("https://example.com", "linux")).toEqual(["xdg-open", "https://example.com"]);
    expect(getOpenCommand("https://example.com", "win32")).toEqual(["cmd", "/c", "start", "", "https://example.com"]);
  });

  test("builds editor command from editor string", () => {
    expect(getEditorCommand("/tmp/config.ts", "code -w")).toEqual(["code", "-w", "/tmp/config.ts"]);
    expect(getEditorCommand("/tmp/config.ts", "")).toEqual(["vi", "/tmp/config.ts"]);
  });
});
