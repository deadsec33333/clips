// Solana: the treasury wallet, Meteora Dynamic Bonding Curve (DBC) pools, fee claims and token transfers.
import { Connection, Keypair, PublicKey, Transaction, sendAndConfirmTransaction, ComputeBudgetProgram } from "@solana/web3.js";
import { getMint, getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction, createTransferCheckedInstruction, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, getAccount, TokenAccountNotFoundError } from "@solana/spl-token";
import {
  DynamicBondingCurveClient, buildCurveWithMarketCap, deriveDbcPoolAddress,
  TokenType, TokenDecimal, TokenAuthorityOption, BaseFeeMode, CollectFeeMode,
  MigrationOption, MigrationFeeOption, ActivationType
} from "@meteora-ag/dynamic-bonding-curve-sdk";
import BN from "bn.js";
import bs58 from "bs58";
import { env, HttpError } from "./core.js";

let _conn, _treasury, _client;

export function connection() {
  if (_conn) return _conn;
  const url = env("SOLANA_RPC_URL");
  if (!url) throw new HttpError(503, "SOLANA_RPC_URL is not set.");
  _conn = new Connection(url, "confirmed");
  return _conn;
}

export function treasury() {
  if (_treasury) return _treasury;
  const raw = env("TREASURY_SECRET_KEY");
  if (!raw) throw new HttpError(503, "TREASURY_SECRET_KEY is not set.");
  try {
    const bytes = raw.startsWith("[") ? Uint8Array.from(JSON.parse(raw)) : bs58.decode(raw);
    _treasury = Keypair.fromSecretKey(bytes);
  } catch { throw new HttpError(503, "TREASURY_SECRET_KEY is not a valid Solana secret key."); }
  return _treasury;
}

export function dbc() {
  if (!_client) _client = new DynamicBondingCurveClient(connection(), "confirmed");
  return _client;
}

export function clipsMint() {
  const m = env("CLIPS_MINT");
  if (!m) throw new HttpError(503, "CLIPS_MINT (the Clips main token address) is not set.");
  return new PublicKey(m);
}

const mintCache = new Map();
export async function mintInfo(mint) {
  const k = mint.toBase58();
  if (mintCache.has(k)) return mintCache.get(k);
  const acc = await connection().getAccountInfo(mint);
  if (!acc) throw new HttpError(400, `Token ${k} was not found on chain.`);
  const programId = acc.owner.equals(TOKEN_2022_PROGRAM_ID) ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
  const info = await getMint(connection(), mint, "confirmed", programId);
  const out = { decimals: info.decimals, programId };
  mintCache.set(k, out);
  return out;
}

function priority(tx) {
  const micro = Number(env("PRIORITY_FEE_MICROLAMPORTS", "50000")) || 0;
  if (micro > 0) tx.instructions.unshift(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: micro }));
  return tx;
}

async function sendTx(tx, signers) {
  priority(tx);
  return sendAndConfirmTransaction(connection(), tx, signers, { commitment: "confirmed", maxRetries: 3 });
}

export async function treasuryBalances() {
  const t = treasury().publicKey;
  const sol = await connection().getBalance(t);
  let clips = null;
  try {
    const mint = clipsMint(), { programId, decimals } = await mintInfo(mint);
    const ata = getAssociatedTokenAddressSync(mint, t, true, programId);
    let raw = "0";
    try { raw = (await getAccount(connection(), ata, "confirmed", programId)).amount.toString(); }
    catch (e) { if (!(e instanceof TokenAccountNotFoundError)) throw e; }
    clips = { raw, decimals };
  } catch (e) { clips = { error: e.message }; }
  return { address: t.toBase58(), sol: sol / 1e9, clips };
}

