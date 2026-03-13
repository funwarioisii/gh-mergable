#!/usr/bin/env bun

import React, { useEffect, useRef, useState } from "react";
import { Box, render, Text, useApp, useInput, useStdin } from "ink";
import {
  clampSelectedIndex,
  collectStats,
  fetchPullRequests,
  formatTime,
  formatTimestamp,
  getEditorCommand,
  getOpenCommand,
  listApprovers,
  listFailingChecks,
  parseArgs,
  resolveOptions,
  setupConfig,
  syncAggressiveRepos,
  summarizeMergeability,
  truncate,
  type PullRequest,
  type ResolvedOptions,
} from "./core";

type ScreenState = {
  prs: PullRequest[];
  lastUpdated?: Date;
  nextRefresh?: Date;
  error?: string;
  loading: boolean;
};

function toneColor(tone: ReturnType<typeof summarizeMergeability>["tone"]) {
  switch (tone) {
    case "success":
      return "green";
    case "blocked":
      return "yellow";
    case "warn":
      return "magenta";
    case "danger":
      return "red";
    case "draft":
      return "blue";
    case "pending":
      return "cyan";
  }
}

function KeyboardShortcuts({
  selectedIndex,
  prs,
  setSelectedIndex,
}: {
  selectedIndex: number;
  prs: PullRequest[];
  setSelectedIndex: React.Dispatch<React.SetStateAction<number>>;
}) {
  useInput((input, key) => {
    if (key.upArrow || input === "k") {
      setSelectedIndex((current) => clampSelectedIndex(current - 1, prs.length));
      return;
    }

    if (key.downArrow || input === "j") {
      setSelectedIndex((current) => clampSelectedIndex(current + 1, prs.length));
      return;
    }

    if ((key.return || input === " " || input === "o") && prs.length > 0) {
      const selected = prs[selectedIndex];
      if (!selected) {
        return;
      }

      Bun.spawn(getOpenCommand(selected.url), {
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
      });
    }
  });

  return null;
}

