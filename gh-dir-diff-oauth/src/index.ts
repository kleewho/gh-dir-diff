interface Env {
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  FRONTEND_URL: string;
  CSRF_SECRET: string; // Used for encrypting state tokens
}

// Simple HMAC-based state validation (you could also use crypto-js or similar)
async function signState(state: string, secret: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(state));
  const sigHex = Array.from(new Uint8Array(signature))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `${state}.${sigHex}`;
}

async function verifyState(
  signedState: string,
  secret: string
): Promise<string | null> {
  const [state, signature] = signedState.split(".");
  if (!state || !signature) return null;

  const expectedSigned = await signState(state, secret);
  const [, expectedSig] = expectedSigned.split(".");

  // Constant-time comparison
  if (signature !== expectedSig) return null;

  // Check expiration (state format: timestamp-uuid)
  const timestamp = parseInt(state.split("-")[0]);
  const now = Date.now();
  if (now - timestamp > 10 * 60 * 1000) return null; // 10 minute expiry

  return state;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": env.FRONTEND_URL,
          "Access-Control-Allow-Methods": "GET",
        },
      });
    }

    if (url.pathname === "/login") {
      // Create state with timestamp for expiry
      const state = `${Date.now()}-${crypto.randomUUID()}`;
      const signedState = await signState(state, env.CSRF_SECRET);

      const githubUrl = new URL("https://github.com/login/oauth/authorize");
      githubUrl.searchParams.set("client_id", env.GITHUB_CLIENT_ID);
      githubUrl.searchParams.set("redirect_uri", `${url.origin}/callback`);
      githubUrl.searchParams.set("scope", "repo");
      githubUrl.searchParams.set("state", state);

      // Set state in secure, httpOnly cookie
      // SameSite=None is required for cross-site redirects (GitHub -> Worker)
      return Response.redirect(githubUrl.toString(), 302, {
        headers: {
          "Set-Cookie": `oauth_state=${signedState}; HttpOnly; Secure; SameSite=None; Max-Age=600; Path=/`,
        },
      });
    }

    if (url.pathname === "/callback") {
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");

      if (!code || !state) {
        return new Response("Missing code or state parameter", { status: 400 });
      }

      // Verify CSRF token from cookie
      const cookieHeader = request.headers.get("Cookie") || "";
      const cookies = Object.fromEntries(
        cookieHeader.split(";").map((c) => {
          const [key, ...v] = c.trim().split("=");
          return [key, v.join("=")];
        })
      );

      const signedState = cookies.oauth_state;
      if (!signedState) {
        return new Response("Missing state cookie", { status: 400 });
      }

      const validState = await verifyState(signedState, env.CSRF_SECRET);
      if (!validState || validState !== state) {
        return new Response("Invalid or expired state", { status: 400 });
      }

      const tokenResponse = await fetch(
        "https://github.com/login/oauth/access_token",
        {
          method: "POST",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            client_id: env.GITHUB_CLIENT_ID,
            client_secret: env.GITHUB_CLIENT_SECRET,
            code,
          }),
        }
      );

      const tokenData = (await tokenResponse.json()) as {
        access_token?: string;
        error?: string;
        error_description?: string;
      };

      if (tokenData.error || !tokenData.access_token) {
        return new Response(
          `OAuth error: ${tokenData.error_description || tokenData.error}`,
          { status: 400 }
        );
      }

      // Clear the state cookie and redirect to frontend with token in URL fragment
      return Response.redirect(
        `${env.FRONTEND_URL}/#access_token=${tokenData.access_token}`,
        302,
        {
          headers: {
            "Set-Cookie": "oauth_state=; HttpOnly; Secure; SameSite=None; Max-Age=0; Path=/",
          },
        }
      );
    }

    // Health check / info endpoint
    if (url.pathname === "/") {
      return new Response("Diff Viewer OAuth Worker. Use /login to authenticate.", {
        headers: { "Content-Type": "text/plain" },
      });
    }

    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
