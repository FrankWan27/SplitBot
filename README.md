# Discord Split Bot

A Discord bot for splitting bills between friends.
Log what someone paid, split it evenly across whoever was there, see who owes who, and record payments when people square up.

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
| `date` | no | When it happened, if not now; defaults to right now |

`description` is required. Discord will not accept a blank or whitespace-only
value for a required option, so every bill has a real one - which is the point,
since `/balances` shows only totals and the description is what tells you later
*what* a debt was for.

Bills logged before the field was required have no description, and `/history`
labels those `no description` rather than leaving a blank line.

```
/bill amount:60 with:@bob @carol description:dinner
```

You paid $60, split three ways, so bob and carol each owe you $20.

```
/bill amount:45 with:@bob @carol payer:@alice
```

Logs a bill that Alice paid, even though you are the one typing it.
Useful when someone else fronted the cash and is not around to log it.

```
/bill amount:30 with:@bob @carol include_payer:false
```

You fronted $30 for bob and carol but are not taking a share, so they owe $15 each.

```
/bill amount:24 with:@bob description:taxi date:yesterday
```

Logs a bill that happened earlier, for when you forgot at the time.

#### Backdating with `date`

Discord has no date option type - there is no calendar picker to offer - so `date`
is free text. Accepted forms:

| Input | Means |
|---|---|
| `today`, `yesterday` | what it says |
| `2026-07-20` | an explicit year-month-day |
| `7/20/2026` | month first, matching the `en-US` formatting used elsewhere |
| `7/20` | the most recent time that date happened, so `12/28` typed in January is last December |

The string is parsed digit-by-digit rather than handed to `new Date()`, which
accepts almost anything and guesses at the rest. A two-digit year is refused as
ambiguous rather than guessed at, an impossible date like `2026-06-31` is refused
rather than rolled forward into July, and a date in the future or over five years
old is refused as a likely typo. The `/bill` reply echoes back the date it read,
since that is the only way to confirm `7/20` was understood the way you meant it.

A backdated bill affects balances immediately, exactly like any other bill - the
date only changes where it sits in `/history`.

### `/balances`

Show outstanding debts, largest first.

```
/balances              # everyone in the server
/balances user:@bob    # only debts involving bob, plus his net position
```

### `/settle`

Record a payment from one person to another.

| Option | Required | Meaning |
|---|---|---|
| `to` | yes | Who is being paid |
| `amount` | no | How much; omit to clear the whole balance |
| `from` | no | Who paid; defaults to you |

```
/settle to:@alice              # pay off everything you owe alice
/settle to:@alice amount:10    # partial payment
/settle to:@alice from:@bob    # record that bob paid alice
```

Omitting `amount` settles exactly what is outstanding, so you never have to look
up the figure first. Paying more than owed is allowed but the bot says plainly
that the debt has flipped direction rather than hiding it.

### `/history`

Show recently logged bills and payments, newest first.
This is where a bill's `description` becomes useful - `/balances` only shows
totals, so the history is what tells you *what* a debt was for.

| Option | Required | Meaning |
|---|---|---|
| `user` | no | Only entries involving this person |
| `count` | no | How many to show, 1-25; defaults to 5 |

```
/history                  # last 5 entries in this server
/history user:@bob        # everything bob was involved in
/history count:25         # a longer stretch
```

Entries are grouped under a `MM/DD` date heading, and each one reads as the
amount and what it was for, who paid and for how many, who borrowed what, then the
time and who logged it as subtext:

```
## 07/27
 **$21.45 - Trader Joes**
Paid by @franky for 3 people.
_@mikula @pepega8359 borrowed $7.15._
-# 4 hours ago - Logged by @franky

 **$12.32 - Molly Tea**
Paid by @franky for 3 people.
_@mikula @pepega8359 borrowed $4.10._
-# 4 hours ago - Logged by @franky

## 07/26
 **$7.15**
@mikula paid @franky.
-# yesterday
```

