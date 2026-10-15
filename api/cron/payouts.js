// Daily: claim each campaign's trading fees, split them between clippers by views, and send payouts.
// Nothing moves on chain unless PAYOUTS_ENABLED=true. Without it the run is a dry run that only reports.
//
// Safety rules:
// - Only one payout run at a time (database lock).
// - Fees are allocated with an atomic database function, so two runs can never allocate the same fees.
// - A payout's transaction is signed and its signature saved BEFORE it is broadcast. If anything goes wrong
//   afterwards, the signature is checked on chain. Rows are only set back to "owed" when the network rejected
//   the transaction before broadcasting it, or when it is confirmed failed on chain. Anything uncertain is held
//   as "failed" for a manual check in the admin page. This prevents paying anyone twice.
import { handler, send, db, must, env, requireCron } from "../_lib/core.js";
import { splitByViews, afterPlatformFee, pickPayouts, toRawStrict, rawFromDb, fromRaw } from "../_lib/allocate.js";
import { unclaimedQuoteFees, claimFees, claimedQuoteTotal, prepareTransfer, broadcast, signatureState, mintInfo, clipsMint, clipsPriceUsd, treasuryBalances, connection } from "../_lib/solana.js";
import { PublicKey } from "@solana/web3.js";

const isWallet = w => { try { return PublicKey.isOnCurve(new PublicKey(w).toBytes()); } catch { return false; } };

const PER_TX = 6;
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function openRun(dry) {
  // Close runs that crashed more than 15 minutes ago so they do not block forever.
  const stale = new Date(Date.now() - 15 * 60000).toISOString();
  await db().from("clips_runs").update({ finished_at: new Date().toISOString(), ok: false, summary: { errors: ["Run did not finish (timed out)."] } })
    .eq("kind", "payouts").is("finished_at", null).lt("started_at", stale);
  const { data, error } = await db().from("clips_runs").insert({ kind: "payouts", dry_run: dry }).select();
  if (error) return null; // unique index: another run is open
  return data[0];
}

