// POST /api/verify  { instagram }
// Checks the clipper's public Instagram bio for their Clips link.
import { handler, send, body, db, must, normInstagram, HttpError } from "./_lib/core.js";
import { getProfile, bioHasCode } from "./_lib/apify.js";

const COOLDOWN_MS = 3 * 60 * 1000;

export default handler(["POST"], async (req, res) => {
  const instagram = normInstagram(body(req).instagram);
  const clipper = (await must(db().from("clips_clippers").select("*").eq("instagram", instagram).limit(1), "clipper"))[0];
  if (!clipper) throw new HttpError(404, "Join a campaign first to get your Clips link.");
  if (clipper.verified) return send(res, 200, { ok: true, verified: true, message: "Already verified." });
  if (clipper.last_bio_check && Date.now() - new Date(clipper.last_bio_check).getTime() < COOLDOWN_MS) {
    throw new HttpError(429, "Checked a moment ago. Wait a few minutes, then try again.");
  }
  await must(db().from("clips_clippers").update({ last_bio_check: new Date().toISOString() }).eq("id", clipper.id), "clipper");

  const profile = await getProfile(instagram);
  if (!profile) throw new HttpError(404, "That Instagram account could not be found.");
  if (profile.isPrivate) throw new HttpError(400, "Your Instagram account is private. Make it public so your views can be counted.");
  const ok = bioHasCode(profile, clipper.code);
  await must(db().from("clips_clippers").update({ bio_ok: ok, verified: ok, verified_at: ok ? new Date().toISOString() : null }).eq("id", clipper.id), "clipper");
  if (!ok) return send(res, 200, { ok: false, verified: false, message: "Your Clips link is not in your bio yet. Instagram can take a few minutes to update, so try again shortly." });

  // Clips submitted before verification start counting now.
  await must(db().from("clips_clips").update({ status: "ok" }).eq("clipper_id", clipper.id).eq("status", "pending").is("reject_reason", null), "clips");
  send(res, 200, { ok: true, verified: true, message: "Verified. Your Reels now count toward the leaderboard." });
});
