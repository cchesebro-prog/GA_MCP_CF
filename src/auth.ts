/**
 * Mints Google OAuth2 access tokens from a service-account key using the
 * JWT-bearer grant (RFC 7523), signed with the Workers Web Crypto API.
 * This replaces what the original Python server got for free from
 * `google.auth.default()` / ADC, which isn't available in a Worker.
 */

const SCOPE = "https://www.googleapis.com/auth/analytics.readonly";
const TOKEN_URI = "https://oauth2.googleapis.com/token";

interface ServiceAccountKey {
  client_email: string;
  private_key: string;
  token_uri?: string;
}

interface CachedToken {
  accessToken: string;
  expiresAt: number; // epoch ms
}

let cached: CachedToken | null = null;
let inFlight: Promise<string> | null = null;

function base64UrlEncode(bytes: ArrayBuffer | Uint8Array): string {
  const bytesArr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = "";
  for (const b of bytesArr) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlEncodeString(input: string): string {
  return base64UrlEncode(new TextEncoder().encode(input));
}

function pemToArrayBuffer(pem: string): ArrayBuffer {
  const contents = pem
    .replace(/-----BEGIN PRIVATE KEY-----/, "")
    .replace(/-----END PRIVATE KEY-----/, "")
    .replace(/\s+/g, "");
  const binary = atob(contents);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

async function signJwt(key: ServiceAccountKey): Promise<string> {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const claimSet = {
    iss: key.client_email,
    scope: SCOPE,
    aud: key.token_uri ?? TOKEN_URI,
    iat: nowSeconds,
    exp: nowSeconds + 3600,
  };

  const unsigned = `${base64UrlEncodeString(JSON.stringify(header))}.${base64UrlEncodeString(
    JSON.stringify(claimSet)
  )}`;

  const cryptoKey = await crypto.subtle.importKey(
    "pkcs8",
    pemToArrayBuffer(key.private_key),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    cryptoKey,
    new TextEncoder().encode(unsigned)
  );

  return `${unsigned}.${base64UrlEncode(signature)}`;
}

async function fetchAccessToken(rawKey: string): Promise<string> {
  let key: ServiceAccountKey;
  try {
    key = JSON.parse(rawKey);
  } catch {
    throw new Error(
      "GA_SERVICE_ACCOUNT_KEY is not valid JSON. Store the full service account key file contents as the secret."
    );
  }
  if (!key.client_email || !key.private_key) {
    throw new Error(
      "GA_SERVICE_ACCOUNT_KEY is missing client_email or private_key fields."
    );
  }

  const assertion = await signJwt(key);
  const tokenUri = key.token_uri ?? TOKEN_URI;

  const res = await fetch(tokenUri, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Failed to obtain Google access token (${res.status}): ${body}`);
  }

  const json = (await res.json()) as { access_token: string; expires_in: number };
  cached = {
    accessToken: json.access_token,
    // Refresh a minute early to avoid edge-of-expiry failures.
    expiresAt: Date.now() + (json.expires_in - 60) * 1000,
  };
  return cached.accessToken;
}

/** Returns a valid access token, reusing a cached one for this isolate when possible. */
export async function getAccessToken(rawKey: string): Promise<string> {
  if (cached && cached.expiresAt > Date.now()) {
    return cached.accessToken;
  }
  if (!inFlight) {
    inFlight = fetchAccessToken(rawKey).finally(() => {
      inFlight = null;
    });
  }
  return inFlight;
}
