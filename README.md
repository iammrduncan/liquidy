# liquidy

A Discord bot that judges every message in a server with Liquid AI's
[d1 decision model](https://docs.liquid.ai/lfm/models/d1) and acts on spam and scams.

## Modes

Set `MODE` to choose what happens when a message is flagged.

| Mode | What the bot does | Who gets pinged |
| --- | --- | --- |
| `shadow` (default) | Nothing. It posts an alert in the moderator channel. | `MOD_ROLE_ID` |
| `delete` | Deletes the message. | No one, unless the delete fails |
| `kick` | Removes the author and deletes their messages from the last 24 hours. | No one, unless the kick fails |
| `ban` | Bans the author and deletes their messages from the last 24 hours. | No one, unless the ban fails |

Every mode posts an alert to `MOD_CHANNEL_ID` when one is set. The alert shows the message text in
a code block, so its links can't be clicked, along with the author, the probabilities and what the
bot did. The moderator role is pinged at most once per author every 10 minutes.

**Kick is a softban.** Discord's kick can't delete messages, so `kick` bans the author with 24
hours of message deletion and then lifts the ban straight away. The author is out of the server
and can rejoin with an invite. The audit log, and any logging bot, shows a ban and an unban. Both
`kick` and `ban` need the **Ban Members** permission.

If the author's highest role is above the bot's, or an action fails, the bot deletes the message
if it can and pings moderators.

## How a message is judged

Each message, and each edit that changes the text, becomes one d1 **Choice** question over three
labels: `legitimate`, `spam` and `scam`. The labels and their descriptions are in
[`src/model/classifier.ts`](src/model/classifier.ts). d1 returns a probability for each label and
generates no text. The bot acts when `P(spam) + P(scam) >= FLAG_THRESHOLD` (0.8 by default).

The model sees the following state, built in [`src/context.ts`](src/context.ts):

- **Message:** the text (up to 2,000 characters), links with their parsed host (lookalike Unicode
  domains show up as `xn--` punycode), attachments, embeds and mention counts.
- **Author:** username, display name, account age, time in the server, number of roles and
  whether they have an avatar.
- **Recent activity:** the author's messages in the last 10 minutes, how many channels they used
  and how many were identical to this one. Repeating the same text across channels is the usual
  sign of a raid or a compromised account.
- **Channel:** the channel's name and topic, plus the last `CHANNEL_CONTEXT_MESSAGES` messages
  from the bot's cache. Reading them makes no API calls.
- **Server:** its name and anything you put in `SERVER_CONTEXT`, such as "Self-promotion is
  allowed in #showcase".
- **Images:** with `CLASSIFY_IMAGES=true`, up to 4 image attachments go in too. They are scaled
  to 1024 px on the longest side through Discord's media proxy.

The bot never judges:

- bots, webhooks or system messages;
- channels listed in `EXEMPT_CHANNEL_IDS` (threads inherit from their parent channel);
- roles listed in `EXEMPT_ROLE_IDS`;
- members who can already moderate (`EXEMPT_STAFF`, on by default).

## Marking messages for training

Moderators can label any message. Right-click it (long-press on mobile), open **Apps**, and pick
one of three commands:

- **Mark as spam** or **Mark as scam** for a message the bot missed.
- **Mark as not spam** for a false positive. This saves the label `legitimate`.

The bot saves the message as a labelled example in its SQLite database (`DATABASE_PATH`, by
default `data/liquidy.db`) and replies only to that moderator.

**Marking a deleted message through its alert.** In `delete`, `kick` and `ban` modes the flagged
message is already gone, so moderators mark the bot's alert about it instead. The alert's footer
says so. The bot maps the alert back to the message it flagged and saves that message, with the
state it judged. It remembers its last 1,000 alerts and forgets them when it restarts. Marking an
alert as not spam doesn't undo the bot's action. Restore the message, or lift the ban, by hand.

Each example holds:

- the label;
- the state the model saw;
- the bot's own verdict at the time, which shows what it missed;
- message, channel and author IDs;
- who marked it, and when.

The bot remembers the state and verdict of its last 2,000 judged messages. For an older message,
or one it never judged (staff, exempt channels, or sent before it started), it saves the state it
would build now and records that with `state_source = 'rebuilt'`. Marking a message again changes
its label, and keeps the state saved first.

By default, only members with **Manage Messages** see the commands. Change that under
**Server Settings > Integrations**. The bot also accepts `MOD_ROLE_ID` members once they can see
them.

To write every example as JSON Lines, ready for training or for scoring thresholds, run:

```sh
npm run -s export > examples.jsonl
```

## Model backends

### `MODEL_PROVIDER=liquid` (default)

This calls Liquid's System One API: `POST {LIQUID_BASE_URL}/decisions/v1/systemone`, using
`model` (`d1` or `d1-ultra`), `state` and `questions`. Get a key at
[console.liquid.ai](https://console.liquid.ai) (Dashboard > API Keys). Keys start with `liquid_`.

`LIQUID_BASE_URL` can point at anything else that serves the same route. Two examples are a
LiteLLM [pass-through endpoint](https://docs.litellm.ai/docs/proxy/pass_through) that forwards to
`api.liquid.ai`, and your own wrapper around the open-weight `LiquidAI/d1-3B`. A key is required
only for `https://api.liquid.ai`.

### `MODEL_PROVIDER=openai`

This calls any OpenAI-compatible endpoint: `POST {OPENAI_BASE_URL}/chat/completions`. Examples
are LiteLLM, vLLM, SGLang and llama-server. The request asks for a JSON verdict
`{label, confidence}` with `response_format: json_schema`, and the reply is validated. The
stated confidence goes to the chosen label, and the rest is split evenly between the other two.

d1 is a decision model, not a chat model. Liquid documents only the System One route for it, so
a chat completions endpoint has to serve a chat model, such as LFM2.5. A chat model's stated
confidence isn't calibrated like d1's probabilities, so expect to retune `FLAG_THRESHOLD`.

## Setup

1. Create a new application at the
   [Discord Developer Portal](https://discord.com/developers/applications) for this bot alone.
   It leaves every server except `GUILD_ID`, so don't reuse an application that is in other
   servers. Under **Bot**, turn on the **Message Content Intent**. It is privileged, and without
   it the bot can't log in.
2. Make the application private, so only you can add it to a server:
   1. **Installation > Installation Contexts:** untick **User Install** and keep **Guild Install**.
   2. **Installation > Install Link:** choose **None** and save. Discord won't make an
      application private while it has an install link.
   3. **Bot > Public Bot:** turn it off.
3. Invite the bot with the scopes `bot` and `applications.commands` (for the mark commands) and
   the permissions it needs. Once the bot is private, only you, as its owner, can use this link.
   Permissions `93188` cover View Channels, Send Messages, Embed Links, Read Message History,
   Manage Messages and Ban Members:
   `https://discord.com/oauth2/authorize?client_id=<APPLICATION_ID>&scope=bot+applications.commands&permissions=93188`
4. In **Server Settings > Roles**, drag the bot's role above the roles of the members it should
   act on. Discord won't let it kick or ban anyone at or above its own role.
5. Configure and run:

   ```sh
   cp .env.example .env    # then fill it in
   npm install
   npm run dev             # runs src/ directly, restarting on changes
   ```

At startup, the bot logs a warning for each permission the chosen mode needs but doesn't have.

### What keeps the bot private

The Developer Portal settings in step 2 decide who can add the bot. The code also keeps it to
your server:

- **One server.** It acts only in `GUILD_ID`. It leaves any other server, both at startup and
  whenever it is added to one, and logs the server's ID and name.
- **Install check.** If **Public Bot** or **User Install** is still on, it logs a warning at
  startup.
- **Commands.** The mark commands are registered in `GUILD_ID` only. They work only in a server,
  for a server install. By default only members with Manage Messages see them.
- **No DMs.** It reads no direct messages: it doesn't request the DM intents.

To try the model without Discord, using only the model settings from `.env`, run:

```sh
npm run classify -- "Free Nitro for everyone: https://dlscord-gift.com/claim"
```

Start in `shadow` mode. Watch the alerts and the `judged` log lines (each one has
`flagProbability`) to set `FLAG_THRESHOLD`, then switch to an acting mode.

## Configuration

All settings are environment variables, documented in [`.env.example`](.env.example) and
validated at startup in [`src/config.ts`](src/config.ts). A blank value counts as unset.

## Development

Requires Node.js 22.15 or later. `npm run dev`, `npm test` and `npm run classify` run the
TypeScript directly with Node's type stripping.

| Command | |
| --- | --- |
| `npm run check` | Typecheck, lint (Biome) and test |
| `npm test` | Unit tests (`node:test`); the model backends are tested against a local HTTP stub |
| `npm run build` / `npm start` | Compile to `dist/` and run the compiled bot |
| `npm run -s export` | Print the marked examples as JSON Lines |

## Data and privacy

Every message the bot judges goes to the model provider, along with the author details and
recent channel messages described above. Set `CHANNEL_CONTEXT_MESSAGES=0` to send only the
message being judged. Logs record message, channel and author IDs and verdicts, never message
text.

The database keeps every marked message, including its text, the author's ID and the recent
channel messages in its state, until you delete it. Treat `data/` as moderation records: it is
git-ignored, and it is yours to back up and to prune.

## Limits of this version

- **Single server.** The bot watches only `GUILD_ID`, and all settings are global.
- **History resets on restart.** The per-author activity window is kept in memory, so it starts
  empty each time the bot restarts.
- **Recent edits only.** Edits are judged only for messages still in discord.js's cache (the
  last 200 per channel).
- **No retries.** A failed model call is logged and no action is taken on that message.
- **No buttons.** Moderators act on shadow-mode alerts by hand.
- **Alerts are forgotten on restart.** After a restart, an older alert can't be marked. Only
  examples already saved are kept.
- **No images in examples.** Examples keep attachment names and types, not the images. Discord's
  attachment links expire.
