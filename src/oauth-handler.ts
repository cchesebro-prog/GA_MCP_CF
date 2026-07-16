/**
 * Implements the interactive part of the OAuth 2.1 authorization flow that
 * @cloudflare/workers-oauth-provider doesn't handle itself: the `/authorize`
 * login screen. Dynamic client registration (`/register`) and code-for-token
 * exchange (`/token`) are handled internally by OAuthProvider — this file
 * only needs to authenticate the human and call completeAuthorization().
 *
 * There's a single shared login password (MCP_LOGIN_PASSWORD) rather than
 * per-user accounts, since every caller ends up using the same GA service
 * account regardless of who logged in.
 */

import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";

export interface OAuthHandlerEnv {
  OAUTH_PROVIDER: OAuthHelpers;
  MCP_LOGIN_PASSWORD?: string;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    switch (char) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}

function loginPage(encodedRequest: string, clientName: string, error?: string): string {
  return `<!doctype html>
<html>
<head>
<title>Sign in - Google Analytics MCP</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  body { font-family: system-ui, -apple-system, sans-serif; max-width: 420px; margin: 15vh auto 0; padding: 0 20px; color: #1a1a1a; }
  h1 { font-size: 1.25rem; margin-bottom: 4px; }
  .client { color: #666; font-size: 0.9rem; margin-bottom: 24px; }
  input[type=password] { width: 100%; padding: 10px; font-size: 1rem; box-sizing: border-box; margin-bottom: 12px; border: 1px solid #ccc; border-radius: 6px; }
  button { width: 100%; padding: 10px; font-size: 1rem; cursor: pointer; border: 0; border-radius: 6px; background: #f38020; color: white; }
  .error { color: #b00020; margin-bottom: 12px; font-size: 0.9rem; }
</style>
</head>
<body>
  <h1>Google Analytics MCP</h1>
  <p class="client">"${escapeHtml(clientName)}" is requesting access to your GA4 data tools.</p>
  ${error ? `<p class="error">${escapeHtml(error)}</p>` : ""}
  <form method="POST">
    <input type="hidden" name="oauthReqInfo" value="${escapeHtml(encodedRequest)}">
    <input type="password" name="password" placeholder="Access password" autofocus required>
    <button type="submit">Sign in</button>
  </form>
</body>
</html>`;
}

export const oauthHandler = {
  async fetch(request: Request, env: OAuthHandlerEnv): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/authorize" && request.method === "GET") {
      const oauthReqInfo = await env.OAUTH_PROVIDER.parseAuthRequest(request);
      const clientInfo = await env.OAUTH_PROVIDER.lookupClient(oauthReqInfo.clientId);
      const encoded = btoa(JSON.stringify(oauthReqInfo));
      return new Response(loginPage(encoded, clientInfo?.clientName ?? oauthReqInfo.clientId), {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

    if (url.pathname === "/authorize" && request.method === "POST") {
      const form = await request.formData();
      const encoded = String(form.get("oauthReqInfo") ?? "");
      const password = String(form.get("password") ?? "");
      const oauthReqInfo = JSON.parse(atob(encoded));

      if (!env.MCP_LOGIN_PASSWORD) {
        return new Response(
          "MCP_LOGIN_PASSWORD secret is not configured on this Worker.",
          { status: 500 }
        );
      }
      if (password !== env.MCP_LOGIN_PASSWORD) {
        const clientInfo = await env.OAUTH_PROVIDER.lookupClient(oauthReqInfo.clientId);
        return new Response(
          loginPage(encoded, clientInfo?.clientName ?? oauthReqInfo.clientId, "Incorrect password. Try again."),
          { status: 401, headers: { "Content-Type": "text/html; charset=utf-8" } }
        );
      }

      const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
        request: oauthReqInfo,
        userId: "wigwam-analytics",
        metadata: {},
        scope: oauthReqInfo.scope,
        props: {},
      });

      return Response.redirect(redirectTo, 302);
    }

    if (url.pathname === "/" || url.pathname === "/health") {
      return new Response(
        "Google Analytics MCP server is running. Connect at /mcp (Streamable HTTP) or /sse (SSE).",
        { status: 200 }
      );
    }

    return new Response("Not found", { status: 404 });
  },
};
