// POST /api/submit  { campaign, instagram, url }
// A clipper submits one of their Reels for a campaign. The Reel must belong to their account.
import { handler, send, body, db, must, normInstagram, reelShortcode, HttpError } from "./_lib/core.js";
import { getReels } from "./_lib/apify.js";

const DAILY_LIMIT = 20;

export default handler(["POST"], async (req, res) => {
  const b = body(req);
  const instagram = normInstagram(b.instagram);
  const shortcode = reelShortcode(b.url);
  const campaignId = String(b.campaign || "");

  const camp = (await must(db().from("clips_campaigns").select("id, status, launched_at, created_at").eq("id", campaignId).limit(1), "campaign"))[0];
  if (!camp || camp.status !== "live") throw new HttpError(404, "This campaign is not open for clippers.");
  const clipper = (await must(db().from("clips_clippers").select("*").eq("instagram", instagram).limit(1), "clipper"))[0];
  if (!clipper) throw new HttpError(404, "Join this campaign first.");
  const member = await must(db().from("clips_memberships").select("campaign_id").eq("campaign_id", campaignId).eq("clipper_id", clipper.id), "membership");
  if (!member.length) throw new HttpError(403, "Join this campaign first.");

  const dupe = (await must(db().from("clips_clips").select("id, campaign_id").eq("shortcode", shortcode).limit(1), "clips"))[0];
  if (dupe) throw new HttpError(409, dupe.campaign_id === campaignId ? "This Reel is already submitted." : "This Reel is already submitted to another campaign.");

  const since = new Date(Date.now() - 86400000).toISOString();
  const recent = await must(db().from("clips_clips").select("id").eq("clipper_id", clipper.id).gte("created_at", since), "clips");
  if (recent.length >= DAILY_LIMIT) throw new HttpError(429, `You can submit up to ${DAILY_LIMIT} Reels a day.`);

  const url = `https://www.instagram.com/reel/${shortcode}/`;
  const [reel] = await getReels([url]);
  if (!reel) throw new HttpError(404, "That Reel could not be found. Check that it is public.");
  if (!reel.owner) throw new HttpError(400, "Could not confirm who posted that Reel. Try again later.");
  if (reel.owner !== instagram) throw new HttpError(403, `That Reel belongs to @${reel.owner}, not @${instagram}.`);
  const opened = new Date(camp.launched_at || camp.created_at);
  if (!reel.postedAt || isNaN(reel.postedAt)) throw new HttpError(400, "Could not read when that Reel was posted. Try again later.");
  if (reel.postedAt < opened) throw new HttpError(400, "Only Reels posted after the campaign started count.");
  if (!reel.isVideo) throw new HttpError(400, "That post is not a video Reel.");

  const status = clipper.verified ? "ok" : "pending";
  await must(db().from("clips_clips").insert({
    campaign_id: campaignId, clipper_id: clipper.id, shortcode, url, views: reel.views, status, last_checked: new Date().toISOString()
  }), "clip insert");
  send(res, 201, {
    ok: true, views: reel.views, status,
    message: status === "ok" ? `Added. ${reel.views.toLocaleString("en-US")} views counted so far, updated daily.` : "Added. It starts counting once your bio link is verified."
  });
});