// ---------- one-time setup: the DBC config every Clips campaign token uses ----------
// Market caps are in Clips main tokens (the quote token), not dollars.
export function curveParams({ initialMarketCap, migrationMarketCap, feeBps = 100, quoteDecimals }) {
  return buildCurveWithMarketCap({
    token: {
      tokenType: TokenType.SPLToken,
      tokenBaseDecimal: TokenDecimal.SIX,
      tokenQuoteDecimal: quoteDecimals,
      tokenAuthorityOption: TokenAuthorityOption.Immutable,
      totalTokenSupply: 1_000_000_000,
      leftover: 0
    },
    fee: {
      baseFeeParams: { baseFeeMode: BaseFeeMode.FeeSchedulerLinear, feeSchedulerParam: { startingFeeBps: feeBps, endingFeeBps: feeBps, numberOfPeriod: 0, totalDuration: 0 } },
      dynamicFeeEnabled: true,
      collectFeeMode: CollectFeeMode.QuoteToken,
      creatorTradingFeePercentage: 0,
      poolCreationFee: 0,
      enableFirstSwapWithMinFee: false
    },
    migration: {
      migrationOption: MigrationOption.MET_DAMM_V2,
      migrationFeeOption: MigrationFeeOption.FixedBps100,
      migrationFee: { feePercentage: 0, creatorFeePercentage: 0 }
    },
    liquidityDistribution: {
      partnerPermanentLockedLiquidityPercentage: 100,
      partnerLiquidityPercentage: 0,
      creatorPermanentLockedLiquidityPercentage: 0,
      creatorLiquidityPercentage: 0
    },
    lockedVesting: { totalLockedVestingAmount: 0, numberOfVestingPeriod: 0, cliffUnlockAmount: 0, totalVestingDuration: 0, cliffDurationFromMigrationTime: 0 },
    activationType: ActivationType.Timestamp,
    initialMarketCap: Number(initialMarketCap),
    migrationMarketCap: Number(migrationMarketCap)
  });
}

export async function createClipsConfig({ initialMarketCap, migrationMarketCap, feeBps }) {
  const quote = clipsMint();
  const { decimals } = await mintInfo(quote);
  const params = curveParams({ initialMarketCap, migrationMarketCap, feeBps, quoteDecimals: decimals });
  const config = Keypair.generate();
  const t = treasury();
  const tx = await dbc().partner.createConfig2({
    ...params, config: config.publicKey, feeClaimer: t.publicKey, leftoverReceiver: t.publicKey, quoteMint: quote, payer: t.publicKey
  });
  const sig = await sendTx(tx, [t, config]);
  return { config: config.publicKey.toBase58(), signature: sig };
}

// ---------- launch a campaign token ----------
export async function launchToken({ name, symbol, uri }) {
  const cfg = env("DBC_CONFIG");
  if (!cfg) throw new HttpError(503, "DBC_CONFIG is not set. Create the config in the admin page first.");
  const config = new PublicKey(cfg);
  const t = treasury();
  const baseMint = Keypair.generate();
  const tx = await dbc().creator.createPool({
    name: name.slice(0, 32), symbol: symbol.slice(0, 10), uri,
    payer: t.publicKey, poolCreator: t.publicKey, config, baseMint: baseMint.publicKey
  });
  const sig = await sendTx(tx, [t, baseMint]);
  const pool = deriveDbcPoolAddress(clipsMint(), baseMint.publicKey, config);
  return { mint: baseMint.publicKey.toBase58(), pool: pool.toBase58(), signature: sig };
}

// ---------- fees ----------
export async function unclaimedQuoteFees(poolAddress) {
  const m = await dbc().state.getPoolFeeMetrics(new PublicKey(poolAddress));
  return {
    partner: BigInt(m.current.partnerQuoteFee.toString()),
    creator: BigInt(m.current.creatorQuoteFee.toString())
  };
}

