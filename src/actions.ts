// Actions for Lakay.
//
// The news is Lakay's own: seven times a day the Lakay journalist
// (a research task started by refreshDailyArticles) searches the web,
// verifies the facts on the source pages, writes each story as a
// short post in Lakay's own words, and saves it through
// saveDailyArticle; listDailyArticles serves those posts. No other
// site's articles are fetched or shown. Everything else is the
// community's own data — the Home wall, stories & confessions,
// questions for Lakay, music spotlights, events, kont — all stored
// in ctx.db and written only through these actions. Posting and
// commenting take a free account: the write actions verify the
// member's email + password hash against the member list and stamp
// the post or comment with the member's account name, so nothing
// on Lakay is posted or commented anonymously.

import { defineAction, z, type ActionsModule, type Ctx } from "./shim.js";
import { and, asc, desc, eq, gte, inArray, isNotNull, sql } from "drizzle-orm";
import * as schema from "./schema.js";

// The shared shape of a news post on its way through translation:
// Lakay's own posts are written in English by the daily journalist
// task, so for readers in another language the headline and body are
// translated with the model, once per post, and cached in-process by
// the post's source link.
interface FeedItem {
  title: string;
  link: string;
  source: string;
  published_at: string | null;
  excerpt: string;
  image_url: string | null;
}

// News-post translation: for readers in another language the posts'
// headlines and bodies are translated with the model, once per
// post, and stored in the news_translations table forever (an
// in-process cache sits in front of the table as a fast path).
// Storing them is what makes a language switch fast and complete:
// before the table existed the translations lived only in this
// process's memory, so every server restart threw them away and
// the next switch paid the full wait again. On any failure the
// original English is shown for that response — a real post
// untranslated beats a missing one — and the response reports how
// many posts are still pending so the client knows to ask again
// in a few seconds instead of keeping the half-translated page.
const translationCache = new Map<
  string,
  { title: string; excerpt: string }
>();

const LANG_NAMES_FOR_TRANSLATION: Record<string, string> = {
  en: "English",
  ht: "Haitian Creole (Kreyòl Ayisyen)",
  fr: "French",
  pt: "Portuguese",
  es: "Spanish",
};

// Each translated item echoes its number from the prompt, and the
// cache is filled by number — a reply that drops or merges an item
// can no longer void the whole chunk (which is exactly what kept
// the first Haitian Times chunk, the lead lane, untranslated).
const translationSchema = z.object({
  items: z.array(
    z.object({ n: z.number(), title: z.string(), excerpt: z.string() }),
  ),
});

async function translateItems(
  ctx: Ctx,
  items: FeedItem[],
  lang: string,
): Promise<{ items: FeedItem[]; pendingCount: number }> {
  const target = LANG_NAMES_FOR_TRANSLATION[lang];
  if (!target || items.length === 0) return { items, pendingCount: 0 };
  const db = ctx.db<typeof schema>();
  // What this process already knows, by source link.
  const known = new Map<string, { title: string; excerpt: string }>();
  for (const item of items) {
    const hit = translationCache.get(`${lang}:${item.link}`);
    if (hit) known.set(item.link, hit);
  }
  // Durable translations: rows stored by any earlier read, on any
  // device, in any server run. A stored row only counts if it
  // translates the post as it stands now — a rewritten post (its
  // English title or body changed) retranslates instead of serving
  // the stale version.
  if (known.size < items.length) {
    try {
      const stored = await db
        .select()
        .from(schema.newsTranslations)
        .where(
          and(
            eq(schema.newsTranslations.lang, lang),
            inArray(
              schema.newsTranslations.link,
              items.map((i) => i.link),
            ),
          ),
        );
      const byLink = new Map(items.map((i) => [i.link, i]));
      for (const row of stored) {
        const item = byLink.get(row.link);
        if (
          item &&
          row.sourceTitle === item.title &&
          row.sourceBody === item.excerpt
        ) {
          const value = { title: row.title, excerpt: row.body };
          translationCache.set(`${lang}:${row.link}`, value);
          known.set(row.link, value);
        }
      }
    } catch {
      // A store read failure never blocks the news — the in-process
      // cache and a fresh translation below still apply.
    }
  }
  const pending = items.filter((item) => !known.has(item.link));
  if (pending.length > 0) {
    // Chunks are packed by text size, not by count: a chunk of six
    // posts carries six full bodies and its
    // translation call could not finish inside the budget below.
    // Small prompts finish fast, so a chunk
    // closes at ~800 characters of headline + excerpt (or 6 items).
    const chunks: FeedItem[][] = [];
    let chunk: FeedItem[] = [];
    let chunkChars = 0;
    for (const item of pending) {
      const size = item.title.length + item.excerpt.length;
      if (chunk.length > 0 && (chunkChars + size > 800 || chunk.length >= 6)) {
        chunks.push(chunk);
        chunk = [];
        chunkChars = 0;
      }
      chunk.push(item);
      chunkChars += size;
    }
    if (chunk.length > 0) chunks.push(chunk);
    const translating = Promise.all(
      chunks.map(async (chunk) => {
        try {
          const result = await ctx.inference.complete(
            `Translate each news headline and text below into ${target}. ` +
              `Keep the names of people, places, and organizations unchanged. ` +
              `Return every item with its number in the n field.\n\n` +
              chunk
                .map(
                  (it, i) =>
                    `${i + 1}. HEADLINE: ${it.title}\n   EXCERPT: ${it.excerpt || "(none)"}`,
                )
                .join("\n"),
            // A single translation call gets a hard cap, so one hung
            // call can never stall the lane forever.
            { schema: translationSchema, timeout_secs: 45 },
          );
          // Fill the cache by echoed item number: whatever came back
          // translated is kept, and only the missing numbers stay in
          // the original language for the next attempt.
          for (const t of result.items) {
            const item = chunk[t.n - 1];
            if (item && t.title.trim()) {
              const value = {
                title: t.title,
                // An item with no excerpt sends the placeholder
                // "(none)" — and the model translates the placeholder
                // itself ("(okenn)", "(aucun)", "(ninguno)…), which
                // then showed on cards as if it were a real excerpt.
                // An originally-empty excerpt stays empty, always.
                excerpt: !item.excerpt
                  ? ""
                  : t.excerpt === "(none)"
                    ? ""
                    : t.excerpt,
              };
              translationCache.set(`${lang}:${item.link}`, value);
              known.set(item.link, value);
              // Store it for good: the next reader in this language
              // — and this reader after any server restart — gets
              // this post translated instantly, with no model wait.
              try {
                await db
                  .insert(schema.newsTranslations)
                  .values({
                    lang,
                    link: item.link,
                    sourceTitle: item.title,
                    sourceBody: item.excerpt,
                    title: value.title,
                    body: value.excerpt,
                  })
                  .onConflictDoUpdate({
                    target: [
                      schema.newsTranslations.link,
                      schema.newsTranslations.lang,
                    ],
                    set: {
                      sourceTitle: item.title,
                      sourceBody: item.excerpt,
                      title: value.title,
                      body: value.excerpt,
                    },
                  });
              } catch {
                // The in-process cache still holds it for this run.
              }
            }
          }
        } catch {
          // Leave these items in the original language.
        }
      }),
    );
    // Translation must never hold the news hostage. On a cold store
    // the Kreyòl path translates every post at once, and waiting for
    // every chunk left the Creole news stuck on its loading state
    // long after the English news had loaded. So the response waits
    // only a short budget for translations: chunks that land in time
    // are applied below, and chunks still running keep filling the
    // cache and the store in the background. What is still missing
    // when the budget runs out is reported as pending, and the
    // client quietly asks again a few seconds later — so the page
    // finishes switching to the reader's language on its own
    // instead of keeping English leftovers until a manual refresh.
    // Untranslated beats invisible, but only for one response.
    await Promise.race([
      translating,
      new Promise((resolve) => setTimeout(resolve, 9_000)),
    ]);
  }
  const translatedItems = items.map((item) => {
    const cached = known.get(item.link);
    return cached
      ? {
          ...item,
          title: cached.title,
          excerpt: item.excerpt ? cached.excerpt : "",
        }
      : item;
  });
  return {
    items: translatedItems,
    pendingCount: items.filter((item) => !known.has(item.link)).length,
  };
}

// News comment counts ride on every news post (the "💬 N comments"
// toggle under each post): one grouped query over news_comments for
// all the links in a response, instead of a query per card.
async function attachNewsCommentCounts(
  ctx: Ctx,
  items: FeedItem[],
): Promise<(FeedItem & { comment_count: number })[]> {
  if (items.length === 0) return [];
  const db = ctx.db<typeof schema>();
  const rows = await db
    .select({
      link: schema.newsComments.link,
      count: sql<number>`count(*)`,
    })
    .from(schema.newsComments)
    .where(inArray(schema.newsComments.link, items.map((i) => i.link)))
    .groupBy(schema.newsComments.link);
  const byLink = new Map(rows.map((r) => [r.link, r.count]));
  return items.map((i) => ({ ...i, comment_count: byLink.get(i.link) ?? 0 }));
}

// ---------------------------------------------------------------------------
// Keep-it-clean filter
//
// Community posts cannot curse. When someone writes a bad word, the word
// is stored as a run of "•" characters, and the client renders those runs
// blurred — the post still reads, but the word stays hidden. Matching is
// tolerant of leetspeak (f*ck, sh1t), stretched letters (fuuuck), and
// separators between letters, and covers the common swear words of the
// app's five languages.
// ---------------------------------------------------------------------------

const BAD_WORDS = [
  // English
  "motherfucker", "bullshit", "fuck", "shit", "bitch", "asshole",
  "bastard", "cunt", "dick", "cock", "pussy", "whore", "slut",
  "nigger", "nigga", "faggot", "damn",
  // French
  "putain", "merde", "salope", "connard", "encule",
  // Spanish
  "mierda", "puta", "puto", "joder", "pendejo", "cabron",
  // Portuguese
  "caralho", "porra", "merda", "foda",
  // Haitian Creole — the bad slang of home: "kou langèt" (aimed at
  // someone's mother, the strongest insult in Kreyòl), "bouzen",
  // "kaka", "mèd", "bounda", "kokorat", "salop". Accented and
  // unaccented spellings both listed: the matcher works on the raw
  // letters, so "langèt" does not match a pattern built from
  // "langet" and the other way around.
  "langet", "langèt", "bouzen", "gwobouzen", "kaka", "mèd",
  "bounda", "kokorat", "salop",
].sort((a, b) => b.length - a.length);

const LEET: Record<string, string> = {
  a: "a4@", e: "e3", i: "i1!", o: "o0", s: "s5$", t: "t7",
};

function badWordPattern(word: string): string {
  return word
    .split("")
    .map((ch) => {
      const alts = LEET[ch] ?? ch;
      return `[${alts.replace(/[\\\]^\-]/g, "\\$&")}]+`;
    })
    .join("[\\s._\\-*]*");
}

const BAD_WORD_RE = new RegExp(
  `(?<![A-Za-z0-9])(${BAD_WORDS.map(badWordPattern).join("|")})(?![A-Za-z0-9])`,
  "gi",
);

function censorText(text: string): string {
  return text.replace(BAD_WORD_RE, (match) => {
    const letters = match.replace(/[^A-Za-z0-9]/g, "").length;
    return "•".repeat(Math.max(3, Math.min(letters, 10)));
  });
}

// ---------------------------------------------------------------------------
// Who is writing — accounts are required, names are real
//
// The owner's rule: everybody can post, but nobody posts or comments
// anonymously. Every write action takes the writer's member email +
// the SHA-256 hash of their password (the same hash sign-in uses —
// the plain password never crosses the wire) and the author name
// stamped on the row comes from the member list itself, never from
// a name the caller typed, so a post always says who really wrote
// it. The one exception is the owner in admin mode (asAdmin): his
// posts and comments carry the Lakay name — but the flag alone
// proves nothing. Admin used to be a bare on/off switch stored on
// the device, so ANY signed-in account (or none) could flip it and
// write as Lakay, edit, and delete. Now the admin path runs the
// same proof as the member list (verifiedOwner): the caller must
// also present the admin code's hash AND the account that code is
// bound to — the owner's own. Credentials that are present but
// wrong are refused outright — they never fall through to another
// path.
// ---------------------------------------------------------------------------

const memberCredFields = {
  memberEmail: z.string().trim().toLowerCase().min(3).max(120).optional(),
  memberPwHash: z.string().trim().min(16).max(128).optional(),
  asAdmin: z.boolean().optional(),
  // The admin code's SHA-256 hash (the device remembers the hash,
  // never the code) — required, together with the bound account's
  // own credentials, whenever asAdmin is claimed.
  codeHash: z.string().trim().max(128).optional(),
};

type MemberCredArgs = {
  memberEmail?: string;
  memberPwHash?: string;
  asAdmin?: boolean;
  codeHash?: string;
};

async function verifiedMember(
  ctx: Ctx,
  args: MemberCredArgs,
): Promise<{ name: string; email: string } | null> {
  if (!args.memberEmail || !args.memberPwHash) return null;
  const db = ctx.db<typeof schema>();
  const rows = await db
    .select({ name: schema.members.name, email: schema.members.email, pwHash: schema.members.pwHash })
    .from(schema.members)
    .where(eq(schema.members.email, args.memberEmail))
    .limit(1);
  const row = rows[0];
  if (!row || row.pwHash !== args.memberPwHash) return null;
  return { name: row.name, email: row.email };
}

// The owner check behind every admin surface — the member list,
// member removal, the likers list, the spotlight pick, the recovery
// key, and issuing password-reset codes. The admin code alone no
// longer opens anything: the code is BOUND to one member account —
// the owner's — and the caller must also prove that account (email
// + password hash, verified exactly like sign-in). A code created
// before binding existed carries no owner_email yet; the first
// caller who presents the valid code AND a real account's correct
// password binds that account as the owner (in practice the owner
// himself — the only person who knows the code he created), and
// from then on the binding is always required.
async function verifiedOwner(
  ctx: Ctx,
  args: { codeHash?: string; memberEmail?: string; memberPwHash?: string },
): Promise<boolean> {
  if (!args.codeHash) return false;
  const db = ctx.db<typeof schema>();
  const rows = await db
    .select({
      codeHash: schema.adminAccess.codeHash,
      ownerEmail: schema.adminAccess.ownerEmail,
    })
    .from(schema.adminAccess)
    .limit(1);
  const access = rows[0];
  if (!access || access.codeHash !== args.codeHash) return false;
  const member = await verifiedMember(ctx, args);
  if (!member) return false;
  if (access.ownerEmail) return access.ownerEmail === member.email;
  await db
    .update(schema.adminAccess)
    .set({ ownerEmail: member.email })
    .where(eq(schema.adminAccess.id, 1));
  return true;
}

// The owner acting as admin: writing as Lakay, and every
// moderation control (edit / delete / hide, the owner's message,
// polls, answering questions). The asAdmin flag by itself is just a
// claim — it counts only when the caller ALSO passes verifiedOwner:
// the admin code's hash plus proof of the account that code is
// bound to. Any other account, the right account with no code, or
// the code with the wrong account all fail here, so admin mode is
// the owner's and only the owner's.
async function verifiedAdmin(
  ctx: Ctx,
  args: MemberCredArgs,
): Promise<boolean> {
  if (!args.asAdmin) return false;
  return verifiedOwner(ctx, {
    codeHash: args.codeHash,
    memberEmail: args.memberEmail,
    memberPwHash: args.memberPwHash,
  });
}

// The gate in front of every moderation-only action: without the
// owner's code + bound account, the action does not happen at all.
async function requireAdmin(ctx: Ctx, args: MemberCredArgs): Promise<void> {
  const ok = await verifiedOwner(ctx, {
    codeHash: args.codeHash,
    memberEmail: args.memberEmail,
    memberPwHash: args.memberPwHash,
  });
  if (!ok) {
    throw new Error(
      "admin_required: this control belongs to Lakay's owner — it takes the admin code and the account that code is tied to",
    );
  }
}

// SHA-256 hex, the same digest the client computes (over the
// `lakay:`-prefixed string) for passwords, codes, and keys — used
// server-side only for the password-reset codes the server itself
// generates, so what is stored matches what the client will send.
async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return [...new Uint8Array(buf)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// The author name for a post or comment: the verified member's
// account name, or "Lakay" for the owner writing in admin mode —
// and admin mode itself must check out (verifiedAdmin: the code
// plus the account it is bound to). Anything else throws — the
// write does not happen.
async function authorNameForWrite(
  ctx: Ctx,
  args: MemberCredArgs,
): Promise<string> {
  if (args.asAdmin) {
    if (await verifiedAdmin(ctx, args)) return "Lakay";
    throw new Error(
      "login_required: writing as Lakay takes the owner's account and admin code",
    );
  }
  if (args.memberEmail || args.memberPwHash) {
    const member = await verifiedMember(ctx, args);
    if (member) return member.name;
    throw new Error("login_required: those account details did not check out");
  }
  throw new Error("login_required: posting and commenting take a free Lakay account");
}

// ---------------------------------------------------------------------------
// Shared row shapes
// ---------------------------------------------------------------------------

const storyShape = z.object({
  id: z.number(),
  kind: z.enum(["story", "confession"]),
  title: z.string(),
  body: z.string(),
  author_name: z.string().nullable(),
  image_url: z.string().nullable(),
  hearts: z.number(),
  comment_count: z.number(),
  created_at: z.string(),
});

const commentShape = z.object({
  id: z.number(),
  story_id: z.number(),
  body: z.string(),
  author_name: z.string().nullable(),
  created_at: z.string(),
});

const questionShape = z.object({
  id: z.number(),
  name: z.string().nullable(),
  topic: z.string(),
  question: z.string(),
  answer: z.string().nullable(),
  answered_at: z.string().nullable(),
  created_at: z.string(),
});

const spotlightShape = z.object({
  id: z.number(),
  artist: z.string(),
  song: z.string().nullable(),
  genre: z.string(),
  note: z.string(),
  link: z.string().nullable(),
  added_by: z.string().nullable(),
  likes: z.number(),
  comment_count: z.number(),
  image_urls: z.array(z.string()),
  video_url: z.string().nullable(),
  created_at: z.string(),
});

const spotlightCommentShape = z.object({
  id: z.number(),
  spotlight_id: z.number(),
  body: z.string(),
  author_name: z.string().nullable(),
  created_at: z.string(),
});

const pollShape = z.object({
  id: z.number(),
  question: z.string(),
  options: z.array(
    z.object({ id: z.number(), label: z.string(), votes: z.number() }),
  ),
  created_at: z.string(),
});

// A kont on the board. The stored answer is deliberately NOT part
// of this shape: it only ever leaves the server through
// getRiddleAnswer, when a reader taps to peek.
const riddleShape = z.object({
  id: z.number(),
  riddle: z.string(),
  author_name: z.string().nullable(),
  answer_count: z.number(),
  created_at: z.string(),
});

const riddleAnswerShape = z.object({
  id: z.number(),
  riddle_id: z.number(),
  body: z.string(),
  author_name: z.string().nullable(),
  created_at: z.string(),
});

const newsCommentShape = z.object({
  id: z.number(),
  link: z.string(),
  body: z.string(),
  author_name: z.string().nullable(),
  created_at: z.string(),
});

const messageCommentShape = z.object({
  id: z.number(),
  body: z.string(),
  author_name: z.string().nullable(),
  created_at: z.string(),
});

const ownerPostShape = z.object({
  id: z.number(),
  title: z.string().nullable(),
  body: z.string(),
  image_urls: z.array(z.string()),
  video_link: z.string().nullable(),
  link_url: z.string().nullable(),
  // Who wrote the post: the member's account name, or null for the
  // owner's own posts (shown under the Lakay name). mine is true
  // when the caller proved (email + password hash) that the post is
  // theirs, so the client can offer them the delete control.
  author_name: z.string().nullable(),
  // The author's hometown (their town in Haiti or their city
  // abroad), from their member account — shown on the post so
  // people can find their own people, and what the wall's
  // hometown filter matches. Null for the owner's posts and for
  // members who haven't picked one.
  author_hometown: z.string().nullable(),
  mine: z.boolean(),
  likes: z.number(),
  comment_count: z.number(),
  created_at: z.string(),
});

// One of Lakay's own news posts: Lakay's headline and the whole
// short post, the real photo when the story has one, and the credit
// for where the facts were reported (source name + the link readers
// can open to check).
const lakayNewsPostShape = z.object({
  id: z.number(),
  title: z.string(),
  body: z.string(),
  source: z.string(),
  link: z.string(),
  image_url: z.string().nullable(),
  published_at: z.string(),
  comment_count: z.number(),
});

const ownerPostCommentShape = z.object({
  id: z.number(),
  post_id: z.number(),
  body: z.string(),
  author_name: z.string().nullable(),
  created_at: z.string(),
});

const eventShape = z.object({
  id: z.number(),
  title: z.string(),
  city: z.string(),
  venue: z.string().nullable(),
  event_date: z.string(),
  time_label: z.string().nullable(),
  details: z.string(),
  link: z.string().nullable(),
  added_by: z.string().nullable(),
  going_count: z.number(),
  created_at: z.string(),
});

const shoutoutShape = z.object({
  id: z.number(),
  name: z.string(),
  address: z.string(),
  food: z.string(),
  note: z.string().nullable(),
  added_by: z.string().nullable(),
  created_at: z.string(),
});

const rsvpShape = z.object({
  id: z.number(),
  event_id: z.number(),
  name: z.string(),
  created_at: z.string(),
});

const leaderboardEntryShape = z.object({
  name: z.string(),
  points: z.number(),
  chapters_done: z.number(),
});

// The trivia leaderboard's week: the Monday (YYYY-MM-DD, UTC) of the
// current week. A player's row for the week keeps their best total.
function currentWeekKey(): string {
  const d = new Date();
  const daysSinceMonday = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - daysSinceMonday);
  return d.toISOString().slice(0, 10);
}

