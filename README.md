# Kira Orb

A Jarvis-style talking orb for your OpenClaw agents. Talk to it, it answers out loud,
and the dot sphere reacts: each agent has its own colour (Kira pink, Forge blue, Ledger green),
the orb brightens and swirls while the agent works, and it swells with the voice while it speaks.
Tap the orb mid-reply to interrupt.

```
browser ──HTTPS + password──▶ Caddy ──agentnet──▶ kira-orb ──agentnet──▶ openclaw-gateway /v1
                                                (holds the token)
```

The gateway token stays inside the `kira-orb` container. The browser never sees it,
and `/v1` is blocked on the public `claw.bigsixtech.tech` address.

## What's in this folder

| Path | Goes to |
|---|---|
| `server.js`, `package.json`, `Dockerfile`, `public/` | `/docker/agent-stack/kira-orb/` (the app) |
| `.env.example` | copy to `/docker/agent-stack/kira-orb/.env` |
| `deploy/docker-compose.override.yml` | replaces `/docker/agent-stack/docker-compose.override.yml` |
| `deploy/Caddyfile` | replaces `/docker/agent-stack/Caddyfile` |
| `deploy/backup.env.example` | copy to `/docker/agent-stack/backup.env` |
| `voice/` | the Chatterbox Nano voice service (built by the `voice` compose service) |
| `deploy/voice.env.example` | copy to `/docker/agent-stack/voice.env` |

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
docker exec agent-stack-caddy-1 caddy hash-password --plaintext 'choose-a-password'
nano Caddyfile           # replace PASTE_HASH_HERE with the hash
```

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

## Agent voices (Chatterbox Nano)

Each agent can speak in its own voice, cloned from a short clip, using Resemble AI's open-source
Chatterbox Nano model running in the `voice` container on your VPS. Agents without a clip, or any
time the voice service is down, fall back to the browser voice automatically.

**1. Get access to the model.** Sign in at huggingface.co, open
[ResembleAI/chatterbox-nano](https://huggingface.co/ResembleAI/chatterbox-nano) and accept the terms.
Then create a **Read** token under Settings → Access Tokens.

```bash
cd /docker/agent-stack
cp kira-orb/deploy/voice.env.example voice.env && chmod 600 voice.env
nano voice.env                       # paste the token after HF_TOKEN=
mkdir -p data/voices data/voice-cache
```

**2. Add a voice clip for each agent**, named after the agent id: `main.wav` (K.I.R.A.), `forge.wav`,
`ledger.wav`. Each clip must be **longer than 5 seconds**; 10–20 seconds of one person speaking clearly,
with no music or background noise, works best. Use your own recordings or voices you have the rights to,
and don't clone a real person without their permission. From PowerShell on your PC:

```powershell
scp .\main.wav .\forge.wav .\ledger.wav root@179.236.241.98:/docker/agent-stack/data/voices/
```

**3. Start it.** The first build takes several minutes, and the first start downloads the model (about 0.5 GB).

```bash
docker compose up -d --build voice
docker compose logs -f voice         # wait for "[voice] ready in …", then Ctrl+C
```

**4. Connect the orb.** `VOICE_URL=http://voice:8000` is already in `kira-orb/.env.example`; add it to your
`kira-orb/.env` if your copy predates it, then run `docker compose up -d kira-orb`.

**5. Check it.** The startup sequence shows `Voice synthesis … CHATTERBOX · 3 voices`, and Settings lists
which agents have their own voice. To test from the server:

```bash
docker compose exec kira-orb wget -qO- --post-data='{"agent":"main","text":"Systems online."}' \
  --header='Content-Type: application/json' http://localhost:8080/api/tts > /tmp/test.wav && ls -lh /tmp/test.wav
```

**Good to know**
- Add or replace a clip any time; the change is picked up on the next sentence, with no restart needed.
- Speed: Resemble rates Nano at about 3× real time on 8 CPU cores. Your VPS has 2, and the container is
  capped at 1.5 so OpenClaw stays responsive, so expect roughly real time: a pause before the first
  sentence, then the next sentence is prepared while the current one plays. If it's too slow, raise
  `cpus` or switch Settings → Agent voices to the browser voice.
- Every Chatterbox clip carries Resemble's inaudible watermark identifying it as AI-generated.
- To turn it off, set Settings → Agent voices to "Browser voice", or remove `VOICE_URL` and restart the orb.

## Using it

- **Power down:** type or say "Power down the interface" (also "Kira, power down", "shut down the orb", "power off"),
  or use Settings → Power down interface. The startup sequence plays in reverse and the screen collapses to a
  standby dot; tap or press any key to power back up. The command is handled by the orb and never sent to the
  agent, and only a message that is just the command counts, so "can you power down the display on my server" still
  goes to the agent. While powered down the orb stops polling and drawing.
- **Full names** under each acronym come from the agent's own `SOUL.md` (refreshed every 30 seconds), using a line
  such as `## F.O.R.G.E. - Fabrication Operations ...`, `FORGE: ...` or `... stands for ...`. The words must spell
  the acronym. Agents without one show "AI Core". The orb mounts OpenClaw's data folder read-only and only opens
  `workspace*/SOUL.md` files in it.
- **Startup sequence** plays the first time the app opens in a browser tab or as the phone app (a reload skips it).
  Tap or press any key to skip it; **Settings → Replay startup sequence** plays it again. Every status in its log
  is a real check: gateway link and latency, agents found, who's online, and whether voice input is available.
- **Left panel:** every agent with its coloured dot when online, grey when offline (on a phone it's a row of chips).
  The orb checks every 15 seconds. An agent shows offline when the gateway can't be reached, when it's no longer
  in OpenClaw's agent list, or when its last request failed (it comes back as soon as it answers again).
  Agents named in `AGENT_LABELS` or `AGENT_COLORS` stay in the list even after they disappear from OpenClaw.
- **Offline orb:** the sphere goes grey, two thirds of the dots go dark, the core light goes out and it barely
  turns. A faint ring in the agent's own colour pulses every few seconds while it waits to reconnect.
  Talking is disabled until the agent is back; tapping the orb checks again immediately.
- **HUD effects** around the orb are decoration: compass ring, radar sweep, orbiting satellites, scan line and
  corner brackets. The four readouts on leader lines are real: orb rotation, dot count, frame rate and link latency.
- **Right-hand boxes** (wide screens): live voice bars (your mic while listening, the speech while it talks),
  a decorative scope, gateway status and latency, reply timing with a trend line, and this session's exchanges and talk time.
- **Tap the orb** (or the mic, or hold **Space** on a keyboard) to talk. Tap again to interrupt.
- **Hands-free** keeps listening after every reply, like a real conversation.
- **Transcript** shows the full text, including code the orb doesn't read aloud.
  **Start new conversation** gives the agent a fresh session.
- **Voice** picks the speaking voice and speed. The best free voices are Microsoft's
  "Natural" voices in Edge and Google's voices in Chrome.
- Each agent keeps its own orb conversation, separate from its Slack threads.

## Good to know

- Voice input uses the browser's speech recognition: Chrome, Edge, Safari and iPhone work;
  Firefox can only type. In Chrome and Edge the audio is processed by Google or Microsoft.
- Messages arrive in OpenClaw as owner messages on a channel named `orb`.
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
