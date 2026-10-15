// GET  /api/campaigns          live campaigns with leaderboards (what the site shows)
// POST /api/campaigns          anyone submits a new campaign; it waits for admin approval
import { handler, send, body, db, must, clean, normInstagram, normWallet, HttpError, siteUrl } from "./_lib/core.js";
import { liveCampaigns } from "./_lib/campaigns.js";

export default handler(["GET", "POST"], async (req, res) => {
  if (req.method === "GET") {
    res.setHeader("Cache-Control", "public, s-maxage=30, stale-while-revalidate=120");
    const campaigns = await liveCampaigns(siteUrl(req));
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    return res.end(JSON.stringify({ campaigns, updated: new Date().toISOString() }));
  }

  const b = body(req);
  const name = clean(b.name);
  if (name.length < 2 || name.length > 32) throw new HttpError(400, "The name must be 2 to 32 characters.");
  const ticker = clean(b.ticker).toUpperCase().replace(/^\$/, "");
  if (!/^[A-Z0-9]{2,10}$/.test(ticker)) throw new HttpError(400, "The ticker must be 2 to 10 letters or numbers.");
  const tagline = clean(b.tagline).slice(0, 140);
  const image = clean(b.image);
  if (image && !/^data:image\/(png|jpe?g|webp|gif);base64,/.test(image) && !/^https:\/\//.test(image)) throw new HttpError(400, "The image must be a PNG, JPG, WEBP or GIF.");
  if (image.length > 700000) throw new HttpError(400, "The image is too large. Use one under 500 KB.");
  const creator = normInstagram(b.instagram);
  const wallet = b.wallet ? normWallet(b.wallet) : null;
  const url = v => { const s = clean(v); return /^https?:\/\//.test(s) ? s.slice(0, 300) : (s ? `https://${s}`.slice(0, 300) : null); };

  let id = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "campaign";
  const existing = await must(db().from("clips_campaigns").select("id").like("id", `${id}%`), "campaigns");
  if (existing.some(e => e.id === id)) id = `${id}-${existing.length + 1}`;

  const pending = await must(db().from("clips_campaigns").select("id", { count: "exact" }).eq("status", "pending").eq("creator_instagram", creator), "campaigns");
  if (pending.length >= 3) throw new HttpError(429, "You already have 3 campaigns waiting for review.");

  await must(db().from("clips_campaigns").insert({
    id, name, ticker, tagline, image_url: image || null, status: "pending",
    creator_instagram: creator, creator_wallet: wallet, video_url: url(b.video),
    x_url: url(b.x), telegram_url: url(b.telegram), website_url: url(b.website)
  }), "campaign insert");
  send(res, 201, { ok: true, id, message: "Campaign submitted. It goes live after review." });
});
