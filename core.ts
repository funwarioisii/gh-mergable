import os from "node:os";
import path from "node:path";
import { mkdir } from "node:fs/promises";
import { pathToFileURL } from "node:url";

export type ReviewDecision = "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | null;
export type MergeableState = "CONFLICTING" | "MERGEABLE" | "UNKNOWN";
export type MergeStateStatus =
  | "BEHIND"
  | "BLOCKED"
  | "CLEAN"
  | "DIRTY"
  | "DRAFT"
  | "HAS_HOOKS"
  | "UNKNOWN"
  | "UNSTABLE";

export type PullRequest = {
  number: number;
  title: string;
  url: string;
  isDraft: boolean;
  updatedAt: string;
  mergeable: MergeableState;
  mergeStateStatus: MergeStateStatus;
  reviewDecision: ReviewDecision;
  headRefName: string;
  baseRefName: string;
  repository: {
    nameWithOwner: string;
  };
  latestOpinionatedReviews?: {
    nodes?: Array<{
      state: string;
      author?: {
        login: string;
      } | null;
    } | null>;
  };
  commits?: {
    nodes?: Array<
      | {
          commit?: {
            statusCheckRollup?: {
              state?: string | null;
              contexts?: {
                nodes?: Array<
                  | {
                      __typename: "CheckRun";
                      name: string;
                      status?: string | null;
                      conclusion?: string | null;
                    }
                  | {
                      __typename: "StatusContext";
                      context: string;
                      state?: string | null;
                    }
                  | null
                >;
              } | null;
            } | null;
          } | null;
        }
      | null
    >;
  };
};

type SearchResponse = {
  data?: {
    search?: {
      nodes?: Array<PullRequest | null>;
    };
  };
  errors?: Array<{ message?: string }>;
};

type LatestRepoResponse = {
  data?: {
    search?: {
      nodes?: Array<
        | {
            repository: {
              nameWithOwner: string;
            };
          }
        | null
      >;
    };
  };
  errors?: Array<{ message?: string }>;
};

export type AppConfig = {
  repos?: string[];
  intervalSec?: number;
  limit?: number;
};

export type CliOptions = {
  command: "watch";
  intervalMs?: number;
  once: boolean;
  repos: string[];
  limit?: number;
  configPath?: string;
};

export type SetupOptions = {
  command: "setup";
  configPath?: string;
};

export type ConfigCommandOptions = {
  command: "config";
  configPath?: string;
};

export type ParsedCommand = CliOptions | SetupOptions | ConfigCommandOptions;

export type ResolvedOptions = {
  command: "watch";
  intervalMs: number;
  once: boolean;
  repos: string[];
  limit: number;
  configPath: string;
};

export const DEFAULT_INTERVAL_MS = 10_000;
export const DEFAULT_LIMIT = 30;
export const CONFIG_DIR_NAME = "gh-mergeable";
export const DEFAULT_CONFIG_BASENAME = "config.ts";

const SEARCH_QUERY = `
  query($searchQuery: String!, $limit: Int!) {
    search(query: $searchQuery, type: ISSUE, first: $limit) {
      nodes {
        ... on PullRequest {
          number
          title
          url
          isDraft
          updatedAt
          mergeable
          mergeStateStatus
          reviewDecision
          headRefName
          baseRefName
          repository {
            nameWithOwner
          }
          latestOpinionatedReviews(first: 10) {
            nodes {
              state
              author {
                login
              }
            }
          }
          commits(last: 1) {
            nodes {
              commit {
                statusCheckRollup {
                  state
                  contexts(first: 20) {
                    nodes {
                      __typename
                      ... on CheckRun {
                        name
                        status
                        conclusion
                      }
                      ... on StatusContext {
                        context
                        state
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
`;

const LATEST_REPO_QUERY = `
  query($searchQuery: String!) {
    search(query: $searchQuery, type: ISSUE, first: 1) {
      nodes {
        ... on PullRequest {
          repository {
            nameWithOwner
          }
        }
      }
    }
  }
`;

export function parseArgs(args: string[]): ParsedCommand {
  if (args[0] === "setup") {
    return parseSetupArgs(args.slice(1));
  }

  if (args[0] === "config") {
    return parseConfigCommandArgs(args.slice(1));
  }

  return parseWatchArgs(args);
}

