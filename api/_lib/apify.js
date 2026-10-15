// Instagram data through Apify (public data only, no Instagram login).
import { env, HttpError } from "./core.js";

async function runActor(actor, input, timeoutSecs = 120) {
  const token = env("APIFY_TOKEN");
  if (!token) throw new HttpError(503, "Instagram checks are not configured yet (APIFY_TOKEN is missing).");
  const url = `https://api.apify.com/v2/acts/${actor}/run-sync-get-dataset-items?token=${encodeURIComponent(token)}&timeout=${timeoutSecs}&clean=true`;
  const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) });
  if (!r.ok) {
    const t = await r.text().catch(() => "");
    console.error("apify", actor, r.status, t.slice(0, 300));
    throw new HttpError(502, "Instagram could not be checked right now. Try again in a few minutes.");
  }
  const items = await r.json();
  return Array.isArray(items) ? items : [];
}

// Public profile: bio text and bio links.
export async function getProfile(username) {
  const items = await runActor("apify~instagram-profile-scraper", { usernames: [username] }, 40);
  const p = items.find(i => (i.username || "").toLowerCase() === username) || items[0];
  if (!p || p.error) return null;
  const links = [p.externalUrl, ...(Array.isArray(p.externalUrls) ? p.externalUrls.map(x => x && (x.url || x.lynx_url)) : [])].filter(Boolean);
  return { username: (p.username || username).toLowerCase(), biography: p.biography || "", links, isPrivate: !!p.private };
}

// Does the profile carry this clipper's Clips link?
export function bioHasCode(profile, code) {
  if (!profile) return false;
  const hay = [profile.biography, ...profile.links].join(" ").toLowerCase();
  const plain = decodeURIComponentSafe(hay);
  return plain.includes(`/r/${code}`);
}

function decodeURIComponentSafe(s) { try { return decodeURIComponent(s); } catch { return s; } }

// One or more Reels: owner and view counts.
export async function getReels(urls) {
  if (!urls.length) return [];
  const items = await runActor("apify~instagram-scraper", { directUrls: urls, resultsType: "posts", resultsLimit: 1, addParentData: false }, 45);
  return items.filter(i => i && i.shortCode).map(i => ({
    shortcode: i.shortCode,
    owner: (i.ownerUsername || "").toLowerCase(),
    isVideo: i.type === "Video" || i.productType === "clips" || i.videoPlayCount != null || i.videoViewCount != null,
    views: Math.max(Number(i.videoPlayCount) || 0, Number(i.videoViewCount) || 0),
    postedAt: i.timestamp ? new Date(i.timestamp) : null
  }));
}