const okResponse = z.object({ ok: z.literal(true) });

// ---------------------------------------------------------------------------
// Community-text translation (the small Translate button on posts,
// stories, comments, questions). One piece of text, one target
// language. A finished translation is stored in text_translations
// forever, keyed by the exact source text, so the slow path below
// runs at most once per text per language, for everyone.
//
// The slow path used to be a single model call with a JSON-object
// schema and a 30-second cap, and the client gave up on the first
// failure — which is why readers saw translations take forever or
// never arrive at all: one slow or failed call was the whole story.
// Now the model returns the translation as plain text (no JSON
// wrapping to generate or validate, so calls finish sooner and far
// fewer fail validation), a failed or empty attempt is retried
// instead of surfaced, and simultaneous taps on the same post share
// one in-flight translation instead of each paying for their own.
const inflightTextTranslations = new Map<string, Promise<string>>();

async function translateTextFresh(
  ctx: Ctx,
  text: string,
  lang: string,
  target: string,
): Promise<string> {
  const db = ctx.db<typeof schema>();
  const key = `${lang}\n${text}`;
  const running = inflightTextTranslations.get(key);
  if (running) return running;
  const work = (async (): Promise<string> => {
    let lastError: unknown = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const raw = await ctx.inference.complete(
          `You are an expert translator for a Haitian community app. ` +
            `Translate the text below into ${target}, as accurately as you can. ` +
            `The text may be written in English, Haitian Creole, French, Spanish, Portuguese, or a mix — translate all of it. ` +
            `Be faithful and complete: the same meaning and the same tone (formal or casual), the same line breaks, ` +
            `nothing added, nothing explained, and nothing left out. Keep the names of people and places unchanged, ` +
            `and keep any • characters exactly as they are. Return only the translation itself.\n\n` +
            text,
          { schema: z.string(), timeout_secs: 25 },
        );
        const translated = raw.trim();
        if (translated) {
          try {
            await db
              .insert(schema.textTranslations)
              .values({ sourceText: text, lang, translated })
              .onConflictDoNothing();
          } catch {
            // The translation is still returned — only the
            // remembering failed.
          }
          return translated;
        }
        lastError = new Error("translation came back empty");
      } catch (e) {
        lastError = e;
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new Error("translateUserText: translation failed");
  })();
  inflightTextTranslations.set(key, work);
  try {
    return await work;
  } finally {
    inflightTextTranslations.delete(key);
  }
}

// ---------------------------------------------------------------------------
// Signup email check: real addresses only, but NO verification gate.
//
// The owner wants fake signups stopped — today any string with an @
// in it opens an account. What he does NOT want is a verification
// step: nobody should have to go check their inbox, click a link,
// or type a code before they can use Lakay (Lakay has no email
// channel anyway — the forgot-password flow already works with
// owner-issued codes for that reason). So signup checks that the
// address is REAL, then lets the person straight in:
//
//   1. Properly formed: a normal local part, a domain with a real
//      public ending, no doubled dots or stray spaces.
//   2. Not a throwaway: the well-known temporary-inbox services
//      (mailinator and friends) are refused — those addresses are
//      real domains, so the domain check alone would wave them
//      through, but nobody's real email lives there.
//   3. The domain must actually be able to receive mail: a DNS
//      lookup (over HTTPS) must find mail servers for it, or at
//      least the domain itself. A made-up domain — the classic
//      fake signup — has neither and is refused.
//
// The lookup can also fail to answer at all (network trouble on
// either side); that is NOT treated as fake — the signup proceeds
// on the strength of checks 1–2 rather than locking real people
// out because a DNS service hiccuped.
// ---------------------------------------------------------------------------

const SIGNUP_EMAIL_RE =
  /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/;

// Temporary / throwaway inbox domains — addresses here are
// disposable by design, which is exactly the "not a legit email"
// case the owner wants refused.
const THROWAWAY_EMAIL_DOMAINS = new Set([
  "mailinator.com",
  "mailinator.net",
  "mailinator2.com",
  "notmailinator.com",
  "guerrillamail.com",
  "guerrillamail.info",
  "guerrillamail.net",
  "guerrillamail.org",
  "guerrillamail.biz",
  "guerrillamail.de",
  "guerrillamailblock.com",
  "sharklasers.com",
  "pokemail.net",
  "spam4.me",
  "10minutemail.com",
  "tempmail.com",
  "temp-mail.org",
  "temp-mail.io",
  "tempmail.net",
  "tmpmail.net",
  "tmpmail.org",
  "yopmail.com",
  "yopmail.net",
  "throwawaymail.com",
  "getnada.com",
  "nada.email",
  "maildrop.cc",
  "dispostable.com",
  "fakeinbox.com",
  "trashmail.com",
  "trashmail.net",
  "mohmal.com",
  "emailondeck.com",
  "mintemail.com",
  "mytemp.email",
  "tempinbox.com",
  "mailnesia.com",
  "bccto.me",
  "chogmail.com",
  "reallymymail.com",
  "mailcatch.com",
  "spamgourmet.com",
  "jetable.org",
  "example.com",
  "example.org",
  "example.net",
  "test.com",
  "fake.com",
]);

function signupEmailLooksFake(email: string): boolean {
  if (email.length > 254) return true;
  if (!SIGNUP_EMAIL_RE.test(email)) return true;
  const at = email.lastIndexOf("@");
  const local = email.slice(0, at);
  const domain = email.slice(at + 1).toLowerCase();
  if (local.length === 0 || local.length > 64) return true;
  if (local.startsWith(".") || local.endsWith(".") || local.includes("..")) {
    return true;
  }
  if (domain.includes("..")) return true;
  const labels = domain.split(".");
  const tld = labels[labels.length - 1] ?? "";
  if (tld.length < 2) return true;
  // Exact throwaway domain, or any subdomain of one.
  if (THROWAWAY_EMAIL_DOMAINS.has(domain)) return true;
  for (const blocked of THROWAWAY_EMAIL_DOMAINS) {
    if (domain.endsWith(`.${blocked}`)) return true;
  }
  return false;
}

// Can this domain receive mail at all? true = yes (it has mail
// servers, or at least resolves itself — mail falls back to the
// domain's own address when no MX is published), false = the DNS
// answer is definitive that there is nothing there (no such domain,
// or a domain with no mail route at all), null = the lookup could
// not be completed, which the caller treats as "don't block".
async function domainCanReceiveMail(
  domain: string,
): Promise<boolean | null> {
  type Lookup = "records" | "none" | "nxdomain" | "unknown";
  const lookup = async (type: "MX" | "A"): Promise<Lookup> => {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 4000);
      const res = await fetch(
        `https://dns.google/resolve?name=${encodeURIComponent(domain)}&type=${type}`,
        { headers: { accept: "application/dns-json" }, signal: ctrl.signal },
      );
      clearTimeout(timer);
      if (!res.ok) return "unknown";
      const data = (await res.json()) as {
        Status?: number;
        Answer?: unknown[];
      };
      if (data.Status === 3) return "nxdomain";
      if (data.Status !== 0) return "unknown"; // SERVFAIL etc.
      return Array.isArray(data.Answer) && data.Answer.length > 0
        ? "records"
        : "none";
    } catch {
      return "unknown";
    }
  };
  const mx = await lookup("MX");
  if (mx === "records") return true;
  if (mx === "nxdomain") return false;
  if (mx === "unknown") return null;
  // The domain exists but publishes no mail servers: mail then
  // falls back to the domain's own address, so check that.
  const a = await lookup("A");
  if (a === "records") return true;
  if (a === "nxdomain" || a === "none") return false;
  return null;
}

// The owner's whole-app overview for the Settings panel: real
// counts from Lakay's own tables, nothing else. counts is null
// whenever the caller is not the verified owner (locked).
const adminOverviewResponse = z.object({
  locked: z.boolean(),
  counts: z
    .object({
      members: z.number(),
      stories: z.number(),
      posts: z.number(),
      comments: z.number(),
      questions_waiting: z.number(),
      songs: z.number(),
      events: z.number(),
      polls: z.number(),
      kont: z.number(),
      news_posts: z.number(),
      supporters: z.number(),
      home_now: z.number(),
    })
    .nullable(),
});

// The owner's Database section for Settings: the live state of
// Lakay's own database (per-table row counts + totals), the admin
// binding, and the app-control state the control buttons act on.
// Every field is null/empty whenever the caller is not the
// verified owner (locked) — regular members get nothing at all.
const adminDatabaseResponse = z.object({
  locked: z.boolean(),
  checked_at: z.string().nullable(),
  owner_email: z.string().nullable(),
  code_set: z.boolean(),
  recovery_set: z.boolean(),
  tables: z.array(z.object({ name: z.string(), rows: z.number() })),
  total_rows: z.number(),
  hidden_news: z.number(),
  owner_message_posted: z.boolean(),
  owner_message_updated_at: z.string().nullable(),
  spotlight_name: z.string().nullable(),
  presence_active: z.number(),
  presence_stale: z.number(),
});

