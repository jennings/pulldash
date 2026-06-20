#!/usr/bin/env bun

const PULLDASH_URL_DEFAULT = "http://localhost:3002";

let pulldashUrl: string;
try {
  const input = prompt(`Enter your pulldash URL (${PULLDASH_URL_DEFAULT}): `);
  pulldashUrl = input?.trim() || PULLDASH_URL_DEFAULT;
} catch {
  pulldashUrl = PULLDASH_URL_DEFAULT;
}

const server = Bun.serve({
  port: 0,
  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const suffix = Math.floor(Math.random() * 1000);
    const localUrl = `http://localhost:${server.port}`;

    if (url.pathname === "/") {
      const manifest = {
        name: `pulldash-instance-${suffix}`,
        url: pulldashUrl,
        redirect_url: `${localUrl}/api/auth/callback`,
        callback_urls: [`${localUrl}/api/auth/callback`],
        public: false,
        request_oauth_on_install: true,
        default_permissions: {
          pull_requests: "write",
          contents: "read",
        },
      };

      return new Response(
        `<!DOCTYPE html>
<html>
  <body>
    <h2>Setting up your Pulldash Client...</h2>
    <form id="ghForm" action="https://github.com/settings/apps/new" method="post">
      <input type="hidden" name="manifest" value='${JSON.stringify(manifest)}'>
    </form>
    <script>document.getElementById("ghForm").submit();</script>
  </body>
</html>`,
        { headers: { "Content-Type": "text/html" } }
      );
    }

    if (url.pathname === "/api/auth/callback") {
      const code = url.searchParams.get("code");

      if (!code) {
        return new Response("Missing setup code from GitHub.", { status: 400 });
      }

      try {
        const response = await fetch(
          `https://api.github.com/app-manifests/${code}/conversions`,
          {
            method: "POST",
            headers: { Accept: "application/vnd.github+json" },
          }
        );

        const appCredentials = await response.json();

        console.log("\n✅ Successfully Configured GitHub App!\n");
        console.log("Set these environment variables on your server:");
        console.log(`  export GITHUB_CLIENT_ID=${appCredentials.client_id}`);
        console.log(
          `  export GITHUB_CLIENT_SECRET=${appCredentials.client_secret}`
        );
        console.log(
          "\nSave these for future use (not yet consumed by pulldash):"
        );
        console.log(`  App ID: ${appCredentials.id}`);
        console.log(`  Private Key:\n${appCredentials.pem}`);

        setTimeout(() => {
          server.stop();
          process.exit(0);
        }, 100);

        return new Response(
          "<h3>App configured successfully! You can close this tab and return to your terminal.</h3>",
          { headers: { "Content-Type": "text/html" } }
        );
      } catch (err) {
        return new Response(
          "Error converting manifest: " + (err as Error).message,
          { status: 500 }
        );
      }
    }

    return new Response("Not found", { status: 404 });
  },
});

const localUrl = `http://localhost:${server.port}`;
console.log(`Setup server active at ${localUrl}`);

async function openBrowser(url: string) {
  try {
    switch (process.platform) {
      case "darwin":
        await Bun.$`open ${url}`.quiet();
        break;
      case "win32":
        await Bun.$`start ${url}`.quiet();
        break;
      default:
        await Bun.$`xdg-open ${url}`.quiet();
    }
  } catch {
    // browser open not available
  }
}

await openBrowser(localUrl);

export {};