export default handler(["GET", "POST"], async (req, res) => {
  requireCron(req);
  const dry = env("PAYOUTS_ENABLED") !== "true" || String(req.query?.dry || "") === "1";
  const run = await openRun(dry);
  if (!run) return send(res, 409, { error: "A payout run is already in progress. Try again in a few minutes." });

  const summary = { dryRun: dry, campaigns: [], sent: [], skipped: [], held: [], errors: [] };
  try {
    const { decimals } = await mintInfo(clipsMint());
    const price = await clipsPriceUsd();
    const feeBps = Number(env("PLATFORM_FEE_BPS", "0")) || 0;
    const minRaw = toRawStrict(env("MIN_PAYOUT", "1"), decimals, "MIN_PAYOUT");
    const capEnv = toRawStrict(env("MAX_PAYOUT_PER_RUN", "0"), decimals, "MAX_PAYOUT_PER_RUN");

    // ---- 1. claim and allocate, campaign by campaign ----
    const camps = await must(db().from("clips_campaigns").select("id, pool_address, fees_allocated::text").eq("status", "live").not("pool_address", "is", null), "campaigns");
    for (const c of camps) {
      const row = { id: c.id };
      try {
        if (!dry) {
          const fees = await unclaimedQuoteFees(c.pool_address);
          if (fees.partner + fees.creator > 0n) {
            try { row.claimSignatures = (await claimFees(c.pool_address)).signatures; }
            catch (e) { row.claimError = e.message; summary.errors.push(`${c.id} claim: ${e.message}`); }
          }
        }
        // Totals straight from the pool, so a failed database write can never lose track of claimed fees.
        const claimed = await claimedQuoteTotal(c.pool_address);
        const left = await unclaimedQuoteFees(c.pool_address);
        const unclaimed = left.partner + left.creator;
        await db().from("clips_campaigns").update({ fees_claimed: claimed.toString(), fees_unclaimed: unclaimed.toString(), token_decimals: decimals, price_usd: price, snapshot_at: new Date().toISOString() }).eq("id", c.id);
        row.claimedTotal = fromRaw(claimed, decimals); row.unclaimed = fromRaw(unclaimed, decimals);

        const allocatedBefore = rawFromDb(c.fees_allocated);
        let available = (dry ? claimed + unclaimed : claimed) - allocatedBefore;
        if (available < 0n) available = 0n;
        const board = await must(db().from("clips_leaderboard").select("clipper_id, views, verified").eq("campaign_id", c.id), "leaderboard");
        const eligible = board.filter(r => r.verified && Number(r.views) > 0).map(r => ({ clipperId: r.clipper_id, views: String(r.views) }));
        const toSplit = afterPlatformFee(available, feeBps);
        const platformCut = available - toSplit;
        const { allocations, allocated } = splitByViews(toSplit, eligible);
        row.available = fromRaw(available, decimals); row.toClippers = fromRaw(allocated, decimals); row.clippers = allocations.length;

        if (!dry && (allocated > 0n || platformCut > 0n)) {
          const { data: ok, error } = await db().rpc("clips_allocate", {
            p_campaign: c.id, p_expected: c.fees_allocated, p_new: (allocatedBefore + allocated + platformCut).toString(),
            p_rows: allocations.map(a => ({ clipper_id: a.clipperId, amount: a.amount.toString(), views: a.views.toString(), share: a.shareBps / 10000 }))
          });
          if (error) throw new Error(`allocation failed: ${error.message}`);
          if (!ok) throw new Error("allocation skipped: the pool changed during this run, it will be retried next run");
        }
      } catch (e) {
        row.error = e.message; summary.errors.push(`${c.id}: ${e.message}`);
      }
      summary.campaigns.push(row);
    }

    // ---- 2. resolve payouts held from earlier runs where the chain now gives a clear answer ----
    if (!dry) {
      // Rows marked "sending" but never given a signature were never broadcast: put them back.
      await db().from("clips_payouts").update({ status: "owed" }).eq("status", "sending").is("signature", null);
      const held = await must(db().from("clips_payouts").select("id, signature, last_valid_block_height").in("status", ["sending", "failed"]).not("signature", "is", null).limit(200), "held payouts");
      const bySig = new Map();
      held.forEach(h => { if (!bySig.has(h.signature)) bySig.set(h.signature, { ids: [], lvbh: h.last_valid_block_height }); bySig.get(h.signature).ids.push(h.id); });
      let height = null;
      try { height = await connection().getBlockHeight("finalized"); } catch {}
      for (const [sig, g] of bySig) {
        const st = await signatureState(sig).catch(() => "error");
        if (st === "landed") await db().from("clips_payouts").update({ status: "sent", sent_at: new Date().toISOString(), error: null }).in("id", g.ids);
        // Failed on chain, or never landed and its blockhash has expired (so it can never land): safe to pay again.
        else if (st === "failed" || (st === "unknown" && height !== null && g.lvbh && height > Number(g.lvbh) + 150)) {
          await db().from("clips_payouts").update({ status: "owed", signature: null, last_valid_block_height: null }).in("id", g.ids).in("status", ["sending", "failed"]);
        }
      }
    }

    // ---- 3. send owed balances ----
    if (!dry) {
      const bal = await treasuryBalances();
      if (bal.clips?.error) throw new Error(`Could not read the treasury balance, no payouts sent: ${bal.clips.error}`);
      const have = BigInt(bal.clips?.raw || "0");
      if (have === 0n) { summary.errors.push("The treasury holds no Clips tokens, no payouts sent."); }
      else {
        const cap = capEnv > 0n ? (capEnv < have ? capEnv : have) : have;
        const owedRows = await must(db().from("clips_payouts").select("id, clipper_id, amount::text, clips_clippers(wallet, instagram, verified)").eq("status", "owed"), "owed payouts");
        const byClipper = new Map();
        for (const p of owedRows) {
          const cl = p.clips_clippers || {};
          const cur = byClipper.get(p.clipper_id) || { clipperId: p.clipper_id, wallet: cl.wallet, instagram: cl.instagram, verified: cl.verified, amount: 0n, ids: [] };
          cur.amount += rawFromDb(p.amount); cur.ids.push(p.id);
          byClipper.set(p.clipper_id, cur);
        }
        // Only verified clippers are paid; an unverified clipper's balance waits until they verify again.
        const payable = [...byClipper.values()].filter(o => o.wallet && o.verified && isWallet(o.wallet));
        const { picked } = pickPayouts(payable, minRaw, cap);
        summary.skipped = [...byClipper.values()].filter(o => !picked.includes(o)).map(o => ({ instagram: o.instagram, owed: fromRaw(o.amount, decimals), reason: !o.verified ? "not verified" : !isWallet(o.wallet) ? "wallet address is not valid, fix it in the admin page" : o.amount < minRaw ? "below minimum" : "over today's cap" }));

        const queue = [];
        for (let i = 0; i < picked.length; i += PER_TX) queue.push(picked.slice(i, i + PER_TX));
        while (queue.length) {
          const group = queue.shift();
          await payGroup(group, queue, summary, decimals);
        }
      }
    }
  } catch (e) {
    summary.errors.push(e.message);
  }

  await db().from("clips_runs").update({ ok: summary.errors.length === 0, summary, finished_at: new Date().toISOString() }).eq("id", run.id);
  send(res, 200, { ok: true, summary });
});

