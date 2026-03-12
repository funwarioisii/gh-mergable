# gh-mergeable

`gh-mergeable` is a Bun CLI that watches open pull requests you authored or are assigned to you and shows whether they are mergeable.

The default refresh interval is 10 seconds. PRs are sorted with `MERGEABLE`, then `BLOCKED`, then `DRAFT`, then the rest, and failed CI checks are shown explicitly.

## Setup

```bash
mise run setup
gh auth status
```

`mise run setup` installs dependencies, builds, links the CLI, and creates a default config at:

```bash
~/.config/gh-mergeable/config.ts
```

If `XDG_CONFIG_HOME` is set, that directory is used instead. The generated config defaults to the repository where you most recently opened a PR.

You can also create the config directly:

```bash
bun run index.tsx setup
```

Or install with Bun only:

```bash
bun install
bun run build
bun link
bun run index.tsx setup
```

## Config

Example config:

```ts
export default {
  repos: [
    "heyinc/bongo",
    "heyinc/rt-rails",
  ],
  intervalSec: 10,
  limit: 30,
};
```

See [config.example.ts](/Users/wako/ghq/github.com/funwarioisii/gh-mergeable/config.example.ts).

## Run

Watch all configured PRs:

```bash
gh-mergeable
```

Fetch once and exit:

```bash
gh-mergeable --once
```

Add repo filters on top of config:

```bash
gh-mergeable --repo heyinc/bongo --repo heyinc/rt-rails
```

Change the refresh interval:

```bash
gh-mergeable --interval 30
```

Load a config file from another path:

```bash
gh-mergeable --config ~/dotfiles/gh-mergeable/config.ts
```

The terminal UI is built with Ink and refreshes in place.

## Test

```bash
bun test
mise run test
```
