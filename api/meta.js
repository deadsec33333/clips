// GET /api/meta?id=campaign        token metadata JSON (used as the token's URI on Solana)
// GET /api/meta?id=campaign&img=1  the campaign image
import { db, siteUrl } from "./_lib/core.js";

export default async function (req, res) {
  const id = String(req.query?.id || "");
  const { data } = await db().from("clips_campaigns").select("id, name, ticker, tagline, image_url, x_url, telegram_url, website_url").eq("id", id).limit(1);
  const c = data && data[0];
  if (!c) { res.statusCode = 404; return res.end("Not found"); }
  const base = siteUrl(req);

  if (req.query?.img) {
    const m = (c.image_url || "").match(/^data:(image\/[a-z+]+);base64,(.+)$/);
    if (m) {
      res.statusCode = 200;
      res.setHeader("Content-Type", m[1]);
      res.setHeader("Cache-Control", "public, max-age=86400");
      return res.end(Buffer.from(m[2], "base64"));
    }
    res.statusCode = c.image_url ? 302 : 404;
    if (c.image_url) res.setHeader("Location", c.image_url);
    return res.end();
  }

  const image = c.image_url ? (c.image_url.startsWith("data:") ? `${base}/api/meta?id=${encodeURIComponent(c.id)}&img=1` : c.image_url) : `${base}/logo.png`;
  res.statusCode = 200;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "public, max-age=3600");
  res.end(JSON.stringify({
    name: c.name, symbol: c.ticker || "", description: c.tagline || `${c.name} on Clips`,
    image, external_url: `${base}/#c-${c.id}`,
    extensions: { website: c.website_url || `${base}/#c-${c.id}`, twitter: c.x_url || undefined, telegram: c.telegram_url || undefined }
  }));
}
