# K.I.B.I. — Kobler Interactive Bot Interface

A Jarvis-style talking orb for your OpenClaw agents (the project started as "Kira Orb"). Talk to it, it answers
out loud, and the glass orb reacts: light ribbons turn inside it in each agent's own two colours (Kira pink,
Forge blue, Ledger green, or whatever you pick in Settings), they spin faster while the agent thinks, and they
fold into a voice waveform that follows the speech while it talks.
Tap the orb mid-reply to interrupt.

```
browser ──HTTPS + password──▶ Caddy ──agentnet──▶ kira-orb ──WebSocket (agentnet)──▶ openclaw-gateway
                                                (holds the token          same protocol as the
                                                 and its device key)      OpenClaw chat page
```

The gateway token stays inside the `kira-orb` container. The browser never sees it,
and `/v1` is blocked on the public `claw.bigsixtech.tech` address.

The orb talks to OpenClaw the same way OpenClaw's own chat page does, so every message is a normal
agent turn with the agent's **full tool set**: the browser, image generation, files, memory, everything
the agent can do in the OpenClaw chat. The **Chat** window shows the conversation with each tool step
as it happens and any images or files the agent makes. Until the orb is approved as a device (one time,
see **Full tools** below) it falls back to OpenClaw's basic HTTP chat endpoint: text only, no tools.

## What's in this folder

| Path | Goes to |
|---|---|
| `server.js`, `gateway.js`, `package.json`, `Dockerfile`, `public/` | `/docker/agent-stack/kira-orb/` (the app) |
| `.env.example` | copy to `/docker/agent-stack/kira-orb/.env` |
| `deploy/docker-compose.override.yml` | replaces `/docker/agent-stack/docker-compose.override.yml` |
| `deploy/Caddyfile` | replaces `/docker/agent-stack/Caddyfile` |
| `deploy/backup.env.example` | copy to `/docker/agent-stack/backup.env` |
| `voice/` | the Pocket TTS voice service (built by the `voice` compose service) |
| `voices/` | one voice clip per agent, named after its id |
| `deploy/voice.env.example` | copy to `/docker/agent-stack/voice.env` with your Hugging Face token |

Your main `docker-compose.yml` is not changed.

## Install (about 15 minutes)

**1. Copy the zip to the VPS.** From PowerShell on your PC:

```powershell
scp $HOME\Downloads\kira-orb.zip root@179.236.241.98:/root/
```

Then in the VPS console:

```bash
cd /docker/agent-stack
python3 -m zipfile -e /root/kira-orb.zip .
cp docker-compose.override.yml docker-compose.override.yml.bak4
cp Caddyfile Caddyfile.bak4
```

**2. Turn on OpenClaw's chat endpoint.**

```bash
docker compose exec openclaw-gateway node dist/index.js config set gateway.http.endpoints.chatCompletions.enabled true
docker compose restart openclaw-gateway
```

If `config set` isn't recognised, open `data/openclaw/openclaw.json` with `nano` and add
`"http": { "endpoints": { "chatCompletions": { "enabled": true } } }` inside the `"gateway"` section, then restart.

