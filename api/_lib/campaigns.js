// Turning database rows into what the website shows.
import { db, must } from "./core.js";

export function poolUsd(c) {
  if (c.fee_pool_usd_override != null) return Number(c.fee_pool_usd_override);
  if (!c.token_decimals || !c.price_usd) return 0;
  const raw = Number(c.fees_claimed || 0) + Number(c.fees_unclaimed || 0);
  return (raw / 10 ** c.token_decimals) * Number(c.price_usd);
}

export function imageFor(c, base) {
  if (!c.image_url) return null;
  if (c.image_url.startsWith("data:")) return `${base}/api/meta?id=${encodeURIComponent(c.id)}&img=1`;
  return c.image_url;
}

export function tradeLinks(c) {
  return {
    axiom: c.axiom_url || (c.pool_address ? `https://axiom.trade/meme/${c.pool_address}` : null),
    gmgn: c.gmgn_url || (c.token_mint ? `https://gmgn.ai/sol/token/${c.token_mint}` : null)
  };
}

export async function liveCampaigns(base, onlyId) {
  let q = db().from("clips_campaigns").select("*").eq("status", "live");
  if (onlyId) q = q.eq("id", onlyId);
  const camps = await must(q.order("featured", { ascending: false }).order("created_at"), "campaigns");
  if (!camps.length) return [];
  const ids = camps.map(c => c.id);
  const rows = await must(db().from("clips_leaderboard").select("campaign_id, instagram, verified, views").in("campaign_id", ids), "leaderboard");
  return camps.map(c => {
    const board = rows.filter(r => r.campaign_id === c.id && r.verified && Number(r.views) > 0)
      .map(r => ({ username: r.instagram, views: Number(r.views) }))
      .sort((a, b) => b.views - a.views).slice(0, 200);
    const links = tradeLinks(c);
    return {
      id: c.id, name: c.name, ticker: c.ticker || "", tagline: c.tagline || "",
      sky: c.sky || undefined, featured: !!c.featured,
      partner: c.partner || null, details: c.details || undefined, badges: c.badges || undefined,
      image: imageFor(c, base), video: c.video_url || null,
      axiom: links.axiom, gmgn: links.gmgn,
      tokenMint: c.token_mint || null, pool: c.pool_address || null,
      feePool: Math.round(poolUsd(c) * 100) / 100,
      rows: board
    };
  });
}
