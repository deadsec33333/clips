// Shared helpers for every Clips API function.
import { createClient } from "@supabase/supabase-js";
import { PublicKey } from "@solana/web3.js";

export const env = (k, d = "") => (process.env[k] ?? d).toString().trim();

let _db;
export function db() {
  if (_db) return _db;
  const url = env("SUPABASE_URL"), key = env("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) throw new HttpError(503, "The database is not configured yet.");
  _db = createClient(url, key, { auth: { persistSession: false } });
  return _db;
}

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export function send(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(body));
}

// Wrap a handler: method check, JSON errors, CORS for same-site use.
export function handler(methods, fn) {
  return async (req, res) => {
    res.setHeader("Access-Control-Allow-Origin", env("SITE_URL") || "*");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Admin-Secret");
    res.setHeader("Access-Control-Allow-Methods", methods.join(", ") + ", OPTIONS");
    if (req.method === "OPTIONS") return send(res, 204, {});
    if (!methods.includes(req.method)) return send(res, 405, { error: "Method not allowed." });
    try {
      await fn(req, res);
    } catch (e) {
      const status = e.status || 500;
      if (status >= 500) console.error(e);
      send(res, status, { error: status >= 500 && !(e instanceof HttpError) ? "Something went wrong. Try again in a minute." : e.message });
    }
  };
}

export function body(req) {
  const b = req.body;
  if (!b) return {};
  if (typeof b === "string") { try { return JSON.parse(b); } catch { throw new HttpError(400, "The request body is not valid JSON."); } }
  return b;
}

export const clean = s => (s ?? "").toString().trim();

export function normInstagram(v) {
  let s = clean(v).toLowerCase();
  const m = s.match(/instagram\.com\/([a-z0-9._]+)/);
  if (m) s = m[1];
  s = s.replace(/^@/, "").replace(/\/+$/, "");
  if (!/^[a-z0-9._]{1,30}$/.test(s)) throw new HttpError(400, "Enter a valid Instagram username, for example @yourname.");
  return s;
}

export function normWallet(v) {
  const s = clean(v);
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s)) throw new HttpError(400, "Enter a valid Solana wallet address.");
  let ok = false;
  try { ok = PublicKey.isOnCurve(new PublicKey(s).toBytes()); } catch { ok = false; }
  if (!ok) throw new HttpError(400, "That looks like a token account, not a wallet. Paste your main wallet address from Phantom or another wallet app.");
  return s;
}

// Reel or post URL -> shortcode.
export function reelShortcode(url) {
  const m = clean(url).match(/instagram\.com\/(?:[a-z0-9._]+\/)?(?:reel|reels|p|tv)\/([A-Za-z0-9_-]{5,20})/i);
  if (!m) throw new HttpError(400, "Paste a link to an Instagram Reel, for example https://www.instagram.com/reel/ABC123/.");
  return m[1];
}

export function randomCode(len = 8) {
  const a = "abcdefghjkmnpqrstuvwxyz23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  return [...bytes].map(b => a[b % a.length]).join("");
}

export function siteUrl(req) {
  const s = env("SITE_URL");
  if (s) return s.replace(/\/+$/, "");
  const host = req?.headers?.["x-forwarded-host"] || req?.headers?.host || "localhost:3000";
  return `https://${host}`;
}

export function requireAdmin(req) {
  const want = env("ADMIN_SECRET");
  const got = req.headers["x-admin-secret"] || "";
  if (!want || want.length < 12) throw new HttpError(503, "Set ADMIN_SECRET (at least 12 characters) in Vercel first.");
  if (!timingSafeEqual(got, want)) throw new HttpError(401, "Wrong admin password.");
}

export function requireCron(req) {
  const secret = env("CRON_SECRET");
  const auth = req.headers.authorization || "";
  if (secret && timingSafeEqual(auth, `Bearer ${secret}`)) return;
  // The admin page can also trigger cron jobs.
  requireAdmin(req);
}

function timingSafeEqual(a, b) {
  a = String(a); b = String(b);
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

export async function must(promise, what = "database") {
  const { data, error } = await promise;
  if (error) { console.error(what, error); throw new HttpError(500, `The ${what} request failed.`); }
  return data;
}
