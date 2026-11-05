# home-assistant

A family iMessage chat assistant ("Homebot"). It reads the thread and uses Claude to work out what's being asked. It keeps Skylight lists and the shared Google calendar up to date, sets reminders, looks things up on the web, reads the family mailbox, and answers questions. It remembers what it learns about the family and can be taught routines.

It uses the unofficial Skylight API, which may break if Skylight changes it. Auth flow ported from [chrischall/skylight-mcp](https://github.com/chrischall/skylight-mcp).

## How it works
- Polls `~/Library/Messages/chat.db` every 5 seconds, read-only, for new messages in `CHAT_GUID` from `ALLOWED_HANDLES`.
- Chats listed in `DM_CHAT_GUIDS` (one-to-one chats with the bot) are watched the same way, and replies go back to the chat a message came from.
- `state/checkpoint.json` stores the last message ROWID it handled. The checkpoint only moves forward after a batch succeeds. After downtime, it catches up on everything since the checkpoint in one batch and sends one summary reply.
- Retries after a crash or error don't create duplicates, because `add_items` skips items already pending on the list and `add_event` skips an event with the same title and start.
- Claude runs through the Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`) on your Claude subscription, with tools in `src/tools/` served as an in-process MCP server. Replies go out through AppleScript to Messages.

## Talking to it
- In the group chat it replies when a message is meant for it: it uses its name (`BOT_NAME`, default Homebot), follows up on something it said, or is a request it can act on ("we're out of milk"). It stays out of everything else. In a direct message it always replies.
- The rules for when and how it speaks are `BASE` in `src/agent.ts`.
- It can search the web and read pages. It has no shell or file access and cannot send email.

## Memory
- `state/memory.json` holds lasting facts and preferences. The bot adds to it on its own as it learns things, and when told to remember something. All of it is given to Claude on every run, and to the weekly newsletter digest.
- Ask it "what do you know about ...", or tell it to forget or correct something. The file can also be edited by hand.

## Skills
- A skill is a routine taught in the chat ("when I say date night, do ..."). Each is a file in `state/skills/<name>.md`: first line says when to use it, the rest is the steps. The bot writes and updates these itself, and they can be edited by hand.
- Skills only describe how to use the tools the bot already has. A new kind of access is a new tool domain (see "Adding a use case").

## Tasks, reminders and scheduled jobs
- "Remind us Thursday to ..." adds a Google Task on the family account (shown in its Google Calendar; day only, any time goes in the title), so it is there even when the Mac is off. Needs the Google sign-in below with task access.
- "Text us Thursday at 7am to ..." texts the same chat at that time. "Every Sunday at 6pm send the week ahead" is a job: the bot runs that instruction at that time and posts the result.
- They live in `state/reminders.json`. Ones missed while the Mac was asleep go out when it wakes, marked late.

## Wishlist
- `state/wishlist.json` records what the family wanted that the bot can't do yet, with how often each has come up. The bot adds to it when it has to say "can't do that", and when told "add to the wishlist ...". Ask it "what's on the wishlist?".
- This is the backlog for improving the bot: build from the most-asked open entries, then mark them `done`.

## Family email
- With Gmail set up (see below), the bot can search and read that mailbox to answer questions. Read-only. It can open PDF and image attachments (`src/readFile.ts`: a separate Claude call reads the file and reports what it says); other file types are listed by name only.

## Weekly school newsletter
- Every Friday at 5pm the bot reads the newest email from `NEWSLETTER_SENDER` in the Gmail account it was signed into, with its PDF attachment and the linked school-wide newsletter (Smore), and texts the group chat a short summary plus the dates that are not on the calendar yet, asking whether to add them. Replying "yes" (or "all but ...") in the chat adds them.
- If no new email has arrived it looks once more on Saturday at noon, then says there was none. A Mac that was asleep on Friday catches up when it wakes.
- `state/newsletter.json` records the last email handled and every date already asked about, so nothing is asked twice. Dates already on the calendar are left out too.
- Describe the child (name, class, school, teacher, programs they are not in) in `NEWSLETTER_CONTEXT`, and name the sender in `NEWSLETTER_FROM_NAME`. The rules for what counts as relevant are in `SYSTEM` in `src/newsletter/digest.ts`.
- `DRY_RUN=1 NEWSLETTER_NOW=1 npm start` digests the newest email once and prints the text without sending or saving. Without `DRY_RUN` it sends it for real.

Gmail setup (once):
1. In the same Google Cloud project as the calendar key, enable the **Gmail API** and the **Google Tasks API**.
2. Google Auth Platform → Audience: External, and **publish the app** (in Testing, the sign-in expires after 7 days). Clients → create an OAuth client of type **Desktop app** and download its JSON.
3. `npm run gmail-auth ~/Downloads/client_secret_....json`, sign in as the mailbox the newsletter arrives in, and tick both boxes: read Gmail, manage Tasks (Google warns the app is unverified; continue via Advanced). This writes `state/gmail-oauth.json`.
4. Set `GMAIL_OAUTH_FILE`, `NEWSLETTER_SENDER`, `NEWSLETTER_FROM_NAME` and `NEWSLETTER_CONTEXT` in `.env` and restart the bot.

## Adding a use case
1. Create `src/tools/<domain>.ts` that exports `{ prompt, tools }`. Use `lists.ts` as the template.
2. Register it in `DOMAINS` in `src/tools/index.ts`.

## Setup
1. **Bot macOS user.** Create a standard user called `homebot`.
   - Log in as homebot and sign Messages in with the bot Apple ID (a separate Apple ID just for the bot).
   - In Messages → Settings → iMessage: enable Messages in iCloud, and set "Start new conversations from" to that email.
2. **Add the bot to the group chat.** From your iPhone, add the bot Apple ID. Send one message so the chat shows up in homebot's Messages.
3. **Project location.** homebot can't read your home folder, so copy the project somewhere it can:
   ```
   sudo mkdir -p /Users/Shared/home-assistant && sudo chown homebot /Users/Shared/home-assistant
   # as homebot:
   rsync -a --exclude node_modules --exclude state ~YOUR_USER/Projects/home-assistant/ /Users/Shared/home-assistant/
   cd /Users/Shared/home-assistant && npm install
   ```
4. **Configure.** As homebot:
   - `cp .env.example .env` and fill in the Skylight credentials, and `CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token` (needs a Claude Pro/Max subscription).
   - The Skylight account needs an email/password login, not Google or Apple sign-in.
5. **Google Calendar.** The bot signs in as a service account, so there is no browser login and no token to expire.
   - In [Google Cloud Console](https://console.cloud.google.com), create a project and enable the **Google Calendar API**.
   - IAM & Admin → Service Accounts → create one (no roles needed) → Keys → Add key → JSON.
   - Save the downloaded file as `state/google-key.json`, readable by homebot only.
   - In Google Calendar, open the shared calendar's settings → "Share with specific people" → add the service account's email (`client_email` in the key file) with **Make changes to events**.
   - Put the calendar's ID in `GOOGLE_CALENDAR_ID` (same settings page → "Integrate calendar" → Calendar ID).
   - Event times use the Mac's timezone.
6. **Full Disk Access.** In System Settings → Privacy & Security → Full Disk Access, add:
   - the node binary: `realpath $(which node)`, currently `/opt/homebrew/Cellar/node/26.0.0/bin/node`
   - Terminal, so `discover` can run.

   A `brew upgrade node` changes this path, so re-grant after upgrading.
7. **Discover IDs.** Run `npm run discover`, then fill in `SKYLIGHT_FRAME_ID` (only needed if the account has several frames), `CHAT_GUID`, and `ALLOWED_HANDLES`. For example: `Alex=+15551234567,Sam=+15557654321`. `npm run discover calendar` checks that the calendar is reachable.
8. **Dry run.** No writes, no replies.
   ```
   DRY_RUN=1 REPLAY_LAST=30 npm start   # replay the last 30 thread messages once
   npm run dry-run                      # watch live messages
   ```
9. **Install.** Run `./scripts/install-launchagent.sh`. The first reply triggers an "allow node to control Messages" prompt; approve it.
10. **Power.** `sudo pmset -c sleep 0` keeps the Mac awake on AC. If it sleeps, the bot catches up when it wakes.
11. **After reboots.** Log into homebot once, then switch back to your account (fast user switching). The bot only runs while homebot's session is active.

Logs: `logs/agent.log`