Check it, and note your agent ids (you'll see `openclaw/main` and one line per agent):

```bash
curl -s http://127.0.0.1:18789/v1/models -H "Authorization: Bearer $(grep ^OPENCLAW_GATEWAY_TOKEN= .env | cut -d= -f2-)"
```

**3. Configure the orb.**

```bash
cp kira-orb/.env.example kira-orb/.env
TOKEN=$(grep ^OPENCLAW_GATEWAY_TOKEN= .env | cut -d= -f2-)
sed -i "s|^OPENCLAW_TOKEN=.*|OPENCLAW_TOKEN=$TOKEN|" kira-orb/.env
chmod 600 kira-orb/.env
nano kira-orb/.env      # make AGENT_LABELS, AGENT_COLORS and AGENT_TITLES use the ids from step 2 (preset: main, forge, ledger)
```

**4. Configure backups.**

```bash
cp kira-orb/deploy/backup.env.example backup.env
chmod 600 backup.env
mkdir -p /root/backups
openssl rand -base64 24      # copy this into GPG_PASSPHRASE, and into your password manager
nano backup.env
```

**5. Put the new stack files in place.**

```bash
cp kira-orb/deploy/docker-compose.override.yml docker-compose.override.yml
cp kira-orb/deploy/Caddyfile Caddyfile
docker compose restart caddy   # Caddy must restart (not just reload) to see a replaced Caddyfile
```
Set your sign-in email and password in `kira-orb/.env` (see **Sign-in** below).

**6. DNS.** In Hostinger DNS for bigsixtech.tech, add an **A** record: name `orb`, value `179.236.241.98`.

**7. Start it.**

```bash
docker compose up -d --build
docker exec agent-stack-caddy-1 caddy reload --config /etc/caddy/Caddyfile
```

OpenClaw, n8n and the mailer restart once because of the new labels and memory limit.

**8. Test.**

- Open **https://orb.bigsixtech.tech** in Chrome or Edge, sign in as `ian`, allow the microphone, tap the orb.
- On your phone, open the same address and use **Add to Home Screen** for an app icon.
- Run a backup now instead of waiting for tonight, then confirm the file exists:

```bash
docker compose exec backup backup
ls -lh /root/backups
```

## Full tools and the chat window (one-time approval)

The orb signs in to OpenClaw with the gateway token **and its own device key**, like the OpenClaw app on a
phone. OpenClaw asks you to approve a new device once.

**Updating an existing orb** (from the Orbis repo on your PC: commit and push first):

```bash
cd /docker/agent-stack/kira-orb && git pull && cd ..
cp kira-orb/deploy/docker-compose.override.yml docker-compose.override.yml   # adds the /state folder
mkdir -p data/kira-orb && chown 1000:1000 data/kira-orb                       # the orb's device key lives here
docker compose up -d --build kira-orb
docker compose logs kira-orb | tail -5
```

The log shows `waiting for device approval (request …)`. Approve it:

```bash
docker compose exec openclaw-gateway openclaw devices list
docker compose exec openclaw-gateway openclaw devices approve <request id>
```

(If `openclaw` isn't found inside the container, use `node dist/index.js devices …` instead.) Within about
10 seconds the log says `connected to OpenClaw …`, the gateway line in the orb says **full tools**, and the
yellow "Basic chat only" note in the Chat window disappears. The chat window shows the exact approve
command, with the request id, while it's waiting.

**Good to know**
- The orb asks for operator access with admin scope: the same access the gateway token already gives it on the
  HTTP endpoint. That makes its messages owner turns, like OpenClaw's own chat page, so the agent gets its full
  tool set. If you approved an earlier test version with fewer scopes, OpenClaw asks once more ("asking for more
  scopes than currently approved"); approve that request the same way.
- The key is in `data/kira-orb/device.json`. Keep it (it's in the nightly backup). If it's lost, the orb asks
  for approval again. To remove the orb: `openclaw devices list`, then `openclaw devices remove <device id>`.
- Each agent's orb conversation is an ordinary OpenClaw session, `agent:<id>:orb:<conversation>`, so you can
  also open it in OpenClaw's own chat page. The first message after this update starts a fresh session.
- One conversation per agent is shared by every device you sign in on (PC and phone see the same chat).
  **New chat** starts a fresh one everywhere.
- The orb needs `gateway.http.endpoints.chatCompletions` only as the fallback. Once approved you can turn it
  off, and the orb still lists agents and chats over the WebSocket.
- To go back to the old text-only behaviour, set `TRANSPORT=http` in `kira-orb/.env`.

## Sign-in

The orb has its own sign-in page: one email and password, set in `kira-orb/.env`:

```
ORB_EMAIL=you@example.com
ORB_PASSWORD=a-long-password
```

Then `docker compose up -d kira-orb`. A sign-in lasts 30 days per device (`SESSION_DAYS`), **Settings → Sign out**
ends it, and five wrong attempts lock that address out for 10 minutes. Changing the password signs every device out.
If either line is blank, the sign-in page is off.

## Agent voices (Kyutai Pocket TTS)

Each agent speaks in its own voice, cloned from a short clip, using Kyutai's open-source Pocket TTS running in the
`voice` container on your VPS (about 100M parameters, CPU-only, uses 2 cores). Agents without a clip, or any time the
voice service is down or slow, use the browser voice set for that agent in Settings.

**1. Get access to the model (one time).** The Pocket TTS weights are gated on Hugging Face:
- Sign in at huggingface.co, open [kyutai/pocket-tts](https://huggingface.co/kyutai/pocket-tts) and accept the terms.
- Click your profile picture (top right) → **Settings** → **Access Tokens** → **Create new token**, choose **Read**, copy it.

```bash
cd /docker/agent-stack
cp kira-orb/deploy/voice.env.example voice.env && chmod 600 voice.env
nano voice.env                       # paste the token after HF_TOKEN=
mkdir -p data/voice-cache
```

**2. Voice clips** live in the repo's `voices/` folder, named after the agent id: `main.mp3` (K.I.R.A.), `forge.mp3`,
`ledger.wav` (`.wav`, `.mp3`, `.m4a`, `.flac`, `.ogg`). 5–20 seconds of one person speaking clearly, with no music or
background noise. Only the first 10 seconds are used (`CLIP_SECONDS`), because longer clips make every sentence slower, so put the cleanest speech at the start. Kyutai's terms require the speaker's consent, so use your own
recordings or voices you have the rights to. To add or change one: commit, push, then `git pull` on the VPS. No restart.
Agents without a clip can use a built-in Pocket TTS voice (alba, jane, marius, george…) via `BUILTIN_VOICES` in the stack file.

**3. Start it:** `docker compose up -d --build voice`, then `docker compose logs -f voice` until `[voice] ready`.

**4. Check the speed** (generation should be well under the audio length):

```bash
docker compose exec kira-orb wget -S -O /dev/null -T 120 --post-data='{"voice":"main","input":"Good afternoon. All systems are online and the agents are standing by."}' \
  --header='Content-Type: application/json' http://voice:8000/v1/audio/speech 2>&1 | grep -iE "x-gen|x-audio"
```

**Good to know**
- Settings → Agent voices switches between cloned voices and the per-agent browser voices.
- If a sentence's cloned audio is late, that sentence is spoken with the browser voice instead, so the agent is never silent.

## Using it

- **Attach files** with the 📎 button, by dragging them onto the orb, or by pasting. Each file shows as a chip
  you can remove before sending, and voice messages carry pending attachments too.
  - **Images** (PNG, JPEG, GIF, WebP, HEIC) go to the agent with the message so it can see them: up to 8 per
    message, 20 MB in total. Large photos are scaled to 2048 px first.
  - **Text files** (txt, md, csv, json, code, logs… up to 200 KB) are included in the message.
  - **Everything else** (PDF, Word, Excel, zip…, up to 25 MB) is saved to the agent's own workspace in `inbox/`,
    for example `data/openclaw/workspace-ledger/inbox/statement.pdf`, and the agent is told the path so it can
    open it with its file tools. Existing files are never overwritten; a timestamp is added instead.
  - For this the orb mounts OpenClaw's data folder read-write. Its code only writes inside `workspace*/inbox/`.
- **Sounds:** the startup and shutdown sequences have their own original synthesised digital effects (power-on
  sweep, a blip as each system reports in, a confirmation chord; the reverse on shutdown, ending with a CRT
  switch-off). When startup finishes, the live agent says "Startup complete." Turn the effects off in Settings.
  Browsers only allow sound after you've tapped the page, so if the app opens without that, it shows a
  "tap to power up" standby screen first.
- **Shutdown system:** say or type "Shutdown system" (or "Shut down the system", "System shutdown") to run the full
  shutdown sequence and sign out. "Power down the interface" and Settings → Shut down & sign out do the same.
- **Power down:** type or say "Power down the interface" (also "Kira, power down", "shut down the orb", "power off"),
  or use Settings → Power down interface. The startup sequence plays in reverse and the screen collapses to a
  standby dot; tap or press any key to power back up. The command is handled by the orb and never sent to the
  agent, and only a message that is just the command counts, so "can you power down the display on my server" still
  goes to the agent. While powered down the orb stops polling and drawing.
- **Full names** under each acronym come from the agent's own `SOUL.md` (refreshed every 30 seconds), using a line
  such as `**Name:** FORGE — Federated Operations, Runtime & Graph Engineer`, `## K.I.R.A. - ...` or
  `... stands for ...`. The words must spell the acronym. Agents without one show "AI Core".
- **Startup sequence** plays the first time the app opens in a browser tab or as the phone app (a reload skips it).
  The K.I.B.I. screen loads each system from 0000 to 1000 on a red-to-green bar, then the console's panels power
  up one at a time, the orb draws itself in the middle, and the live agent says "Startup sequence complete,
  Kira online". Tap or press any key to skip; **Settings → Replay startup sequence** plays it again. The gateway,
  agent tools, roster, each agent, voice input and speech rows are real checks.
- **Shutdown** (Settings → Shut down & sign out, or say "Power down the interface") is the startup in reverse:
  "Shutting down all systems", the orb un-draws, the panels switch off last to first, and the K.I.B.I. screen
  drains every system from 1000 to 0000 before the screen collapses.
- **Agent colours:** Settings → Agent colours has a main and an accent colour for each agent. Choices are saved
  on the server (`state/colors.json`) per agent id, so every device matches and renaming an agent keeps them.
  Reset goes back to `AGENT_COLORS`. New agents get a colour automatically until you pick one.
- **Chat Mode:** in the chat window, **Full screen** turns it into a ChatGPT-style page: a centred conversation, the
  agent's live glass orb at the top and as its icon beside each reply, agent switcher pills, and a large message bar
  with attach, mic and send. Esc or **Exit full screen** goes back. On phones the chat always opens this way.
- **Your chat icon:** Settings → Your chat icon sets the picture beside your messages (saved on the server in
  `state/user.json`, so every device shows it). OpenClaw doesn't share a user picture, so choose it here.
- **Agent names** come from `AGENT_LABELS`, otherwise from the name OpenClaw gives the agent, otherwise its id.
- **Left panel:** every agent with its coloured dot when online, grey when offline (on a phone it's a row of chips).
  The orb checks every 15 seconds. An agent shows offline when the gateway can't be reached, when it's no longer
  in OpenClaw's agent list, or when its last request failed (it comes back as soon as it answers again).
  Agents named in `AGENT_LABELS` or `AGENT_COLORS` stay in the list even after they disappear from OpenClaw.
- **Offline orb:** the ribbons, glow and inner bubble fade away, leaving only the grey glass rim and a small dot
  in the agent's own colour breathing in the middle while it waits to reconnect.
  Talking is disabled until the agent is back; tapping the orb checks again immediately.
- **HUD effects** around the orb are decoration: compass ring, radar sweep, orbiting satellites, scan line and
  corner brackets. The four readouts on leader lines are real: orb rotation, ribbon strand count, frame rate and link latency.
- **Right-hand boxes** (wide screens): live voice bars (your mic while listening, the speech while it talks),
  the Scope (a spinning neural core whose impulses speed up while listening and thinking), gateway status and latency, reply timing with a trend line, and this session's exchanges and talk time.
- **Tap the orb** (or the mic, or hold **Space** on a keyboard) to talk. Tap again to interrupt.
- **Hands-free** keeps listening after every reply, like a real conversation.
- **Chat** opens the chat window: the full conversation (it survives a reload and is shared with your phone),
  formatted text, code, links and tables, each tool the agent uses ("Read from SOUL.md", "Browsing…") with a
  live status dot, and any images or files the agent makes (tap an image to open it full size). Type there,
  attach files, or keep talking to the orb; it's one conversation. When the agent makes an image, the chat
  window opens by itself. **New chat** gives the agent a fresh session.
- **Voice** picks the speaking voice and speed. The best free voices are Microsoft's
  "Natural" voices in Edge and Google's voices in Chrome.
- Each agent keeps its own orb conversation, separate from its Slack threads.

## Good to know

- Voice input uses the browser's speech recognition: Chrome, Edge, Safari and iPhone work;
  Firefox can only type. In Chrome and Edge the audio is processed by Google or Microsoft.
- Messages arrive in OpenClaw as owner messages from the "Kira Orb" device, in sessions named
  `agent:<id>:orb:<conversation>`.
- Backups are encrypted with your passphrase and kept 14 days in `/root/backups` on the
  same VPS. Fill in the Backblaze lines in `backup.env` to keep a copy off the server.
- To remove the orb: delete the `kira-orb` service and the `orb` Caddy block, then run
  `docker compose up -d --remove-orphans`. To turn the endpoint off again, set
  `gateway.http.endpoints.chatCompletions.enabled` to `false`.

## Restoring a backup

```bash
gpg -d /root/backups/agent-stack-YYYY-MM-DDTHH-MM.tar.gz.gpg > restore.tar.gz
mkdir restore && tar -xzf restore.tar.gz -C restore
# the stack is in restore/backup/agent-stack/; stop the stack, copy back what you need, start it
```