async function payGroup(group, queue, summary, decimals) {
  // Claim the rows for this run. Only rows that were still "owed" are paid.
  const ids = group.flatMap(g => g.ids);
  const claimedRows = await must(db().from("clips_payouts").update({ status: "sending" }).in("id", ids).eq("status", "owed").select("id"), "mark sending");
  const claimedIds = new Set(claimedRows.map(r => r.id));
  const ready = group.filter(g => g.ids.every(id => claimedIds.has(id)));
  const partial = group.filter(g => !ready.includes(g)).flatMap(g => g.ids.filter(id => claimedIds.has(id)));
  if (partial.length) await db().from("clips_payouts").update({ status: "owed" }).in("id", partial).eq("status", "sending");
  if (!ready.length) return;
  const readyIds = ready.flatMap(g => g.ids);

  let prepared;
  try { prepared = await prepareTransfer(ready.map(g => ({ wallet: g.wallet, amount: g.amount }))); }
  catch (e) {
    await db().from("clips_payouts").update({ status: "owed", error: String(e.message).slice(0, 500) }).in("id", readyIds);
    if (ready.length > 1) ready.forEach(g => queue.push([g]));
    else summary.errors.push(`Could not prepare payout to @${ready[0].instagram}: ${e.message}`);
    return;
  }
  // Save the signature before broadcasting.
  await must(db().from("clips_payouts").update({ signature: prepared.signature, last_valid_block_height: prepared.lastValidBlockHeight }).in("id", readyIds), "save signature");

  let outcome = "unknown", errMsg = null;
  try { await broadcast(prepared); }
  catch (e) {
    errMsg = e.message;
    if (e.preflight) outcome = "rejected";
  }
  if (outcome !== "rejected") {
    for (let i = 0; i < 4 && outcome === "unknown"; i++) {
      outcome = await signatureState(prepared.signature).catch(() => "unknown");
      if (outcome === "unknown") await sleep(2500);
    }
  }

  if (outcome === "landed") {
    await db().from("clips_payouts").update({ status: "sent", sent_at: new Date().toISOString(), error: null }).in("id", readyIds);
    ready.forEach(g => summary.sent.push({ instagram: g.instagram, amount: fromRaw(g.amount, decimals), signature: prepared.signature }));
  } else if (outcome === "rejected" || outcome === "failed") {
    // Never landed: safe to pay again. If several wallets were grouped, retry each one alone so one bad wallet cannot block the rest.
    await db().from("clips_payouts").update({ status: "owed", signature: null, last_valid_block_height: null, error: String(errMsg || "failed on chain").slice(0, 500) }).in("id", readyIds);
    if (ready.length > 1) ready.forEach(g => queue.push([g]));
    else summary.errors.push(`Payout to @${ready[0].instagram} was rejected: ${errMsg || "failed on chain"}`);
  } else {
    await db().from("clips_payouts").update({ status: "failed", error: String(errMsg || "not confirmed yet").slice(0, 500) }).in("id", readyIds);
    summary.held.push({ signature: prepared.signature, clippers: ready.map(g => g.instagram) });
    summary.errors.push(`Payout ${prepared.signature} not confirmed yet. The next run checks it again, or resolve it in the admin page.`);
  }
}