function App({ options }: { options: ResolvedOptions }) {
  const { exit } = useApp();
  const { isRawModeSupported } = useStdin();
  const [activeRepos, setActiveRepos] = useState(options.repos);
  const activeReposRef = useRef(options.repos);
  const [state, setState] = useState<ScreenState>({
    prs: [],
    loading: true,
  });
  const [selectedIndex, setSelectedIndex] = useState(0);
  const columns = process.stdout.columns ?? 120;

  useEffect(() => {
    setSelectedIndex((current) => clampSelectedIndex(current, state.prs.length));
  }, [state.prs.length]);

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const refresh = async () => {
      try {
        let repos = activeReposRef.current;
        if (options.aggressiveMode) {
          const synced = await syncAggressiveRepos(options.configPath);
          if (synced.addedRepos.length > 0) {
            repos = [...new Set([...activeReposRef.current, ...synced.config.repos])];
            activeReposRef.current = repos;
            setActiveRepos(repos);
          }
        }

        const prs = await fetchPullRequests({
          repos,
          limit: options.limit,
        });
        if (!alive) {
          return;
        }

        const now = new Date();
        setState({
          prs,
          lastUpdated: now,
          nextRefresh: options.once ? undefined : new Date(now.getTime() + options.intervalMs),
          loading: false,
        });

        if (options.once) {
          setTimeout(exit, 25);
          return;
        }

        timer = setTimeout(refresh, options.intervalMs);
      } catch (error) {
        if (!alive) {
          return;
        }

        const message = error instanceof Error ? error.message : String(error);
        const now = new Date();
        setState({
          prs: [],
          lastUpdated: now,
          nextRefresh: options.once ? undefined : new Date(now.getTime() + options.intervalMs),
          error: message,
          loading: false,
        });

        if (options.once) {
          setTimeout(exit, 25);
          return;
        }

        timer = setTimeout(refresh, options.intervalMs);
      }
    };

    void refresh();

    return () => {
      alive = false;
      if (timer) {
        clearTimeout(timer);
      }
    };
  }, [exit, options]);

  const scope = activeRepos.length > 0 ? activeRepos.join(", ") : "all repos";
  const stats = collectStats(state.prs);
  const titleWidth = Math.max(24, columns - 52);

  return (
    <Box flexDirection="column" padding={1}>
      {isRawModeSupported ? (
        <KeyboardShortcuts selectedIndex={selectedIndex} prs={state.prs} setSelectedIndex={setSelectedIndex} />
      ) : null}
      <Box justifyContent="space-between" borderStyle="round" borderColor="cyan" paddingX={1}>
        <Text color="cyanBright">gh-mergeable</Text>
        <Text color="gray">{scope}</Text>
      </Box>

      <Box marginTop={1} justifyContent="space-between">
        <Text>
          <Text color="greenBright">{state.prs.length}</Text>
          <Text color="gray"> open PRs</Text>
        </Text>
        <Text color="gray">
          {state.loading ? "loading..." : `updated ${formatTimestamp(state.lastUpdated ?? new Date())}`}
        </Text>
      </Box>

      <Box marginTop={1} borderStyle="round" borderColor="gray" paddingX={1} flexDirection="column">
        <Box gap={2}>
          <Text color="green">MERGEABLE {stats.mergeable}</Text>
          <Text color="yellow">BLOCKED {stats.blocked}</Text>
          <Text color="redBright">FAILING {stats.failing}</Text>
          <Text color="magenta">BEHIND {stats.behind}</Text>
          <Text color="red">CONFLICT {stats.conflict}</Text>
          <Text color="blue">DRAFT {stats.draft}</Text>
          <Text color="cyan">PENDING {stats.pending}</Text>
        </Box>
        <Box justifyContent="space-between">
          <Text color="gray">
            {isRawModeSupported ? "Up/Down or j/k: select  Enter/Space/o: open  Ctrl+C: quit" : "Use Ctrl+C to quit"}
          </Text>
          <Text color="gray">
            next refresh {options.once ? "-" : formatTime(state.nextRefresh ?? new Date(Date.now() + options.intervalMs))}
          </Text>
        </Box>
      </Box>

      {state.error ? (
        <Box marginTop={1} borderStyle="round" borderColor="red" paddingX={1} flexDirection="column">
          <Text color="redBright">GitHub API error</Text>
          <Text>{state.error}</Text>
        </Box>
      ) : null}

      <Box marginTop={1} flexDirection="column">
        {state.prs.length === 0 && !state.loading ? (
          <Box borderStyle="round" borderColor="gray" paddingX={1}>
            <Text color="gray">No open PRs found.</Text>
          </Box>
        ) : null}

        {state.prs.map((pr, index) => {
          const summary = summarizeMergeability(pr);
          const approvers = listApprovers(pr);
          const failingChecks = listFailingChecks(pr);
          const isSelected = index === selectedIndex;
          return (
            <Box
              key={pr.url}
              marginBottom={1}
              borderStyle="round"
              borderColor={isSelected ? "white" : toneColor(summary.tone)}
              paddingX={1}
              flexDirection="column"
            >
              <Box justifyContent="space-between">
                <Text color={toneColor(summary.tone)}>
                  {isSelected ? ">" : " "} {summary.label.padEnd(9, " ")} {pr.repository.nameWithOwner}#{pr.number}
                </Text>
                <Text color="gray">{formatTime(pr.updatedAt)}</Text>
              </Box>
              <Text bold>{truncate(pr.title, titleWidth)}</Text>
              <Text color="gray">
                {pr.headRefName} -&gt; {pr.baseRefName} | review {pr.reviewDecision ?? "NONE"} | state {pr.mergeStateStatus}
              </Text>
              {approvers.length > 0 ? (
                <Text color="green">approved by {truncate(approvers.join(", "), columns - 18)}</Text>
              ) : null}
              {failingChecks.length > 0 ? (
                <Text color="redBright">failing checks: {truncate(failingChecks.join(", "), columns - 18)}</Text>
              ) : null}
              <Text color="cyan">{truncate(pr.url, columns - 6)}</Text>
            </Box>
          );
        })}
      </Box>
    </Box>
  );
}

async function main() {
  const command = parseArgs(process.argv.slice(2));

  if (command.command === "setup") {
    const result = await setupConfig(command.configPath);
    if (result.created) {
      console.log(`Created ${result.configPath}`);
      if (result.defaultRepo) {
        console.log(`Default repo: ${result.defaultRepo}`);
      }
    } else {
      console.log(`Config already exists: ${result.configPath}`);
    }
    return;
  }

  if (command.command === "config") {
    const result = await setupConfig(command.configPath);
    if (result.created) {
      console.log(`Created ${result.configPath}`);
      if (result.defaultRepo) {
        console.log(`Default repo: ${result.defaultRepo}`);
      }
    }

    const proc = Bun.spawn(getEditorCommand(result.configPath), {
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    });
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      process.exit(exitCode);
    }
    return;
  }

  const options = await resolveOptions(command);
  render(<App options={options} />, {
    exitOnCtrlC: true,
  });
}

if (import.meta.main) {
  await main();
}