function parseWatchArgs(args: string[]): CliOptions {
  let intervalMs: number | undefined;
  let once = false;
  let limit: number | undefined;
  const repos: string[] = [];
  let configPath: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg) {
      fail("Unexpected empty argument");
    }

    if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }

    if (arg === "--once") {
      once = true;
      continue;
    }

    if (arg === "--repo") {
      const repo = args[index + 1];
      if (!repo) {
        fail("--repo requires a value like OWNER/REPO");
      }
      repos.push(repo);
      index += 1;
      continue;
    }

    if (arg.startsWith("--repo=")) {
      repos.push(arg.slice("--repo=".length));
      continue;
    }

    if (arg === "--interval") {
      const rawValue = args[index + 1];
      if (!rawValue) {
        fail("--interval requires seconds");
      }
      intervalMs = parseIntervalMs(rawValue);
      index += 1;
      continue;
    }

    if (arg.startsWith("--interval=")) {
      intervalMs = parseIntervalMs(arg.slice("--interval=".length));
      continue;
    }

    if (arg === "--limit") {
      const rawValue = args[index + 1];
      if (!rawValue) {
        fail("--limit requires a number between 1 and 100");
      }
      limit = parseLimit(rawValue);
      index += 1;
      continue;
    }

    if (arg.startsWith("--limit=")) {
      limit = parseLimit(arg.slice("--limit=".length));
      continue;
    }

    if (arg === "--config") {
      const rawValue = args[index + 1];
      if (!rawValue) {
        fail("--config requires a file path");
      }
      configPath = rawValue;
      index += 1;
      continue;
    }

    if (arg.startsWith("--config=")) {
      configPath = arg.slice("--config=".length);
      continue;
    }

    fail(`Unknown argument: ${arg}`);
  }

  return { command: "watch", intervalMs, once, repos, limit, configPath };
}

function parseSetupArgs(args: string[]): SetupOptions {
  return {
    command: "setup",
    configPath: parseConfigPathFlag(args),
  };
}

function parseConfigCommandArgs(args: string[]): ConfigCommandOptions {
  return {
    command: "config",
    configPath: parseConfigPathFlag(args),
  };
}

function parseConfigPathFlag(args: string[]) {
  let configPath: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg) {
      fail("Unexpected empty argument");
    }

    if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }

    if (arg === "--config") {
      const rawValue = args[index + 1];
      if (!rawValue) {
        fail("--config requires a file path");
      }
      configPath = rawValue;
      index += 1;
      continue;
    }

    if (arg.startsWith("--config=")) {
      configPath = arg.slice("--config=".length);
      continue;
    }

    fail(`Unknown argument: ${arg}`);
  }

  return configPath;
}

function parseIntervalMs(rawValue: string) {
  const seconds = Number(rawValue);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    fail(`Invalid interval: ${rawValue}`);
  }
  return Math.round(seconds * 1000);
}

function parseLimit(rawValue: string) {
  const limit = Number(rawValue);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    fail(`Invalid limit: ${rawValue}`);
  }
  return limit;
}

export async function fetchPullRequests(options: Pick<ResolvedOptions, "repos" | "limit">) {
  const responses = await Promise.all(
    buildSearchQueries(options.repos).map((searchQuery) =>
      runGh<SearchResponse>([
        "api",
        "graphql",
        "-f",
        `query=${SEARCH_QUERY}`,
        "-F",
        `searchQuery=${searchQuery}`,
        "-F",
        `limit=${options.limit}`,
      ])
    )
  );

  const errors = responses.flatMap((response) => response.errors ?? []);
  if (errors.length > 0) {
    fail(errors.map((error) => error.message || "Unknown GraphQL error").join("\n"));
  }

  const uniquePullRequests = new Map<string, PullRequest>();
  for (const response of responses) {
    for (const node of response.data?.search?.nodes ?? []) {
      if (!node) {
        continue;
      }
      uniquePullRequests.set(node.url, node);
    }
  }

  return [...uniquePullRequests.values()].sort(comparePullRequests);
}

export function buildSearchQuery(repos: string[], qualifier = "author:@me") {
  const parts = ["is:open", "is:pr", "archived:false", qualifier];

  for (const repo of repos) {
    parts.push(`repo:${repo}`);
  }

  return parts.join(" ");
}

export function buildSearchQueries(repos: string[]) {
  return [buildSearchQuery(repos, "author:@me"), buildSearchQuery(repos, "assignee:@me")];
}

export async function resolveOptions(cliOptions: CliOptions): Promise<ResolvedOptions> {
  const configPath = cliOptions.configPath ?? getDefaultConfigPath();
  const config = await loadConfig(configPath);
  const repos = uniqueRepos([...(config.repos ?? []), ...cliOptions.repos]);

  return {
    command: "watch",
    once: cliOptions.once,
    repos,
    intervalMs: cliOptions.intervalMs ?? config.intervalSec * 1000,
    limit: cliOptions.limit ?? config.limit,
    configPath,
  };
}