// Claims a pool's partner and creator fees into the treasury. Returns the transaction signatures.
export async function claimFees(poolAddress) {
  const pool = new PublicKey(poolAddress);
  const t = treasury();
  const fees = await unclaimedQuoteFees(poolAddress);
  const signatures = [];
  if (fees.partner > 0n) {
    const tx = await dbc().partner.claimPartnerTradingFee({ feeClaimer: t.publicKey, payer: t.publicKey, pool, maxBaseAmount: new BN(0), maxQuoteAmount: new BN(fees.partner.toString()), receiver: t.publicKey });
    signatures.push(await sendTx(tx, [t]));
  }
  if (fees.creator > 0n) {
    const tx = await dbc().creator.claimCreatorTradingFee({ creator: t.publicKey, payer: t.publicKey, pool, maxBaseAmount: new BN(0), maxQuoteAmount: new BN(fees.creator.toString()), receiver: t.publicKey });
    signatures.push(await sendTx(tx, [t]));
  }
  return { signatures };
}

// Lifetime fees already claimed from a pool, read from the pool itself (so nothing depends on wallet balance changes).
export async function claimedQuoteTotal(poolAddress) {
  const b = await dbc().state.getPoolFeeBreakdown(new PublicKey(poolAddress));
  return BigInt(b.partner.claimedQuoteFee.toString()) + BigInt(b.creator.claimedQuoteFee.toString());
}

// ---------- payouts ----------
// Builds and signs a transfer of Clips main tokens to several wallets. The signature is known before anything is sent,
// so it can be saved first and checked on chain later. transfers: [{ wallet, amount (BigInt) }]
export async function prepareTransfer(transfers) {
  const t = treasury();
  const mint = clipsMint(), { decimals, programId } = await mintInfo(mint);
  const from = getAssociatedTokenAddressSync(mint, t.publicKey, true, programId);
  const tx = new Transaction();
  const micro = Number(env("PRIORITY_FEE_MICROLAMPORTS", "50000")) || 0;
  if (micro > 0) tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: micro }));
  for (const x of transfers) {
    const owner = new PublicKey(x.wallet);
    if (!PublicKey.isOnCurve(owner.toBytes())) throw new Error(`${x.wallet} is not a wallet address.`);
    const to = getAssociatedTokenAddressSync(mint, owner, false, programId);
    tx.add(createAssociatedTokenAccountIdempotentInstruction(t.publicKey, to, owner, mint, programId));
    tx.add(createTransferCheckedInstruction(from, mint, to, t.publicKey, x.amount, decimals, [], programId));
  }
  const { blockhash, lastValidBlockHeight } = await connection().getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash; tx.feePayer = t.publicKey;
  tx.sign(t);
  return { tx, signature: bs58.encode(tx.signature), blockhash, lastValidBlockHeight };
}

// Sends a prepared transfer. Throws {preflight:true} when the network rejected it before broadcasting (safe to retry).
export async function broadcast(prepared) {
  try {
    await connection().sendRawTransaction(prepared.tx.serialize(), { skipPreflight: false, preflightCommitment: "confirmed", maxRetries: 5 });
  } catch (e) {
    const msg = String(e && e.message || e);
    const err = new Error(msg);
    err.preflight = /simulation failed|Transaction simulation|preflight/i.test(msg);
    throw err;
  }
  try {
    await connection().confirmTransaction({ signature: prepared.signature, blockhash: prepared.blockhash, lastValidBlockHeight: prepared.lastValidBlockHeight }, "confirmed");
  } catch (e) { /* the caller checks the signature on chain */ }
  return prepared.signature;
}

// "landed", "failed" (on chain with an error), or "unknown" (not found yet).
export async function signatureState(sig) {
  if (!sig) return "unknown";
  const s = await connection().getSignatureStatus(sig, { searchTransactionHistory: true });
  if (!s.value) return "unknown";
  if (s.value.err) return "failed";
  return s.value.confirmationStatus === "confirmed" || s.value.confirmationStatus === "finalized" ? "landed" : "unknown";
}

export async function clipsPriceUsd() {
  try {
    const mint = env("CLIPS_MINT");
    if (!mint) return null;
    const r = await fetch(`https://lite-api.jup.ag/price/v3?ids=${mint}`);
    const j = await r.json();
    const p = j?.[mint]?.usdPrice;
    return typeof p === "number" && p > 0 ? p : null;
  } catch { return null; }
}
