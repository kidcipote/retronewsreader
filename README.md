# retronewsreader, do it yourself

A news reader with the look of an old desktop: your feeds in one list, filters by date, source, topic and place, saved and read stories, and (on a server) friends you can send stories to. Plain HTML and JavaScript on the front, Python on your own computer, or one Cloudflare Worker on the web. No framework; the only build step copies the page into one folder.

This is a concept project, shared as it is. Read the code before you run it, and read the notes at the end before you put it in front of other people.

## Two ways to run it

| | On your own computer | On Cloudflare |
|---|---|---|
| What you get | The reader: your feeds, filters, topics and places, saved and read | The same, plus accounts, friends, messages and a feed list for each person |
| What you need | Python 3 | A Cloudflare account and a GitHub account (free plans are enough for a few feeds; see below). A phone is enough: nothing to install. An email service is optional |
| Friends | No. There are no accounts on your computer | Yes, on your own server. A server cannot see another server's users |
| Where it is reachable | `http://localhost:8787`, on that computer only | Anywhere, at the address Cloudflare gives it or your own domain |
| Saved and read lists | Kept in that browser | Kept in the browser, and on the account when signed on |

Start with your own computer. It is five minutes and you can move to Cloudflare later.

### On your own computer

```
python3 fetch.py      # fetch the feeds in feeds.json into data.json and tag new stories
python3 server.py     # then open http://localhost:8787
```

Change what you follow by editing `feeds.json` (id, name, colors, feed address), or from the page: Edit, then Add to feed. Run `fetch.py` on a schedule (cron or launchd) to keep it current; `server.py` also fetches when you press Refresh. Python 3.11 is what it was written on; if a newer Python complains about `pyexpat`, use 3.11.

### On Cloudflare, with friends

#### From a phone or any browser (nothing to install)

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/kidcipote/retronewsreader)

1. Tap the button. Sign in to GitHub and to Cloudflare (free accounts are fine). Cloudflare puts a copy of this repository in your GitHub account and builds it.
2. When it asks for secrets, you can leave all three empty. `TYPESAFE_API_KEY` is for Jev; without it the keyword tagger is used. `RESEND_API_KEY` is for sign-up and password email; without it no mail is sent. `ADMIN_TOKEN` is only for maintenance scripts you will not need.
3. Deploy. Cloudflare creates the storage and the database for you and gives your copy an address ending in `.workers.dev`. Open it.
4. **Make an account first.** The first account made on a new copy becomes the operator (it can fetch feeds, add feeds for others and open sign-ups). After that, sign-ups need an invitation, so do this before you share the address.
5. In the reader: File, then Fetch feeds now. Without that the first stories arrive within half an hour on their own.
6. To change anything later (the categories in `taxonomy.json`, the starting feeds in `feeds.json`), edit the file in your GitHub copy and commit it: Cloudflare rebuilds and publishes the Worker. Secrets and the account address are in the Cloudflare dashboard, under the Worker's Settings.

*This route was built to Cloudflare's documentation and tested from an empty database here, but the button itself has not yet been tried from a phone. If a step does not match what you see, the terminal route below is the one that has been run end to end.*

#### From a terminal

```
npm install
npx wrangler login
npm run deploy      # builds the page into public/, publishes the Worker (creating the storage and database the first time), applies the migrations
```

Run the same command again after any change. To pin your Cloudflare account, or to use your own domain, edit `wrangler.jsonc` first (the comments show how). Secrets: `npx wrangler secret put TYPESAFE_API_KEY` (and `RESEND_API_KEY`, `ADMIN_TOKEN`). `npm run dev` runs it on your computer with a local database.

What it costs: nothing, for a few feeds. The copy is set to Cloudflare's free plan (`"PLAN": "free"` in `wrangler.jsonc`), and the free plan's limits are what that setting works within:

