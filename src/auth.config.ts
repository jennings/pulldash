// GitHub OAuth App Client ID.
// Set this alongside GITHUB_CLIENT_SECRET to enable the
// "Sign in with GitHub" (web flow) button.
// Can be configured via the GITHUB_CLIENT_ID environment variable, or
// by editing the fallback value below.
// Create an OAuth App at https://github.com/settings/developers/apps
// with callback URL set to <your-pulldash-url>/api/auth/callback.
// Only users who run the server need this — PAT auth works without it.
export const GITHUB_CLIENT_ID = process.env.GITHUB_CLIENT_ID ?? "FIXME";
