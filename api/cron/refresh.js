// Daily: update Reel view counts and re-check that verified clippers still have their link in their bio.
import { handler, send, db, must, requireCron } from "../_lib/core.js";
import { getReels, getProfile, bioHasCode } from "../_lib/apify.js";

const BATCH = 30;              // Reels per Apify call
const MAX_REELS = 120;         // per run (oldest-checked first, so every Reel gets its turn)
const MAX_PROFILES = 10;       // bio re-checks per run
const BIO_RECHECK_MS = 3 * 86400000;

export default handler(["GET", "POST"], async (req, res) => {
  requireCron(req);
  const run = (await must(db().from("clips_runs").insert({ kind: "refresh", dry_run: false }).select(), "run"))[0];
  const summary = { reels: 0, updated: 0, missing: 0, wrongOwner: 0, profiles: 0, unverified: 0, errors: [] };
  const started = Date.now();

  try {
    const live = (await must(db().from("clips_campaigns").select("id").eq("status", "live"), "campaigns")).map(c => c.id);
    const clips = live.length ? await must(db().from("clips_clips")
      .select("id, shortcode, url, clipper_id, campaign_id, clips_clippers(instagram)")
      .in("campaign_id", live).in("status", ["ok", "pending"])
      .order("last_checked", { ascending: true, nullsFirst: true }).limit(MAX_REELS), "clips") : [];
    summary.reels = clips.length;

    for (let i = 0; i < clips.length && Date.now() - started < 35000; i += BATCH) {
      const chunk = clips.slice(i, i + BATCH);
      let found = [];
      try { found = await getReels(chunk.map(c => c.url)); } catch (e) { summary.errors.push(String(e.message)); continue; }
      const byCode = new Map(found.map(r => [r.shortcode, r]));
      const now = new Date().toISOString();
      for (const c of chunk) {
        const r = byCode.get(c.shortcode);
        if (!r) { summary.missing++; await db().from("clips_clips").update({ last_checked: now }).eq("id", c.id); continue; }
        const owner = c.clips_clippers?.instagram;
        if (r.owner && owner && r.owner !== owner) {
          summary.wrongOwner++;
          await db().from("clips_clips").update({ status: "rejected", reject_reason: "owner changed", last_checked: now }).eq("id", c.id);
          continue;
        }
        // Views never go down in our records, so a temporary scrape glitch cannot shrink someone's share.
        const { data: cur } = await db().from("clips_clips").select("views").eq("id", c.id).limit(1);
        const views = Math.max(Number(cur?.[0]?.views) || 0, r.views);
        await db().from("clips_clips").update({ views, last_checked: now }).eq("id", c.id);
        summary.updated++;
      }
    }

    // Bio re-checks: a clipper who removes their link stops counting until they add it back and verify again.
    const cutoff = new Date(Date.now() - BIO_RECHECK_MS).toISOString();
    const due = await must(db().from("clips_clippers").select("id, instagram, code")
      .eq("verified", true).or(`last_bio_check.is.null,last_bio_check.lt.${cutoff}`).limit(MAX_PROFILES), "clippers");
    for (const p of due) {
      if (Date.now() - started > 50000) break;
      try {
        const prof = await getProfile(p.instagram);
        if (!prof) { summary.errors.push(`@${p.instagram}: profile not readable, left unchanged`); continue; }
        const ok = bioHasCode(prof, p.code);
        summary.profiles++;
        if (!ok) summary.unverified++;
        await db().from("clips_clippers").update({ last_bio_check: new Date().toISOString(), bio_ok: ok, verified: ok }).eq("id", p.id);
      } catch (e) { summary.errors.push(String(e.message)); }
    }
  } catch (e) {
    summary.errors.push(String(e.message));
  }

  await db().from("clips_runs").update({ ok: summary.errors.length === 0, summary, finished_at: new Date().toISOString() }).eq("id", run.id);
  send(res, 200, { ok: true, summary });
});