async function loadConfig(configPath: string): Promise<Required<AppConfig>> {
  const file = Bun.file(configPath);
  if (!(await file.exists())) {
    return {
      repos: [],
      intervalSec: DEFAULT_INTERVAL_MS / 1000,
      limit: DEFAULT_LIMIT,
    };
  }

  let mod: unknown;
  try {
    const url = `${pathToFileURL(configPath).href}?t=${Date.now()}`;
    mod = await import(url);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    fail(`Failed to load config ${configPath}: ${message}`);
  }

  return normalizeConfig((mod as { default?: unknown }).default ?? mod, configPath);
}

export function normalizeConfig(data: unknown, source = getDefaultConfigPath()): Required<AppConfig> {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    fail(`Invalid config in ${source}: expected default export object`);
  }

  const config = data as AppConfig;
  const repos = config.repos ?? [];
  const intervalSec = config.intervalSec ?? DEFAULT_INTERVAL_MS / 1000;
  const limit = config.limit ?? DEFAULT_LIMIT;

  if (!Array.isArray(repos) || repos.some((repo) => typeof repo !== "string" || repo.length === 0)) {
    fail(`Invalid config in ${source}: "repos" must be an array of non-empty strings`);
  }

  if (!Number.isFinite(intervalSec) || intervalSec <= 0) {
    fail(`Invalid config in ${source}: "intervalSec" must be a positive number`);
  }

  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    fail(`Invalid config in ${source}: "limit" must be an integer between 1 and 100`);
  }

  return {
    repos: uniqueRepos(repos),
    intervalSec,
    limit,
  };
}

export async function setupConfig(configPath = getDefaultConfigPath()) {
  const file = Bun.file(configPath);
  if (await file.exists()) {
    return { configPath, created: false };
  }

  const defaultRepo = await findLatestAuthoredRepo();
  const configText = renderConfigTemplate(defaultRepo ? [defaultRepo] : []);

  await mkdir(path.dirname(configPath), { recursive: true });
  await Bun.write(configPath, configText);
  return { configPath, created: true, defaultRepo };
}

export async function findLatestAuthoredRepo() {
  const response = await runGh<LatestRepoResponse>([
    "api",
    "graphql",
    "-f",
    `query=${LATEST_REPO_QUERY}`,
    "-F",
    "searchQuery=is:pr author:@me archived:false sort:created-desc",
  ]);

  const errors = response.errors ?? [];
  if (errors.length > 0) {
    fail(errors.map((error) => error.message || "Unknown GraphQL error").join("\n"));
  }

  return response.data?.search?.nodes?.[0]?.repository.nameWithOwner;
}

export function renderConfigTemplate(repos: string[]) {
  const repoLines =
    repos.length > 0
      ? repos.map((repo) => `    "${repo}",`).join("\n")
      : '    // "owner/repo",';

  return `export default {
  repos: [
${repoLines}
  ],
  intervalSec: ${DEFAULT_INTERVAL_MS / 1000},
  limit: ${DEFAULT_LIMIT},
};
`;
}

export function getDefaultConfigDir() {
  const xdgConfigHome = process.env.XDG_CONFIG_HOME;
  if (xdgConfigHome) {
    return path.join(xdgConfigHome, CONFIG_DIR_NAME);
  }

  return path.join(os.homedir(), ".config", CONFIG_DIR_NAME);
}

export function getDefaultConfigPath() {
  return path.join(getDefaultConfigDir(), DEFAULT_CONFIG_BASENAME);
}

export function summarizeMergeability(pr: PullRequest) {
  if (hasFailingChecks(pr)) {
    return { tone: "danger", label: "FAILING", sortRank: 3 } as const;
  }

  if (pr.isDraft || pr.mergeStateStatus === "DRAFT") {
    return { tone: "draft", label: "DRAFT", sortRank: 2 } as const;
  }

  if (pr.mergeStateStatus === "DIRTY" || pr.mergeable === "CONFLICTING") {
    return { tone: "danger", label: "CONFLICT", sortRank: 4 } as const;
  }

  if (pr.mergeStateStatus === "BEHIND") {
    return { tone: "warn", label: "BEHIND", sortRank: 3 } as const;
  }

  if (pr.mergeStateStatus === "BLOCKED" || pr.reviewDecision === "CHANGES_REQUESTED") {
    return { tone: "blocked", label: "BLOCKED", sortRank: 1 } as const;
  }

  if (pr.mergeStateStatus === "UNKNOWN" || pr.mergeable === "UNKNOWN" || pr.mergeStateStatus === "UNSTABLE") {
    return { tone: "pending", label: "PENDING", sortRank: 6 } as const;
  }

  return { tone: "success", label: "MERGEABLE", sortRank: 0 } as const;
}

