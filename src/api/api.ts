import { Hono } from "hono";
import { GITHUB_CLIENT_ID } from "../auth.config";

// ============================================================================
// API Routes
// ============================================================================

const api = new Hono()
  .basePath("/api")

  // Device Authorization - Step 1: Request device code
  // Proxies to GitHub since their endpoint doesn't support CORS
  .post("/auth/device/code", async (c) => {
    try {
      const response = await fetch("https://github.com/login/device/code", {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          client_id: GITHUB_CLIENT_ID,
          scope: "repo read:user",
        }),
      });

      if (!response.ok) {
        const error = await response.text();
        return c.json(
          { error: "Failed to initiate device authorization", details: error },
          500
        );
      }

      const data = await response.json();
      return c.json(data);
    } catch (err) {
      return c.json({ error: (err as Error).message }, 500);
    }
  })

  // Device Authorization - Step 2: Poll for access token
  .post("/auth/device/token", async (c) => {
    try {
      const body = await c.req.json();
      const { device_code } = body;

      if (!device_code) {
        return c.json({ error: "device_code is required" }, 400);
      }

      const response = await fetch(
        "https://github.com/login/oauth/access_token",
        {
          method: "POST",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            client_id: GITHUB_CLIENT_ID,
            device_code,
            grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          }),
        }
      );

      if (!response.ok) {
        const error = await response.text();
        return c.json(
          { error: "Failed to get access token", details: error },
          500
        );
      }

      const data = await response.json();
      return c.json(data);
    } catch (err) {
      return c.json({ error: (err as Error).message }, 500);
    }
  })

  // Auth config: returns which flows are available
  .get("/auth/config", (c) => {
    const clientSecret = process.env.GITHUB_CLIENT_SECRET ?? "";
    return c.json({
      flows: [
        "pat",
        ...(GITHUB_CLIENT_ID !== "FIXME" ? ["device"] : []),
        ...(GITHUB_CLIENT_ID !== "FIXME" && clientSecret ? ["web"] : []),
      ],
      clientId: GITHUB_CLIENT_ID,
    });
  })

  // OAuth web flow: exchange authorization code for tokens
  .post("/auth/callback", async (c) => {
    try {
      const { code, code_verifier } = await c.req.json();
      const clientSecret = process.env.GITHUB_CLIENT_SECRET ?? "";

      if (!code) {
        return c.json({ error: "code is required" }, 400);
      }

      const body: Record<string, string> = {
        client_id: GITHUB_CLIENT_ID,
        client_secret: clientSecret,
        code,
      };
      if (code_verifier) body.code_verifier = code_verifier;

      const response = await fetch(
        "https://github.com/login/oauth/access_token",
        {
          method: "POST",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
        }
      );

      const data = await response.json();
      return c.json(data);
    } catch (err) {
      return c.json({ error: (err as Error).message }, 500);
    }
  })

  // OAuth web flow: GitHub redirects here after authorization.
  // Redirects to the SPA which handles the code exchange with PKCE.
  .get("/auth/callback", async (c) => {
    const code = c.req.query("code") || "";
    const error = c.req.query("error") || "";
    const errorDescription = c.req.query("error_description") || "";

    if (error) {
      return c.redirect(
        `/?auth_error=${encodeURIComponent(errorDescription || error)}`,
        302
      );
    }

    return c.redirect(`/?code=${encodeURIComponent(code)}`, 302);
  })

  // OAuth web flow: refresh an expired access token
  .post("/auth/refresh", async (c) => {
    try {
      const { refresh_token } = await c.req.json();
      const clientSecret = process.env.GITHUB_CLIENT_SECRET ?? "";

      if (!refresh_token) {
        return c.json({ error: "refresh_token is required" }, 400);
      }

      const response = await fetch(
        "https://github.com/login/oauth/access_token",
        {
          method: "POST",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            client_id: GITHUB_CLIENT_ID,
            client_secret: clientSecret,
            refresh_token,
            grant_type: "refresh_token",
          }),
        }
      );

      const data = await response.json();
      return c.json(data);
    } catch (err) {
      return c.json({ error: (err as Error).message }, 500);
    }
  });

export default api;
export type AppType = typeof api;
