# Clips backend: setup guide

You do this once. After that, you only push the folder to GitHub as usual.

## What the backend does

1. **Clippers join** on a campaign page (Clip tab) with their Instagram username and Solana wallet. They get a personal link like `https://clips-smoky.vercel.app/r/ab3k9xyz`.
2. **They put the link in their Instagram bio** and press Verify. The site reads their public bio and checks that the link is there. No account linking.
3. **They submit their Reels.** The site checks each Reel belongs to them and reads its views.
4. **Every day** the site updates Reel views and re-checks bios. A clipper who removes the link stops counting until they add it back.
5. **Every day** the site claims each campaign token's trading fees, splits them between clippers by their share of views, and sends the payouts in the Clips main token.
6. **Anyone can submit a campaign** from "Launch a campaign". You approve it in the admin page and launch its token there with one button. Every token is paired with the Clips main token.

Payouts never move real tokens until you switch them on (step 8).

## What you need

| What | Where to get it | Cost |
|---|---|---|
| Supabase service key | Supabase, project **stillwire**, Project Settings, API Keys, the **secret / service_role** key | Free |
| Apify token | apify.com, sign up, Settings, API and Integrations, Personal API token | About $2 to $3 per 1,000 Reel or bio checks |
| Solana RPC URL | helius.dev, sign up, copy the mainnet RPC URL | Free tier is enough to start |
| Treasury wallet | A **new** Phantom wallet used only for Clips. Settings, Manage accounts, Show private key | Put about 0.2 SOL in it |
| Clips main token address | The mint address of your Clips main token | |

The treasury wallet signs token launches, receives all trading fees and sends every payout. Treat its private key like cash: never share it, never paste it anywhere except Vercel, and keep only what you need in it.

## Step 1. Add the settings in Vercel

Vercel, your **clips** project, Settings, Environment Variables. Add each of these for **Production**:

| Name | Value |
|---|---|
| `SUPABASE_URL` | `https://mgryijxpfjvunhuthnxz.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY` | the secret key from Supabase |
| `APIFY_TOKEN` | your Apify token |
| `SOLANA_RPC_URL` | your Helius URL |
| `TREASURY_SECRET_KEY` | the treasury wallet's private key |
| `CLIPS_MINT` | the Clips main token address |
| `ADMIN_SECRET` | a long password you make up (at least 12 characters) |
| `CRON_SECRET` | another long random password (Vercel uses it to run the daily jobs) |
| `SITE_URL` | `https://clips-smoky.vercel.app` (or your own domain later) |
| `MIN_PAYOUT` | smallest payout in Clips tokens, for example `10` |
| `MAX_PAYOUT_PER_RUN` | safety cap per day in Clips tokens, for example `100000` (`0` means no cap) |

Leave `PAYOUTS_ENABLED` and `DBC_CONFIG` out for now.

## Step 2. Push the folder

Push the `clips-site` folder to GitHub as usual. Vercel installs everything and deploys.

## Step 3. Open the admin page

Go to `https://clips-smoky.vercel.app/admin.html` and sign in with your `ADMIN_SECRET`. The Status box should show everything as Set.

## Step 4. Create the token launch settings (once)

In the admin page, "One-time setup", enter:

- **Starting market cap** and **graduation market cap**, both counted in Clips main tokens (not dollars). Example: if 1 Clips token is worth $0.01, a $5,000 starting market cap is 500,000 Clips tokens.
- **Trading fee**: 100 means 1% of every trade goes to the fee pool.

Press "Create settings on Solana". Copy the `DBC_CONFIG` address it shows into Vercel as a new environment variable, then redeploy (Vercel, Deployments, the three dots, Redeploy).

## Step 5. Launch campaign tokens

In the admin page, Campaigns:

- Press **Launch token** on a campaign. The token goes live on Meteora, paired with the Clips main token. The Axiom and GMGN buttons on the site fill in automatically.
- King of the Hill is already in the database. Give it a ticker with Edit first, then launch.
- If a token was launched somewhere else, paste its mint and links with Edit instead. Fees can only be claimed automatically for tokens launched from this admin page, because the treasury must be the token's fee claimer.

New campaigns people submit appear as **pending**. Approve and launch the ones you want.

## Step 6. Test with a dry run

Press "Payouts: dry run". It shows the fees waiting in each pool and how they would be split, without sending anything.

## Step 7. Check the clipper flow yourself

Join a campaign with your own Instagram, put the link in your bio, verify, submit a Reel. It should appear on the leaderboard once views are counted.

## Step 8. Switch payouts on

When you are happy with the dry runs, add `PAYOUTS_ENABLED` = `true` in Vercel and redeploy. From then on the daily job claims fees and pays clippers automatically.

## Good to know

- **Daily jobs**: on Vercel's free plan they run once a day (views at 09:00 UTC, payouts at 09:30 UTC) and each run has 60 seconds, so about 120 Reels are refreshed per day, oldest first. You can also run them any time from the admin page. Vercel Pro allows hourly runs.
- **Failed payouts**: if a payout was sent but not confirmed, it is held as "failed" so nobody is paid twice. Open it on Solscan from the admin page and mark it "It landed" or "Pay again".
- **Fees after graduation**: when a token graduates to a full Meteora pool, its later trading fees are not claimed by the daily job yet. That is the next piece to add.
- **Website without the backend**: if the backend is not set up, the site still works and shows the campaigns written at the top of `index.html`.
- **Database**: the tables live in the stillwire Supabase project, all named `clips_...`, so they never mix with your other data.