The heading appears once per day, not once per entry, so a busy day reads as one
block. The year is added (`12/25/2025`) only on entries from a previous year,
where `12/25` alone would be genuinely ambiguous. Each page of a long history
repeats the heading for whichever day it opens on, so a page is readable on its
own.

The headcount counts everyone the bill was divided between, including the payer
when they took a share, which is what makes the borrowed figure divide the total.
When a total does not divide evenly the borrowers do not all owe the same amount,
so each distinct share gets its own line rather than one figure that would be
wrong for somebody.

Very large groups name the first eight and summarise the rest as `and N more`, and
a long listing is trimmed from the oldest end to stay inside Discord's embed limit
rather than being rejected outright. A date heading is never left stranded with
nothing under it: entries are appended whole, heading included.

**Timezone.** Grouping by calendar day forces a choice of zone, because an entry
logged at 6pm in California is already the next day in UTC. Unlike the relative
times in the listing, which each reader's Discord client localises, the grouping
has to be decided once, server-side, for everyone reading the message. It defaults
to UTC; set `DISPLAY_TIMEZONE` in `.env` to an IANA name such as
`America/Los_Angeles` to group by the day your group actually lives in. An
unrecognised name logs a warning and falls back to UTC rather than failing.

**Paging.** When there is more history than fits, ⬆️ Newer and ⬇️ Older buttons
walk through it, editing the same message in place instead of posting a new
listing per click. Both buttons are always shown so the row does not jump around;
the direction with nothing left is greyed out. If everything fits on one page the
buttons are omitted entirely.

Each button carries its own paging state - offset, page size, and any `user`
filter - inside its Discord custom id rather than in bot memory. That means the
buttons on an old message keep working after the bot restarts, and there is no
session table to expire. Anything trimmed for length is still reachable, because
the next page starts after what was actually displayed rather than after what was
fetched.

Anyone who can see the message can click its buttons. The listing is already
visible to that channel, so this only changes which slice of it is on screen.

Filtering by `user` matches every role a person can play - the payer of a bill,
one of the people it was split between, or either side of a payment. A bill you
were merely charged for still shows up, which is usually the reason to look.

Someone who only *typed* the command for other people is not counted as
involved, but the subtext always names them, so a bill logged on someone else's
behalf is visible without having to compare it against who paid.

**Backdated bills sort by when they happened**, not by when they were typed, so a
bill logged today with `date:yesterday` slots in below yesterday's entries rather
than jumping to the top. Two facts are stored separately: when a bill was logged,
and when it happened. The listing shows and orders by the latter; the former stays
in the ledger, so a backdated entry remains identifiable and the audit trail is
intact. Entries on the same date keep their insertion order.

## Setup

### 1. Create the Discord application

