<h1>
  <img src="src/browser/logo.svg" alt="pulldash logo" width="40" height="40" align="center">
  Pulldash
</h1>

![GitHub Release](https://img.shields.io/github/v/release/jennings/pulldash) ![GitHub License](https://img.shields.io/github/license/jennings/pulldash) ![GitHub Actions Workflow Status](https://img.shields.io/github/actions/workflow/status/jennings/pulldash/ci.yml)

Fast, filterable PR review. Entirely client-side.

> [!WARNING]
> Pulldash is WIP. Expect bugs.

## Try It

**Browser**: [pr.jennings.io](https://pr.jennings.io). Open pull requests at `https://pr.jennings.io/<owner>/<repo>/pull/<number>`.

[![Example](./docs/screenshots/overview.png)](https://pr.jennings.io)

## Features

- **Custom filters**: Add repos and filter by review requests, authored PRs, or all activity.

  ![Filtering PRs](./docs/screenshots/filtering.png)

- **Keyboard-driven**: `j`/`k` to navigate files, arrows for lines, `c` to comment, `s` to submit.

  ![Keybinds](./docs/screenshots/keybind-driven.png)

- **Fast file search**: `Ctrl+K` to fuzzy-find across hundreds of changed files.

  ![Search](./docs/screenshots/search.png)

## Why

- GitHub's review UI is slow (especially for large diffs)
- No central view to filter PRs you care about
- AI tooling has produced more PRs than ever before—making a snappy review UI essential

## How It Works

GitHub's API supports [CORS](https://docs.github.com/en/rest/using-the-rest-api/using-cors-and-jsonp-to-make-cross-origin-requests), so Pulldash runs entirely client-side. No backend proxying your requests.

- **Web Worker pool**: Diff parsing and syntax highlighting run in workers sized to `navigator.hardwareConcurrency`. The main thread stays free for scrolling.

- **Pre-computed navigation**: When a diff loads, we index all navigable lines. Arrow keys are O(1)—no DOM queries.

- **External store**: State lives outside React ([`useSyncExternalStore`](https://react.dev/reference/react/useSyncExternalStore)). Focusing line 5000 doesn't re-render the file tree.

- **Virtualized rendering**: Diffs, file lists, and the command palette only render visible rows.

## Setup (self-hosted)

### 1. Choose the application type

| App type       | Flow   | Server config            | Token storage                                           |
| -------------- | ------ | ------------------------ | ------------------------------------------------------- |
| **PAT**        | —      | Static                   | `localStorage`                                          |
| **OAuth App**  | Device | `GITHUB_CLIENT_ID`       | `localStorage`                                          |
|                | Web    | + `GITHUB_CLIENT_SECRET` | `localStorage`                                          |
| **GitHub App** | Device | `GITHUB_CLIENT_ID`       | Access token in memory, refresh token in `localStorage` |
|                | Web    | + `GITHUB_CLIENT_SECRET` | Access token in memory, refresh token in `localStorage` |

**PAT** — The user generates a [classic GitHub PAT](https://github.com/settings/tokens) on github and paste it in the UI.

Use the `repo` scope for private repos, or `public_repo` for public repos only.

Only a static server is required.

**Device flow** — The user is presented with a code to copy/paste on github.

No client secret needed. The device flow is ideal for admins who don't want to manage a client secret.

**Web flow** — The user is redirected to github to authorize the application.

Requires a client secret on the server.

The token storage depends on the application type (OAuth App vs GitHub App), not on the flow.

### 2. Create an application

**PAT** — No setup needed.

**OAuth App (device flow)**

1. Go to **GitHub Settings → Developer settings → [New OAuth App](https://github.com/settings/applications/new)**
2. Fill in:
   - **Application name**: `pulldash` (or any name)
   - **Homepage URL**: your pulldash URL (e.g. `http://localhost:3002`)
   - **Authorization callback URL**: `{your-url}/api/auth/callback` (e.g. `http://localhost:3002/api/auth/callback`)
   - **Enable Device Flow**: check this box
3. Click **Register application**
4. Copy the **Client ID**

**OAuth App (web flow)**

1. Go to **GitHub Settings → Developer settings → [New OAuth App](https://github.com/settings/applications/new)**
2. Fill in:
   - **Application name**: `pulldash` (or any name)
   - **Homepage URL**: your pulldash URL (e.g. `http://localhost:3002`)
   - **Authorization callback URL**: `{your-url}/api/auth/callback` (e.g. `http://localhost:3002/api/auth/callback`)
3. Click **Register application**
4. Copy the **Client ID**
5. Generate a **Client Secret** and copy it

**GitHub App (recommended)**

Use the creation script:

```bash
bun run scripts/create-github-app.ts
```

It will ask for your pulldash URL, open a pre-configured GitHub App creation
page, and print the environment variables to set on your server.

GitHub Apps also support the device flow — after creation, go to the app's
settings page and check **Enable Device Flow**.

### 3. Run the server

**PAT**

Just serve the files with you preferred web server.

**Device flow**

```bash
export GITHUB_CLIENT_ID=your_client_id
bun run src/node/main.ts
```

**Web flow**

```bash
export GITHUB_CLIENT_ID=your_client_id
export GITHUB_CLIENT_SECRET=your_secret
bun run src/node/main.ts
```

The frontend fetches the Client ID and available flows from the
server's `GET /api/auth/config` endpoint at runtime — no rebuild
needed when changing the OAuth App configuration.

## Development

```bash
bun install
bun dev
```

Then open `http://localhost:3002` (or the next available port if 3002 is in use).

To run the server without the build watcher:

```bash
bun run build:browser
bun run src/node/main.ts
```

## License

[AGPL](./LICENSE)
