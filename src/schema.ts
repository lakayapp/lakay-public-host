// Drizzle schema for Lakay — the community's own rows.
//
// stories:     Stories & Confessions posted by readers (name optional —
//              blank means anonymous).
// questions:   Questions and advice requests sent to Lakay, with his
//              answer once he replies (answer/answered_at stay null until
//              then).
// spotlights:  Music artist spotlights added through the in-page form.
// news_comments / message_comments: reader comments under news stories
//              (keyed by article link) and under the owner's message.
// events / event_rsvps: the community events board and who's coming.
// trivia_scores: the trivia leaderboard, one row per player per week.
//
// News is never stored here: it is fetched live from RSS feeds at page
// open. History, proverbs, jokes, and trivia are fixed editorial content
// bundled with the client.

import {
integer,
sqliteTable,
text,
uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const stories = sqliteTable("stories", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  kind: text("kind", { enum: ["story", "confession"] }).notNull(),
  title: text("title").notNull(),
  body: text("body").notNull(),
  authorName: text("author_name"),
  imageBlobKey: text("image_blob_key"),
  hearts: integer("hearts").notNull().default(0),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const questions = sqliteTable("questions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name"),
  topic: text("topic").notNull(),
  question: text("question").notNull(),
  answer: text("answer"),
  answeredAt: integer("answered_at", { mode: "timestamp_ms" }),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const spotlights = sqliteTable("spotlights", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  artist: text("artist").notNull(),
  song: text("song"),
  genre: text("genre").notNull(),
  note: text("note").notNull(),
  link: text("link"),
  addedBy: text("added_by"),
  likes: integer("likes").notNull().default(0),
  // The sharer's own media on a music post: up to four photos
  // (imageKeys is a JSON array of ctx.blobs keys, the owner-posts
  // pattern) and one short video clip of their own (a blob key;
  // the clip's bytes live in ctx.blobs, never in this row). Both
  // are the sharer's own uploads — nothing is pulled from another
  // site. Null on every post shared before media existed.
  imageKeys: text("image_keys"),
  videoBlobKey: text("video_blob_key"),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

// On-demand translations of the community's own words — a wall
// post, a story, a comment, a question — made when a reader taps
// the small Translate button on that post and picks a language.
// The original text is never changed or replaced; this table only
// remembers a translation once it has been made (keyed by the
// exact source text plus the target language) so the same post
// never has to be translated twice, for anyone. Lakay's own
// content (news, trivia) has its own tables; this one is only for
// what people write themselves.
export const textTranslations = sqliteTable(
  "text_translations",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    sourceText: text("source_text").notNull(),
    lang: text("lang").notNull(),
    translated: text("translated").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [
    uniqueIndex("text_translations_source_lang_unique").on(t.sourceText, t.lang),
  ],
);

// News-post translations into Haitian Creole, French, Spanish,
// and Portuguese. Lakay's news posts are written in English by the
// journalist task; for readers in another language the headline
// and body are translated once by the model and stored here
// forever (keyed by the post's source link plus the English source
// text, so a rewritten post retranslates instead of serving a
// stale translation). Before this table existed the translations
// lived only in the server process's memory, so every restart
// threw them away and the next language switch paid the full
// translation wait again — and a switch that timed out mid-way
// left posts showing in English. Stored rows make a finished
// translation permanent and shared by every reader.
export const newsTranslations = sqliteTable(
  "news_translations",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    link: text("link").notNull(),
    lang: text("lang").notNull(),
    sourceTitle: text("source_title").notNull(),
    sourceBody: text("source_body").notNull(),
    title: text("title").notNull(),
    body: text("body").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [uniqueIndex("news_translations_link_lang_unique").on(t.link, t.lang)],
);

// Comments under a shared song on the music wall. Deleting a song
// deletes its comments (handled in the delete action).
export const spotlightComments = sqliteTable("spotlight_comments", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  spotlightId: integer("spotlight_id")
    .notNull()
    .references(() => spotlights.id),
  body: text("body").notNull(),
  authorName: text("author_name"),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

// Trivia translations into Haitian Creole, French, Spanish, and
// Portuguese. The bundled bank in the client carries the question
// and fact in English + Kreyòl but the answer choices in English
// only; the choices (and, for French/Spanish/Portuguese, the whole
// question) are translated once per question by the model and
// stored here forever (keyed by the question's global index plus the
// English source text, so an edited question retranslates instead of
// serving a stale translation). choices is a JSON array in the same
// order as the bundled choices — order carries the answer.
export const triviaTranslations = sqliteTable("trivia_translations", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  lang: text("lang").notNull(),
  qIndex: integer("q_index").notNull(),
  sourceQ: text("source_q").notNull(),
  q: text("q").notNull(),
  choices: text("choices").notNull(),
  fact: text("fact").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const storyComments = sqliteTable("story_comments", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  storyId: integer("story_id")
    .notNull()
    .references(() => stories.id),
  body: text("body").notNull(),
  authorName: text("author_name"),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

// The owner's message on Home: a single row (id = 1) the admin writes
// and rewrites whenever he wants — a short note to everybody, shown
// at the top of the home feed. No row means no message is posted.
export const ownerMessage = sqliteTable("owner_message", {
  id: integer("id").primaryKey(),
  body: text("body").notNull(),
  videoLink: text("video_link"),
  linkUrl: text("link_url"),
  imageBlobKey: text("image_blob_key"),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

// The Home wall — a Facebook-style feed. It started as the owner's
// own posts; the owner has since opened it to every member: anyone
// with a free account can post (a note, a longer article, photos, a
// video link, a link), posts pile up newest first, and every post
// carries its author's account name — there is no anonymous posting.
// Rows with author_name/author_email null are the owner's own posts
// (published from admin mode, shown under the Lakay name); member
// posts store the verified member's name + email. imageKeys is a
// JSON array of ctx.blobs keys (the post's photos, in order); likes
// counts the taps, with the who in content_likes (kind "post"),
// same as stories and songs — visible to the owner only.
export const ownerPosts = sqliteTable("owner_posts", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  title: text("title"),
  body: text("body").notNull(),
  imageKeys: text("image_keys"),
  videoLink: text("video_link"),
  linkUrl: text("link_url"),
  authorName: text("author_name"),
  authorEmail: text("author_email"),
  likes: integer("likes").notNull().default(0),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

// Comments under one of the owner's posts. Deleting a post deletes
// its comments (handled in the delete action).
export const ownerPostComments = sqliteTable("owner_post_comments", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  postId: integer("post_id")
    .notNull()
    .references(() => ownerPosts.id),
  body: text("body").notNull(),
  authorName: text("author_name"),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

// Kont — the Haitian riddles in the Fun section. In Kreyòl a riddle
// is not a "devinèt", it is a kont: one person poses it, everybody
// else tries to answer it. The poster stores the real answer with
// the kont, but listRiddles never sends it — the answer comes back
// only through getRiddleAnswer when a reader taps to peek, so the
// game stays honest. riddle_answers are the community's attempts
// under a kont, written like comments: a signed-in member answers
// under their account name; a guest writes a name or stays
// anonymous. Deleting a kont deletes its answers (handled in the
// delete action).
export const riddles = sqliteTable("riddles", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  riddle: text("riddle").notNull(),
  answer: text("answer").notNull(),
  authorName: text("author_name"),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const riddleAnswers = sqliteTable("riddle_answers", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  riddleId: integer("riddle_id")
    .notNull()
    .references(() => riddles.id),
  body: text("body").notNull(),
  authorName: text("author_name"),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

// Polls for the Fun section: the admin writes a question and as many
// options as he wants (two minimum); each option is its own row in
// poll_options with its vote count. Who voted is not tracked
// server-side (no accounts) — each device remembers its own picks
// in localStorage.
export const polls = sqliteTable("polls", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  question: text("question").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const pollOptions = sqliteTable("poll_options", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  pollId: integer("poll_id")
    .notNull()
    .references(() => polls.id),
  label: text("label").notNull(),
  votes: integer("votes").notNull().default(0),
  position: integer("position").notNull().default(0),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

// Lakay's own news posts: seven times a day the Lakay journalist
// (a research task) searches the web for what is new about Haiti and
// the diaspora — the gangs, the Jovenel Moïse case and its arrests,
// Les Grenadiers, President Bukele of El Salvador, ICE/immigration,
// and anything else major — verifies each item against its source
// page, writes it as a SHORT post in Lakay's own words (the whole
// news, nothing padded; unconfirmed facts hedged and the source
// credited), and saves it here through saveDailyArticle. title +
// body are the post itself, shown exactly as written (translated
// for the reader's language on the way out). source_url is the
// story's primary source page: it is the dedupe key (the same story
// is never saved twice) and the key news comments hang on — it is
// kept for the record only and is NEVER shown as a tappable link:
// per the owner's ruling, news posts carry no outbound links at
// all and the source is credited as plain text, so readers stay
// inside Lakay. image_url, when present, must be a picture from a
// safe source (public-domain, free-to-reuse, or Lakay's own) —
// never a photo taken from another site. source_text is the facts-only brief
// the post was written from — kept for the record, never sent to
// the client. Rows saved before the post format existed have no
// title/body and are not shown.
export const dailyArticles = sqliteTable("daily_articles", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  sourceUrl: text("source_url").notNull().unique(),
  sourceName: text("source_name").notNull(),
  sourceTitle: text("source_title").notNull(),
  teaser: text("teaser").notNull(),
  sourceText: text("source_text").notNull(),
  title: text("title"),
  body: text("body"),
  imageUrl: text("image_url"),
  sourcePublishedAt: integer("source_published_at", {
    mode: "timestamp_ms",
  }),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

// News items the admin has hidden: news itself is fetched live and
// never stored, so a hide is recorded by the article's link and
// getNews filters those links out for everyone.
export const hiddenNews = sqliteTable("hidden_news", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  link: text("link").notNull().unique(),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

// Comments under news stories. News itself is fetched live and never
// stored, so a comment hangs on the article's link; the story's title
// and source are kept with the comment so the thread stays readable
// even after a story ages out of the live feeds. Deleting is by id
// (host moderation), same pattern as story comments.
export const newsComments = sqliteTable("news_comments", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  link: text("link").notNull(),
  title: text("title").notNull(),
  source: text("source").notNull(),
  body: text("body").notNull(),
  authorName: text("author_name"),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

// Comments under the owner's message on Home. The message is a single
// row (id = 1) that the admin rewrites, so its comments belong to the
// message spot itself rather than to one version of the text.
export const messageComments = sqliteTable("message_comments", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  body: text("body").notNull(),
  authorName: text("author_name"),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

// Community events board ("Haitian events near me"): gatherings the
// community itself posts — parties, concerts, church and cultural
// events — each with a city so readers can filter to where they live.
// event_date is a plain YYYY-MM-DD day picked by the poster; the
// app filters/sorts on it as a calendar day, not an instant.
export const events = sqliteTable("events", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  title: text("title").notNull(),
  city: text("city").notNull(),
  venue: text("venue"),
  eventDate: text("event_date").notNull(),
  timeLabel: text("time_label"),
  details: text("details").notNull(),
  link: text("link"),
  addedBy: text("added_by"),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

// Restaurant shout-outs on the Events board: a place somebody in
// the community visited and liked — the restaurant's name, its
// address (street + city, so people can actually find it), the food
// to try there, and an optional note. Like events, these are the
// community's own posts, shown exactly as written; nothing is
// pulled from a listings service.
export const restaurantShoutouts = sqliteTable("restaurant_shoutouts", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  address: text("address").notNull(),
  food: text("food").notNull(),
  note: text("note"),
  addedBy: text("added_by"),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

// Who's coming to an event: a name per row, so the count and the
// name list both come straight from the rows.
export const eventRsvps = sqliteTable("event_rsvps", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  eventId: integer("event_id")
    .notNull()
    .references(() => events.id),
  name: text("name").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

// Trivia leaderboard: one row per player name per week (week_key is
// the Monday of that week, YYYY-MM-DD). A player re-submits their
// best total as they play; the row keeps the highest points seen for
// that name that week. The all-time board groups every week's rows
// by name. No accounts — the name is typed in by the player.
export const triviaScores = sqliteTable("trivia_scores", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  points: integer("points").notNull(),
  chaptersDone: integer("chapters_done").notNull(),
  weekKey: text("week_key").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const supporters = sqliteTable("supporters", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  kind: text("kind", { enum: ["donation", "gift", "vip"] }).notNull(),
  name: text("name"),
  amountCents: integer("amount_cents"),
  tier: text("tier"),
  recipient: text("recipient"),
  message: text("message"),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

// Finished Lakay-written articles, saved for good: one row per story
// (article link) per language, holding the write + fact-check result.
// Once a story exists here in a language, opening it — or switching
// to that language and opening it — is a plain database read instead
// of a fresh wait while Lakay writes. paragraphs is a JSON array of
// the article's paragraph strings, in order.
export const lakayArticles = sqliteTable(
  "lakay_articles",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    link: text("link").notNull(),
    lang: text("lang").notNull(),
    title: text("title").notNull(),
    dek: text("dek").notNull(),
    paragraphs: text("paragraphs").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [uniqueIndex("lakay_articles_link_lang").on(t.link, t.lang)],
);

// Lakay's member list: everyone who created a free account, saved on
// the server so the list survives across devices and the owner can
// see who joined (name + email) in admin mode. The password is never
// stored in plain text — pw_hash is the SHA-256 hash the client
// computes before sending, the same hash the device-local account
// used before accounts moved server-side.
export const members = sqliteTable("members", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  pwHash: text("pw_hash").notNull(),
  // Where the member calls home: their hometown in Haiti or the
  // city abroad they live in now (Miami, New York, Montréal…).
  // Picked by the member in their account panel; shown on their
  // wall posts so people can find their own people, and what the
  // wall's "My people" filter matches on. Null until they pick one.
  hometown: text("hometown"),
  // A pending one-time password-reset code, issued by the owner
  // from the member list and handed to the member out-of-band (in
  // person, by message — Lakay has no email channel). Only the
  // code's SHA-256 hash is stored (the same `lakay:`-prefixed hash
  // the client computes for passwords), plus its expiry as epoch
  // milliseconds; a successful reset — or a new code — replaces
  // both, and the reset clears them. Null when no reset is pending.
  resetHash: text("reset_hash"),
  resetExpires: integer("reset_expires"),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

// Answers to the Question of the Day on Home. The question itself
// is bundled editorial content (one per day, rotating, in all five
// languages); the answers are the community's own words, stored by
// calendar day (day_key is the reader-local YYYY-MM-DD the client
// sends, the same day the question was picked for). Answering takes
// a free account, like every other post in Lakay.
export const dailyAnswers = sqliteTable("daily_answers", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  dayKey: text("day_key").notNull(),
  body: text("body").notNull(),
  authorName: text("author_name"),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

// Trivia challenges: a member picks a chapter and gets a short
// code to send a friend (however they like — the app shows the
// code and a WhatsApp share). Both play the chapter; each side's
// score lands here when they finish, and the challenge view shows
// who scored higher. The friend slot is claimed by the first
// other member who submits a score with the code. Emails identify
// the two players server-side and are never sent to the client —
// only names and scores are.
export const triviaChallenges = sqliteTable(
  "trivia_challenges",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    code: text("code").notNull(),
    chapterN: integer("chapter_n").notNull(),
    challengerName: text("challenger_name").notNull(),
    challengerEmail: text("challenger_email").notNull(),
    challengerScore: integer("challenger_score"),
    friendName: text("friend_name"),
    friendEmail: text("friend_email"),
    friendScore: integer("friend_score"),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [uniqueIndex("trivia_challenges_code_unique").on(t.code)],
);

// Who is home right now: one row per open app session, kept fresh
// by a quiet heartbeat from the client while the app is open.
// last_seen is a plain epoch-milliseconds number (not a timestamp
// column) because presence is arithmetic, not history: the count
// is rows seen inside the last few minutes, and stale rows are
// deleted on sight. A row never identifies a person publicly —
// only the count is ever shown.
export const presence = sqliteTable("presence", {
  sessionId: text("session_id").primaryKey(),
  memberEmail: text("member_email"),
  lastSeen: integer("last_seen").notNull(),
});

// The member spotlight on Home: a single row (id = 1) naming the
// member of the week, chosen by the owner from the member list in
// admin mode (behind his admin code, like the list itself). The
// member's hometown is copied in when chosen, so the card can say
// where they're from without another lookup. No row = no spotlight.
export const memberSpotlight = sqliteTable("member_spotlight", {
  id: integer("id").primaryKey(),
  memberName: text("member_name").notNull(),
  memberEmail: text("member_email").notNull(),
  hometown: text("hometown"),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

// Who liked what: one row per heart on a story and per like on a
// song. The counts everyone sees still live on the stories /
// spotlights rows; these rows exist so the owner — and only the
// owner, through the admin-code-locked listLikers action — can see
// WHO liked something. A signed-in liker is recorded by member name
// + email; a guest's row leaves both null (shown to the owner simply
// as "Guest"). The unique index on (kind, target, email) stops one
// account liking the same thing twice at the server, not just on
// one device; guest rows carry a null email, which SQLite treats as
// distinct, so guests stay governed by their device's memory.
export const contentLikes = sqliteTable(
  "content_likes",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    kind: text("kind", { enum: ["story", "spotlight", "post"] }).notNull(),
    targetId: integer("target_id").notNull(),
    memberName: text("member_name"),
    memberEmail: text("member_email"),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [
    uniqueIndex("content_likes_member_unique").on(
      t.kind,
      t.targetId,
      t.memberEmail,
    ),
  ],
);

// The owner's admin code, a single row (id = 1). The member list
// holds everyone's email, so it is not enough to hide it behind the
// client-side admin toggle: the admin actions check this code on
// the server before returning any rows — and the code is bound to
// the owner's own member account (owner_email), so every admin call
// must ALSO prove that account with its email + password hash. The
// code alone, claimed or leaked, opens nothing. Only the SHA-256
// hash of the code is stored — the same treatment as member
// passwords. The owner creates the code once, from the member list
// itself, while signed in to the account it binds to; until then
// the list stays locked for everyone.
export const adminAccess = sqliteTable("admin_access", {
  id: integer("id").primaryKey(),
  codeHash: text("code_hash").notNull(),
  // The member account the admin code is bound to — the owner's own
  // Lakay account (email). Every admin surface (member list, likers,
  // member removal, spotlight pick, recovery key, password-reset
  // codes) requires BOTH the code and proof of this account (its
  // email + password hash, verified like sign-in), so the code alone
  // is never enough and an unclaimed code can never be seized by a
  // stranger: creating the code requires a verified member login and
  // binds that account. Null only on the row created before binding
  // existed; the first caller who presents the valid code AND a real
  // account's correct password binds that account (in practice the
  // owner — the only person who knows the code he created), and
  // from then on the binding is required.
  ownerEmail: text("owner_email"),
  // Hash of the owner's recovery key — the one secret that can
  // reset a forgotten admin code. The key itself is shown to the
  // owner exactly once, when he creates it (after proving the
  // current code); only its SHA-256 hash is stored. Null until the
  // owner creates one. A successful reset clears it (one-time use),
  // so a fresh key must be created after each reset.
  recoveryHash: text("recovery_hash"),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});
