// RSS-only Lakay news journalist for the public host.
//
// The Muse version of this round spawned a research agent that searched
// Twitter/X, Google News and the web and verified facts on source pages.
// There is no agent on the public host, so this round does the same job
// with RSS feeds only (no X/Twitter lane):
//
//  1. Fetch the Haiti feeds below and keep items from roughly the last day.
//  2. Drop anything already posted (same source URL, or a near-identical
//     headline to a post already in the app).
//  3. Open each candidate's own page and read its text (falling back to
//     the feed summary), then ask Gemini to write the post in Lakay's own
//     words: short but complete, unconfirmed facts hedged with reserve
//     wording, source credited as plain text, and NO link or URL anywhere
//     in the title or body.
//  4. Pair the post with a picture from a SAFE source only: Wikimedia
//     Commons, or one of Lakay's own images. Never a photo from a news
//     site. A story with no safe picture is skipped.
//  5. Save through the same saveDailyArticle action the Muse journalist
//     used, so dedupe and censoring behave identically.
//
// An empty round is better than a repeated or unverified story: if
// nothing genuinely new and verified turns up, nothing is saved.

import { z } from "zod";
import { Actions } from "./actions.js";
import type { Ctx } from "./shim.js";

const PUBLIC_URL = (process.env.PUBLIC_URL ?? "https://lakay.onrender.com").replace(/\/$/, "");
const LAKAY_OWN_IMAGE = `${PUBLIC_URL}/citadelle.webp`;

const FEEDS: { name: string; url: string }[] = [
  { name: "Google News", url: "https://news.google.com/rss/search?q=Haiti&hl=en-US&gl=US&ceid=US:en" },
  { name: "The Haitian Times", url: "https://haitiantimes.com/feed/" },
  { name: "Le Nouvelliste", url: "https://lenouvelliste.com/feed.xml" },
];

const HAITI_RE = /haiti|haït|port-au-prince|pòtoprens|les grenadiers|grenadières|grenadier|moïse|moise|bukele|kenya|déport|deport|expuls|tps|ice\b|immigration|caribbean|ayiti|jovenel/i;

interface FeedItem {
  title: string;
  link: string;
  pubDate: string;
  description: string;
  sourceName: string;
}

function decodeEntities(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_m, n) => String.fromCharCode(Number(n)));
}

function tagText(xml: string, tag: string): string {
  const m = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i"));
  return m ? decodeEntities(m[1]).trim() : "";
}

function parseRss(xml: string, feedName: string): FeedItem[] {
  const items: FeedItem[] = [];
  for (const block of xml.match(/<item>[\s\S]*?<\/item>/gi) ?? []) {
    const title = tagText(block, "title");
    const link = tagText(block, "link");
    const pubDate = tagText(block, "pubDate");
    const description = tagText(block, "description")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    const sourceName = tagText(block, "source") || feedName;
    if (title && link) items.push({ title, link, pubDate, description, sourceName });
  }
  return items;
}

