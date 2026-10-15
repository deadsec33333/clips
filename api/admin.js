// Admin API. Every request needs the X-Admin-Secret header (ADMIN_SECRET in Vercel).
// GET  /api/admin?action=status|list
// POST /api/admin  { action, ... }
import { handler, send, body, db, must, env, requireAdmin, HttpError, siteUrl, clean } from "./_lib/core.js";
import { treasuryBalances, createClipsConfig, launchToken } from "./_lib/solana.js";

const CAMPAIGN_FIELDS = ["name", "ticker", "tagline", "image_url", "sky", "featured", "partner", "details", "badges", "creator_instagram", "creator_wallet",
  "video_url", "x_url", "telegram_url", "website_url", "token_mint", "pool_address", "status", "fee_pool_usd_override", "axiom_url", "gmgn_url"];

export default handler(["GET", "POST"], async (req, res) => {
  requireAdmin(req);
  const b = req.method === "POST" ? body(req) : {};
  const action = req.query?.action || b.action;

  if (action === "status") {
    const has = k => !!env(k);
    let treasury = null;
    try { treasury = await treasuryBalances(); } catch (e) { treasury = { error: e.message }; }
    const runs = await must(db().from("clips_runs").select("kind, dry_run, ok, summary, started_at, finished_at").order("started_at", { ascending: false }).limit(10), "runs");
    return send(res, 200, {
      config: {
        SUPABASE: has("SUPABASE_URL") && has("SUPABASE_SERVICE_ROLE_KEY"), APIFY_TOKEN: has("APIFY_TOKEN"), SOLANA_RPC_URL: has("SOLANA_RPC_URL"),
        TREASURY_SECRET_KEY: has("TREASURY_SECRET_KEY"), CLIPS_MINT: env("CLIPS_MINT") || null, DBC_CONFIG: env("DBC_CONFIG") || null,
        CRON_SECRET: has("CRON_SECRET"), SITE_URL: siteUrl(req), PAYOUTS_ENABLED: env("PAYOUTS_ENABLED") === "true",
        MIN_PAYOUT: env("MIN_PAYOUT", "1"), MAX_PAYOUT_PER_RUN: env("MAX_PAYOUT_PER_RUN", "0"), PLATFORM_FEE_BPS: env("PLATFORM_FEE_BPS", "0")
      },
      treasury, runs
    });
  }

  if (action === "list") {
    const [campaigns, clippers, clips, payouts] = await Promise.all([
      must(db().from("clips_campaigns").select("id, name, ticker, tagline, status, featured, image_url, creator_instagram, creator_wallet, video_url, token_mint, pool_address, axiom_url, gmgn_url, fee_pool_usd_override, fees_claimed::text, fees_allocated::text, fees_unclaimed::text, token_decimals, price_usd, created_at, launched_at").order("created_at", { ascending: false }), "campaigns"),
      must(db().from("clips_clippers").select("id, instagram, wallet, code, verified, bio_ok, last_bio_check, created_at").order("created_at", { ascending: false }).limit(300), "clippers"),
      must(db().from("clips_clips").select("id, campaign_id, url, views, status, reject_reason, last_checked, created_at, clips_clippers(instagram)").order("created_at", { ascending: false }).limit(300), "clips"),
      must(db().from("clips_payouts").select("id, campaign_id, amount::text, status, signature, error, created_at, sent_at, clips_clippers(instagram, wallet)").order("created_at", { ascending: false }).limit(300), "payouts")
    ]);
    campaigns.forEach(c => { if (c.image_url && c.image_url.startsWith("data:")) c.image_url = "(uploaded image)"; });
    return send(res, 200, { campaigns, clippers, clips, payouts });
  }

  if (action === "campaign-save") {
    const id = clean(b.id).toLowerCase();
    if (!/^[a-z0-9][a-z0-9-]{1,47}$/.test(id)) throw new HttpError(400, "The id must be lowercase letters, numbers and dashes.");
    const row = {};
    for (const k of CAMPAIGN_FIELDS) if (k in b) row[k] = b[k] === "" ? null : b[k];
    if (row.ticker) row.ticker = String(row.ticker).toUpperCase().replace(/^\$/, "");
    if (row.status === "live") row.launched_at = row.launched_at || new Date().toISOString();
    const exists = await must(db().from("clips_campaigns").select("id").eq("id", id), "campaign");
    if (exists.length) await must(db().from("clips_campaigns").update(row).eq("id", id), "campaign update");
    else {
      if (!row.name) throw new HttpError(400, "A new campaign needs a name.");
      await must(db().from("clips_campaigns").insert({ id, status: "pending", ...row }), "campaign insert");
    }
    return send(res, 200, { ok: true, id });
  }

  if (action === "launch") {
    const c = (await must(db().from("clips_campaigns").select("*").eq("id", clean(b.id)), "campaign"))[0];
    if (!c) throw new HttpError(404, "Campaign not found.");
    if (c.token_mint) throw new HttpError(409, "This campaign already has a token.");
    if (!c.ticker) throw new HttpError(400, "Set a ticker before launching.");
    const out = await launchToken({ name: c.name, symbol: c.ticker, uri: `${siteUrl(req)}/api/meta?id=${encodeURIComponent(c.id)}` });
    await must(db().from("clips_campaigns").update({ token_mint: out.mint, pool_address: out.pool, status: "live", launched_at: new Date().toISOString() }).eq("id", c.id), "campaign update");
    return send(res, 200, { ok: true, ...out });
  }

  if (action === "setup-config") {
    if (env("DBC_CONFIG") && !b.force) throw new HttpError(409, "DBC_CONFIG is already set. Only create a new config if you mean to change the curve for future launches.");
    const initialMarketCap = Number(b.initialMarketCap), migrationMarketCap = Number(b.migrationMarketCap);
    if (!(initialMarketCap > 0) || !(migrationMarketCap > initialMarketCap)) throw new HttpError(400, "The graduation market cap must be higher than the starting market cap.");
    const feeBps = Math.round(Number(b.feeBps) || 100);
    if (feeBps < 25 || feeBps > 1000) throw new HttpError(400, "The trading fee must be between 0.25% and 10%.");
    const out = await createClipsConfig({ initialMarketCap, migrationMarketCap, feeBps });
    return send(res, 200, { ok: true, ...out, next: `Add DBC_CONFIG=${out.config} in Vercel, then redeploy.` });
  }

  if (action === "clip-save") {
    const row = {};
    if (b.status) { if (!["ok", "pending", "rejected"].includes(b.status)) throw new HttpError(400, "Bad status."); row.status = b.status; row.reject_reason = b.status === "rejected" ? (clean(b.reason) || "rejected by admin") : null; }
    if (b.views != null) { const v = Math.floor(Number(b.views)); if (!(v >= 0)) throw new HttpError(400, "Views must be a number."); row.views = v; }
    await must(db().from("clips_clips").update(row).eq("id", clean(b.id)), "clip update");
    return send(res, 200, { ok: true });
  }

  if (action === "clipper-save") {
    const row = {};
    if (typeof b.verified === "boolean") { row.verified = b.verified; row.verified_at = b.verified ? new Date().toISOString() : null; }
    if (b.wallet) { if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(b.wallet)) throw new HttpError(400, "Bad wallet."); row.wallet = b.wallet; }
    await must(db().from("clips_clippers").update(row).eq("id", clean(b.id)), "clipper update");
    return send(res, 200, { ok: true });
  }

  if (action === "payout-resolve") {
    // After checking a "failed" payout on Solscan: mark it sent (it landed) or owed (pay again).
    if (!["sent", "owed"].includes(b.status)) throw new HttpError(400, "Status must be sent or owed.");
    const patch = b.status === "sent" ? { status: "sent", sent_at: new Date().toISOString(), error: null } : { status: "owed", signature: null, last_valid_block_height: null, sent_at: null };
    await must(db().from("clips_payouts").update(patch).eq("id", clean(b.id)).in("status", ["failed", "sending"]), "payout update");
    return send(res, 200, { ok: true });
  }

  throw new HttpError(400, "Unknown action.");
});