1. Go to the [Discord Developer Portal](https://discord.com/developers/applications) and click **New Application**.
2. Under **Bot**, click **Reset Token** and copy the token. This is your `DISCORD_TOKEN` - treat it like a password.
3. Under **General Information**, copy the **Application ID**. This is your `DISCORD_CLIENT_ID`.

No privileged gateway intents are needed. Leave Presence, Server Members, and Message Content switched off.

### 2. Invite the bot

Under **OAuth2 → URL Generator**, tick the `bot` and `applications.commands`
scopes, then open the generated URL and pick your server. The bot needs no
special permissions beyond the default - it only replies to slash commands.

### 3. Configure and run

```bash
npm install
cp .env.example .env      # then fill in your token and client id
npm run build
npm run deploy            # register slash commands with Discord
npm start
```

Set `DISPLAY_TIMEZONE` to your group's timezone (`America/Los_Angeles`) so the
`/history` date headings match the days you actually had dinner on. It defaults to
UTC, which puts an evening bill on the wrong side of midnight for most of the
Americas.

While developing, set `DISCORD_GUILD_ID` in `.env` to your server's id.
Commands then register to that one server and appear instantly rather than taking
up to an hour to propagate globally. Re-run `npm run deploy` after changing any
command's name, description, or options.

## How balances are tracked

Balances are stored per *pair* of people, not as one running total per person.
A pair is written with its two user ids sorted into a fixed order, so the pair
(A, B) and the pair (B, A) can never both exist and drift apart. The stored
number is signed and always read in the same direction, so a debt and its
repayment are the same operation with opposite signs.

Two consequences worth knowing:

- **Debts net automatically within a pair.** If Bob owes you $10 and then pays
  for a $6 coffee you shared, the ledger shows Bob owing $7 rather than two
  separate entries pointing in opposite directions.
- **Debts are not netted across a chain.** If A owes B and B owes C, `/balances`
  shows both debts rather than collapsing them into one payment from A to C.
  Collapsing chains into the minimum set of payments is deliberately not included
  here - see below.

Every bill and payment is also appended to an `entries` audit table, which is
what `/history` reads. Balances are never computed from it - they are maintained
directly - so the two are independent: a display bug in the history cannot
corrupt a balance, and the log stays a faithful record of what was entered.

Opening the database brings an older file up to the current schema by adding any
columns it is missing. New columns are nullable with no default, which is what
makes this safe to apply to rows already written, and re-opening is a no-op.

### Money is never a float

All arithmetic and storage uses integer cents. Dollar strings are parsed
digit-by-digit rather than multiplied by 100, because `0.29 * 100` is
`28.999999999999996` in IEEE-754 and a ledger that quietly sheds pennies is
worse than no ledger.

### Odd pennies go to random participants

When a total does not divide evenly there are fewer spare pennies than people, so
somebody has to carry them. Each spare penny goes to a different randomly chosen
participant. `$10` across three people is always `$3.34 / $3.33 / $3.33`; *which*
person pays the extra cent is chance, and the `/bill` reply names them so it does
not look like a rounding bug.

Nothing is dropped - the shares always sum to the exact total, and no two shares
on a bill ever differ by more than one cent. Randomising the recipient means no
single person is systematically the one rounded up, so it evens out across bills
without anyone having to decide.

The payer is an ordinary participant in the draw and can be the one who pays the
extra cent. When the payer takes no share (`include_payer:false`) they are not in
the draw at all, so the pennies fall among the people who do owe, and the payer is
always reimbursed in full.

The randomness is injectable: `splitEvenly` takes an optional generator, which is
how the tests pin a draw and assert exact shares.

## Development

```bash
npm test     # 147 tests: money math, date parsing, ledger invariants, and end-to-end command runs
npm run lint # typecheck without emitting
```

The end-to-end tests in `test/commands.test.ts` drive the real command handlers
through a stand-in for Discord's interaction object, so option parsing,
participant validation, reply text, and ledger writes are all covered without a
live connection. Button clicks go through the same stand-in: a test reads the
custom id off a rendered button and feeds it back to the handler, which is exactly
what Discord does.

Storage is SQLite via Node's built-in `node:sqlite`, so there is no native
dependency to compile and no database server to run. Requires Node 22.5+;
developed on Node 26.

## Deliberate omissions

These were left out to keep the first version small, and each is a clean
addition later:

- **Uneven and share-based splits** - every split is even. Itemised or
  percentage splits would need a different `with` syntax.
- **Undo** - `/history` shows what was logged, but there is no command to reverse
  an entry, so a mistyped bill has to be corrected with an offsetting one. Each
  entry has a stable id, so `/undo <id>` is the natural next addition.
- **Debt simplification** - A→B→C chains are not collapsed into the minimum set
  of payments.
- **Currencies** - amounts are formatted as USD. Nothing in the storage layer
  assumes a currency, so this is a formatting change.

## Notes

- Ledgers are per-server. The same people in two different Discord servers keep
  entirely separate balances.
- Anyone in the server can log a bill or record a payment on anyone else's
  behalf. This suits a group of friends who trust each other; it is not an
  access-controlled system.
- Bots cannot owe or be owed money, and people outside the server are rejected
  rather than silently skipped.
