/**
 * Password hashing + JWT helpers.
 *
 * Why bcryptjs (pure JS) and not a native binding:
 *   Workers don't let us ship native modules. bcryptjs runs in Wasm-friendly
 *   pure JS — about 200ms per hash at 12 rounds on Workers isolates, which is
 *   fine at login frequency (~dozens/day for a 5-10 user deployment).
 *
 * Why we roll our own tiny JWT instead of using hono/jwt:
 *   We only need HS256 sign + verify, and hono/jwt's base64url handling pulls
 *   Buffer in some code paths. Doing it directly against SubtleCrypto keeps
 *   the runtime deps minimal and behaviour identical between local dev (Node
 *   compat shims) and production (V8 isolates).
 */
import bcrypt from 'bcryptjs';

// -----------------------------------------------------------------------------
// Password hashing
// -----------------------------------------------------------------------------

/**
 * 12 rounds is the current OWASP floor. Bump to 13 when average Worker CPU
 * budget allows (right now 12 keeps us well under the 30s CPU wall).
 */
const BCRYPT_ROUNDS = 12;

export async function hashPassword(plain: string): Promise<string> {
  if (plain.length < 8) {
    throw new Error('password must be at least 8 characters');
  }
  return bcrypt.hash(plain, BCRYPT_ROUNDS);
}

/**
 * Always runs the bcrypt compare, even when the user doesn't exist. The caller
 * passes a dummy hash in that case so total time is constant regardless of
 * whether the email is registered — basic timing side-channel defense.
 */
export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

/**
 * A pre-computed bcrypt hash of the string "dummy-password-for-timing-safety".
 * Used when the user lookup returns nothing, so verifyPassword still runs and
 * the response time doesn't leak account existence.
 *
 * If you regenerate this, keep the rounds parameter matching BCRYPT_ROUNDS.
 */
export const DUMMY_BCRYPT_HASH =
  '$2a$12$CwTycUXWue0Thq9StjUM0uJ8J9bNz5i4mQ8VQf9rHn4J9Y5mL5wYq';

// -----------------------------------------------------------------------------
// JWT (HS256)
// -----------------------------------------------------------------------------

export interface JWTPayload {
  sub: number; // user id
  email: string;
  role: 'admin' | 'user';
  iat: number; // issued at, seconds
  exp: number; // expires at, seconds
  iss: string; // issuer, from env
}

const TOKEN_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days

function base64UrlEncode(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function base64UrlEncodeString(str: string): string {
  return base64UrlEncode(new TextEncoder().encode(str));
}

function base64UrlDecodeToBytes(input: string): Uint8Array {
  const padded = input.replace(/-/g, '+').replace(/_/g, '/') +
    '==='.slice((input.length + 3) % 4);
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function base64UrlDecodeToString(input: string): string {
  return new TextDecoder().decode(base64UrlDecodeToBytes(input));
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

/**
 * Mint a JWT. `user` is what we know from the users table row; iat/exp/iss are
 * filled in here so callers never have to think about time math.
 */
export async function signToken(
  user: { id: number; email: string; role: 'admin' | 'user' },
  secret: string,
  issuer: string,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const payload: JWTPayload = {
    sub: user.id,
    email: user.email,
    role: user.role,
    iat: now,
    exp: now + TOKEN_TTL_SECONDS,
    iss: issuer,
  };

  const headerB64 = base64UrlEncodeString(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payloadB64 = base64UrlEncodeString(JSON.stringify(payload));
  const signingInput = `${headerB64}.${payloadB64}`;

  const key = await hmacKey(secret);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(signingInput));
  const sigB64 = base64UrlEncode(new Uint8Array(sig));

  return `${signingInput}.${sigB64}`;
}

/**
 * Verify + decode a JWT. Returns the payload on success, throws on any
 * mismatch (bad signature, expired, wrong issuer). Callers should catch and
 * map to 401.
 */
export async function verifyToken(
  token: string,
  secret: string,
  expectedIssuer: string,
): Promise<JWTPayload> {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('malformed token');

  const [headerB64, payloadB64, sigB64] = parts;
  const signingInput = `${headerB64}.${payloadB64}`;

  const key = await hmacKey(secret);
  const ok = await crypto.subtle.verify(
    'HMAC',
    key,
    base64UrlDecodeToBytes(sigB64),
    new TextEncoder().encode(signingInput),
  );
  if (!ok) throw new Error('bad signature');

  const payload = JSON.parse(base64UrlDecodeToString(payloadB64)) as JWTPayload;

  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== 'number' || payload.exp < now) {
    throw new Error('token expired');
  }
  if (payload.iss !== expectedIssuer) {
    throw new Error('wrong issuer');
  }
  if (typeof payload.sub !== 'number') {
    throw new Error('malformed payload');
  }

  return payload;
}
