# Discord Split Bot

A Discord bot for splitting bills between friends.
Log what someone paid, split it evenly across whoever was there, see who owes who, and record payments when people square up.

Replies are titled by category: 💳 bill, 💰 balances, ✅ payment, 🕓 history, and ✏️ 🗑️ ♻️ for edit, delete, and restore.

Every command takes `private:true`, which shows the reply to you alone instead of posting it to the channel, and a private reply calls you "you" rather than mentioning you by name.
`/balances` is private by default, since what you owe is nobody else's business unless you say so.
See [Private replies](#private-replies).

## Commands

### `/bill`

Log a bill and split it evenly.

| Option | Required | Meaning |
|---|---|---|
| `amount` | yes | Total of the bill, e.g. `42.50`, `$42.50`, `1,234.56` |
| `with` | yes | Mention everyone splitting it, e.g. `@alice @bob` |
| `description` | yes | What it was for, e.g. `dinner at Nopa` |
| `payer` | no | Who actually paid; defaults to you |
| `include_payer` | no | Whether the payer shares the cost; defaults to yes |
| `date` | no | When it happened, if not now, e.g. `yesterday`, `July 20`; defaults to right now |
| `private` | no | Show the reply only to you; defaults to no |

```
/bill amount:60 with:@bob @carol description:dinner        # you paid $60, they owe $20 each
/bill amount:45 with:@bob @carol payer:@alice              # alice paid, you are just logging it
/bill amount:30 with:@bob @carol include_payer:false       # you took no share, they owe $15 each
/bill amount:24 with:@bob description:taxi date:yesterday  # you forgot at the time
/bill amount:24 with:@bob description:taxi date:JUL 20     # or name the month
```

`description` is required, because `/balances` shows only totals and this is what tells you later what a debt was for.

**Dates.** Discord has no date option type, so `date` is free text: `today`, `yesterday`, `2026-07-20`, `7/20/2026`, `7/20`, `July 20`, `JUL 20`, or `July 20, 2026`.
Month names are matched in full or as the usual three-letter abbreviation, in any case, and a form with no year means the most recent time that date happened - so `12/28` or `Dec 28` typed in July is last December rather than five months ahead.
Every form is read month-first, matching the `en-US` convention the rest of the bot formats in; `20 July` is refused rather than read the other way round, since mixing the two conventions is what makes `03/04` unreadable.
It is parsed part-by-part rather than handed to `new Date()`, so a two-digit year, an impossible date like `2026-06-31` or `Feb 30`, or anything in the future or over five years old is refused rather than guessed at.
The reply echoes back the date it read.
A backdated bill affects balances immediately; the date only changes where it sits in `/history`.

### `/balances`

Show outstanding debts, largest first.

| Option | Required | Meaning |
|---|---|---|
| `user` | no | Show this person instead of yourself, split by direction, plus their net position |
| `everyone` | no | Every debt in the server rather than one person's; defaults to no |
| `details` | no | List the bills and payments each balance is made of; defaults to no |
| `private` | no | Show the reply only to you; **defaults to yes** for this command |

```
/balances                    # your own debts, shown to you alone
/balances user:@bob          # only debts involving bob, plus his net position
/balances everyone:true      # every debt in the server, as one flat list
/balances private:false      # post your balances to the channel
/balances details:true       # your balances, with the entries behind each one
```

**On its own, `/balances` answers "what do I owe?"** - your debts, addressed to you, shown to nobody else.

```
💰 Your balances

__Owed to you__ · **$10.00**
@carol → you  **$6.00**
@dave → you  **$4.00**

__You owe__ · **$20.00**
You → @alice  **$20.00**

Net position
You owe $10.00 overall.
```

That is the question the command is nearly always run for, and the one answer that is nobody else's business by default.
`everyone:true` gives the server-wide listing instead, and `private:false` posts any of it to the channel.
Naming both `everyone` and `user` is refused rather than guessed at, since the resulting figures would look like a straight answer to whichever question was dropped.

**A listing about one person splits their debts by direction**, into what they are owed and what they owe, each with its own subtotal and still largest first within it.
Asked about somebody else, or posted to the channel, the same listing names them instead of addressing them:

```
💰 Balances for bob

__Owed to bob__ · **$10.00**
@carol → @bob  **$6.00**
@dave → @bob  **$4.00**

__bob owes__ · **$20.00**
@bob → @alice  **$20.00**

Net position
Owes $10.00 overall.
```

The two subtotals differ by exactly the net position below them, which is what makes the net figure checkable rather than something to take on trust.
Each one covers every debt in its direction, including any the listing had no room for, so a reply that had to drop a pair says so in the footer rather than quietly reporting a smaller subtotal.

The headings name the person instead of saying "incoming" and "outgoing", because which of those a debt counts as depends on whose listing it is.
They appear only when debts run both ways: with everything pointing one direction there is nothing to divide, and the total is already stated as the net position.
`everyone:true` gives a single flat list for the same reason - it has no reference person, and every debt there is incoming for one side and outgoing for the other.

`details` answers "why do I owe that?".
Each balance is followed by the entries that make it up, oldest first, with a running total that ends on the figure in the headline - so a disputed balance can be checked line by line instead of taken on trust.

```
💰 Your balances

You → @franky  **$6.00**
 `#12` 07/26 dinner at Nopa **+$10.00** → $10.00
 `#14` 07/27 _payment_ **-$5.00** → $5.00
 `#15` 07/28 bagels **+$1.00** → $6.00
```

Signs are relative to the debt in the headline, so a payment visibly subtracts and a bill running the other way does too.
The entry ids are the same ones `/edit` and `/delete` take, so a line you disagree with can be fixed on the spot.
Everything here runs one way, so the listing needs no direction headings; add a debt the other way and the same breakdowns appear under one heading each.

Deleted entries are left out, since they no longer affect the balance and including them would break the running total; `/history show_deleted:true` is where they stay visible.
A bill you both merely shared - say one you each owed a third person for - does not appear, because it moved nothing between the two of you.

A breakdown runs to several lines per pair, so at most 8 pairs are broken down at once; the reply says how many it left out.
Narrow it with `user` to see a specific person's in full.

### `/settle`

Record a payment from one person to another.

| Option | Required | Meaning |
|---|---|---|
| `to` | yes | Who is being paid |
| `amount` | no | How much; omit to clear the whole balance |
| `from` | no | Who paid; defaults to you |
| `private` | no | Show the reply only to you; defaults to no |

```
/settle to:@alice              # pay off everything you owe alice
/settle to:@alice amount:10    # partial payment
/settle to:@alice from:@bob    # record that bob paid alice
```

Overpaying is allowed, and the reply says plainly that the debt has flipped direction.

### `/history`

Show recently logged bills, newest first.

| Option | Required | Meaning |
|---|---|---|
| `user` | no | Only entries involving this person |
| `count` | no | How many to show, 1-25; defaults to 5 |
| `bills` | no | Show bills; defaults to yes |
| `payments` | no | Show payments between people; defaults to no |
| `show_deleted` | no | Also list deleted entries, struck through; defaults to no |
| `private` | no | Show the reply only to you; defaults to no |

```
/history                              # last 5 bills in this server
/history user:@bob                    # bills bob was involved in
/history count:25                     # a longer stretch
/history payments:true                # bills and payments together
/history bills:false payments:true    # payments only
/history show_deleted:true            # including deleted ones
```

**Bills only, by default.**
Payments are bookkeeping - they mostly just push the bills you were looking for off the page - so they are listed only when asked for.

Each flag means only itself.
`bills` is on unless you turn it off and `payments` is off unless you turn it on, and neither one moves the other: `payments:true` *adds* payments to the bills already listed, because nothing said to stop listing bills.
Payments on their own are `bills:false payments:true`, said explicitly.
Turning both off is refused, since there would be nothing left to show.

The title says what the listing covers - `Recent bills`, `Recent payments`, or `Recent history` for both - because a listing that quietly omitted payments while calling itself history would read as an empty ledger.
For the same reason, an empty page distinguishes a server with nothing logged from one where the filter is hiding everything.

```
🕓 Recent history

## __07/27__
 `#31` **$21.45 - Trader Joes**
Paid by @franky for 3 people.
@mikula @pepega8359 borrowed $7.15.
_4 hours ago_

 `#30` **$12.32 - Molly Tea**
Paid by @pepega8359 for 3 people.
@mikula @franky borrowed $4.10.
_4 hours ago - Logged by @franky_

## __07/26__
 `#29` **$7.15**
@mikula paid @franky.
_yesterday_
```

`#31` is the entry id, which is what `/edit`, `/delete`, and `/restore` take.

The italic closing line also carries `Edited by` and `Deleted by` where they apply.
`Logged by` shows only when the person who typed the command is not the payer, as on the Molly Tea bill - usually they are the same person and it would just restate the line above.

Filtering by `user` matches every role a person can play: payer, one of the people it was split between, or either side of a payment.
Someone who only *typed* the command is not counted as involved, but `Logged by` names them.

Backdated bills sort by when they happened, not when they were typed.
Both facts are stored, so a backdated entry stays identifiable.

**Timezone.** Grouping by calendar day needs a zone, since a 6pm bill in California is already tomorrow in UTC.
Set `DISPLAY_TIMEZONE` in `.env` to an IANA name such as `America/New_York`; it defaults to UTC, and an unrecognised name logs a warning and falls back to UTC.

**Paging.** ⬆️ Newer and ⬇️ Older buttons edit the same message in place rather than posting a listing per click, and are omitted entirely when everything fits on one page.
Each button carries its paging state in its Discord custom id rather than in bot memory, so buttons on an old message keep working after a restart.
Every filter rides along in that id - the user, the count, which kinds, and `show_deleted` - so page two covers exactly what page one did.
Anyone who can see the message can click them.

### `/edit`

Change a bill that was already logged.

| Option | Required | Meaning |
|---|---|---|
| `id` | yes | The id shown next to the entry in `/history`, e.g. `31` |
| `amount` | no | New total |
| `description` | no | New description |
| `with` | no | Replace who it was split with |
| `payer` | no | Change who paid |
| `include_payer` | no | Whether the payer shares the cost |
| `date` | no | Change when it happened; same forms as `/bill` |
| `private` | no | Show the reply only to you; defaults to no |

```
/edit id:31 amount:24.50            # the receipt was more than you remembered
/edit id:31 description:Trader Joes # you typed it in a hurry
/edit id:31 with:@bob @carol        # carol was there too
/edit id:31 payer:@bob              # bob paid, not you
```

An omitted option keeps its stored value, so you can fix a description without restating the split.
The reply lists what changed, old to new, and who owes what now.

An edit re-splits only when the split actually changed.
This matters because an uneven total leaves one person a penny short, and re-splitting would move that cent of real debt between two people as a side effect of fixing a typo.

Changing `payer` alone keeps the same people in the split; the debts just point at the new payer.

Payments cannot be edited - use `/delete` plus a corrected `/settle`.

### `/delete` and `/restore`

Delete an entry and undo its effect on balances, or bring it back.

| Option | Meaning |
|---|---|
| `id` | One entry, e.g. `31` |
| `ids` | Several entries, comma separated, e.g. `31,32` |
| `private` | Show the reply only to you; defaults to no |

```
/delete id:31
/delete ids:31,32,35
/restore id:31
/restore ids:31,32
```

Give one or the other, not both.
`ids` also accepts spaces and the `#` that `/history` prints, so `ids:#31 #32` works; repeats collapse, and at most 25 entries can be named at once.

The row is marked deleted rather than removed, so the ledger stays an append-only record of what happened, including who deleted what.
A restore reproduces the original balances penny for penny, because it re-applies the *stored* shares rather than re-splitting the total.

**A batch is all or nothing.**
If any id in `ids` does not exist, or is already in the state you asked for, nothing is deleted or restored and the reply names the id that stopped it.
A half-applied delete would leave you working out which entries went through, and the ids you would need to finish the job are the ones already gone from `/history`.

**Anyone in the server can edit, delete, and restore anything.**
The bot is for a group of friends who already trust each other with the ledger, and the log records who did what.

## Private replies

Every command takes `private`, which sends the reply to you alone rather than to the channel.

```
/balances                                    # already private: this is its default
/history user:@bob private:true
/bill amount:60 with:@bob description:dinner private:true
/balances private:false                      # the other way: post it to the channel
```

Discord calls this an ephemeral message: only you can see it, nobody else in the channel is aware it happened, and it disappears when you dismiss it or restart your client.

**Each command has its own default.**
Anything that records a shared fact - `/bill`, `/settle`, `/edit`, `/delete`, `/restore` - posts to the channel, because the point of logging it is that everyone can see it.
`/balances` answers a question about one person and defaults to private.
`/history` is public, being a shared record.
Whichever way a command leans, `private` overrides it in both directions.

**A private reply calls you "you".**
There is exactly one person reading it, so mentioning them by name reads as a sentence about somebody else: "@you owe @gant $61.58", shown only to you, is worse than "You owe @gant $61.58".
A public reply is the opposite case - every reader is a third party, so a mention is the only thing that works.
So the wording follows from who can see the reply rather than being chosen separately, in `src/voice.ts`.

Only the reader is ever addressed this way.
`/balances user:@bob`, read by alice, still says "bob owes" and "Owed to bob", because bob is who the listing is *about* and alice is who it is *for*.
Verbs agree either way, so it is never "you owes".

It changes who sees the reply and how it addresses them, not what the reply reports.
A private `/bill` still moves the balances and still shows up in everyone's `/history`, because the ledger is shared even when the confirmation is not.
A private `/balances` reports the same money a public one would, down to the last figure.

`/history` keeps working paging buttons when private, since an ephemeral message can still be edited in place for the person it was sent to.
A public listing's buttons stay in the third person even for whoever clicks them: the click edits the message the whole channel is reading, so addressing the clicker would rewrite everyone else's copy to speak to somebody they are not.

The option is added to all seven commands from one place in `src/commands/index.ts` rather than declared in each, so its name and meaning cannot drift apart between commands; only the default comes from the command itself.
Error messages have always been private, and stay that way regardless of the flag - nobody else needs to read them.

## Setup

1. In the [Discord Developer Portal](https://discord.com/developers/applications), click **New Application**.
2. Under **Bot**, **Reset Token** and copy it - this is `DISCORD_TOKEN`, treat it like a password.
3. Under **General Information**, copy the **Application ID** - this is `DISCORD_CLIENT_ID`.
4. Under **OAuth2 → URL Generator**, tick `bot` and `applications.commands`, then open the URL and pick your server.

No privileged gateway intents are needed; leave Presence, Server Members, and Message Content off.
The bot needs no permissions beyond the default.

```bash
npm install
cp .env.example .env      # then fill in your token and client id
npm run build
npm run deploy            # register slash commands with Discord
npm start
```

Set `DISPLAY_TIMEZONE` to your group's timezone so `/history` headings match the days you actually had dinner on.
`DATABASE_PATH` sets where the SQLite file lives, defaulting to `./data/splits.db`.

While developing, set `DISCORD_GUILD_ID` to your server's id: commands then register to that one server and appear instantly rather than taking up to an hour to propagate globally.
Re-run `npm run deploy` after changing any command's name, description, or options.

## How balances are tracked

Balances are stored per *pair* of people, with the two user ids sorted into a fixed order, so (A, B) and (B, A) can never both exist and drift apart.
The stored number is signed, so a debt and its repayment are the same operation with opposite signs.

- **Debts net within a pair.** If Bob owes you $10 and then covers a $6 coffee you shared, the ledger shows Bob owing $7.
- **Debts are not netted across a chain.** If A owes B and B owes C, `/balances` shows both rather than collapsing them into one payment.

Every bill and payment is also appended to an `entries` audit table, which is what `/history` reads.
Balances are never computed from it - they are maintained directly - so a display bug in the history cannot corrupt a balance.
Editing and deleting keep that append-only property, and reverse their effect on balances explicitly, since there is no recomputation to fall back on.

`/balances details:true` does reconstruct each pair from the log, but only to display it; the stored balance is still the authoritative figure.
The two agreeing is exactly what the breakdown's running total asserts, and the tests check that they agree over deletes, restores, edits, uneven splits, and debts running both ways.

Opening the database brings an older file up to the current schema by adding any missing columns.
New columns are nullable with no default, which makes this safe on rows already written.

**Money is never a float.**
All arithmetic and storage uses integer cents, and dollar strings are parsed digit-by-digit rather than multiplied by 100, because `0.29 * 100` is `28.999999999999996` in IEEE-754.

**Odd pennies go to random participants.**
`$10` across three people is always `$3.34 / $3.33 / $3.33`; *which* person pays the extra cent is chance, and the `/bill` reply names them so it does not look like a rounding bug.
Shares always sum to the exact total and never differ by more than a cent.
Randomising means nobody is systematically the one rounded up.
A payer taking no share is not in the draw at all, so they are always reimbursed in full.
`splitEvenly` takes an optional generator, which is how the tests pin a draw.

## Development

```bash
npm test     # 290 tests: money math, date parsing, ledger invariants, and end-to-end command runs
npm run lint # typecheck without emitting
```

The end-to-end tests in `test/commands.test.ts` drive the real command handlers through a stand-in for Discord's interaction object, so option parsing, participant validation, reply text, and ledger writes are covered without a live connection.
Button clicks go through the same stand-in: a test reads the custom id off a rendered button and feeds it back to the handler, exactly as Discord does.

Storage is SQLite via Node's built-in `node:sqlite`, so there is no native dependency to compile and no database server to run.
Requires Node 22.5+; developed on Node 26.

## Deliberate omissions

- **Uneven and share-based splits** - every split is even.
- **Debt simplification** - A→B→C chains are not collapsed into the minimum set of payments.
- **Currencies** - amounts are formatted as USD, but nothing in the storage layer assumes one.

## Notes

- Ledgers are per-server. The same people in two different servers keep entirely separate balances.
- Anyone can log, settle, edit, or delete on anyone else's behalf. It is not an access-controlled system, but every entry records who logged it and who last changed it.
- Bots cannot owe or be owed money, and people outside the server are rejected rather than silently skipped.