export function listApprovers(pr: PullRequest) {
  const logins = new Set<string>();

  for (const review of pr.latestOpinionatedReviews?.nodes ?? []) {
    if (review?.state !== "APPROVED" || !review.author?.login) {
      continue;
    }
    logins.add(review.author.login);
  }

  return [...logins];
}

export function comparePullRequests(left: PullRequest, right: PullRequest) {
  const leftSummary = summarizeMergeability(left);
  const rightSummary = summarizeMergeability(right);

  if (leftSummary.sortRank !== rightSummary.sortRank) {
    return leftSummary.sortRank - rightSummary.sortRank;
  }

  return new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime();
}

export function listFailingChecks(pr: PullRequest) {
  const failing = new Set<string>();
  const contexts = pr.commits?.nodes?.[0]?.commit?.statusCheckRollup?.contexts?.nodes ?? [];

  for (const context of contexts) {
    if (!context) {
      continue;
    }

    if (context.__typename === "CheckRun") {
      if (context.conclusion === "FAILURE" || context.conclusion === "TIMED_OUT" || context.conclusion === "CANCELLED") {
        failing.add(context.name);
      }
      continue;
    }

    if (context.state === "FAILURE" || context.state === "ERROR") {
      failing.add(context.context);
    }
  }

  return [...failing];
}

export function hasFailingChecks(pr: PullRequest) {
  return listFailingChecks(pr).length > 0;
}

export function collectStats(prs: PullRequest[]) {
  const counts = {
    mergeable: 0,
    blocked: 0,
    failing: 0,
    behind: 0,
    conflict: 0,
    draft: 0,
    pending: 0,
  };

  for (const pr of prs) {
    const summary = summarizeMergeability(pr);
    switch (summary.label) {
      case "MERGEABLE":
        counts.mergeable += 1;
        break;
      case "BLOCKED":
        counts.blocked += 1;
        break;
      case "FAILING":
        counts.failing += 1;
        break;
      case "BEHIND":
        counts.behind += 1;
        break;
      case "CONFLICT":
        counts.conflict += 1;
        break;
      case "DRAFT":
        counts.draft += 1;
        break;
      case "PENDING":
        counts.pending += 1;
        break;
    }
  }

  return counts;
}

export function formatTimestamp(value: Date | string) {
  const date = typeof value === "string" ? new Date(value) : value;
  return new Intl.DateTimeFormat("ja-JP", {
    dateStyle: "medium",
    timeStyle: "medium",
  }).format(date);
}

export function formatTime(value: Date | string) {
  const date = typeof value === "string" ? new Date(value) : value;
  return new Intl.DateTimeFormat("ja-JP", {
    timeStyle: "medium",
  }).format(date);
}

export function truncate(value: string, maxLength: number) {
  if (value.length <= maxLength) {
    return value;
  }

  if (maxLength <= 3) {
    return value.slice(0, maxLength);
  }

  return `${value.slice(0, maxLength - 3)}...`;
}

export function printHelp() {
  console.log(`Usage:
  bun run index.tsx [options]
  bun run index.tsx setup [options]

Watch options:
  --once              Fetch once and exit
  --interval <sec>    Refresh interval in seconds (default: 10)
  --repo <owner/repo> Filter to a repository, repeatable
  --limit <count>     Number of PRs to fetch, 1-100 (default: 30)
  --config <path>     Load config file (default: ${getDefaultConfigPath()})

Setup options:
  --config <path>     Write config file to this path

General:
  --help              Show this help
`);
}

export function getOpenCommand(url: string, platform = process.platform) {
  switch (platform) {
    case "darwin":
      return ["open", url];
    case "win32":
      return ["cmd", "/c", "start", "", url];
    default:
      return ["xdg-open", url];
  }
}

export function clampSelectedIndex(index: number, length: number) {
  if (length <= 0) {
    return 0;
  }

  if (index < 0) {
    return 0;
  }

  if (index >= length) {
    return length - 1;
  }

  return index;
}

export function getEditorCommand(configPath: string, editor = process.env.VISUAL || process.env.EDITOR || "vi") {
  const parts = editor.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) {
    return ["vi", configPath];
  }

  return [...parts, configPath];
}

function uniqueRepos(repos: string[]) {
  return [...new Set(repos)];
}

async function runGh<T>(args: string[]): Promise<T> {
  const proc = Bun.spawn(["gh", ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;

  if (exitCode !== 0) {
    fail(stderr.trim() || `gh exited with status ${exitCode}`);
  }

  return JSON.parse(stdout) as T;
}

function fail(message: string): never {
  throw new Error(message);
}
