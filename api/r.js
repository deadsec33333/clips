// GET /r/:code  (rewritten to /api/r?code=...)
// The link clippers put in their bio. Sends visitors to the campaign the clipper joined most recently.
import { db, siteUrl } from "./_lib/core.js";

export default async function (req, res) {
  const base = siteUrl(req);
  const code = String(req.query?.code || "").toLowerCase();
  let target = `${base}/#campaigns`;
  try {
    if (/^[a-z0-9]{6,12}$/.test(code)) {
      const { data: c } = await db().from("clips_clippers").select("id").eq("code", code).limit(1);
      if (c && c[0]) {
        const { data: m } = await db().from("clips_memberships").select("campaign_id").eq("clipper_id", c[0].id).order("joined_at", { ascending: false }).limit(1);
        if (m && m[0]) target = `${base}/#c-${m[0].campaign_id}`;
      }
    }
  } catch (e) { console.error("redirect", e); }
  res.statusCode = 302;
  res.setHeader("Location", target);
  res.setHeader("Cache-Control", "public, max-age=300");
  res.end();
}