export const Actions = {
  registerMember: defineAction({
    description:
      "Creates a free Lakay member account on the server: the person's name and email join Lakay's member list (the list the owner can see in admin mode), keyed by email. The password arrives only as the SHA-256 hash the client computes — plain-text passwords are never sent or stored. The email must be a real one: properly formed, not a throwaway-inbox domain, and on a domain that can actually receive mail (checked live over DNS) — a fake or made-up address is refused with email_invalid:true and NO account is created. There is deliberately no verification step: an address that passes goes straight in, nobody waits on an inbox. If the email already has an account, nothing is written and email_taken comes back true.",
    request: z.object({
      name: z.string().trim().min(1).max(60),
      email: z.string().trim().toLowerCase().min(3).max(120),
      pwHash: z.string().trim().min(16).max(128),
    }),
    response: z.object({
      ok: z.boolean(),
      email_taken: z.boolean(),
      email_invalid: z.boolean(),
    }),
    handler: async (
      ctx,
      args,
    ): Promise<{ ok: boolean; email_taken: boolean; email_invalid: boolean }> => {
      // Real-email check first: malformed or throwaway addresses
      // are refused outright, and the domain must be able to
      // receive mail (a made-up domain can't). A lookup that can't
      // be completed doesn't block — see domainCanReceiveMail.
      if (signupEmailLooksFake(args.email)) {
        return { ok: false, email_taken: false, email_invalid: true };
      }
      const domain = args.email.slice(args.email.lastIndexOf("@") + 1);
      const canReceive = await domainCanReceiveMail(domain);
      if (canReceive === false) {
        return { ok: false, email_taken: false, email_invalid: true };
      }
      const db = ctx.db<typeof schema>();
      const existing = await db
        .select({ id: schema.members.id })
        .from(schema.members)
        .where(eq(schema.members.email, args.email))
        .limit(1);
      if (existing.length > 0) {
        return { ok: false, email_taken: true, email_invalid: false };
      }
      await db.insert(schema.members).values({
        name: censorText(args.name),
        email: args.email,
        pwHash: args.pwHash,
      });
      ctx.invalidateQueries();
      return { ok: true, email_taken: false, email_invalid: false };
    },
  }),

  signInMember: defineAction({
    description:
      "Signs a Lakay member back in: checks the email + password hash against the member list and returns the member's name when they match. Nothing is written either way.",
    request: z.object({
      email: z.string().trim().toLowerCase().min(3).max(120),
      pwHash: z.string().trim().min(16).max(128),
    }),
    response: z.object({
      ok: z.boolean(),
      name: z.string().nullable(),
      hometown: z.string().nullable(),
    }),
    handler: async (
      ctx,
      args,
    ): Promise<{ ok: boolean; name: string | null; hometown: string | null }> => {
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select()
        .from(schema.members)
        .where(eq(schema.members.email, args.email))
        .limit(1);
      const row = rows[0];
      if (!row || row.pwHash !== args.pwHash) {
        return { ok: false, name: null, hometown: null };
      }
      return { ok: true, name: row.name, hometown: row.hometown ?? null };
    },
  }),

  setMemberHometown: defineAction({
    description:
      "Sets (or clears) a member's hometown — the town in Haiti they're from, or the city abroad they live in — shown on their wall posts so people can find their own people. The caller proves the account with the same email + password hash as sign-in; wrong details change nothing.",
    request: z.object({
      email: z.string().trim().toLowerCase().min(3).max(120),
      pwHash: z.string().trim().min(16).max(128),
      hometown: z.string().trim().max(60),
    }),
    response: z.object({ ok: z.boolean() }),
    handler: async (ctx, args): Promise<{ ok: boolean }> => {
      const db = ctx.db<typeof schema>();
      const member = await verifiedMember(ctx, {
        memberEmail: args.email,
        memberPwHash: args.pwHash,
      });
      if (!member) return { ok: false };
      await db
        .update(schema.members)
        .set({ hometown: args.hometown ? censorText(args.hometown) : null })
        .where(eq(schema.members.email, member.email));
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),

  resetMemberPassword: defineAction({
    description:
      "Resets a member's password ('forgot password' on the sign-in screen) — only with a one-time reset code. Lakay has no email-sending channel, so the code is the secret: the owner issues one for the member from the member list (issueMemberResetCode) and hands it over out-of-band; the member enters their email, the code, and a new password. The server compares the code's hash against the stored one, checks it has not expired (48 hours), replaces the password hash, and burns the code. Name, email, or any other public fact about the account authorizes nothing — an earlier version accepted the account's display name as proof, and names are public all over Lakay.",
    request: z.object({
      email: z.string().trim().toLowerCase().min(3).max(120),
      resetCodeHash: z.string().trim().min(16).max(128),
      pwHash: z.string().trim().min(16).max(128),
    }),
    response: z.object({ ok: z.boolean() }),
    handler: async (ctx, args): Promise<{ ok: boolean }> => {
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select()
        .from(schema.members)
        .where(eq(schema.members.email, args.email))
        .limit(1);
      const row = rows[0];
      if (!row || !row.resetHash || !row.resetExpires) return { ok: false };
      if (row.resetExpires < Date.now()) {
        await db
          .update(schema.members)
          .set({ resetHash: null, resetExpires: null })
          .where(eq(schema.members.id, row.id));
        return { ok: false };
      }
      if (row.resetHash !== args.resetCodeHash) return { ok: false };
      await db
        .update(schema.members)
        .set({ pwHash: args.pwHash, resetHash: null, resetExpires: null })
        .where(eq(schema.members.id, row.id));
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),

  issueMemberResetCode: defineAction({
    description:
      "Issues a one-time password-reset code for one member — the owner's half of the forgot-password flow. Owner-only, behind the same bound-owner check as the member list (admin code + proof of the owner's own account). The code is generated on the server, returned exactly once so the owner can hand it to the member out-of-band, and only its hash is stored, with a 48-hour expiry; issuing a new one replaces the old. The member redeems it through resetMemberPassword.",
    request: z.object({
      codeHash: z.string().trim().max(128).default(""),
      memberEmail: z.string().trim().toLowerCase().min(3).max(120),
      memberPwHash: z.string().trim().min(16).max(128),
      targetEmail: z.string().trim().toLowerCase().min(3).max(120),
    }),
    response: z.object({
      ok: z.boolean(),
      locked: z.boolean(),
      code: z.string().nullable(),
    }),
    handler: async (
      ctx,
      args,
    ): Promise<{ ok: boolean; locked: boolean; code: string | null }> => {
      const isOwner = await verifiedOwner(ctx, args);
      if (!isOwner) return { ok: false, locked: true, code: null };
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select({ id: schema.members.id })
        .from(schema.members)
        .where(eq(schema.members.email, args.targetEmail))
        .limit(1);
      if (!rows[0]) return { ok: false, locked: false, code: null };
      // Eight characters from an alphabet with no look-alikes
      // (no 0/O, 1/I/L) — easy to read aloud or type from a
      // message, and at ~40 bits with a 48-hour life and a single
      // account it can target, not guessable in practice.
      const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
      const bytes = new Uint8Array(8);
      crypto.getRandomValues(bytes);
      const raw = [...bytes].map((b) => alphabet[b % alphabet.length]).join("");
      const code = `${raw.slice(0, 4)}-${raw.slice(4)}`;
      const resetHash = await sha256Hex(`lakay:${raw}`);
      await db
        .update(schema.members)
        .set({ resetHash, resetExpires: Date.now() + 48 * 60 * 60 * 1000 })
        .where(eq(schema.members.id, rows[0].id));
      ctx.invalidateQueries();
      return { ok: true, locked: false, code };
    },
  }),

  getMembersAccess: defineAction({
    description:
      "Says whether the owner's admin code has been created yet, and whether a recovery key exists for it. The member list holds everyone's email, so it stays locked behind that code: until a code exists the list shows nothing to anyone, and once it exists only a caller who presents the code (as its SHA-256 hash) sees the rows.",
    request: z.object({}),
    response: z.object({ code_set: z.boolean(), recovery_set: z.boolean() }),
    handler: async (
      ctx,
    ): Promise<{ code_set: boolean; recovery_set: boolean }> => {
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select({
          id: schema.adminAccess.id,
          recoveryHash: schema.adminAccess.recoveryHash,
        })
        .from(schema.adminAccess)
        .limit(1);
      return {
        code_set: rows.length > 0,
        recovery_set: !!rows[0]?.recoveryHash,
      };
    },
  }),

  verifyAdminAccess: defineAction({
    description:
      "Answers whether admin mode may turn on for this caller — the check the header's Admin switch now asks the server before it lights up. ok:true only when the caller presents BOTH the admin code (as its SHA-256 hash) AND proof of the member account that code is bound to (verifiedOwner — the owner's own account, verified like sign-in). Any other account, a missing code, or a wrong code gets ok:false, so the switch by itself opens nothing for anyone but the owner.",
    request: z.object({
      codeHash: z.string().trim().max(128).default(""),
      memberEmail: z.string().trim().toLowerCase().max(120).optional(),
      memberPwHash: z.string().trim().max(128).optional(),
    }),
    response: z.object({ ok: z.boolean() }),
    handler: async (ctx, args): Promise<{ ok: boolean }> => {
      const ok = await verifiedOwner(ctx, {
        codeHash: args.codeHash,
        memberEmail: args.memberEmail,
        memberPwHash: args.memberPwHash,
      });
      return { ok };
    },
  }),

  setRecoveryKey: defineAction({
    description:
      "Creates (or replaces) the owner's recovery key for the admin code. Creating one requires proving the owner first — the caller presents the current code's SHA-256 hash AND proof of the account the code is bound to (verifiedOwner) — so only the owner can set up the way back in. Only the recovery key's hash is stored; the key itself is shown to the owner once, on his own device, and never sent or stored anywhere else.",
    request: z.object({
      codeHash: z.string().trim().min(16).max(128),
      memberEmail: z.string().trim().toLowerCase().min(3).max(120),
      memberPwHash: z.string().trim().min(16).max(128),
      recoveryHash: z.string().trim().min(16).max(128),
    }),
    response: z.object({ ok: z.boolean() }),
    handler: async (ctx, args): Promise<{ ok: boolean }> => {
      const isOwner = await verifiedOwner(ctx, args);
      if (!isOwner) return { ok: false };
      const db = ctx.db<typeof schema>();
      await db
        .update(schema.adminAccess)
        .set({ recoveryHash: args.recoveryHash })
        .where(eq(schema.adminAccess.id, 1));
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),

  resetAdminCode: defineAction({
    description:
      "Resets a forgotten admin code — the owner's way back into his member list. There is deliberately no reset-by-asking: the caller must present the recovery key (as its SHA-256 hash) that the owner created while he still knew the code, and it must match the stored hash. A match replaces the code hash with the new code's hash and burns the recovery key (one-time use — the owner creates a fresh one after getting back in). Anything else changes nothing and returns ok:false.",
    request: z.object({
      recoveryHash: z.string().trim().min(16).max(128),
      newCodeHash: z.string().trim().min(16).max(128),
    }),
    response: z.object({ ok: z.boolean() }),
    handler: async (ctx, args): Promise<{ ok: boolean }> => {
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select({ recoveryHash: schema.adminAccess.recoveryHash })
        .from(schema.adminAccess)
        .limit(1);
      const stored = rows[0]?.recoveryHash;
      if (!stored || stored !== args.recoveryHash) return { ok: false };
      await db
        .update(schema.adminAccess)
        .set({ codeHash: args.newCodeHash, recoveryHash: null })
        .where(eq(schema.adminAccess.id, 1));
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),

  setAdminCode: defineAction({
    description:
      "Creates the owner's admin code for the member list — once only: if a code already exists this changes nothing and returns ok:false. Creating one takes a real Lakay account: the caller proves a member login (email + password hash, verified like sign-in) and the code is BOUND to that account — from then on the admin surfaces require the code and that account together, so an anonymous first caller can never claim the code. Only the SHA-256 hash of the code is stored, never the code itself.",
    request: z.object({
      codeHash: z.string().trim().min(16).max(128),
      memberEmail: z.string().trim().toLowerCase().min(3).max(120),
      memberPwHash: z.string().trim().min(16).max(128),
    }),
    response: z.object({ ok: z.boolean() }),
    handler: async (ctx, args): Promise<{ ok: boolean }> => {
      const db = ctx.db<typeof schema>();
      const existing = await db
        .select({ id: schema.adminAccess.id })
        .from(schema.adminAccess)
        .limit(1);
      if (existing.length > 0) return { ok: false };
      const member = await verifiedMember(ctx, args);
      if (!member) return { ok: false };
      await db
        .insert(schema.adminAccess)
        .values({ id: 1, codeHash: args.codeHash, ownerEmail: member.email })
        .onConflictDoNothing();
      const check = await db
        .select({
          codeHash: schema.adminAccess.codeHash,
          ownerEmail: schema.adminAccess.ownerEmail,
        })
        .from(schema.adminAccess)
        .limit(1);
      return {
        ok:
          check[0]?.codeHash === args.codeHash &&
          check[0]?.ownerEmail === member.email,
      };
    },
  }),

  listMembers: defineAction({
    description:
      "Lists Lakay's member list — everyone who created a free account, newest first, with the name and email they joined with and when. This is the owner's view of who subscribed, and it is locked on the server: the caller must present the owner's admin code (as its SHA-256 hash) AND prove the member account the code is bound to (verifiedOwner — the code alone is never enough); with no code created yet, or a failed check, it returns locked:true and no rows at all.",
    request: z.object({
      codeHash: z.string().trim().max(128).default(""),
      memberEmail: z.string().trim().toLowerCase().max(120).optional(),
      memberPwHash: z.string().trim().max(128).optional(),
    }),
    response: z.object({
      locked: z.boolean(),
      code_set: z.boolean(),
      members: z.array(
        z.object({
          name: z.string(),
          email: z.string(),
          hometown: z.string().nullable(),
          created_at: z.string(),
        }),
      ),
      total: z.number(),
    }),
    handler: async (
      ctx,
      args,
    ): Promise<{
      locked: boolean;
      code_set: boolean;
      members: {
        name: string;
        email: string;
        hometown: string | null;
        created_at: string;
      }[];
      total: number;
    }> => {
      const db = ctx.db<typeof schema>();
      const access = await db
        .select({ codeHash: schema.adminAccess.codeHash })
        .from(schema.adminAccess)
        .limit(1);
      if (!access[0]) {
        return { locked: true, code_set: false, members: [], total: 0 };
      }
      const isOwner = await verifiedOwner(ctx, args);
      if (!isOwner) {
        return { locked: true, code_set: true, members: [], total: 0 };
      }
      // Only the columns the list shows — password and reset-code
      // hashes never leave the database — and the total is a real
      // count, not the length of the (capped) page of rows.
      const [rows, totalRows] = await Promise.all([
        db
          .select({
            name: schema.members.name,
            email: schema.members.email,
            hometown: schema.members.hometown,
            createdAt: schema.members.createdAt,
          })
          .from(schema.members)
          .orderBy(desc(schema.members.id))
          .limit(1000),
        db.select({ n: sql<number>`count(*)` }).from(schema.members),
      ]);
      return {
        locked: false,
        code_set: true,
        members: rows.map((r) => ({
          name: r.name,
          email: r.email,
          hometown: r.hometown ?? null,
          created_at: r.createdAt.toISOString(),
        })),
        total: totalRows[0]?.n ?? rows.length,
      };
    },
  }),

  getAdminOverview: defineAction({
    description:
      "The owner's whole-app overview for the Settings panel: real counts from Lakay's own tables — members, stories & confessions, Home wall posts, comments across the app, questions still waiting for an answer, songs shared, events, polls, kont riddles, Lakay news posts, supporters, and how many people are home right now. Locked behind the same bound-owner check as the member list (admin code hash + proof of the account the code is bound to): anyone else gets locked:true and no numbers at all, so non-admins never see the app's records.",
    request: z.object({
      codeHash: z.string().trim().max(128).default(""),
      memberEmail: z.string().trim().toLowerCase().max(120).optional(),
      memberPwHash: z.string().trim().max(128).optional(),
    }),
    response: adminOverviewResponse,
    handler: async (
      ctx,
      args,
    ): Promise<z.infer<typeof adminOverviewResponse>> => {
      const isOwner = await verifiedOwner(ctx, args);
      if (!isOwner) return { locked: true, counts: null };
      const db = ctx.db<typeof schema>();
      const countOf = async (
        q: Promise<{ n: number }[]>,
      ): Promise<number> => (await q)[0]?.n ?? 0;
      const now = Date.now();
      const [
        members,
        stories,
        posts,
        storyComments,
        postComments,
        newsComments,
        messageComments,
        songComments,
        questionsWaiting,
        songs,
        events,
        polls,
        kont,
        newsPosts,
        supporters,
        homeNow,
      ] = await Promise.all([
        countOf(db.select({ n: sql<number>`count(*)` }).from(schema.members)),
        countOf(db.select({ n: sql<number>`count(*)` }).from(schema.stories)),
        countOf(
          db.select({ n: sql<number>`count(*)` }).from(schema.ownerPosts),
        ),
        countOf(
          db.select({ n: sql<number>`count(*)` }).from(schema.storyComments),
        ),
        countOf(
          db
            .select({ n: sql<number>`count(*)` })
            .from(schema.ownerPostComments),
        ),
        countOf(
          db.select({ n: sql<number>`count(*)` }).from(schema.newsComments),
        ),
        countOf(
          db
            .select({ n: sql<number>`count(*)` })
            .from(schema.messageComments),
        ),
        countOf(
          db
            .select({ n: sql<number>`count(*)` })
            .from(schema.spotlightComments),
        ),
        countOf(
          db
            .select({ n: sql<number>`count(*)` })
            .from(schema.questions)
            .where(sql`${schema.questions.answer} is null`),
        ),
        countOf(
          db.select({ n: sql<number>`count(*)` }).from(schema.spotlights),
        ),
        countOf(db.select({ n: sql<number>`count(*)` }).from(schema.events)),
        countOf(db.select({ n: sql<number>`count(*)` }).from(schema.polls)),
        countOf(db.select({ n: sql<number>`count(*)` }).from(schema.riddles)),
        countOf(
          db
            .select({ n: sql<number>`count(*)` })
            .from(schema.dailyArticles)
            .where(isNotNull(schema.dailyArticles.title)),
        ),
        countOf(
          db.select({ n: sql<number>`count(*)` }).from(schema.supporters),
        ),
        countOf(
          db
            .select({ n: sql<number>`count(*)` })
            .from(schema.presence)
            .where(sql`${schema.presence.lastSeen} >= ${now - 3 * 60_000}`),
        ),
      ]);
      return {
        locked: false,
        counts: {
          members,
          stories,
          posts,
          comments:
            storyComments +
            postComments +
            newsComments +
            messageComments +
            songComments,
          questions_waiting: questionsWaiting,
          songs,
          events,
          polls,
          kont,
          news_posts: newsPosts,
          supporters,
          home_now: homeNow,
        },
      };
    },
  }),

  getAdminDatabase: defineAction({
    description:
      "The owner's Database section for Settings: the real state of Lakay's own database, read live — a per-table row count for every table the app keeps (members, stories, posts, comments, news, trivia, translations, and the rest), the total row count, the admin binding (which account the admin code is tied to, whether a code and a recovery key exist), and the live app-control state (owner message posted or not, member spotlight, hidden news count, who's-home check-ins). Locked behind the same bound-owner check as the member list (admin code hash + proof of the account the code is bound to): anyone else gets locked:true and no data at all — the section does not exist for regular members. The connection is proven by the read itself: if these counts come back, the database answered.",
    request: z.object({
      codeHash: z.string().trim().max(128).default(""),
      memberEmail: z.string().trim().toLowerCase().max(120).optional(),
      memberPwHash: z.string().trim().max(128).optional(),
    }),
    response: adminDatabaseResponse,
    handler: async (
      ctx,
      args,
    ): Promise<z.infer<typeof adminDatabaseResponse>> => {
      const lockedReply: z.infer<typeof adminDatabaseResponse> = {
        locked: true,
        checked_at: null,
        owner_email: null,
        code_set: false,
        recovery_set: false,
        tables: [],
        total_rows: 0,
        hidden_news: 0,
        owner_message_posted: false,
        owner_message_updated_at: null,
        spotlight_name: null,
        presence_active: 0,
        presence_stale: 0,
      };
      const isOwner = await verifiedOwner(ctx, args);
      if (!isOwner) return lockedReply;
      const db = ctx.db<typeof schema>();
      const countOf = async (
        q: Promise<{ n: number }[]>,
      ): Promise<number> => (await q)[0]?.n ?? 0;
      const tableDefs: [string, Promise<{ n: number }[]>][] = [
        ["members", db.select({ n: sql<number>`count(*)` }).from(schema.members)],
        ["stories", db.select({ n: sql<number>`count(*)` }).from(schema.stories)],
        ["story_comments", db.select({ n: sql<number>`count(*)` }).from(schema.storyComments)],
        ["owner_posts", db.select({ n: sql<number>`count(*)` }).from(schema.ownerPosts)],
        ["owner_post_comments", db.select({ n: sql<number>`count(*)` }).from(schema.ownerPostComments)],
        ["owner_message", db.select({ n: sql<number>`count(*)` }).from(schema.ownerMessage)],
        ["questions", db.select({ n: sql<number>`count(*)` }).from(schema.questions)],
        ["spotlights", db.select({ n: sql<number>`count(*)` }).from(schema.spotlights)],
        ["spotlight_comments", db.select({ n: sql<number>`count(*)` }).from(schema.spotlightComments)],
        ["polls", db.select({ n: sql<number>`count(*)` }).from(schema.polls)],
        ["poll_options", db.select({ n: sql<number>`count(*)` }).from(schema.pollOptions)],
        ["riddles", db.select({ n: sql<number>`count(*)` }).from(schema.riddles)],
        ["riddle_answers", db.select({ n: sql<number>`count(*)` }).from(schema.riddleAnswers)],
        ["events", db.select({ n: sql<number>`count(*)` }).from(schema.events)],
        ["event_rsvps", db.select({ n: sql<number>`count(*)` }).from(schema.eventRsvps)],
        ["restaurant_shoutouts", db.select({ n: sql<number>`count(*)` }).from(schema.restaurantShoutouts)],
        ["daily_articles", db.select({ n: sql<number>`count(*)` }).from(schema.dailyArticles)],
        ["daily_answers", db.select({ n: sql<number>`count(*)` }).from(schema.dailyAnswers)],
        ["news_comments", db.select({ n: sql<number>`count(*)` }).from(schema.newsComments)],
        ["message_comments", db.select({ n: sql<number>`count(*)` }).from(schema.messageComments)],
        ["hidden_news", db.select({ n: sql<number>`count(*)` }).from(schema.hiddenNews)],
        ["trivia_scores", db.select({ n: sql<number>`count(*)` }).from(schema.triviaScores)],
        ["trivia_challenges", db.select({ n: sql<number>`count(*)` }).from(schema.triviaChallenges)],
        ["supporters", db.select({ n: sql<number>`count(*)` }).from(schema.supporters)],
        ["content_likes", db.select({ n: sql<number>`count(*)` }).from(schema.contentLikes)],
        ["presence", db.select({ n: sql<number>`count(*)` }).from(schema.presence)],
        ["member_spotlight", db.select({ n: sql<number>`count(*)` }).from(schema.memberSpotlight)],
        ["news_translations", db.select({ n: sql<number>`count(*)` }).from(schema.newsTranslations)],
        ["trivia_translations", db.select({ n: sql<number>`count(*)` }).from(schema.triviaTranslations)],
        ["text_translations", db.select({ n: sql<number>`count(*)` }).from(schema.textTranslations)],
        ["lakay_articles", db.select({ n: sql<number>`count(*)` }).from(schema.lakayArticles)],
        ["admin_access", db.select({ n: sql<number>`count(*)` }).from(schema.adminAccess)],
      ];
      const counts = await Promise.all(tableDefs.map(([, q]) => countOf(q)));
      const tables = tableDefs.map(([name], i) => ({
        name,
        rows: counts[i] ?? 0,
      }));
      const [accessRows, messageRows, spotlightRows, presenceRows] =
        await Promise.all([
          db
            .select({
              ownerEmail: schema.adminAccess.ownerEmail,
              recoveryHash: schema.adminAccess.recoveryHash,
            })
            .from(schema.adminAccess)
            .limit(1),
          db
            .select({ updatedAt: schema.ownerMessage.updatedAt })
            .from(schema.ownerMessage)
            .limit(1),
          db
            .select({ memberName: schema.memberSpotlight.memberName })
            .from(schema.memberSpotlight)
            .limit(1),
          db.select({ lastSeen: schema.presence.lastSeen }).from(schema.presence),
        ]);
      const now = Date.now();
      const presenceActive = presenceRows.filter(
        (r) => r.lastSeen >= now - 3 * 60_000,
      ).length;
      return {
        locked: false,
        checked_at: new Date().toISOString(),
        owner_email: accessRows[0]?.ownerEmail ?? null,
        code_set: accessRows.length > 0,
        recovery_set: !!accessRows[0]?.recoveryHash,
        tables,
        total_rows: tables.reduce((sum, t) => sum + t.rows, 0),
        hidden_news: tables.find((t) => t.name === "hidden_news")?.rows ?? 0,
        owner_message_posted: messageRows.length > 0,
        owner_message_updated_at:
          messageRows[0]?.updatedAt.toISOString() ?? null,
        spotlight_name: spotlightRows[0]?.memberName ?? null,
        presence_active: presenceActive,
        presence_stale: presenceRows.length - presenceActive,
      };
    },
  }),

  adminAppControl: defineAction({
    description:
      "App control from the owner's Settings Database section — real changes to the live app, each behind the same bound-owner check as the member list (admin code hash + proof of the bound account); anyone else gets locked:true and nothing changes. Ops: unhide_all_news brings back every news story the owner hid (clears the hidden list); clear_spotlight takes the member spotlight off Home; take_down_owner_message removes the owner's message from Home; clear_stale_presence deletes who's-home check-ins older than the live window (housekeeping — nothing visible changes). Returns how many rows the op touched.",
    request: z.object({
      codeHash: z.string().trim().max(128).default(""),
      memberEmail: z.string().trim().toLowerCase().max(120).optional(),
      memberPwHash: z.string().trim().max(128).optional(),
      op: z.enum([
        "unhide_all_news",
        "clear_spotlight",
        "take_down_owner_message",
        "clear_stale_presence",
      ]),
    }),
    response: z.object({
      ok: z.boolean(),
      locked: z.boolean(),
      affected: z.number(),
    }),
    handler: async (
      ctx,
      args,
    ): Promise<{ ok: boolean; locked: boolean; affected: number }> => {
      const isOwner = await verifiedOwner(ctx, args);
      if (!isOwner) return { ok: false, locked: true, affected: 0 };
      const db = ctx.db<typeof schema>();
      const countOf = async (
        q: Promise<{ n: number }[]>,
      ): Promise<number> => (await q)[0]?.n ?? 0;
      let affected = 0;
      if (args.op === "unhide_all_news") {
        affected = await countOf(
          db.select({ n: sql<number>`count(*)` }).from(schema.hiddenNews),
        );
        if (affected > 0) await db.delete(schema.hiddenNews);
      } else if (args.op === "clear_spotlight") {
        affected = await countOf(
          db.select({ n: sql<number>`count(*)` }).from(schema.memberSpotlight),
        );
        if (affected > 0) await db.delete(schema.memberSpotlight);
      } else if (args.op === "take_down_owner_message") {
        affected = await countOf(
          db.select({ n: sql<number>`count(*)` }).from(schema.ownerMessage),
        );
        if (affected > 0) await db.delete(schema.ownerMessage);
      } else {
        const cutoff = Date.now() - 3 * 60_000;
        affected = await countOf(
          db
            .select({ n: sql<number>`count(*)` })
            .from(schema.presence)
            .where(sql`${schema.presence.lastSeen} < ${cutoff}`),
        );
        if (affected > 0) {
          await db
            .delete(schema.presence)
            .where(sql`${schema.presence.lastSeen} < ${cutoff}`);
        }
      }
      ctx.invalidateQueries();
      return { ok: true, locked: false, affected };
    },
  }),

  deleteMember: defineAction({
    description:
      "Removes one member account from Lakay's member list — the owner's cleanup control (a test account, a duplicate, someone who asked to be removed). Locked behind the same bound-owner check as the list itself (admin code + proof of the owner's account): with no code created yet, or a failed check, nothing is deleted and locked:true comes back. Removing the account also removes that member's liker rows; like counts already given stay counted, and the person's comments stay (they belong to the threads).",
    request: z.object({
      email: z.string().trim().toLowerCase().min(3).max(120),
      codeHash: z.string().trim().max(128).default(""),
      memberEmail: z.string().trim().toLowerCase().max(120).optional(),
      memberPwHash: z.string().trim().max(128).optional(),
    }),
    response: z.object({ ok: z.boolean(), locked: z.boolean() }),
    handler: async (
      ctx,
      args,
    ): Promise<{ ok: boolean; locked: boolean }> => {
      const isOwner = await verifiedOwner(ctx, args);
      if (!isOwner) {
        return { ok: false, locked: true };
      }
      const db = ctx.db<typeof schema>();
      await db
        .delete(schema.contentLikes)
        .where(eq(schema.contentLikes.memberEmail, args.email));
      const gone = await db
        .delete(schema.members)
        .where(eq(schema.members.email, args.email))
        .returning({ id: schema.members.id });
      ctx.invalidateQueries();
      return { ok: gone.length > 0, locked: false };
    },
  }),

  listLikers: defineAction({
    description:
      "Lists who liked one story, song, or owner post — the owner's view only. Everyone sees like counts; the names behind them sit behind the same lock as the member list: the caller must present the owner's admin code (as its SHA-256 hash) AND prove the member account the code is bound to (verifiedOwner), and with no code created yet, or a failed check, it returns locked:true and no rows. Signed-in likers come back with their account name and email; guest likers have both null and are shown simply as guests.",
    request: z.object({
      kind: z.enum(["story", "spotlight", "post"]),
      targetId: z.number().int().positive(),
      codeHash: z.string().trim().max(128).default(""),
      memberEmail: z.string().trim().toLowerCase().max(120).optional(),
      memberPwHash: z.string().trim().max(128).optional(),
    }),
    response: z.object({
      locked: z.boolean(),
      code_set: z.boolean(),
      likers: z.array(
        z.object({
          name: z.string().nullable(),
          email: z.string().nullable(),
          created_at: z.string(),
        }),
      ),
      total: z.number(),
    }),
    handler: async (
      ctx,
      args,
    ): Promise<{
      locked: boolean;
      code_set: boolean;
      likers: { name: string | null; email: string | null; created_at: string }[];
      total: number;
    }> => {
      const db = ctx.db<typeof schema>();
      const access = await db
        .select({ codeHash: schema.adminAccess.codeHash })
        .from(schema.adminAccess)
        .limit(1);
      if (!access[0]) {
        return { locked: true, code_set: false, likers: [], total: 0 };
      }
      const isOwner = await verifiedOwner(ctx, args);
      if (!isOwner) {
        return { locked: true, code_set: true, likers: [], total: 0 };
      }
      const rows = await db
        .select()
        .from(schema.contentLikes)
        .where(
          and(
            eq(schema.contentLikes.kind, args.kind),
            eq(schema.contentLikes.targetId, args.targetId),
          ),
        )
        .orderBy(desc(schema.contentLikes.id))
        .limit(500);
      return {
        locked: false,
        code_set: true,
        likers: rows.map((r) => ({
          name: r.memberName,
          email: r.memberEmail,
          created_at: r.createdAt.toISOString(),
        })),
        total: rows.length,
      };
    },
  }),

  saveDailyArticle: defineAction({
    description:
      "Saves one Lakay news post written by the Lakay journalist (the daily research task): a verified new story about Haiti or the diaspora, written as a short post in Lakay's own words — title + body are the post itself, the whole news in as few words as honesty allows, with anything unconfirmed hedged and the source credited as plain text (readers are never linked out of Lakay; there are no outbound links on news posts). sourceUrl is the primary source page (the dedupe key, kept for the record — it is never shown as a tappable link), sourceText the facts-only brief the post was written from (kept for the record, never shown). imageUrl must be a picture from a safe source only — public-domain, free-to-reuse, or Lakay's own — never a photo taken from a news site. Deduped by source URL — saving the same story twice changes nothing.",
    request: z.object({
      sourceUrl: z
        .string()
        .trim()
        .min(1)
        .max(2000)
        .refine((v) => /^https?:\/\//i.test(v), {
          message: "Source URL must start with http:// or https://",
        }),
      sourceName: z.string().trim().min(1).max(200),
      sourceTitle: z.string().trim().min(1).max(500),
      teaser: z.string().trim().max(600).optional(),
      sourceText: z.string().trim().min(40).max(6000),
      title: z.string().trim().min(1).max(300),
      body: z.string().trim().min(1).max(2400),
      // A real picture is mandatory: the owner wants every news post
      // to carry one, so a post the journalist cannot pair with a
      // picture is not saved at all (the run covers another story
      // instead). The picture must come from a safe source only —
      // public-domain, free-to-reuse, or Lakay's own images — never
      // a photo lifted from a news site's pages.
      imageUrl: z
        .string()
        .trim()
        .min(1)
        .max(2000)
        .refine((v) => /^https?:\/\//i.test(v), {
          message: "Image URL must start with http:// or https://",
        }),
      sourcePublishedAt: z.string().max(40).nullable().optional(),
    }),
    response: z.object({ ok: z.literal(true), saved: z.boolean() }),
    handler: async (
      ctx,
      args,
    ): Promise<{ ok: true; saved: boolean }> => {
      const db = ctx.db<typeof schema>();
      const published = args.sourcePublishedAt
        ? new Date(args.sourcePublishedAt)
        : null;
      const inserted = await db
        .insert(schema.dailyArticles)
        .values({
          sourceUrl: args.sourceUrl,
          sourceName: censorText(args.sourceName),
          sourceTitle: censorText(args.sourceTitle),
          teaser: args.teaser ? censorText(args.teaser) : "",
          sourceText: args.sourceText,
          title: censorText(args.title),
          body: censorText(args.body),
          imageUrl: args.imageUrl,
          sourcePublishedAt:
            published && !Number.isNaN(published.getTime())
              ? published
              : null,
        })
        .onConflictDoNothing()
        .returning({ id: schema.dailyArticles.id });
      if (inserted.length > 0) ctx.invalidateQueries();
      return { ok: true, saved: inserted.length > 0 };
    },
  }),

  listDailyArticles: defineAction({
    description:
      "Lists Lakay's own news posts — the short posts the Lakay journalist writes each day about Haiti and the diaspora — newest first, in the reader's language, each with its comment count. Translations into the reader's language are stored permanently once made; translations_pending reports how many posts still show in English because their translation has not finished yet. Only posts in the written-post format are returned; the facts brief behind each post is never included.",
    request: z.object({
      lang: z.enum(["en", "ht", "fr", "pt", "es"]).default("en"),
    }),
    response: z.object({
      articles: z.array(lakayNewsPostShape),
      fetched_at: z.string(),
      // How many of the returned posts are still showing in English
      // because their translation into the reader's language has not
      // finished yet. Zero in English and whenever every post is
      // fully translated; the client quietly re-asks while it is
      // above zero so a language switch finishes on its own.
      translations_pending: z.number(),
    }),
    handler: async (
      ctx,
      args,
    ): Promise<{
      articles: z.infer<typeof lakayNewsPostShape>[];
      fetched_at: string;
      translations_pending: number;
    }> => {
      const db = ctx.db<typeof schema>();
      const [allRows, hiddenRows] = await Promise.all([
        db
          .select()
          .from(schema.dailyArticles)
          .where(
            and(
              isNotNull(schema.dailyArticles.title),
              isNotNull(schema.dailyArticles.body),
            ),
          )
          .orderBy(desc(schema.dailyArticles.id))
          .limit(30),
        db.select({ link: schema.hiddenNews.link }).from(schema.hiddenNews),
      ]);
      // A post the admin hid (the Hide control sits on news cards)
      // disappears from the feed for everyone.
      const hiddenLinks = new Set(hiddenRows.map((r) => r.link));
      const rows = allRows.filter((r) => !hiddenLinks.has(r.sourceUrl));
      const items: FeedItem[] = rows.map((r) => ({
        title: r.title ?? "",
        link: r.sourceUrl,
        source: r.sourceName,
        published_at: (r.sourcePublishedAt ?? r.createdAt).toISOString(),
        excerpt: r.body ?? "",
        image_url: r.imageUrl,
      }));
      const { items: translated, pendingCount } =
        args.lang === "en"
          ? { items, pendingCount: 0 }
          : await translateItems(ctx, items, args.lang);
      const withCounts = await attachNewsCommentCounts(ctx, translated);
      const byLink = new Map(rows.map((r) => [r.sourceUrl, r.id]));
      return {
        articles: withCounts.map((i) => ({
          id: byLink.get(i.link) ?? 0,
          title: i.title,
          body: i.excerpt,
          source: i.source,
          link: i.link,
          image_url: i.image_url,
          published_at: i.published_at ?? new Date().toISOString(),
          comment_count: i.comment_count,
        })),
        fetched_at: new Date().toISOString(),
        translations_pending: pendingCount,
      };
    },
  }),

  refreshDailyArticles: defineAction({
    description:
      "Starts one of the Lakay journalist's seven daily news rounds (about 6:30 AM, 11:30 AM, 3 PM, 5 PM, 7 PM, 9 PM, and midnight, America/New_York — then no rounds until the morning): a background task searches Twitter/X, Google (News and web search), and other trustworthy sources for what is genuinely new about Haiti and the diaspora SINCE THE LAST ROUND — the gangs, the Jovenel Moïse case and its arrests, Les Grenadiers and Haitian soccer, President Bukele of El Salvador, ICE/immigration, and other major news — verifies each item on its source page, writes it as a short post in Lakay's own words (the whole news, nothing padded; unconfirmed facts hedged with reserve wording, the source credited as plain text — news posts carry no outbound links and never send readers to another website — and a real picture from a safe source required: public-domain, free-to-reuse, or Lakay's own, never a photo taken from a news site), and saves up to three genuinely new posts through saveDailyArticle. A story already posted in an earlier round is never posted again. Also safe to call by hand; runs within the same round are single-flighted, but each scheduled round gets its own run.",
    request: z.object({}),
    response: z.object({
      ok: z.literal(true),
      started: z.boolean(),
      message: z.string(),
    }),
    handler: async (
      ctx,
    ): Promise<{ ok: true; started: boolean; message: string }> => {
      const now = new Date();
      const today = now.toISOString().slice(0, 10);
      // One journalist task per ROUND, not per day: the dedupe key
      // carries the current hour, so the seven scheduled rounds
      // (06:30, 11:30, 15:00, 17:00, 19:00, 21:00, 00:00 ET — each
      // more than an hour apart) each start a fresh round, while two
      // triggers landing in the same hour (e.g. a schedule plus a
      // manual call) still collapse into a single round.
      const roundKey = now.toISOString().slice(0, 13);
      const result = await ctx.agent.spawnTask(
        `You are the journalist for Lakay News, the newsroom of the Lakay app ` +
          `for Haitians everywhere. Today is ${today}. Lakay News runs seven rounds a ` +
          `day (early morning, late morning, afternoon, evening, night, and a last one ` +
          `at midnight); THIS is one round, and your job is only what is genuinely new ` +
          `SINCE THE LAST ROUND — roughly the last few hours (for the early-morning ` +
          `round, everything since the midnight round overnight). Search Twitter/X ` +
          `(posts by President Bukele, Haitian officials and police, journalists, the ` +
          `national teams and players), Google — Google News and regular Google web ` +
          `search — and other trustworthy sources (Reuters, AP, The Haitian Times, Le ` +
          `Nouvelliste, AyiboPost, the Miami Herald, and similar reputable outlets) for ` +
          `what is new on these beats, in this order: ` +
          `(1) the gangs in Haiti — security developments, police operations, gang ` +
          `leaders, neighbourhoods affected; (2) the Jovenel Moïse assassination case — ` +
          `the trials, court hearings, and any arrests in the case; (3) other arrests of ` +
          `notable figures connected to Haiti; (4) Haitian soccer — Les Grenadiers (the ` +
          `men's national team), Les Grenadières (the women's team), Haitian clubs and ` +
          `Haitian players abroad: matches, results, transfers, call-ups; (5) Nayib ` +
          `Bukele, the president of El Salvador — anything he says or does about Haiti ` +
          `first, then his major news; (6) ICE, deportation and immigration news ` +
          `affecting Haitians; (7) any other major news about Haiti or the diaspora, ` +
          `including public statements or posts about Haiti by important people. ` +
          `First call the listDailyArticles action with lang "en" and note EVERY post ` +
          `already in the app — its source URL and what story it tells. A story that is ` +
          `already posted is NEVER posted again: not under a different URL, not from a ` +
          `different outlet covering the same event, and not rewritten. Only a real new ` +
          `development that no existing post already reports (a new arrest, a verdict, ` +
          `a result that just happened) counts as new. Then open the most promising ` +
          `source pages and verify every fact on the ` +
          `page itself — never rely on a search snippet alone, and never invent a fact, ` +
          `quote, date, name, or reaction. Pick up to 3 genuinely new, verified stories. ` +
          `For each one, WRITE THE POST YOURSELF, the way a good wire journalist writes ` +
          `a brief: as short as possible, but the whole news — who, what, when, where, ` +
          `and by whom if it is known, with the date of the event stated in the text. ` +
          `Do not pad, do not repeat the headline in the body, do not add background the ` +
          `reader does not need to understand what happened. If something is not ` +
          `confirmed yet, write it with a journalist's reserve inside the post itself — ` +
          `"reportedly", "allegedly", "according to [the source]" — and never state an ` +
          `unconfirmed claim as fact. NEVER put a link or a URL anywhere in the title ` +
          `or the body: Lakay readers stay inside Lakay, news posts carry no outbound ` +
          `links at all, and the source is credited as plain text only (the "— via ` +
          `[source]" line below). Then call the saveDailyArticle action exactly ` +
          `once per story with: title = your own short headline for the post, in ` +
          `English; body = your post, in English — two to five short sentences, ` +
          `roughly 40–110 words, plain and clear, ending with the credit "— via ` +
          `[source name]" when the key facts rest on a single source; sourceUrl = the ` +
          `exact URL of the page you opened (copied verbatim, never a search-results ` +
          `URL); sourceName = the publisher's name (the credit readers will see); ` +
          `sourceTitle = the page's own headline, for the record; sourceText = a ` +
          `facts-only brief of 120–350 words in English with only facts stated on the ` +
          `page — the key names, numbers, dates and quotes exactly as the source gives ` +
          `them, and nothing else (kept for the record, never shown); imageUrl = a ` +
          `picture of this story from a SAFE source only — a public-domain or ` +
          `free-to-reuse picture (for example from Wikimedia Commons, or a photo ` +
          `published by a US government agency), or one of Lakay's own images — ` +
          `REQUIRED: every post must carry a real picture, but NEVER take the photo ` +
          `from a news article's page, never use a page's og:image, and never use any ` +
          `picture copied from another website's reporting: those photos are ` +
          `copyrighted and are forbidden here, however well they fit the story. Find ` +
          `the picture on the safe source itself and use that page's direct image ` +
          `URL. If no safe-source picture genuinely shows this story or its direct ` +
          `subject, skip that story and cover a different one instead — never use a ` +
          `stock, generic, or unrelated picture, and never save a post without its ` +
          `picture; sourcePublishedAt = the page's ` +
          `publication date/time in ISO format if shown, otherwise omit it. If ` +
          `nothing genuinely new and verified turns ` +
          `up, save nothing — an empty round is better than a repeated story.`,
        {
          expectsAction: "saveDailyArticle",
          dedupeKey: `lakay-news-round-${roundKey}`,
        },
      );
      return result.ok
        ? {
            ok: true,
            started: true,
            message: `Lakay News round started for ${today}; new posts will appear in the News section as they are saved.`,
          }
        : {
            ok: true,
            started: false,
            message: `Lakay News round did not start: ${result.error}`,
          };
    },
  }),

  hideNewsItem: defineAction({
    description:
      "Hides one news story (by its article link) from the home feed and News section for everyone. Admin moderation — the UI only offers it in admin mode.",
    request: z.object({
      ...memberCredFields,
      link: z.string().trim().min(1).max(2000),
    }),
    response: okResponse,
    handler: async (ctx, args): Promise<z.infer<typeof okResponse>> => {
      await requireAdmin(ctx, args);
      const db = ctx.db<typeof schema>();
      await db
        .insert(schema.hiddenNews)
        .values({ link: args.link })
        .onConflictDoNothing();
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),

  getOwnerMessage: defineAction({
    description:
      "Returns the owner's current message for the top of Home — text plus any video link, link, and photo — or null when none is posted.",
    request: z.object({}),
    response: z.object({
      message: z
        .object({
          body: z.string(),
          video_link: z.string().nullable(),
          link_url: z.string().nullable(),
          image_url: z.string().nullable(),
          updated_at: z.string(),
        })
        .nullable(),
    }),
    async handler(ctx) {
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select()
        .from(schema.ownerMessage)
        .where(eq(schema.ownerMessage.id, 1))
        .limit(1);
      const row = rows[0];
      return {
        message: row
          ? {
              body: row.body,
              video_link: row.videoLink,
              link_url: row.linkUrl,
              image_url: row.imageBlobKey
                ? await ctx.blobs.getUrl(row.imageBlobKey)
                : null,
              updated_at: row.updatedAt.toISOString(),
            }
          : null,
      };
    },
  }),

  setOwnerMessage: defineAction({
    description:
      "Posts or replaces the owner's message on Home (admin only in the UI): text, an optional video link, an optional link, and an optional photo. Sending everything empty takes the message down; omit the photo fields to keep the current photo, pass removeImage to drop it.",
    request: z.object({
      ...memberCredFields,
      body: z.string().trim().max(1000),
      videoLink: z
        .string()
        .trim()
        .max(500)
        .optional()
        .refine((v) => !v || /^https?:\/\//i.test(v), {
          message: "Link must start with http:// or https://",
        }),
      linkUrl: z
        .string()
        .trim()
        .max(500)
        .optional()
        .refine((v) => !v || /^https?:\/\//i.test(v), {
          message: "Link must start with http:// or https://",
        }),
      imageBase64: z.string().max(4_200_000).optional(),
      imageType: z
        .enum(["image/jpeg", "image/png", "image/webp", "image/gif"])
        .optional(),
      removeImage: z.boolean().optional(),
    }),
    response: okResponse,
    handler: async (ctx, args): Promise<z.infer<typeof okResponse>> => {
      await requireAdmin(ctx, args);
      const db = ctx.db<typeof schema>();
      const existing = await db
        .select()
        .from(schema.ownerMessage)
        .where(eq(schema.ownerMessage.id, 1))
        .limit(1);
      // Photo: a fresh upload replaces it, removeImage drops it,
      // otherwise the current photo stays.
      let imageBlobKey: string | null = existing[0]?.imageBlobKey ?? null;
      if (args.removeImage) imageBlobKey = null;
      if (args.imageBase64 && args.imageType) {
        const bytes = Buffer.from(args.imageBase64, "base64");
        if (bytes.length > 0 && bytes.length <= 3_200_000) {
          imageBlobKey = `owner-photos/${crypto.randomUUID()}`;
          await ctx.blobs.put(imageBlobKey, bytes, {
            contentType: args.imageType,
          });
        }
      }
      const videoLink = args.videoLink ? args.videoLink : null;
      const linkUrl = args.linkUrl ? args.linkUrl : null;
      if (!args.body && !videoLink && !linkUrl && !imageBlobKey) {
        await db
          .delete(schema.ownerMessage)
          .where(eq(schema.ownerMessage.id, 1));
      } else {
        const body = censorText(args.body);
        const now = new Date();
        await db
          .insert(schema.ownerMessage)
          .values({ id: 1, body, videoLink, linkUrl, imageBlobKey, updatedAt: now })
          .onConflictDoUpdate({
            target: schema.ownerMessage.id,
            set: { body, videoLink, linkUrl, imageBlobKey, updatedAt: now },
          });
      }
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),

  // ---------------------------------------------------------------------
  // Owner posts — the owner's own feed on Home. He publishes as many
  // posts as he wants (a note, a longer article, photos, a video
  // link, a link); the composer and delete controls are admin-mode
  // only in the UI, everyone reads the posts, likes them, and
  // comments under them.
  // ---------------------------------------------------------------------

  listOwnerPosts: defineAction({
    description:
      "Lists the Home wall's posts, newest first, each with its photo URLs, its author's name (null for the owner's own posts, shown under the Lakay name), like count, and comment count. A caller who passes their member email + password hash also learns which posts are theirs (mine), so the client can offer the delete control on their own posts.",
    request: z.object({
      limit: z.number().int().positive().max(100).default(50),
      memberEmail: z.string().trim().toLowerCase().max(120).optional(),
      memberPwHash: z.string().trim().min(16).max(128).optional(),
    }),
    response: z.object({ posts: z.array(ownerPostShape) }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const me = await verifiedMember(ctx, args);
      const rows = await db
        .select()
        .from(schema.ownerPosts)
        .orderBy(desc(schema.ownerPosts.id))
        .limit(args.limit);
      const countRows = await db
        .select({
          postId: schema.ownerPostComments.postId,
          n: sql<number>`count(*)`,
        })
        .from(schema.ownerPostComments)
        .groupBy(schema.ownerPostComments.postId);
      const counts = new Map(countRows.map((r) => [r.postId, r.n]));
      // Authors' hometowns, looked up from the member list by the
      // post's author email — the wall shows where a poster is
      // from so people can find their own people.
      const authorEmails = [
        ...new Set(
          rows.map((r) => r.authorEmail).filter((e): e is string => !!e),
        ),
      ];
      const hometownRows =
        authorEmails.length > 0
          ? await db
              .select({
                email: schema.members.email,
                hometown: schema.members.hometown,
              })
              .from(schema.members)
              .where(inArray(schema.members.email, authorEmails))
          : [];
      const hometownByEmail = new Map(
        hometownRows.map((r) => [r.email, r.hometown]),
      );
      const posts = await Promise.all(
        rows.map(async (r) => {
          let keys: string[] = [];
          try {
            const parsed: unknown = r.imageKeys ? JSON.parse(r.imageKeys) : [];
            if (Array.isArray(parsed)) {
              keys = parsed.filter(
                (k): k is string => typeof k === "string",
              );
            }
          } catch {
            keys = [];
          }
          return {
            id: r.id,
            title: r.title,
            body: r.body,
            image_urls: await Promise.all(
              keys.map((k) => ctx.blobs.getUrl(k)),
            ),
            video_link: r.videoLink,
            link_url: r.linkUrl,
            author_name: r.authorName,
            author_hometown: r.authorEmail
              ? (hometownByEmail.get(r.authorEmail) ?? null)
              : null,
            mine: !!me && !!r.authorEmail && r.authorEmail === me.email,
            likes: r.likes,
            comment_count: counts.get(r.id) ?? 0,
            created_at: r.createdAt.toISOString(),
          };
        }),
      );
      return { posts };
    },
  }),

  createOwnerPost: defineAction({
    description:
      "Publishes a post to the Home wall: an optional title, text, up to six photos, an optional video link, and an optional link. At least one of text/photo/video/link must be present. Posting takes a free account — a verified member posts under their own account name; the owner in admin mode (asAdmin) posts under the Lakay name. Bad words are blurred before the post is stored.",
    request: z.object({
      title: z.string().trim().max(160).optional(),
      body: z.string().trim().max(6000).optional(),
      images: z
        .array(
          z.object({
            base64: z.string().max(4_200_000),
            type: z.enum(["image/jpeg", "image/png", "image/webp", "image/gif"]),
          }),
        )
        .max(6)
        .optional(),
      videoLink: z
        .string()
        .trim()
        .max(500)
        .optional()
        .refine((v) => !v || /^https?:\/\//i.test(v), {
          message: "Link must start with http:// or https://",
        }),
      linkUrl: z
        .string()
        .trim()
        .max(500)
        .optional()
        .refine((v) => !v || /^https?:\/\//i.test(v), {
          message: "Link must start with http:// or https://",
        }),
      ...memberCredFields,
    }),
    response: z.object({ id: z.number() }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      // Who is posting decides whose name the post carries: a
      // verified member posts as themselves; the owner in admin
      // mode posts as Lakay (author columns stay null) — and admin
      // mode must itself check out (the code + the account it is
      // bound to), so the flag alone posts nothing.
      let authorName: string | null = null;
      let authorEmail: string | null = null;
      if (args.asAdmin) {
        if (!(await verifiedAdmin(ctx, args))) {
          throw new Error(
            "login_required: posting as Lakay takes the owner's account and admin code",
          );
        }
      } else if (args.memberEmail || args.memberPwHash) {
        const member = await verifiedMember(ctx, args);
        if (!member) {
          throw new Error("login_required: those account details did not check out");
        }
        authorName = member.name;
        authorEmail = member.email;
      } else {
        throw new Error("login_required: posting takes a free Lakay account");
      }
      const imageKeys: string[] = [];
      for (const img of args.images ?? []) {
        const bytes = Buffer.from(img.base64, "base64");
        if (bytes.length > 0 && bytes.length <= 3_200_000) {
          const key = `owner-post-photos/${crypto.randomUUID()}`;
          await ctx.blobs.put(key, bytes, { contentType: img.type });
          imageKeys.push(key);
        }
      }
      const title = args.title ? censorText(args.title) : "";
      const body = args.body ? censorText(args.body) : "";
      const videoLink = args.videoLink ? args.videoLink : null;
      const linkUrl = args.linkUrl ? args.linkUrl : null;
      if (!title && !body && imageKeys.length === 0 && !videoLink && !linkUrl) {
        throw new Error("createOwnerPost: a post needs text, a photo, a video, or a link");
      }
      const result = await db
        .insert(schema.ownerPosts)
        .values({
          title: title || null,
          body,
          imageKeys: imageKeys.length > 0 ? JSON.stringify(imageKeys) : null,
          videoLink,
          linkUrl,
          authorName,
          authorEmail,
        })
        .returning({ id: schema.ownerPosts.id });
      const inserted = result[0];
      if (!inserted) throw new Error("createOwnerPost: insert returned no rows");
      ctx.invalidateQueries();
      return { id: inserted.id };
    },
  }),

  likeOwnerPost: defineAction({
    description:
      "Adds one like to one of the owner's posts and records who gave it in content_likes, the same way heartStory does: members by name + email (no second like from the same account), guests anonymously. Only the owner sees the names, through listLikers.",
    request: z.object({
      id: z.number().int().positive(),
      memberName: z.string().trim().max(60).optional(),
      memberEmail: z.string().trim().toLowerCase().max(120).optional(),
    }),
    response: okResponse,
    handler: async (ctx, args): Promise<z.infer<typeof okResponse>> => {
      const db = ctx.db<typeof schema>();
      const email = args.memberEmail || null;
      if (email) {
        const existing = await db
          .select({ id: schema.contentLikes.id })
          .from(schema.contentLikes)
          .where(
            and(
              eq(schema.contentLikes.kind, "post"),
              eq(schema.contentLikes.targetId, args.id),
              eq(schema.contentLikes.memberEmail, email),
            ),
          )
          .limit(1);
        if (existing.length > 0) return { ok: true };
      }
      await db.insert(schema.contentLikes).values({
        kind: "post",
        targetId: args.id,
        memberName: email ? censorText(args.memberName ?? "") || null : null,
        memberEmail: email,
      });
      await db
        .update(schema.ownerPosts)
        .set({ likes: sql`${schema.ownerPosts.likes} + 1` })
        .where(eq(schema.ownerPosts.id, args.id));
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),

  deleteOwnerPost: defineAction({
    description:
      "Removes one Home wall post along with its comments and like records. The owner (admin mode) can remove any post; a member can remove their own post by presenting their account email + password hash, which must match the post's author.",
    request: z.object({
      id: z.number().int().positive(),
      ...memberCredFields,
    }),
    response: okResponse,
    handler: async (ctx, args): Promise<z.infer<typeof okResponse>> => {
      const db = ctx.db<typeof schema>();
      if (args.asAdmin) {
        // The owner removing any post: admin mode must check out
        // (the code + the account it is bound to) — the flag alone
        // removes nothing.
        if (!(await verifiedAdmin(ctx, args))) {
          throw new Error(
            "login_required: removing any post as the owner takes the owner's account and admin code",
          );
        }
      } else if (args.memberEmail || args.memberPwHash) {
        // A member deleting: only their own post, proven by the
        // account check against the post's author email.
        const member = await verifiedMember(ctx, args);
        if (!member) {
          throw new Error("login_required: those account details did not check out");
        }
        const rows = await db
          .select({ authorEmail: schema.ownerPosts.authorEmail })
          .from(schema.ownerPosts)
          .where(eq(schema.ownerPosts.id, args.id))
          .limit(1);
        if (!rows[0] || rows[0].authorEmail !== member.email) {
          throw new Error("not_your_post: members can only remove their own posts");
        }
      } else {
        throw new Error("login_required: removing a post takes the owner or its author");
      }
      await db
        .delete(schema.ownerPostComments)
        .where(eq(schema.ownerPostComments.postId, args.id));
      await db
        .delete(schema.contentLikes)
        .where(
          and(
            eq(schema.contentLikes.kind, "post"),
            eq(schema.contentLikes.targetId, args.id),
          ),
        );
      await db
        .delete(schema.ownerPosts)
        .where(eq(schema.ownerPosts.id, args.id));
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),

  listOwnerPostComments: defineAction({
    description: "Lists the comments under one of the owner's posts, oldest first.",
    request: z.object({
      postId: z.number().int().positive(),
      limit: z.number().int().positive().max(200).default(100),
    }),
    response: z.object({ comments: z.array(ownerPostCommentShape) }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select()
        .from(schema.ownerPostComments)
        .where(eq(schema.ownerPostComments.postId, args.postId))
        .orderBy(asc(schema.ownerPostComments.id))
        .limit(args.limit);
      return {
        comments: rows.map((r) => ({
          id: r.id,
          post_id: r.postId,
          body: r.body,
          author_name: r.authorName,
          created_at: r.createdAt.toISOString(),
        })),
      };
    },
  }),

  addOwnerPostComment: defineAction({
    description:
      "Adds a comment under a Home wall post, under the commenter's account name (the owner's admin-mode comments carry the Lakay name) — commenting takes a free account, so no comment is anonymous. Bad words are blurred before the comment is stored.",
    request: z.object({
      postId: z.number().int().positive(),
      body: z.string().trim().min(1).max(1000),
      ...memberCredFields,
    }),
    response: z.object({ id: z.number() }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const authorName = await authorNameForWrite(ctx, args);
      const parent = await db
        .select({ id: schema.ownerPosts.id })
        .from(schema.ownerPosts)
        .where(eq(schema.ownerPosts.id, args.postId))
        .limit(1);
      if (!parent[0]) throw new Error("addOwnerPostComment: post not found");
      const result = await db
        .insert(schema.ownerPostComments)
        .values({
          postId: args.postId,
          body: censorText(args.body),
          authorName: censorText(authorName),
        })
        .returning({ id: schema.ownerPostComments.id });
      const inserted = result[0];
      if (!inserted) throw new Error("addOwnerPostComment: insert returned no rows");
      ctx.invalidateQueries();
      return { id: inserted.id };
    },
  }),

  deleteOwnerPostComment: defineAction({
    description: "Removes one comment under one of the owner's posts (host moderation).",
    request: z.object({
      ...memberCredFields, id: z.number().int().positive() }),
    response: okResponse,
    handler: async (ctx, args): Promise<z.infer<typeof okResponse>> => {
      await requireAdmin(ctx, args);
      const db = ctx.db<typeof schema>();
      await db
        .delete(schema.ownerPostComments)
        .where(eq(schema.ownerPostComments.id, args.id));
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),

  // The notifications feed: the newest community activity in one
  // list — stories/confessions, polls, and the owner's message —
  // newest first. The client bell badges anything newer than the
  // last time this device opened the feed. When Lakay ships as
  // native App Store / Play apps, real device push notifications
  // will be driven by these same event kinds; the feed is the
  // in-app half of that system and needs no change then.
  getWhatsNew: defineAction({
    description:
      "Returns the newest community activity — recent stories and confessions, new polls, new kont (riddles), the owner's current message, the owner's posts, the newest daily fresh articles, and upcoming community events — newest first, for the in-app notifications feed.",
    request: z.object({}),
    response: z.object({
      events: z.array(
        z.object({
          kind: z.enum(["story", "confession", "poll", "message", "article", "event", "kont", "restaurant", "post"]),
          id: z.number(),
          title: z.string(),
          at: z.string(),
        }),
      ),
    }),
    async handler(ctx) {
      const db = ctx.db<typeof schema>();
      const events: {
        kind: "story" | "confession" | "poll" | "message" | "article" | "event" | "kont" | "restaurant" | "post";
        id: number;
        title: string;
        at: string;
      }[] = [];
      const storyRows = await db
        .select({
          id: schema.stories.id,
          kind: schema.stories.kind,
          title: schema.stories.title,
          createdAt: schema.stories.createdAt,
        })
        .from(schema.stories)
        .orderBy(desc(schema.stories.id))
        .limit(10);
      for (const r of storyRows) {
        events.push({
          kind: r.kind,
          id: r.id,
          title: r.title,
          at: r.createdAt.toISOString(),
        });
      }
      const pollRows = await db
        .select({
          id: schema.polls.id,
          question: schema.polls.question,
          createdAt: schema.polls.createdAt,
        })
        .from(schema.polls)
        .orderBy(desc(schema.polls.id))
        .limit(10);
      for (const r of pollRows) {
        events.push({
          kind: "poll",
          id: r.id,
          title: r.question,
          at: r.createdAt.toISOString(),
        });
      }
      const riddleRows = await db
        .select({
          id: schema.riddles.id,
          riddle: schema.riddles.riddle,
          createdAt: schema.riddles.createdAt,
        })
        .from(schema.riddles)
        .orderBy(desc(schema.riddles.id))
        .limit(5);
      for (const r of riddleRows) {
        events.push({
          kind: "kont",
          id: r.id,
          title: r.riddle,
          at: r.createdAt.toISOString(),
        });
      }
      const shoutoutRows = await db
        .select({
          id: schema.restaurantShoutouts.id,
          name: schema.restaurantShoutouts.name,
          createdAt: schema.restaurantShoutouts.createdAt,
        })
        .from(schema.restaurantShoutouts)
        .orderBy(desc(schema.restaurantShoutouts.id))
        .limit(5);
      for (const r of shoutoutRows) {
        events.push({
          kind: "restaurant",
          id: r.id,
          title: r.name,
          at: r.createdAt.toISOString(),
        });
      }
      const articleRows = await db
        .select({
          id: schema.dailyArticles.id,
          title: schema.dailyArticles.title,
          createdAt: schema.dailyArticles.createdAt,
        })
        .from(schema.dailyArticles)
        .where(isNotNull(schema.dailyArticles.title))
        .orderBy(desc(schema.dailyArticles.id))
        .limit(10);
      for (const r of articleRows) {
        events.push({
          kind: "article",
          id: r.id,
          title: r.title ?? "",
          at: r.createdAt.toISOString(),
        });
      }
      // "Today" for the events board is the owner's day —
      // America/New_York — not UTC: with a UTC date, this evening's
      // events (already tomorrow in UTC) fell out of the bell while
      // it was still today for the community in the Eastern US.
      const todayKey = new Intl.DateTimeFormat("en-CA", {
        timeZone: "America/New_York",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(new Date());
      const eventRows = await db
        .select({
          id: schema.events.id,
          title: schema.events.title,
          createdAt: schema.events.createdAt,
        })
        .from(schema.events)
        .where(gte(schema.events.eventDate, todayKey))
        .orderBy(desc(schema.events.id))
        .limit(5);
      for (const r of eventRows) {
        events.push({
          kind: "event",
          id: r.id,
          title: r.title,
          at: r.createdAt.toISOString(),
        });
      }
      const msgRows = await db
        .select()
        .from(schema.ownerMessage)
        .where(eq(schema.ownerMessage.id, 1))
        .limit(1);
      const msg = msgRows[0];
      if (msg) {
        events.push({
          kind: "message",
          id: 1,
          // A media-only message (photo/video/link, no text) still
          // needs a title in the bell — fall back to what it carries.
          title:
            msg.body.trim() ||
            msg.linkUrl ||
            msg.videoLink ||
            "New message from Lakay",
          at: msg.updatedAt.toISOString(),
        });
      }
      const postRows = await db
        .select({
          id: schema.ownerPosts.id,
          title: schema.ownerPosts.title,
          body: schema.ownerPosts.body,
          videoLink: schema.ownerPosts.videoLink,
          linkUrl: schema.ownerPosts.linkUrl,
          createdAt: schema.ownerPosts.createdAt,
        })
        .from(schema.ownerPosts)
        .orderBy(desc(schema.ownerPosts.id))
        .limit(5);
      for (const r of postRows) {
        events.push({
          kind: "post",
          id: r.id,
          // A media-only post (photo/video/link, no words) still
          // needs a title in the bell — fall back to what it carries.
          title:
            r.title?.trim() ||
            r.body.trim() ||
            r.linkUrl ||
            r.videoLink ||
            "New post from Lakay",
          at: r.createdAt.toISOString(),
        });
      }
      events.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
      return { events: events.slice(0, 15) };
    },
  }),

  listStories: defineAction({
    description: "Lists stories and confessions shared by the community, newest first.",
    request: z.object({ limit: z.number().int().positive().max(100).default(50) }),
    response: z.object({ stories: z.array(storyShape) }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select()
        .from(schema.stories)
        .orderBy(desc(schema.stories.id))
        .limit(args.limit);
      const countRows = await db
        .select({
          storyId: schema.storyComments.storyId,
          n: sql<number>`count(*)`,
        })
        .from(schema.storyComments)
        .groupBy(schema.storyComments.storyId);
      const counts = new Map(countRows.map((r) => [r.storyId, r.n]));
      const stories = await Promise.all(
        rows.map(async (r) => ({
          id: r.id,
          kind: r.kind,
          title: r.title,
          body: r.body,
          author_name: r.authorName,
          image_url: r.imageBlobKey ? await ctx.blobs.getUrl(r.imageBlobKey) : null,
          hearts: r.hearts,
          comment_count: counts.get(r.id) ?? 0,
          created_at: r.createdAt.toISOString(),
        })),
      );
      return { stories };
    },
  }),

  addStory: defineAction({
    description:
      "Posts a new story or confession to Stories & Confessions, with an optional photo, under the poster's account name — posting takes a free account, so nothing is posted anonymously. Bad words are blurred before the post is stored.",
    request: z.object({
      kind: z.enum(["story", "confession"]),
      title: z.string().trim().min(1).max(120),
      body: z.string().trim().min(1).max(4000),
      imageBase64: z.string().max(4_200_000).optional(),
      imageType: z
        .enum(["image/jpeg", "image/png", "image/webp", "image/gif"])
        .optional(),
      ...memberCredFields,
    }),
    response: z.object({ id: z.number() }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const authorName = await authorNameForWrite(ctx, args);
      let imageBlobKey: string | null = null;
      if (args.imageBase64 && args.imageType) {
        const bytes = Buffer.from(args.imageBase64, "base64");
        if (bytes.length > 0 && bytes.length <= 3_200_000) {
          imageBlobKey = `story-photos/${crypto.randomUUID()}`;
          await ctx.blobs.put(imageBlobKey, bytes, {
            contentType: args.imageType,
          });
        }
      }
      const result = await db
        .insert(schema.stories)
        .values({
          kind: args.kind,
          title: censorText(args.title),
          body: censorText(args.body),
          authorName: censorText(authorName),
          imageBlobKey,
        })
        .returning({ id: schema.stories.id });
      const inserted = result[0];
      if (!inserted) throw new Error("addStory: insert returned no rows");
      ctx.invalidateQueries();
      return { id: inserted.id };
    },
  }),

  updateStory: defineAction({
    description:
      "Edits a story or confession in place (owner/admin moderation). Bad words are blurred before the edit is stored.",
    request: z.object({
      ...memberCredFields,
      id: z.number().int().positive(),
      title: z.string().trim().min(1).max(120),
      body: z.string().trim().min(1).max(4000),
      authorName: z.string().trim().max(60).nullable().optional(),
    }),
    response: okResponse,
    handler: async (ctx, args): Promise<z.infer<typeof okResponse>> => {
      await requireAdmin(ctx, args);
      const db = ctx.db<typeof schema>();
      await db
        .update(schema.stories)
        .set({
          title: censorText(args.title),
          body: censorText(args.body),
          authorName:
            args.authorName === undefined
              ? undefined
              : args.authorName
                ? censorText(args.authorName)
                : null,
        })
        .where(eq(schema.stories.id, args.id));
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),

  heartStory: defineAction({
    description:
      "Adds one heart (like) to a story or confession and records who gave it in content_likes: a signed-in member by name + email (the server refuses a second heart from the same account), a guest anonymously. The liker rows are only ever read back through the admin-code-locked listLikers action — everyone else sees just the count.",
    request: z.object({
      id: z.number().int().positive(),
      memberName: z.string().trim().max(60).optional(),
      memberEmail: z.string().trim().toLowerCase().max(120).optional(),
    }),
    response: okResponse,
    handler: async (ctx, args): Promise<z.infer<typeof okResponse>> => {
      const db = ctx.db<typeof schema>();
      const email = args.memberEmail || null;
      if (email) {
        const existing = await db
          .select({ id: schema.contentLikes.id })
          .from(schema.contentLikes)
          .where(
            and(
              eq(schema.contentLikes.kind, "story"),
              eq(schema.contentLikes.targetId, args.id),
              eq(schema.contentLikes.memberEmail, email),
            ),
          )
          .limit(1);
        if (existing.length > 0) return { ok: true };
      }
      await db.insert(schema.contentLikes).values({
        kind: "story",
        targetId: args.id,
        memberName: email ? censorText(args.memberName ?? "") || null : null,
        memberEmail: email,
      });
      await db
        .update(schema.stories)
        .set({ hearts: sql`${schema.stories.hearts} + 1` })
        .where(eq(schema.stories.id, args.id));
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),

  deleteStory: defineAction({
    description: "Removes a story or confession and its comments (host moderation).",
    request: z.object({
      ...memberCredFields, id: z.number().int().positive() }),
    response: okResponse,
    handler: async (ctx, args): Promise<z.infer<typeof okResponse>> => {
      await requireAdmin(ctx, args);
      const db = ctx.db<typeof schema>();
      await db
        .delete(schema.storyComments)
        .where(eq(schema.storyComments.storyId, args.id));
      await db
        .delete(schema.contentLikes)
        .where(
          and(
            eq(schema.contentLikes.kind, "story"),
            eq(schema.contentLikes.targetId, args.id),
          ),
        );
      await db.delete(schema.stories).where(eq(schema.stories.id, args.id));
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),

  listStoryComments: defineAction({
    description: "Lists the comments under one story or confession, oldest first.",
    request: z.object({
      storyId: z.number().int().positive(),
      limit: z.number().int().positive().max(200).default(100),
    }),
    response: z.object({ comments: z.array(commentShape) }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select()
        .from(schema.storyComments)
        .where(eq(schema.storyComments.storyId, args.storyId))
        .orderBy(asc(schema.storyComments.id))
        .limit(args.limit);
      return {
        comments: rows.map((r) => ({
          id: r.id,
          story_id: r.storyId,
          body: r.body,
          author_name: r.authorName,
          created_at: r.createdAt.toISOString(),
        })),
      };
    },
  }),

  addStoryComment: defineAction({
    description:
      "Adds a comment under a story or confession, under the commenter's account name — commenting takes a free account, so no comment is anonymous. Bad words are blurred before the comment is stored.",
    request: z.object({
      storyId: z.number().int().positive(),
      body: z.string().trim().min(1).max(1000),
      ...memberCredFields,
    }),
    response: z.object({ id: z.number() }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const authorName = await authorNameForWrite(ctx, args);
      const parent = await db
        .select({ id: schema.stories.id })
        .from(schema.stories)
        .where(eq(schema.stories.id, args.storyId))
        .limit(1);
      if (!parent[0]) throw new Error("addStoryComment: story not found");
      const result = await db
        .insert(schema.storyComments)
        .values({
          storyId: args.storyId,
          body: censorText(args.body),
          authorName: censorText(authorName),
        })
        .returning({ id: schema.storyComments.id });
      const inserted = result[0];
      if (!inserted) throw new Error("addStoryComment: insert returned no rows");
      ctx.invalidateQueries();
      return { id: inserted.id };
    },
  }),

  updateStoryComment: defineAction({
    description:
      "Edits a comment under a story or confession (owner/admin moderation). Bad words are blurred before the edit is stored.",
    request: z.object({
      ...memberCredFields,
      id: z.number().int().positive(),
      body: z.string().trim().min(1).max(1000),
      authorName: z.string().trim().max(60).nullable().optional(),
    }),
    response: okResponse,
    handler: async (ctx, args): Promise<z.infer<typeof okResponse>> => {
      await requireAdmin(ctx, args);
      const db = ctx.db<typeof schema>();
      await db
        .update(schema.storyComments)
        .set({
          body: censorText(args.body),
          authorName:
            args.authorName === undefined
              ? undefined
              : args.authorName
                ? censorText(args.authorName)
                : null,
        })
        .where(eq(schema.storyComments.id, args.id));
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),

  deleteStoryComment: defineAction({
    description: "Removes one comment under a story (host moderation).",
    request: z.object({
      ...memberCredFields, id: z.number().int().positive() }),
    response: okResponse,
    handler: async (ctx, args): Promise<z.infer<typeof okResponse>> => {
      await requireAdmin(ctx, args);
      const db = ctx.db<typeof schema>();
      await db
        .delete(schema.storyComments)
        .where(eq(schema.storyComments.id, args.id));
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),

  listQuestions: defineAction({
    description:
      "Lists questions sent to Lakay: unanswered first (his inbox), then answered ones newest first.",
    request: z.object({ limit: z.number().int().positive().max(100).default(50) }),
    response: z.object({ questions: z.array(questionShape) }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const [waitingRaw, answered, vipRows] = await Promise.all([
        db
          .select()
          .from(schema.questions)
          .where(sql`${schema.questions.answer} IS NULL`)
          .orderBy(asc(schema.questions.id))
          .limit(args.limit),
        db
          .select()
          .from(schema.questions)
          .where(isNotNull(schema.questions.answer))
          .orderBy(desc(schema.questions.answeredAt))
          .limit(args.limit),
        db
          .select({ name: schema.supporters.name })
          .from(schema.supporters)
          .where(eq(schema.supporters.kind, "vip")),
      ]);
      // VIP perk: questions from VIP members (matched by the name they
      // gave) move to the front of Lakay's inbox.
      const vipNames = new Set(
        vipRows
          .map((r) => r.name?.trim().toLowerCase())
          .filter((n): n is string => !!n),
      );
      const waiting = [...waitingRaw].sort((a, b) => {
        const av = a.name && vipNames.has(a.name.trim().toLowerCase()) ? 0 : 1;
        const bv = b.name && vipNames.has(b.name.trim().toLowerCase()) ? 0 : 1;
        return av - bv || a.id - b.id;
      });
      const map = (r: (typeof waiting)[number]) => ({
        id: r.id,
        name: r.name,
        topic: r.topic,
        question: r.question,
        answer: r.answer,
        answered_at: r.answeredAt ? r.answeredAt.toISOString() : null,
        created_at: r.createdAt.toISOString(),
      });
      return { questions: [...waiting.map(map), ...answered.map(map)] };
    },
  }),

  askQuestion: defineAction({
    description:
      "Sends a question or advice request to Lakay, under the asker's account name — asking takes a free account, so no question is anonymous.",
    request: z.object({
      topic: z.string().trim().min(1).max(40),
      question: z.string().trim().min(1).max(2000),
      ...memberCredFields,
    }),
    response: z.object({ id: z.number() }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const authorName = await authorNameForWrite(ctx, args);
      const result = await db
        .insert(schema.questions)
        .values({
          name: censorText(authorName),
          topic: censorText(args.topic),
          question: censorText(args.question),
        })
        .returning({ id: schema.questions.id });
      const inserted = result[0];
      if (!inserted) throw new Error("askQuestion: insert returned no rows");
      ctx.invalidateQueries();
      return { id: inserted.id };
    },
  }),

  answerQuestion: defineAction({
    description: "Publishes Lakay's answer to a reader's question.",
    request: z.object({
      ...memberCredFields,
      id: z.number().int().positive(),
      answer: z.string().trim().min(1).max(4000),
    }),
    response: okResponse,
    handler: async (ctx, args): Promise<z.infer<typeof okResponse>> => {
      await requireAdmin(ctx, args);
      const db = ctx.db<typeof schema>();
      await db
        .update(schema.questions)
        .set({ answer: censorText(args.answer), answeredAt: new Date() })
        .where(eq(schema.questions.id, args.id));
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),

  updateQuestion: defineAction({
    description:
      "Edits a question sent to Lakay and/or Lakay's published answer (owner/admin). Pass answer as null to clear the answer; a non-empty answer keeps or sets the answered time.",
    request: z.object({
      ...memberCredFields,
      id: z.number().int().positive(),
      topic: z.string().trim().min(1).max(40).optional(),
      question: z.string().trim().min(1).max(2000).optional(),
      answer: z.string().trim().max(4000).nullable().optional(),
    }),
    response: okResponse,
    handler: async (ctx, args): Promise<z.infer<typeof okResponse>> => {
      await requireAdmin(ctx, args);
      const db = ctx.db<typeof schema>();
      const patch: {
        topic?: string;
        question?: string;
        answer?: string | null;
        answeredAt?: Date | null;
      } = {};
      if (args.topic !== undefined) patch.topic = censorText(args.topic);
      if (args.question !== undefined) patch.question = censorText(args.question);
      if (args.answer !== undefined) {
        if (args.answer === null || args.answer === "") {
          patch.answer = null;
          patch.answeredAt = null;
        } else {
          patch.answer = censorText(args.answer);
          const existing = await db
            .select({ answeredAt: schema.questions.answeredAt })
            .from(schema.questions)
            .where(eq(schema.questions.id, args.id))
            .limit(1);
          patch.answeredAt = existing[0]?.answeredAt ?? new Date();
        }
      }
      if (Object.keys(patch).length > 0) {
        await db
          .update(schema.questions)
          .set(patch)
          .where(eq(schema.questions.id, args.id));
      }
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),

  deleteQuestion: defineAction({
    description: "Removes a question sent to Lakay (host moderation).",
    request: z.object({
      ...memberCredFields, id: z.number().int().positive() }),
    response: okResponse,
    handler: async (ctx, args): Promise<z.infer<typeof okResponse>> => {
      await requireAdmin(ctx, args);
      const db = ctx.db<typeof schema>();
      await db.delete(schema.questions).where(eq(schema.questions.id, args.id));
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),

  listSpotlights: defineAction({
    description:
      "Lists music artist spotlights added by the community, newest first, each with its like count and comment count.",
    request: z.object({ limit: z.number().int().positive().max(100).default(50) }),
    response: z.object({ spotlights: z.array(spotlightShape) }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select()
        .from(schema.spotlights)
        .orderBy(desc(schema.spotlights.id))
        .limit(args.limit);
      const ids = rows.map((r) => r.id);
      const countRows =
        ids.length > 0
          ? await db
              .select({
                spotlightId: schema.spotlightComments.spotlightId,
                count: sql<number>`count(*)`,
              })
              .from(schema.spotlightComments)
              .where(inArray(schema.spotlightComments.spotlightId, ids))
              .groupBy(schema.spotlightComments.spotlightId)
          : [];
      const counts = new Map(countRows.map((r) => [r.spotlightId, r.count]));
      const spotlights = await Promise.all(
        rows.map(async (r) => {
          let keys: string[] = [];
          try {
            const parsed: unknown = r.imageKeys ? JSON.parse(r.imageKeys) : [];
            if (Array.isArray(parsed)) {
              keys = parsed.filter((k): k is string => typeof k === "string");
            }
          } catch {
            keys = [];
          }
          return {
            id: r.id,
            artist: r.artist,
            song: r.song,
            genre: r.genre,
            note: r.note,
            link: r.link,
            added_by: r.addedBy,
            likes: r.likes,
            comment_count: counts.get(r.id) ?? 0,
            image_urls: await Promise.all(keys.map((k) => ctx.blobs.getUrl(k))),
            video_url: r.videoBlobKey
              ? await ctx.blobs.getUrl(r.videoBlobKey)
              : null,
            created_at: r.createdAt.toISOString(),
          };
        }),
      );
      return { spotlights };
    },
  }),

  likeSpotlight: defineAction({
    description:
      "Adds one like to a shared song on the music wall and records who gave it in content_likes, the same way heartStory does: members by name + email (no second like from the same account), guests anonymously. Only the owner sees the names, through listLikers.",
    request: z.object({
      id: z.number().int().positive(),
      memberName: z.string().trim().max(60).optional(),
      memberEmail: z.string().trim().toLowerCase().max(120).optional(),
    }),
    response: okResponse,
    handler: async (ctx, args): Promise<z.infer<typeof okResponse>> => {
      const db = ctx.db<typeof schema>();
      const email = args.memberEmail || null;
      if (email) {
        const existing = await db
          .select({ id: schema.contentLikes.id })
          .from(schema.contentLikes)
          .where(
            and(
              eq(schema.contentLikes.kind, "spotlight"),
              eq(schema.contentLikes.targetId, args.id),
              eq(schema.contentLikes.memberEmail, email),
            ),
          )
          .limit(1);
        if (existing.length > 0) return { ok: true };
      }
      await db.insert(schema.contentLikes).values({
        kind: "spotlight",
        targetId: args.id,
        memberName: email ? censorText(args.memberName ?? "") || null : null,
        memberEmail: email,
      });
      await db
        .update(schema.spotlights)
        .set({ likes: sql`${schema.spotlights.likes} + 1` })
        .where(eq(schema.spotlights.id, args.id));
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),

  listSpotlightComments: defineAction({
    description: "Lists the comments under one shared song, oldest first.",
    request: z.object({
      spotlightId: z.number().int().positive(),
      limit: z.number().int().positive().max(200).default(100),
    }),
    response: z.object({ comments: z.array(spotlightCommentShape) }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select()
        .from(schema.spotlightComments)
        .where(eq(schema.spotlightComments.spotlightId, args.spotlightId))
        .orderBy(asc(schema.spotlightComments.id))
        .limit(args.limit);
      return {
        comments: rows.map((r) => ({
          id: r.id,
          spotlight_id: r.spotlightId,
          body: r.body,
          author_name: r.authorName,
          created_at: r.createdAt.toISOString(),
        })),
      };
    },
  }),

  addSpotlightComment: defineAction({
    description:
      "Adds a comment under a shared song, under the commenter's account name — commenting takes a free account, so no comment is anonymous. Bad words are blurred before the comment is stored.",
    request: z.object({
      spotlightId: z.number().int().positive(),
      body: z.string().trim().min(1).max(1000),
      ...memberCredFields,
    }),
    response: z.object({ id: z.number() }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const authorName = await authorNameForWrite(ctx, args);
      const parent = await db
        .select({ id: schema.spotlights.id })
        .from(schema.spotlights)
        .where(eq(schema.spotlights.id, args.spotlightId))
        .limit(1);
      if (!parent[0]) throw new Error("addSpotlightComment: song not found");
      const result = await db
        .insert(schema.spotlightComments)
        .values({
          spotlightId: args.spotlightId,
          body: censorText(args.body),
          authorName: censorText(authorName),
        })
        .returning({ id: schema.spotlightComments.id });
      const inserted = result[0];
      if (!inserted) throw new Error("addSpotlightComment: insert returned no rows");
      ctx.invalidateQueries();
      return { id: inserted.id };
    },
  }),

  deleteSpotlightComment: defineAction({
    description: "Removes one comment under a shared song (host moderation).",
    request: z.object({
      ...memberCredFields, id: z.number().int().positive() }),
    response: okResponse,
    handler: async (ctx, args): Promise<z.infer<typeof okResponse>> => {
      await requireAdmin(ctx, args);
      const db = ctx.db<typeof schema>();
      await db
        .delete(schema.spotlightComments)
        .where(eq(schema.spotlightComments.id, args.id));
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),

  addSpotlight: defineAction({
    description: "Adds a music artist spotlight (a new artist or song people should hear), under the sharer's account name — sharing takes a free account, so nothing is shared anonymously. The share carries a listen link (so the song plays inside the app) and/or the sharer's own media: up to four photos and one short video clip of their own. A listen link is required unless a video is attached — the post itself then carries the music.",
    request: z.object({
      artist: z.string().trim().min(1).max(120),
      song: z.string().trim().max(160).optional(),
      genre: z.string().trim().min(1).max(40),
      note: z.string().trim().min(1).max(600),
      // A listen link turns a share into a song people can play
      // right here. It is required unless the sharer attaches a
      // short video of their own — then the post carries the music
      // itself and no link is needed. (Older rows without a link
      // stay listed; the admin edit can still add one.)
      link: z
        .string()
        .trim()
        .max(500)
        .optional()
        .refine((v) => !v || /^https?:\/\//i.test(v), {
          message: "Link must start with http:// or https://",
        }),
      images: z
        .array(
          z.object({
            base64: z.string().max(4_200_000),
            type: z.enum(["image/jpeg", "image/png", "image/webp", "image/gif"]),
          }),
        )
        .max(4)
        .optional(),
      video: z
        .object({
          base64: z.string().max(28_000_000),
          type: z.enum(["video/mp4", "video/webm", "video/quicktime"]),
        })
        .optional(),
      ...memberCredFields,
    }),
    response: z.object({ id: z.number() }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const authorName = await authorNameForWrite(ctx, args);
      const link = args.link ? args.link : null;
      if (!link && !args.video) {
        throw new Error(
          "addSpotlight: a share needs a listen link or an attached video",
        );
      }
      const imageKeys: string[] = [];
      for (const img of args.images ?? []) {
        const bytes = Buffer.from(img.base64, "base64");
        if (bytes.length > 0 && bytes.length <= 3_200_000) {
          const key = `spotlight-photos/${crypto.randomUUID()}`;
          await ctx.blobs.put(key, bytes, { contentType: img.type });
          imageKeys.push(key);
        }
      }
      let videoBlobKey: string | null = null;
      if (args.video) {
        const bytes = Buffer.from(args.video.base64, "base64");
        // A short clip only — about a minute of phone video. The
        // client checks the size before sending; this is the
        // server-side backstop so an oversized clip is never kept.
        if (bytes.length === 0 || bytes.length > 21_000_000) {
          throw new Error("addSpotlight: video is empty or over the size limit");
        }
        videoBlobKey = `spotlight-videos/${crypto.randomUUID()}`;
        await ctx.blobs.put(videoBlobKey, bytes, {
          contentType: args.video.type,
        });
      }
      const result = await db
        .insert(schema.spotlights)
        .values({
          artist: censorText(args.artist),
          song: args.song ? censorText(args.song) : null,
          genre: args.genre,
          note: censorText(args.note),
          link,
          addedBy: censorText(authorName),
          imageKeys: imageKeys.length > 0 ? JSON.stringify(imageKeys) : null,
          videoBlobKey,
        })
        .returning({ id: schema.spotlights.id });
      const inserted = result[0];
      if (!inserted) throw new Error("addSpotlight: insert returned no rows");
      ctx.invalidateQueries();
      return { id: inserted.id };
    },
  }),

  updateSpotlight: defineAction({
    description:
      "Edits a music artist spotlight in place (owner/admin moderation). Bad words are blurred before the edit is stored.",
    request: z.object({
      ...memberCredFields,
      id: z.number().int().positive(),
      artist: z.string().trim().min(1).max(120),
      song: z.string().trim().max(160).nullable().optional(),
      genre: z.string().trim().min(1).max(40),
      note: z.string().trim().min(1).max(600),
      link: z
        .string()
        .trim()
        .max(500)
        .nullable()
        .optional()
        .refine((v) => v == null || v === "" || /^https?:\/\//i.test(v), {
          message: "Link must start with http:// or https://",
        }),
      addedBy: z.string().trim().max(60).nullable().optional(),
    }),
    response: okResponse,
    handler: async (ctx, args): Promise<z.infer<typeof okResponse>> => {
      await requireAdmin(ctx, args);
      const db = ctx.db<typeof schema>();
      await db
        .update(schema.spotlights)
        .set({
          artist: censorText(args.artist),
          song:
            args.song === undefined
              ? undefined
              : args.song
                ? censorText(args.song)
                : null,
          genre: args.genre,
          note: censorText(args.note),
          link:
            args.link === undefined ? undefined : args.link ? args.link : null,
          addedBy:
            args.addedBy === undefined
              ? undefined
              : args.addedBy
                ? censorText(args.addedBy)
                : null,
        })
        .where(eq(schema.spotlights.id, args.id));
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),

  deleteSpotlight: defineAction({
    description: "Removes a music artist spotlight, its comments and like records, and the photos/video stored for it (host moderation).",
    request: z.object({
      ...memberCredFields, id: z.number().int().positive() }),
    response: okResponse,
    handler: async (ctx, args): Promise<z.infer<typeof okResponse>> => {
      await requireAdmin(ctx, args);
      const db = ctx.db<typeof schema>();
      const existing = await db
        .select({
          imageKeys: schema.spotlights.imageKeys,
          videoBlobKey: schema.spotlights.videoBlobKey,
        })
        .from(schema.spotlights)
        .where(eq(schema.spotlights.id, args.id))
        .limit(1);
      const row = existing[0];
      if (row) {
        let keys: string[] = [];
        try {
          const parsed: unknown = row.imageKeys ? JSON.parse(row.imageKeys) : [];
          if (Array.isArray(parsed)) {
            keys = parsed.filter((k): k is string => typeof k === "string");
          }
        } catch {
          keys = [];
        }
        if (row.videoBlobKey) keys.push(row.videoBlobKey);
        for (const key of keys) {
          try {
            await ctx.blobs.delete(key);
          } catch {
            // A blob that is already gone must not block the delete.
          }
        }
      }
      await db
        .delete(schema.spotlightComments)
        .where(eq(schema.spotlightComments.spotlightId, args.id));
      await db
        .delete(schema.contentLikes)
        .where(
          and(
            eq(schema.contentLikes.kind, "spotlight"),
            eq(schema.contentLikes.targetId, args.id),
          ),
        );
      await db.delete(schema.spotlights).where(eq(schema.spotlights.id, args.id));
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),

  translateUserText: defineAction({
    description:
      "Translates one piece of community-written text (a wall post, story, comment, question, note) into the reader's chosen language, for the small Translate button on that post. The original is never changed; a finished translation is stored in text_translations keyed by the exact source text, so the same words are only ever translated once, for everyone.",
    request: z.object({
      text: z.string().trim().min(1).max(2000),
      lang: z.enum(["en", "ht", "fr", "es", "pt"]),
    }),
    response: z.object({ text: z.string() }),
    handler: async (ctx, args): Promise<{ text: string }> => {
      const db = ctx.db<typeof schema>();
      const target = LANG_NAMES_FOR_TRANSLATION[args.lang];
      if (!target) throw new Error("translateUserText: unknown language");
      const stored = await db
        .select({ translated: schema.textTranslations.translated })
        .from(schema.textTranslations)
        .where(
          and(
            eq(schema.textTranslations.sourceText, args.text),
            eq(schema.textTranslations.lang, args.lang),
          ),
        )
        .limit(1);
      if (stored[0]) return { text: stored[0].translated };
      const translated = await translateTextFresh(
        ctx,
        args.text,
        args.lang,
        target,
      );
      return { text: translated };
    },
  }),

  listDailyAnswers: defineAction({
    description:
      "Lists the community's answers to the Question of the Day for one calendar day (day_key is the reader-local YYYY-MM-DD), oldest first so the conversation reads top to bottom.",
    request: z.object({
      dayKey: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      limit: z.number().int().positive().max(200).default(100),
    }),
    response: z.object({
      answers: z.array(
        z.object({
          id: z.number(),
          body: z.string(),
          author_name: z.string().nullable(),
          created_at: z.string(),
        }),
      ),
    }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select()
        .from(schema.dailyAnswers)
        .where(eq(schema.dailyAnswers.dayKey, args.dayKey))
        .orderBy(asc(schema.dailyAnswers.id))
        .limit(args.limit);
      return {
        answers: rows.map((r) => ({
          id: r.id,
          body: r.body,
          author_name: r.authorName,
          created_at: r.createdAt.toISOString(),
        })),
      };
    },
  }),

  addDailyAnswer: defineAction({
    description:
      "Adds one member's answer to the Question of the Day, under their account name — answering takes a free account, like every post in Lakay. Bad words are blurred before the answer is stored.",
    request: z.object({
      dayKey: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      body: z.string().trim().min(1).max(1000),
      ...memberCredFields,
    }),
    response: z.object({ id: z.number() }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const authorName = await authorNameForWrite(ctx, args);
      const result = await db
        .insert(schema.dailyAnswers)
        .values({
          dayKey: args.dayKey,
          body: censorText(args.body),
          authorName: censorText(authorName),
        })
        .returning({ id: schema.dailyAnswers.id });
      const inserted = result[0];
      if (!inserted) throw new Error("addDailyAnswer: insert returned no rows");
      ctx.invalidateQueries();
      return { id: inserted.id };
    },
  }),

  deleteDailyAnswer: defineAction({
    description: "Removes one answer to the Question of the Day (host moderation).",
    request: z.object({
      ...memberCredFields, id: z.number().int().positive() }),
    response: okResponse,
    handler: async (ctx, args): Promise<z.infer<typeof okResponse>> => {
      await requireAdmin(ctx, args);
      const db = ctx.db<typeof schema>();
      await db
        .delete(schema.dailyAnswers)
        .where(eq(schema.dailyAnswers.id, args.id));
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),

  createChallenge: defineAction({
    description:
      "Creates a trivia challenge: a signed-in member picks a chapter and gets a short code to send a friend however they like. The challenger is recorded from their verified account; the friend's slot is claimed by the first other member who submits a score with the code.",
    request: z.object({
      chapterN: z.number().int().min(1).max(500),
      ...memberCredFields,
    }),
    response: z.object({ code: z.string() }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const member = await verifiedMember(ctx, args);
      if (!member) {
        throw new Error("login_required: challenging a friend takes a free Lakay account");
      }
      const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
      for (let attempt = 0; attempt < 6; attempt += 1) {
        const bytes = new Uint8Array(6);
        crypto.getRandomValues(bytes);
        const code = [...bytes].map((b) => alphabet[b % alphabet.length]).join("");
        try {
          await db.insert(schema.triviaChallenges).values({
            code,
            chapterN: args.chapterN,
            challengerName: member.name,
            challengerEmail: member.email,
          });
          ctx.invalidateQueries();
          return { code };
        } catch {
          // Code collision — draw another one.
        }
      }
      throw new Error("createChallenge: could not draw a fresh code");
    },
  }),

  getChallenge: defineAction({
    description:
      "Reads one trivia challenge by its code: the chapter, both players' names, and their scores once each side has played. Emails are never returned — names and scores only.",
    request: z.object({ code: z.string().trim().min(4).max(12) }),
    response: z.object({
      found: z.boolean(),
      chapter_n: z.number().nullable(),
      challenger_name: z.string().nullable(),
      challenger_score: z.number().nullable(),
      friend_name: z.string().nullable(),
      friend_score: z.number().nullable(),
    }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select()
        .from(schema.triviaChallenges)
        .where(eq(schema.triviaChallenges.code, args.code.trim().toUpperCase()))
        .limit(1);
      const row = rows[0];
      if (!row) {
        return {
          found: false,
          chapter_n: null,
          challenger_name: null,
          challenger_score: null,
          friend_name: null,
          friend_score: null,
        };
      }
      return {
        found: true,
        chapter_n: row.chapterN,
        challenger_name: row.challengerName,
        challenger_score: row.challengerScore,
        friend_name: row.friendName,
        friend_score: row.friendScore,
      };
    },
  }),

  submitChallengeScore: defineAction({
    description:
      "Records a player's trivia score on a challenge, from their verified account. The challenger's score fills the challenger slot; the first other member to submit claims the friend slot. A slot, once filled, keeps its first score — replaying a chapter to beat a challenge after seeing the other score isn't the game.",
    request: z.object({
      code: z.string().trim().min(4).max(12),
      score: z.number().int().min(0).max(1000),
      ...memberCredFields,
    }),
    response: z.object({ ok: z.boolean() }),
    async handler(ctx, args): Promise<{ ok: boolean }> {
      const db = ctx.db<typeof schema>();
      const member = await verifiedMember(ctx, args);
      if (!member) return { ok: false };
      const rows = await db
        .select()
        .from(schema.triviaChallenges)
        .where(eq(schema.triviaChallenges.code, args.code.trim().toUpperCase()))
        .limit(1);
      const row = rows[0];
      if (!row) return { ok: false };
      if (member.email === row.challengerEmail) {
        if (row.challengerScore === null) {
          await db
            .update(schema.triviaChallenges)
            .set({ challengerScore: args.score })
            .where(eq(schema.triviaChallenges.id, row.id));
        }
        ctx.invalidateQueries();
        return { ok: true };
      }
      if (row.friendEmail === null) {
        await db
          .update(schema.triviaChallenges)
          .set({
            friendEmail: member.email,
            friendName: member.name,
            friendScore: args.score,
          })
          .where(eq(schema.triviaChallenges.id, row.id));
        ctx.invalidateQueries();
        return { ok: true };
      }
      if (row.friendEmail === member.email) {
        if (row.friendScore === null) {
          await db
            .update(schema.triviaChallenges)
            .set({ friendScore: args.score })
            .where(eq(schema.triviaChallenges.id, row.id));
        }
        ctx.invalidateQueries();
        return { ok: true };
      }
      return { ok: false };
    },
  }),

  listMyChallenges: defineAction({
    description:
      "Lists the trivia challenges a signed-in member is part of — ones they created and ones they joined — newest first, with both names and scores. Only the caller's own challenges come back; the other player's email is never included.",
    request: z.object({ ...memberCredFields }),
    response: z.object({
      challenges: z.array(
        z.object({
          code: z.string(),
          chapter_n: z.number(),
          challenger_name: z.string(),
          challenger_score: z.number().nullable(),
          friend_name: z.string().nullable(),
          friend_score: z.number().nullable(),
          mine: z.enum(["challenger", "friend"]),
          created_at: z.string(),
        }),
      ),
    }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const member = await verifiedMember(ctx, args);
      if (!member) return { challenges: [] };
      const rows = await db
        .select()
        .from(schema.triviaChallenges)
        .where(
          sql`${schema.triviaChallenges.challengerEmail} = ${member.email} OR ${schema.triviaChallenges.friendEmail} = ${member.email}`,
        )
        .orderBy(desc(schema.triviaChallenges.id))
        .limit(30);
      return {
        challenges: rows.map((r) => ({
          code: r.code,
          chapter_n: r.chapterN,
          challenger_name: r.challengerName,
          challenger_score: r.challengerScore,
          friend_name: r.friendName,
          friend_score: r.friendScore,
          mine: (r.challengerEmail === member.email
            ? "challenger"
            : "friend") as "challenger" | "friend",
          created_at: r.createdAt.toISOString(),
        })),
      };
    },
  }),

  getMusicChart: defineAction({
    description:
      "The weekly music chart: the songs with the most likes since Monday (UTC), counted from the like records themselves (each like is a row with a time on it), top 10. Only like counts are public — who liked a song stays visible only to the owner, as everywhere in Lakay.",
    request: z.object({}),
    response: z.object({
      chart: z.array(
        z.object({
          id: z.number(),
          artist: z.string(),
          song: z.string().nullable(),
          likes_this_week: z.number(),
        }),
      ),
    }),
    async handler(ctx) {
      const db = ctx.db<typeof schema>();
      const weekStart = new Date();
      const daysSinceMonday = (weekStart.getUTCDay() + 6) % 7;
      weekStart.setUTCDate(weekStart.getUTCDate() - daysSinceMonday);
      weekStart.setUTCHours(0, 0, 0, 0);
      const likeRows = await db
        .select({
          targetId: schema.contentLikes.targetId,
          n: sql<number>`count(*)`,
        })
        .from(schema.contentLikes)
        .where(
          and(
            eq(schema.contentLikes.kind, "spotlight"),
            gte(schema.contentLikes.createdAt, weekStart),
          ),
        )
        .groupBy(schema.contentLikes.targetId)
        .orderBy(desc(sql`count(*)`))
        .limit(10);
      if (likeRows.length === 0) return { chart: [] };
      const songs = await db
        .select({
          id: schema.spotlights.id,
          artist: schema.spotlights.artist,
          song: schema.spotlights.song,
        })
        .from(schema.spotlights)
        .where(
          inArray(
            schema.spotlights.id,
            likeRows.map((r) => r.targetId),
          ),
        );
      const byId = new Map(songs.map((sp) => [sp.id, sp]));
      return {
        chart: likeRows.flatMap((r) => {
          const sp = byId.get(r.targetId);
          return sp
            ? [
                {
                  id: sp.id,
                  artist: sp.artist,
                  song: sp.song,
                  likes_this_week: r.n,
                },
              ]
            : [];
        }),
      };
    },
  }),

  pingPresence: defineAction({
    description:
      "The 'who's home now' heartbeat: an open app checks in with its session id every minute or so, and the answer is how many sessions checked in during the last three minutes. Stale sessions are swept as part of the same call. Only the count ever leaves the server — never who is home.",
    request: z.object({
      sessionId: z.string().trim().min(8).max(80),
      memberEmail: z.string().trim().toLowerCase().max(120).optional(),
    }),
    response: z.object({ count: z.number() }),
    async handler(ctx, args): Promise<{ count: number }> {
      const db = ctx.db<typeof schema>();
      const now = Date.now();
      await db
        .insert(schema.presence)
        .values({
          sessionId: args.sessionId,
          memberEmail: args.memberEmail ?? null,
          lastSeen: now,
        })
        .onConflictDoUpdate({
          target: schema.presence.sessionId,
          set: { lastSeen: now, memberEmail: args.memberEmail ?? null },
        });
      await db
        .delete(schema.presence)
        .where(sql`${schema.presence.lastSeen} < ${now - 10 * 60_000}`);
      const rows = await db
        .select({ n: sql<number>`count(*)` })
        .from(schema.presence)
        .where(sql`${schema.presence.lastSeen} >= ${now - 3 * 60_000}`);
      return { count: rows[0]?.n ?? 0 };
    },
  }),

  getMemberSpotlight: defineAction({
    description:
      "Returns the member spotlight on Home — the member of the week the owner picked — or null when none is set. Only the name and hometown are public; the email stays server-side.",
    request: z.object({}),
    response: z.object({
      spotlight: z
        .object({ name: z.string(), hometown: z.string().nullable() })
        .nullable(),
    }),
    async handler(ctx) {
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select()
        .from(schema.memberSpotlight)
        .where(eq(schema.memberSpotlight.id, 1))
        .limit(1);
      const row = rows[0];
      return {
        spotlight: row
          ? { name: row.memberName, hometown: row.hometown ?? null }
          : null,
      };
    },
  }),

  setMemberSpotlight: defineAction({
    description:
      "Chooses the member of the week shown on Home — or clears it when member_email is null. Locked behind the owner's bound-owner check exactly like the member list: the caller presents the code's SHA-256 hash AND proves the account the code is bound to. The member's name and hometown are copied from their account at pick time.",
    request: z.object({
      codeHash: z.string().trim().max(128).default(""),
      ownerEmail: z.string().trim().toLowerCase().max(120).optional(),
      ownerPwHash: z.string().trim().max(128).optional(),
      memberEmail: z.string().trim().toLowerCase().max(120).nullable(),
    }),
    response: z.object({ ok: z.boolean(), locked: z.boolean() }),
    handler: async (
      ctx,
      args,
    ): Promise<{ ok: boolean; locked: boolean }> => {
      const isOwner = await verifiedOwner(ctx, {
        codeHash: args.codeHash,
        memberEmail: args.ownerEmail,
        memberPwHash: args.ownerPwHash,
      });
      if (!isOwner) {
        return { ok: false, locked: true };
      }
      const db = ctx.db<typeof schema>();
      if (!args.memberEmail) {
        await db
          .delete(schema.memberSpotlight)
          .where(eq(schema.memberSpotlight.id, 1));
        ctx.invalidateQueries();
        return { ok: true, locked: false };
      }
      const rows = await db
        .select()
        .from(schema.members)
        .where(eq(schema.members.email, args.memberEmail))
        .limit(1);
      const member = rows[0];
      if (!member) return { ok: false, locked: false };
      await db
        .insert(schema.memberSpotlight)
        .values({
          id: 1,
          memberName: member.name,
          memberEmail: member.email,
          hometown: member.hometown ?? null,
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: schema.memberSpotlight.id,
          set: {
            memberName: member.name,
            memberEmail: member.email,
            hometown: member.hometown ?? null,
            updatedAt: new Date(),
          },
        });
      ctx.invalidateQueries();
      return { ok: true, locked: false };
    },
  }),

  listPolls: defineAction({
    description:
      "Lists the Fun section's polls, newest first, each with all of its options and their vote counts.",
    request: z.object({ limit: z.number().int().positive().max(50).default(20) }),
    response: z.object({ polls: z.array(pollShape) }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select()
        .from(schema.polls)
        .orderBy(desc(schema.polls.id))
        .limit(args.limit);
      const ids = rows.map((r) => r.id);
      const optionRows =
        ids.length > 0
          ? await db
              .select()
              .from(schema.pollOptions)
              .where(inArray(schema.pollOptions.pollId, ids))
              .orderBy(asc(schema.pollOptions.position), asc(schema.pollOptions.id))
          : [];
      const byPoll = new Map<number, { id: number; label: string; votes: number }[]>();
      for (const o of optionRows) {
        const list = byPoll.get(o.pollId) ?? [];
        list.push({ id: o.id, label: o.label, votes: o.votes });
        byPoll.set(o.pollId, list);
      }
      return {
        polls: rows.map((r) => ({
          id: r.id,
          question: r.question,
          options: byPoll.get(r.id) ?? [],
          created_at: r.createdAt.toISOString(),
        })),
      };
    },
  }),

  createPoll: defineAction({
    description:
      "Creates a poll for the Fun section with two or more options (admin creates; everyone votes). Bad words are blurred before the poll is stored.",
    request: z.object({
      ...memberCredFields,
      question: z.string().trim().min(1).max(200),
      options: z.array(z.string().trim().min(1).max(80)).min(2).max(10),
    }),
    response: z.object({ id: z.number() }),
    async handler(ctx, args) {
      await requireAdmin(ctx, args);
      const db = ctx.db<typeof schema>();
      const result = await db
        .insert(schema.polls)
        .values({ question: censorText(args.question) })
        .returning({ id: schema.polls.id });
      const inserted = result[0];
      if (!inserted) throw new Error("createPoll: insert returned no rows");
      await db.insert(schema.pollOptions).values(
        args.options.map((label, i) => ({
          pollId: inserted.id,
          label: censorText(label),
          position: i,
        })),
      );
      ctx.invalidateQueries();
      return { id: inserted.id };
    },
  }),

  votePoll: defineAction({
    description: "Adds one vote to one option of a poll.",
    request: z.object({
      pollId: z.number().int().positive(),
      optionId: z.number().int().positive(),
    }),
    response: okResponse,
    handler: async (ctx, args): Promise<z.infer<typeof okResponse>> => {
      const db = ctx.db<typeof schema>();
      await db
        .update(schema.pollOptions)
        .set({ votes: sql`${schema.pollOptions.votes} + 1` })
        .where(
          and(
            eq(schema.pollOptions.id, args.optionId),
            eq(schema.pollOptions.pollId, args.pollId),
          ),
        );
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),

  deletePoll: defineAction({
    description: "Removes a poll and its options from the Fun section (host moderation).",
    request: z.object({
      ...memberCredFields, id: z.number().int().positive() }),
    response: okResponse,
    handler: async (ctx, args): Promise<z.infer<typeof okResponse>> => {
      await requireAdmin(ctx, args);
      const db = ctx.db<typeof schema>();
      await db
        .delete(schema.pollOptions)
        .where(eq(schema.pollOptions.pollId, args.id));
      await db.delete(schema.polls).where(eq(schema.polls.id, args.id));
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),

  // ---------------------------------------------------------------------
  // Kont — the Haitian riddles in Fun. One person poses a kont and
  // everybody else answers it underneath, like a comment thread. The
  // poster's real answer is stored with the kont but is never part
  // of the list payload: it comes back only through getRiddleAnswer,
  // when a reader taps to peek and check themselves.
  // ---------------------------------------------------------------------

  listRiddles: defineAction({
    description:
      "Lists the kont (Haitian riddles) on the Fun board, newest first, each with its count of answers. The riddles' own answers are not included — they are revealed one at a time through getRiddleAnswer.",
    request: z.object({ limit: z.number().int().positive().max(100).default(50) }),
    response: z.object({ riddles: z.array(riddleShape) }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select()
        .from(schema.riddles)
        .orderBy(desc(schema.riddles.id))
        .limit(args.limit);
      const ids = rows.map((r) => r.id);
      const countRows =
        ids.length > 0
          ? await db
              .select({
                riddleId: schema.riddleAnswers.riddleId,
                count: sql<number>`count(*)`,
              })
              .from(schema.riddleAnswers)
              .where(inArray(schema.riddleAnswers.riddleId, ids))
              .groupBy(schema.riddleAnswers.riddleId)
          : [];
      const counts = new Map(countRows.map((r) => [r.riddleId, r.count]));
      return {
        riddles: rows.map((r) => ({
          id: r.id,
          riddle: r.riddle,
          author_name: r.authorName,
          answer_count: counts.get(r.id) ?? 0,
          created_at: r.createdAt.toISOString(),
        })),
      };
    },
  }),

  addRiddle: defineAction({
    description:
      "Posts a kont (a Haitian riddle) to the Fun board, with the real answer stored hidden alongside it, under the poser's account name — posting takes a free account. Bad words are blurred before the kont is stored.",
    request: z.object({
      riddle: z.string().trim().min(1).max(500),
      answer: z.string().trim().min(1).max(200),
      ...memberCredFields,
    }),
    response: z.object({ id: z.number() }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const authorName = await authorNameForWrite(ctx, args);
      const result = await db
        .insert(schema.riddles)
        .values({
          riddle: censorText(args.riddle),
          answer: censorText(args.answer),
          authorName: censorText(authorName),
        })
        .returning({ id: schema.riddles.id });
      const inserted = result[0];
      if (!inserted) throw new Error("addRiddle: insert returned no rows");
      ctx.invalidateQueries();
      return { id: inserted.id };
    },
  }),

  getRiddleAnswer: defineAction({
    description:
      "Returns the stored answer of one kont — called only when a reader taps to peek at the answer and check their guess.",
    request: z.object({ id: z.number().int().positive() }),
    response: z.object({ answer: z.string() }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select({ answer: schema.riddles.answer })
        .from(schema.riddles)
        .where(eq(schema.riddles.id, args.id))
        .limit(1);
      const row = rows[0];
      if (!row) throw new Error("getRiddleAnswer: kont not found");
      return { answer: row.answer };
    },
  }),

  deleteRiddle: defineAction({
    description: "Removes a kont and all of its answers from the Fun board (host moderation).",
    request: z.object({
      ...memberCredFields, id: z.number().int().positive() }),
    response: okResponse,
    handler: async (ctx, args): Promise<z.infer<typeof okResponse>> => {
      await requireAdmin(ctx, args);
      const db = ctx.db<typeof schema>();
      await db
        .delete(schema.riddleAnswers)
        .where(eq(schema.riddleAnswers.riddleId, args.id));
      await db.delete(schema.riddles).where(eq(schema.riddles.id, args.id));
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),

  listRiddleAnswers: defineAction({
    description: "Lists the answers people posted under one kont, oldest first.",
    request: z.object({
      riddleId: z.number().int().positive(),
      limit: z.number().int().positive().max(200).default(100),
    }),
    response: z.object({ answers: z.array(riddleAnswerShape) }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select()
        .from(schema.riddleAnswers)
        .where(eq(schema.riddleAnswers.riddleId, args.riddleId))
        .orderBy(asc(schema.riddleAnswers.id))
        .limit(args.limit);
      return {
        answers: rows.map((r) => ({
          id: r.id,
          riddle_id: r.riddleId,
          body: r.body,
          author_name: r.authorName,
          created_at: r.createdAt.toISOString(),
        })),
      };
    },
  }),

  addRiddleAnswer: defineAction({
    description:
      "Adds someone's answer (their guess) under a kont, under their account name — answering takes a free account, like commenting. Bad words are blurred before the answer is stored.",
    request: z.object({
      riddleId: z.number().int().positive(),
      body: z.string().trim().min(1).max(1000),
      ...memberCredFields,
    }),
    response: z.object({ id: z.number() }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const authorName = await authorNameForWrite(ctx, args);
      const parent = await db
        .select({ id: schema.riddles.id })
        .from(schema.riddles)
        .where(eq(schema.riddles.id, args.riddleId))
        .limit(1);
      if (!parent[0]) throw new Error("addRiddleAnswer: kont not found");
      const result = await db
        .insert(schema.riddleAnswers)
        .values({
          riddleId: args.riddleId,
          body: censorText(args.body),
          authorName: censorText(authorName),
        })
        .returning({ id: schema.riddleAnswers.id });
      const inserted = result[0];
      if (!inserted) throw new Error("addRiddleAnswer: insert returned no rows");
      ctx.invalidateQueries();
      return { id: inserted.id };
    },
  }),

  deleteRiddleAnswer: defineAction({
    description: "Removes one answer under a kont (host moderation).",
    request: z.object({
      ...memberCredFields, id: z.number().int().positive() }),
    response: okResponse,
    handler: async (ctx, args): Promise<z.infer<typeof okResponse>> => {
      await requireAdmin(ctx, args);
      const db = ctx.db<typeof schema>();
      await db
        .delete(schema.riddleAnswers)
        .where(eq(schema.riddleAnswers.id, args.id));
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),

  getSupport: defineAction({
    description:
      "Returns the Support Lakay wall: recent donations and gifts, VIP member names, and totals.",
    request: z.object({}),
    response: z.object({
      wall: z.array(
        z.object({
          id: z.number(),
          kind: z.enum(["donation", "gift", "vip"]),
          name: z.string().nullable(),
          amount_cents: z.number().nullable(),
          tier: z.string().nullable(),
          recipient: z.string().nullable(),
          message: z.string().nullable(),
          created_at: z.string(),
        }),
      ),
      vip_members: z.array(z.string()),
      totals: z.object({
        donation_count: z.number(),
        gift_count: z.number(),
        vip_count: z.number(),
        pledged_cents: z.number(),
      }),
    }),
    async handler(ctx) {
      const db = ctx.db<typeof schema>();
      // The wall shows the newest 30 and the VIP list needs every
      // member, but the totals must cover the whole table — counting
      // only a fetched page of rows would silently freeze the counts
      // once the wall grows past it.
      const [wallRows, vipRows, totalsRows] = await Promise.all([
        db
          .select()
          .from(schema.supporters)
          .orderBy(desc(schema.supporters.id))
          .limit(30),
        db
          .select({ name: schema.supporters.name })
          .from(schema.supporters)
          .where(eq(schema.supporters.kind, "vip")),
        db
          .select({
            kind: schema.supporters.kind,
            count: sql<number>`count(*)`,
            pledged: sql<number>`coalesce(sum(${schema.supporters.amountCents}), 0)`,
          })
          .from(schema.supporters)
          .groupBy(schema.supporters.kind),
      ]);
      const totals = {
        donation_count: 0,
        gift_count: 0,
        vip_count: 0,
        pledged_cents: 0,
      };
      for (const r of totalsRows) {
        if (r.kind === "donation") totals.donation_count = r.count;
        else if (r.kind === "gift") totals.gift_count = r.count;
        else if (r.kind === "vip") totals.vip_count = r.count;
        totals.pledged_cents += r.pledged;
      }
      return {
        wall: wallRows.map((r) => ({
          id: r.id,
          kind: r.kind,
          name: r.name,
          amount_cents: r.amountCents,
          tier: r.tier,
          recipient: r.recipient,
          message: r.message,
          created_at: r.createdAt.toISOString(),
        })),
        vip_members: vipRows
          .map((r) => r.name)
          .filter((n): n is string => !!n),
        totals,
      };
    },
  }),

  giveSupport: defineAction({
    description:
      "Records a donation, a gift to a creator, or a VIP membership for Support Lakay.",
    request: z.object({
      kind: z.enum(["donation", "gift", "vip"]),
      name: z.string().trim().max(60).optional(),
      amountCents: z.number().int().min(100).max(100000).optional(),
      tier: z.string().trim().max(40).optional(),
      recipient: z.string().trim().max(80).optional(),
      message: z.string().trim().max(300).optional(),
    }),
    response: z.object({ id: z.number() }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const result = await db
        .insert(schema.supporters)
        .values({
          kind: args.kind,
          name: args.name ? censorText(args.name) : null,
          amountCents: args.amountCents ?? null,
          tier: args.kind === "vip" ? (args.tier ?? null) : null,
          recipient: args.kind === "gift" ? (args.recipient ?? null) : null,
          message: args.message ? censorText(args.message) : null,
        })
        .returning({ id: schema.supporters.id });
      const inserted = result[0];
      if (!inserted) throw new Error("giveSupport: insert returned no rows");
      ctx.invalidateQueries();
      return { id: inserted.id };
    },
  }),

  // ---------------------------------------------------------------------
  // News comments — discussion under each news story. News is live and
  // unstored, so comments hang on the article's link; the title and
  // source are saved with each comment so the thread still reads if
  // the story later ages out of the feeds.
  // ---------------------------------------------------------------------

  listNewsComments: defineAction({
    description: "Lists the comments under one news story (by its article link), oldest first.",
    request: z.object({
      link: z.string().min(1).max(2000),
      limit: z.number().int().positive().max(200).default(100),
    }),
    response: z.object({ comments: z.array(newsCommentShape) }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select()
        .from(schema.newsComments)
        .where(eq(schema.newsComments.link, args.link))
        .orderBy(asc(schema.newsComments.id))
        .limit(args.limit);
      return {
        comments: rows.map((r) => ({
          id: r.id,
          link: r.link,
          body: r.body,
          author_name: r.authorName,
          created_at: r.createdAt.toISOString(),
        })),
      };
    },
  }),

  addNewsComment: defineAction({
    description:
      "Adds a comment under a Lakay news post, under the commenter's account name — commenting takes a free account, so no comment is anonymous. Bad words are blurred before the comment is stored.",
    request: z.object({
      link: z.string().min(1).max(2000),
      title: z.string().trim().min(1).max(300),
      source: z.string().trim().min(1).max(120),
      body: z.string().trim().min(1).max(1000),
      ...memberCredFields,
    }),
    response: z.object({ id: z.number() }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const authorName = await authorNameForWrite(ctx, args);
      const result = await db
        .insert(schema.newsComments)
        .values({
          link: args.link,
          title: censorText(args.title),
          source: args.source,
          body: censorText(args.body),
          authorName: censorText(authorName),
        })
        .returning({ id: schema.newsComments.id });
      const inserted = result[0];
      if (!inserted) throw new Error("addNewsComment: insert returned no rows");
      ctx.invalidateQueries();
      return { id: inserted.id };
    },
  }),

  deleteNewsComment: defineAction({
    description: "Removes one comment under a news story (host moderation).",
    request: z.object({
      ...memberCredFields, id: z.number().int().positive() }),
    response: okResponse,
    handler: async (ctx, args): Promise<z.infer<typeof okResponse>> => {
      await requireAdmin(ctx, args);
      const db = ctx.db<typeof schema>();
      await db
        .delete(schema.newsComments)
        .where(eq(schema.newsComments.id, args.id));
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),

  // ---------------------------------------------------------------------
  // Owner-message comments — the discussion under the owner's message
  // on Home. The message is one rewritable row, so the comments belong
  // to the message spot itself.
  // ---------------------------------------------------------------------

  listMessageComments: defineAction({
    description: "Lists the comments under the owner's message on Home, oldest first.",
    request: z.object({
      limit: z.number().int().positive().max(200).default(100),
    }),
    response: z.object({ comments: z.array(messageCommentShape) }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select()
        .from(schema.messageComments)
        .orderBy(asc(schema.messageComments.id))
        .limit(args.limit);
      return {
        comments: rows.map((r) => ({
          id: r.id,
          body: r.body,
          author_name: r.authorName,
          created_at: r.createdAt.toISOString(),
        })),
      };
    },
  }),

  addMessageComment: defineAction({
    description:
      "Adds a comment under the owner's message on Home, under the commenter's account name — commenting takes a free account, so no comment is anonymous. Bad words are blurred before the comment is stored.",
    request: z.object({
      body: z.string().trim().min(1).max(1000),
      ...memberCredFields,
    }),
    response: z.object({ id: z.number() }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const authorName = await authorNameForWrite(ctx, args);
      const result = await db
        .insert(schema.messageComments)
        .values({
          body: censorText(args.body),
          authorName: censorText(authorName),
        })
        .returning({ id: schema.messageComments.id });
      const inserted = result[0];
      if (!inserted) throw new Error("addMessageComment: insert returned no rows");
      ctx.invalidateQueries();
      return { id: inserted.id };
    },
  }),

  deleteMessageComment: defineAction({
    description: "Removes one comment under the owner's message (host moderation).",
    request: z.object({
      ...memberCredFields, id: z.number().int().positive() }),
    response: okResponse,
    handler: async (ctx, args): Promise<z.infer<typeof okResponse>> => {
      await requireAdmin(ctx, args);
      const db = ctx.db<typeof schema>();
      await db
        .delete(schema.messageComments)
        .where(eq(schema.messageComments.id, args.id));
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),

  // ---------------------------------------------------------------------
  // Events — the community events board. Anyone can post a Haitian
  // event (party, concert, church or cultural gathering); readers
  // filter by city to find what's near them and add their name to
  // the "I'm going" list.
  // ---------------------------------------------------------------------

  listEvents: defineAction({
    description:
      "Lists upcoming community events (event_date on or after the given day), soonest first, optionally filtered to one city, each with its going count — plus the list of cities that have upcoming events.",
    request: z.object({
      from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      city: z.string().trim().max(80).optional(),
      limit: z.number().int().positive().max(100).default(60),
    }),
    response: z.object({
      events: z.array(eventShape),
      cities: z.array(z.string()),
    }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const conditions = [gte(schema.events.eventDate, args.from)];
      if (args.city) conditions.push(eq(schema.events.city, args.city));
      const rows = await db
        .select()
        .from(schema.events)
        .where(and(...conditions))
        .orderBy(asc(schema.events.eventDate), asc(schema.events.id))
        .limit(args.limit);
      const ids = rows.map((r) => r.id);
      const countRows =
        ids.length > 0
          ? await db
              .select({
                eventId: schema.eventRsvps.eventId,
                count: sql<number>`count(*)`,
              })
              .from(schema.eventRsvps)
              .where(inArray(schema.eventRsvps.eventId, ids))
              .groupBy(schema.eventRsvps.eventId)
          : [];
      const counts = new Map(countRows.map((r) => [r.eventId, r.count]));
      const cityRows = await db
        .select({ city: schema.events.city })
        .from(schema.events)
        .where(gte(schema.events.eventDate, args.from))
        .groupBy(schema.events.city)
        .orderBy(asc(schema.events.city));
      return {
        events: rows.map((r) => ({
          id: r.id,
          title: r.title,
          city: r.city,
          venue: r.venue,
          event_date: r.eventDate,
          time_label: r.timeLabel,
          details: r.details,
          link: r.link,
          added_by: r.addedBy,
          going_count: counts.get(r.id) ?? 0,
          created_at: r.createdAt.toISOString(),
        })),
        cities: cityRows.map((r) => r.city),
      };
    },
  }),

  addEvent: defineAction({
    description:
      "Posts a community event to the events board, under the poster's account name — posting takes a free account. Bad words are blurred before the event is stored.",
    request: z.object({
      title: z.string().trim().min(1).max(160),
      city: z.string().trim().min(1).max(80),
      venue: z.string().trim().max(160).optional(),
      eventDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      timeLabel: z.string().trim().max(60).optional(),
      details: z.string().trim().min(1).max(1000),
      link: z
        .string()
        .trim()
        .max(500)
        .optional()
        .refine((v) => !v || /^https?:\/\//i.test(v), {
          message: "Link must start with http:// or https://",
        }),
      ...memberCredFields,
    }),
    response: z.object({ id: z.number() }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const authorName = await authorNameForWrite(ctx, args);
      const result = await db
        .insert(schema.events)
        .values({
          title: censorText(args.title),
          city: censorText(args.city),
          venue: args.venue ? censorText(args.venue) : null,
          eventDate: args.eventDate,
          timeLabel: args.timeLabel ? censorText(args.timeLabel) : null,
          details: censorText(args.details),
          link: args.link ? args.link : null,
          addedBy: censorText(authorName),
        })
        .returning({ id: schema.events.id });
      const inserted = result[0];
      if (!inserted) throw new Error("addEvent: insert returned no rows");
      ctx.invalidateQueries();
      return { id: inserted.id };
    },
  }),

  deleteEvent: defineAction({
    description: "Removes an event and its going list from the board (host moderation).",
    request: z.object({
      ...memberCredFields, id: z.number().int().positive() }),
    response: okResponse,
    handler: async (ctx, args): Promise<z.infer<typeof okResponse>> => {
      await requireAdmin(ctx, args);
      const db = ctx.db<typeof schema>();
      await db
        .delete(schema.eventRsvps)
        .where(eq(schema.eventRsvps.eventId, args.id));
      await db.delete(schema.events).where(eq(schema.events.id, args.id));
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),

  listEventRsvps: defineAction({
    description: "Lists the names on one event's going list, in the order they joined.",
    request: z.object({ eventId: z.number().int().positive() }),
    response: z.object({ rsvps: z.array(rsvpShape) }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select()
        .from(schema.eventRsvps)
        .where(eq(schema.eventRsvps.eventId, args.eventId))
        .orderBy(asc(schema.eventRsvps.id));
      return {
        rsvps: rows.map((r) => ({
          id: r.id,
          event_id: r.eventId,
          name: r.name,
          created_at: r.createdAt.toISOString(),
        })),
      };
    },
  }),

  addEventRsvp: defineAction({
    description:
      "Adds the caller's own name to an event's going list — the name on the list is the member's account name, so joining takes a free account and nobody signs up under a made-up name.",
    request: z.object({
      eventId: z.number().int().positive(),
      ...memberCredFields,
    }),
    response: z.object({ id: z.number() }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const authorName = await authorNameForWrite(ctx, args);
      const parent = await db
        .select({ id: schema.events.id })
        .from(schema.events)
        .where(eq(schema.events.id, args.eventId))
        .limit(1);
      if (!parent[0]) throw new Error("addEventRsvp: event not found");
      const result = await db
        .insert(schema.eventRsvps)
        .values({ eventId: args.eventId, name: censorText(authorName) })
        .returning({ id: schema.eventRsvps.id });
      const inserted = result[0];
      if (!inserted) throw new Error("addEventRsvp: insert returned no rows");
      ctx.invalidateQueries();
      return { id: inserted.id };
    },
  }),

  deleteEventRsvp: defineAction({
    description: "Removes one name from an event's going list (host moderation).",
    request: z.object({
      ...memberCredFields, id: z.number().int().positive() }),
    response: okResponse,
    handler: async (ctx, args): Promise<z.infer<typeof okResponse>> => {
      await requireAdmin(ctx, args);
      const db = ctx.db<typeof schema>();
      await db
        .delete(schema.eventRsvps)
        .where(eq(schema.eventRsvps.id, args.id));
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),

  // ---------------------------------------------------------------------
  // Restaurant shout-outs — part of the Events board. Somebody in
  // the community visited a restaurant and liked it; they shout it
  // out with the name, the address, and what to try there, so other
  // people can find good food near them.
  // ---------------------------------------------------------------------

  listRestaurantShoutouts: defineAction({
    description:
      "Lists the community's restaurant shout-outs on the Events board, newest first — each with the restaurant's name, address, and what to try there.",
    request: z.object({ limit: z.number().int().positive().max(100).default(60) }),
    response: z.object({ shoutouts: z.array(shoutoutShape) }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select()
        .from(schema.restaurantShoutouts)
        .orderBy(desc(schema.restaurantShoutouts.id))
        .limit(args.limit);
      return {
        shoutouts: rows.map((r) => ({
          id: r.id,
          name: r.name,
          address: r.address,
          food: r.food,
          note: r.note,
          added_by: r.addedBy,
          created_at: r.createdAt.toISOString(),
        })),
      };
    },
  }),

  addRestaurantShoutout: defineAction({
    description:
      "Posts a restaurant shout-out to the Events board: the restaurant's name, its address, and what food to try there, under the poster's account name — posting takes a free account. Bad words are blurred before the shout-out is stored.",
    request: z.object({
      name: z.string().trim().min(1).max(120),
      address: z.string().trim().min(1).max(200),
      food: z.string().trim().min(1).max(300),
      note: z.string().trim().max(500).optional(),
      ...memberCredFields,
    }),
    response: z.object({ id: z.number() }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const authorName = await authorNameForWrite(ctx, args);
      const result = await db
        .insert(schema.restaurantShoutouts)
        .values({
          name: censorText(args.name),
          address: censorText(args.address),
          food: censorText(args.food),
          note: args.note ? censorText(args.note) : null,
          addedBy: censorText(authorName),
        })
        .returning({ id: schema.restaurantShoutouts.id });
      const inserted = result[0];
      if (!inserted) throw new Error("addRestaurantShoutout: insert returned no rows");
      ctx.invalidateQueries();
      return { id: inserted.id };
    },
  }),

  deleteRestaurantShoutout: defineAction({
    description: "Removes a restaurant shout-out from the Events board (host moderation).",
    request: z.object({
      ...memberCredFields, id: z.number().int().positive() }),
    response: okResponse,
    handler: async (ctx, args): Promise<z.infer<typeof okResponse>> => {
      await requireAdmin(ctx, args);
      const db = ctx.db<typeof schema>();
      await db
        .delete(schema.restaurantShoutouts)
        .where(eq(schema.restaurantShoutouts.id, args.id));
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),

  // ---------------------------------------------------------------------
  // Trivia leaderboard — this week and all time. Players submit their
  // best total under a name they pick; one row per name per week keeps
  // the highest score, and the all-time board sums across weeks.
  // ---------------------------------------------------------------------

  getTriviaLeaderboard: defineAction({
    description:
      "Returns the trivia leaderboard: the top 10 players this week and the top 10 of all time, by total points.",
    request: z.object({}),
    response: z.object({
      week: z.array(leaderboardEntryShape),
      all_time: z.array(leaderboardEntryShape),
      week_key: z.string(),
    }),
    async handler(ctx) {
      const db = ctx.db<typeof schema>();
      const weekKey = currentWeekKey();
      const weekRows = await db
        .select()
        .from(schema.triviaScores)
        .where(eq(schema.triviaScores.weekKey, weekKey))
        .orderBy(desc(schema.triviaScores.points), asc(schema.triviaScores.id))
        .limit(10);
      const totalExpr = sql<number>`sum(${schema.triviaScores.points})`;
      const allRows = await db
        .select({
          name: schema.triviaScores.name,
          points: totalExpr,
          chapters_done: sql<number>`max(${schema.triviaScores.chaptersDone})`,
        })
        .from(schema.triviaScores)
        .groupBy(sql`lower(${schema.triviaScores.name})`)
        .orderBy(desc(totalExpr))
        .limit(10);
      return {
        week: weekRows.map((r) => ({
          name: r.name,
          points: r.points,
          chapters_done: r.chaptersDone,
        })),
        all_time: allRows.map((r) => ({
          name: r.name,
          points: r.points,
          chapters_done: r.chapters_done,
        })),
        week_key: weekKey,
      };
    },
  }),

  submitTriviaScore: defineAction({
    description:
      "Submits a player's best trivia total under their chosen name for this week. A re-submit only ever raises that name's score for the week, never lowers it.",
    request: z.object({
      name: z.string().trim().min(1).max(40),
      points: z.number().int().min(0).max(10000),
      chaptersDone: z.number().int().min(0).max(500),
    }),
    response: okResponse,
    handler: async (ctx, args): Promise<z.infer<typeof okResponse>> => {
      const db = ctx.db<typeof schema>();
      const name = censorText(args.name);
      const weekKey = currentWeekKey();
      const existing = await db
        .select()
        .from(schema.triviaScores)
        .where(
          and(
            eq(schema.triviaScores.weekKey, weekKey),
            sql`lower(${schema.triviaScores.name}) = ${name.toLowerCase()}`,
          ),
        )
        .limit(1);
      const row = existing[0];
      const now = new Date();
      if (row) {
        await db
          .update(schema.triviaScores)
          .set({
            points: Math.max(row.points, args.points),
            chaptersDone: Math.max(row.chaptersDone, args.chaptersDone),
            updatedAt: now,
          })
          .where(eq(schema.triviaScores.id, row.id));
      } else {
        await db.insert(schema.triviaScores).values({
          name,
          points: args.points,
          chaptersDone: args.chaptersDone,
          weekKey,
          createdAt: now,
          updatedAt: now,
        });
      }
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),

  // ---------------------------------------------------------------------
  // Trivia in French, Spanish, Portuguese — and the Kreyòl answer
  // choices. The bundled bank carries each question and fact in
  // English + Kreyòl, but the answer CHOICES were only ever written
  // in English, so Kreyòl players saw English choices under a
  // Kreyòl question. For all four languages each question is now
  // translated once by the model and stored in trivia_translations
  // forever, so the first player in a language waits a few seconds
  // for a chapter and every player after that gets it instantly.
  // (Kreyòl readers keep the bundled hand-written question and fact;
  // only their choices come from here.) Choices keep their exact
  // order (the answer rides on it) and a translation whose choice
  // count differs from the original is never stored or served. On
  // any failure the client keeps showing the English question — a
  // real question untranslated beats a missing one.
  // ---------------------------------------------------------------------

  getTriviaTranslations: defineAction({
    description:
      "Returns Haitian Creole, French, Spanish, or Portuguese translations of trivia questions (question, choices in the same order, and the after-answer fact), translating and permanently storing any that are missing. Items are keyed by the question's index in the bundled bank.",
    request: z.object({
      lang: z.enum(["ht", "fr", "es", "pt"]),
      items: z
        .array(
          z.object({
            i: z.number().int().min(0).max(100000),
            q: z.string().trim().min(1).max(600),
            ch: z.array(z.string().trim().min(1).max(300)).min(2).max(8),
            f: z.string().trim().min(1).max(1000),
          }),
        )
        .min(1)
        .max(12),
    }),
    response: z.object({
      translations: z.array(
        z.object({
          i: z.number(),
          q: z.string(),
          ch: z.array(z.string()),
          f: z.string(),
        }),
      ),
    }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const target = LANG_NAMES_FOR_TRANSLATION[args.lang];
      const out: { i: number; q: string; ch: string[]; f: string }[] = [];
      if (!target) return { translations: out };
      const stored = await db
        .select()
        .from(schema.triviaTranslations)
        .where(
          and(
            eq(schema.triviaTranslations.lang, args.lang),
            inArray(
              schema.triviaTranslations.qIndex,
              args.items.map((it) => it.i),
            ),
          ),
        );
      const byIndex = new Map(stored.map((r) => [r.qIndex, r]));
      const missing: typeof args.items = [];
      for (const item of args.items) {
        const row = byIndex.get(item.i);
        // The stored row only counts if it translates the question
        // the client actually sent — an edited bank retranslates.
        if (row && row.sourceQ === item.q) {
          try {
            const ch = JSON.parse(row.choices) as unknown;
            if (
              Array.isArray(ch) &&
              ch.length === item.ch.length &&
              ch.every((c) => typeof c === "string")
            ) {
              out.push({ i: item.i, q: row.q, ch: ch as string[], f: row.fact });
              continue;
            }
          } catch {
            // fall through and retranslate
          }
        }
        missing.push(item);
      }
      if (missing.length > 0) {
        // Translate in small parallel groups, not one call for the
        // whole chapter: a single call carrying ten questions, forty
        // choices, and ten facts was the slowest, most failure-prone
        // call in the app — when it stumbled, the whole chapter
        // stayed English. Groups of five finish faster, run side by
        // side, and each group stores its own items, so one bad
        // group can no longer hold the rest of the chapter hostage.
        const groups: (typeof missing)[] = [];
        for (let g = 0; g < missing.length; g += 5) {
          groups.push(missing.slice(g, g + 5));
        }
        await Promise.all(
          groups.map(async (group) => {
            try {
              const result = await ctx.inference.complete(
                `Translate each trivia item below into ${target}. Rules: keep the ` +
                  `choices in the EXACT same order and count — the correct answer is ` +
                  `identified by position, so never reorder, merge, or drop a choice. ` +
                  `Keep names of people, places, and organizations unchanged. Translate ` +
                  `the question and the fact fully and naturally. Return every item ` +
                  `with its number in the n field.\n\n` +
                  group
                    .map(
                      (it, n) =>
                        `${n + 1}. QUESTION: ${it.q}\n   CHOICES: ${it.ch.join(" | ")}\n   FACT: ${it.f}`,
                    )
                    .join("\n"),
                {
                  schema: z.object({
                    items: z.array(
                      z.object({
                        n: z.number(),
                        q: z.string(),
                        ch: z.array(z.string()),
                        f: z.string(),
                      }),
                    ),
                  }),
                  timeout_secs: 60,
                },
              );
              for (const t of result.items) {
                const src = group[t.n - 1];
                if (!src || !t.q.trim() || !t.f.trim()) continue;
                if (t.ch.length !== src.ch.length) continue;
                const ch = t.ch.map((c) => c.trim());
                if (ch.some((c) => !c)) continue;
                await db
                  .insert(schema.triviaTranslations)
                  .values({
                    lang: args.lang,
                    qIndex: src.i,
                    sourceQ: src.q,
                    q: t.q.trim(),
                    choices: JSON.stringify(ch),
                    fact: t.f.trim(),
                  })
                  .onConflictDoUpdate({
                    target: [
                      schema.triviaTranslations.lang,
                      schema.triviaTranslations.qIndex,
                    ],
                    set: {
                      sourceQ: src.q,
                      q: t.q.trim(),
                      choices: JSON.stringify(ch),
                      fact: t.f.trim(),
                    },
                  });
                out.push({ i: src.i, q: t.q.trim(), ch, f: t.f.trim() });
              }
            } catch {
              // Whatever is already stored still returns; this
              // group's items stay in English on the client for this
              // attempt, and the client's next round re-asks for
              // exactly these.
            }
          }),
        );
      }
      return { translations: out };
    },
  }),
} satisfies ActionsModule;