async function fetchText(url: string, timeoutMs: number): Promise<string | null> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const res = await fetch(url, {
      headers: {
        "User-Agent": "LakayNews/1.0 (+https://lakay.onrender.com)",
        Accept: "application/rss+xml, application/xml, text/html, */*",
      },
      signal: ctrl.signal,
      redirect: "follow",
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

function extractArticleText(html: string): string {
  const noScripts = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ");
  const article = noScripts.match(/<article[\s\S]*?<\/article>/i)?.[0] ?? noScripts;
  const paragraphs = [...article.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)]
    .map((m) => m[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim())
    .filter((p) => p.length > 40);
  return paragraphs.join("\n\n").slice(0, 6000);
}

function normTitle(t: string): string {
  return t.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function titlesOverlap(a: string, b: string): boolean {
  const wa = new Set(normTitle(a).split(" ").filter((w) => w.length > 3));
  const wb = new Set(normTitle(b).split(" ").filter((w) => w.length > 3));
  if (wa.size === 0 || wb.size === 0) return false;
  let shared = 0;
  for (const w of wa) if (wb.has(w)) shared += 1;
  return shared / Math.min(wa.size, wb.size) >= 0.6;
}

async function commonsImage(query: string): Promise<string | null> {
  try {
    const url =
      "https://commons.wikimedia.org/w/api.php?action=query&format=json&generator=search" +
      `&gsrsearch=${encodeURIComponent(query + " filetype:bitmap")}&gsrnamespace=6&prop=imageinfo` +
      "&iiprop=url%7Csize&iiurlwidth=1200&gsrlimit=5";
    const res = await fetch(url, {
      headers: { "User-Agent": "LakayNews/1.0" },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      query?: { pages?: Record<string, { imageinfo?: { thumburl?: string; url?: string }[] }> };
    };
    const pages = Object.values(data.query?.pages ?? {});
    for (const p of pages) {
      const info = p.imageinfo?.[0];
      const u = info?.thumburl ?? info?.url;
      if (u && /^https:\/\/upload\.wikimedia\.org\//.test(u)) return u;
    }
    return null;
  } catch {
    return null;
  }
}

const rewriteSchema = z.object({
  title: z.string().min(1).max(300),
  body: z.string().min(1).max(2400),
});

export async function runJournalistRound(ctx: Ctx, roundKey: string): Promise<void> {
  const started = Date.now();
  console.log(`[lakay] journalist round ${roundKey} starting (RSS-only)`);

  // What is already posted, so nothing is ever posted twice.
  let existing: { link: string; title: string }[] = [];
  try {
    const listed = await Actions.listDailyArticles.handler(ctx, { lang: "en" });
    existing = listed.articles.map((a) => ({ link: a.link, title: a.title }));
  } catch (e) {
    console.error("[lakay] journalist: could not list existing posts, aborting round:", e);
    return;
  }
  const existingLinks = new Set(existing.map((e) => e.link));

  // Gather fresh items from every feed.
  const cutoff = Date.now() - 30 * 60 * 60 * 1000;
  const candidates: FeedItem[] = [];
  for (const feed of FEEDS) {
    const xml = await fetchText(feed.url, 15000);
    if (!xml) {
      console.log(`[lakay] journalist: feed ${feed.name} did not answer`);
      continue;
    }
    for (const item of parseRss(xml, feed.name)) {
      const when = item.pubDate ? Date.parse(item.pubDate) : NaN;
      if (!Number.isNaN(when) && when < cutoff) continue;
      if (!HAITI_RE.test(`${item.title} ${item.description}`)) continue;
      if (existingLinks.has(item.link)) continue;
      if (existing.some((e) => titlesOverlap(e.title, item.title))) continue;
      if (!candidates.some((c) => c.link === item.link)) candidates.push(item);
    }
  }
  candidates.sort((a, b) => Date.parse(b.pubDate || "") - Date.parse(a.pubDate || ""));
  console.log(`[lakay] journalist: ${candidates.length} new candidate(s)`);

  let saved = 0;
  for (const item of candidates.slice(0, 3)) {
    try {
      // Open the story's own page and read its facts. Google News links
      // redirect to the publisher; the final URL is the real source.
      let finalUrl = item.link;
      let pageText = "";
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 12000);
        const res = await fetch(item.link, {
          headers: { "User-Agent": "LakayNews/1.0 (+https://lakay.onrender.com)" },
          signal: ctrl.signal,
          redirect: "follow",
        });
        clearTimeout(timer);
        if (res.ok) {
          finalUrl = res.url;
          pageText = extractArticleText(await res.text());
        }
      } catch {
        // Fall back to the feed summary below.
      }
      if (existingLinks.has(finalUrl)) continue;
      const sourceText = (pageText || item.description).trim();
      if (sourceText.length < 40) continue;

      const rewritten = await ctx.inference.complete(
        `You are the journalist for Lakay News, the newsroom of the Lakay app for Haitians everywhere. ` +
          `Write ONE short news post in English from the facts below, in Lakay's own words: as short as possible, ` +
          `but the whole news — who, what, when, where, and by whom if it is known, with the date of the event stated ` +
          `in the text. Two to five short sentences, roughly 40-110 words. Do not pad, do not repeat the headline in ` +
          `the body. If something is not confirmed yet, hedge it inside the post itself with "reportedly", "allegedly" ` +
          `or "according to ${item.sourceName}", and never state an unconfirmed claim as fact. NEVER put a link or a URL ` +
          `anywhere in the title or the body. End the body with the credit "— via ${item.sourceName}". ` +
          `Never invent a fact, quote, date, name, or reaction.\n\nFACTS:\n${sourceText.slice(0, 4000)}`,
        { schema: rewriteSchema, timeout_secs: 45 },
      );
      if (/https?:\/\//i.test(rewritten.title) || /https?:\/\//i.test(rewritten.body)) {
        console.log("[lakay] journalist: rewrite contained a URL, skipping story");
        continue;
      }

      // Safe-source picture only: Wikimedia Commons first, else one of
      // Lakay's own images. Never a photo from a news site.
      const subject = item.title.replace(/[^A-Za-zÀ-ÿ' -]/g, " ").split(" ").slice(0, 4).join(" ");
      const image =
        (await commonsImage(`${subject} Haiti`)) ??
        (await commonsImage("Haiti")) ??
        LAKAY_OWN_IMAGE;

      const result = await Actions.saveDailyArticle.handler(ctx, {
        sourceUrl: finalUrl,
        sourceName: item.sourceName,
        sourceTitle: item.title,
        sourceText: sourceText.slice(0, 6000),
        title: rewritten.title,
        body: rewritten.body,
        imageUrl: image,
        sourcePublishedAt: item.pubDate ? new Date(item.pubDate).toISOString() : undefined,
      });
      if (result.saved) {
        saved += 1;
        existingLinks.add(finalUrl);
        console.log(`[lakay] journalist: saved "${rewritten.title}"`);
      }
    } catch (e) {
      console.error(`[lakay] journalist: story "${item.title}" failed:`, e);
    }
    if (Date.now() - started > 240_000) break; // never run a round past 4 minutes
  }
  console.log(`[lakay] journalist round ${roundKey} finished: ${saved} post(s) saved`);
}
