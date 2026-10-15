// POST /api/join  { campaign, instagram, wallet }
// Registers a clipper (or finds them) and adds them to a campaign. Returns their Clips link.
import { handler, send, body, db, must, normInstagram, normWallet, randomCode, siteUrl, HttpError } from "./_lib/core.js";

export default handler(["POST"], async (req, res) => {
  const b = body(req);
  const instagram = normInstagram(b.instagram);
  const wallet = normWallet(b.wallet);
  const campaignId = String(b.campaign || "");

  const camp = (await must(db().from("clips_campaigns").select("id, status").eq("id", campaignId).limit(1), "campaign"))[0];
  if (!camp || camp.status !== "live") throw new HttpError(404, "This campaign is not open for clippers.");

  let clipper = (await must(db().from("clips_clippers").select("*").eq("instagram", instagram).limit(1), "clipper"))[0];
  if (clipper && clipper.wallet !== wallet) {
    // A wallet can only change before the account is verified and before it has earned anything.
    // Changing it also issues a new bio link, so only the real account owner can verify the new wallet.
    const earned = await must(db().from("clips_payouts").select("id").eq("clipper_id", clipper.id).limit(1), "payouts");
    if (clipper.verified || earned.length) throw new HttpError(409, "This Instagram account is already registered with a different wallet. Contact Clips to change it.");
    clipper = (await must(db().from("clips_clippers").update({ wallet, code: randomCode(8), verified: false, verified_at: null }).eq("id", clipper.id).eq("verified", false).select(), "clipper update"))[0];
    if (!clipper) throw new HttpError(409, "This Instagram account was just verified with another wallet. Contact Clips to change it.");
  }
  if (!clipper) {
    for (let i = 0; i < 4 && !clipper; i++) {
      const { data, error } = await db().from("clips_clippers").insert({ instagram, wallet, code: randomCode(8) }).select();
      if (!error) clipper = data[0];
      else if (error.code !== "23505") throw new HttpError(500, "Could not register you. Try again.");
      else {
        const again = (await must(db().from("clips_clippers").select("*").eq("instagram", instagram).limit(1), "clipper"))[0];
        if (again) clipper = again;
      }
    }
  }
  await must(db().from("clips_memberships").upsert({ campaign_id: camp.id, clipper_id: clipper.id }, { onConflict: "campaign_id,clipper_id", ignoreDuplicates: true }), "membership");

  send(res, 200, {
    ok: true,
    instagram: clipper.instagram,
    link: `${siteUrl(req)}/r/${clipper.code}`,
    verified: clipper.verified,
    next: clipper.verified ? "You are verified. Submit your Reels below." : "Put this link in your Instagram bio, then press Verify."
  });
});