- A run may make 50 requests, counting every call to storage and the database as well as to a feed. With the free setting a run fetches up to 15 feeds each half hour and merges what it has room for; whatever does not fit takes its turn in the next runs. (Tested here with 16 followed feeds: the first run stayed under 45 requests and everything had caught up within three runs.)
- 1,000 storage writes a day. About 15 feeds use under 400.
- 1 GB of storage in all. A year of 15 feeds is a few hundred megabytes; if you near it, lower `keep_days` in `feeds.json`.
- 10 milliseconds of processor time per run or request. I could not test this on a real free account. If Cloudflare's logs for your copy show error 1102 ("exceeded CPU time limit"), follow fewer feeds, or move up.

So: one or two people and a dozen or so feeds, the free plan. Forty feeds or many readers, the $5 plan, with `PLAN` changed to `"paid"` (up to 400 feeds a run; stories are stored per outlet and a year is kept, a little over a gigabyte at 40 feeds).

Email: sign-up asks for an address and password reset is by email. Sending is through [Resend](https://resend.com): create a key there, and set it as `RESEND_API_KEY` (in the deploy form, or the Cloudflare dashboard under the Worker's Settings, or `npx wrangler secret put RESEND_API_KEY`). Change the sender in `cloud/social.js` (`MAIL_FROM`, `MAIL_REPLY_TO`) to an address on a domain you have verified there. Without a key the Worker still runs; mail is only written to its log, so nobody can reset a password.

You are the operator if you made the first account. Sign-ups are by invitation until you open them (File, then Sign-ups). People join through the invite link in the Gossip Column.

## Topics and places: Jev, or your own

Every story gets a main topic, up to three more, and a place. The page's Topic and Place filters read those tags. There are three ways to fill them, and all three write the same two fields, so the page works the same with any of them.

### 1. With Jev (TypeSafe AI)

Jev is the service the original uses to sort stories. It needs a key from [TypeSafe AI](https://typesafe.ai).

- **On your own computer:** set it in the environment (`export TYPESAFE_API_KEY=...`) before running `fetch.py`, or put one line in `.dev.vars` (a file at the top of the folder, never committed): `TYPESAFE_API_KEY=...`. `fetch.py` reads both (the function is `jev_key()`).
- **On Cloudflare:** the `TYPESAFE_API_KEY` box in the deploy form, or later in the dashboard under the Worker's Settings (Variables and Secrets), or `npx wrangler secret put TYPESAFE_API_KEY`. For `npm run dev`, the same line in `.dev.vars`.

That is all. Each new story's headline, summary and opening text (and the outlet's name) are sent to Jev, and nothing else. The code that does it is `tag_one()` in `fetch.py` and `tagOne()` in `cloud/worker.js`, and the questions it asks are built from `taxonomy.json` (`jev_questions()` and `jevQuestions()`).

### 2. Without Jev: keyword rules (built in)

If there is no key, the reader tags by keyword instead. Nothing to turn on. `tag_rules.py` (your computer) and `cloud/rules.js` (Cloudflare) read the `keywords` list in `taxonomy.json`: for each topic, the words and phrases that point to it. A word in a headline counts three times as much as one in the text. The topic with the most points is the main one; others with at least two points follow. A place is the neighborhood or borough named in the story. A story needs a little evidence to be given a topic (one keyword in the headline, or two in the text; `MIN_SCORE` in `tag_rules.py` and `cloud/rules.js`); otherwise it is filed under "Other".

It is a baseline, not a substitute. On a sample of English news it left about a fifth of stories in "Other" and sometimes picks the wrong topic (a headline that says "court orders" is a crime story to it). It reads only English words unless you add yours. Improve it by editing the lists:

```json
"keywords": {
  "Housing & Real Estate": ["rent", "tenant", "eviction", "zoning", "..."],
  "Sports": ["playoff", "yankees", "..."]
}
```

### 3. Your own categories and labels

The lists are in `taxonomy.json`, and they are the same whichever tagger you use:

- `topics`: each topic and a one-line description of it (Jev reads the description; the keyword tagger ignores it). Keep a topic called `Other`; it is where stories that fit nothing go.
- `medtop`: the IPTC Media Topics term each topic stands for (the news industry's standard list, https://cv.iptc.org/newscodes/mediatopic, free to use with credit). Nothing reads it; it records what each topic means, so you can replace a topic and keep your list matched to the standard.
- `boroughs`: the places, as areas each with a list of neighborhoods. The page calls them Place. Replace New York's with yours: the names are only labels. A story gets one neighborhood and its area, or just an area.
- `secondary_threshold`, `place_threshold`: how sure Jev must be before it adds a second topic or a place (0 to 1). The keyword tagger does not use them.
- `renamed`: to rename a topic, change its key and add `"old name": "new name"` here. Stories already stored keep the old name; the page maps it.
- `keywords`: for the keyword tagger, as above.

The two places that read this file besides the taggers are the page's filter menus and the Worker, so one edit to `taxonomy.json` is enough. On Cloudflare, commit the change (or run `npm run deploy`) and it is published.

**Stories already tagged keep their tags.** New or renamed categories apply to stories fetched after the change. To re-tag the ones you have on your computer, remove their tags and run the tagger again:

```
python3 -c "import json; d=json.load(open('data.json')); [i.pop('topics',None) or i.pop('places',None) for i in d['items']]; json.dump(d,open('data.json','w'))"
python3 fetch.py --retag
```

On Cloudflare, `POST /refresh?retag=1` (with `Authorization: Bearer <your admin token>`) tags stories that have none. There is no one-step way to clear and redo stories already stored.

### Using a different classifier

Whatever you use only has to give each story this shape, and the page does the rest:

```json
{ "topics": [ { "name": "Housing & Real Estate", "p": 0.91 }, { "name": "Government & Politics", "p": 0.7 } ],
  "places": [ { "name": "Astoria", "p": 0.8 }, { "name": "Queens", "p": 0.8 } ] }
```

Names must come from `taxonomy.json`. Replace the body of `tag_one()` (`fetch.py`) and `tagOne()` (`cloud/worker.js`) with a call to your own model or service that returns that.

## Make it yours: what is still the original's

Search the code for these before anyone else uses your copy:

- `retronewsreader.com`, `reader@retronewsreader.com`: the original's address, in `cloud/worker.js` (`HOME`, `MOVED`, the user-agent strings) and `cloud/social.js`. The weather service asks for a contact in its user-agent: put yours.
- `OPERATOR_MAIL`, `MAIL_FROM`, `MAIL_REPLY_TO` in `cloud/social.js`: set to placeholders here; put your own.
- The weather on the Gossip Column is New York's (one forecast address in `cloud/social.js`). Change the grid point or remove it.
- `FRONT_PAGE`, the three feeds a signed-off visitor and a new account start on: in both `app.js` and `cloud/social.js`. Change them together.
- `feeds.json` and `catalog.json`: the starting feeds, New York outlets.
- `privacy.html`, `terms.html`, `ai.html`: they describe the original service, its operator and its promises. They are not yours. Rewrite them to say what your copy does before you let anyone sign up. The same goes for the name and icons.
- The tagged short address `/ig` (`TAGGED` in `cloud/worker.js`) needs a row in the `invites` table; remove it if you do not use it.

## Notes

- Never commit `.dev.vars`, `data.json` or a backup. `.gitignore` keeps them out; keep it that way.
- Messages between friends are sealed in the browser and the server cannot read them. A password reset by email makes earlier messages unreadable to the person who reset. That is by design.
- `cloud/backup.sh` (run from a terminal) copies your database and registry to `backups/`. It does not leave your computer; copy it somewhere else.
- `cloud/test/` has checks for the storage code: `node cloud/test/archive.edge.mjs`.
- The typefaces in `fonts/` are Inter Tight and JetBrains Mono, under the SIL Open Font License.
- MIT licence (see `LICENSE`). The three pages `privacy.html`, `terms.html` and `ai.html` describe the original service and are not covered by what they promise: write your own.
