# VoiceAutoReconnect – Vencord plugin

[![CI](https://github.com/VentumPhoenix/voice-auto-reconnect/actions/workflows/ci.yml/badge.svg)](https://github.com/VentumPhoenix/voice-auto-reconnect/actions/workflows/ci.yml)
[![Vencord compatibility](https://github.com/VentumPhoenix/voice-auto-reconnect/actions/workflows/vencord-compat.yml/badge.svg)](https://github.com/VentumPhoenix/voice-auto-reconnect/actions/workflows/vencord-compat.yml)
[![License: GPL-3.0-or-later](https://img.shields.io/badge/license-GPL--3.0--or--later-blue.svg)](LICENSE)

Does your **Discord voice connection turn red** out of nowhere? The connection icon shows **RTC disconnected** or is **stuck on red bars**, you **can't hear anyone in voice**, and **nobody can hear you, but your avatar still lights up** when you talk? Discord still shows you as connected, so it never tries to fix it. **VoiceAutoReconnect** is a [Vencord](https://vencord.dev) userplugin that detects this silently dead voice connection and **automatically reconnects the voice channel** (leave and rejoin the same channel), notifies you, or both.

## The problem

Every now and then a Discord voice connection dies without any sound or warning:

- You stay in the voice channel and are still shown as connected.
- The connection indicator next to **"Voice Connected"** jumps from green (4 bars) to red (about 2 bars).
- Your avatar still lights up when you speak (that is only local voice activity detection) …
- … but nobody hears you, and you hear nobody.
- Leaving the channel and joining it again fixes it immediately.

What is going on: the signalling connection (WebSocket) is still alive, but the UDP media stream (RTC) is dead, and Discord often does not recover from that by itself. There is no reconnect button and no warning.

![Red voice connection indicator](docs/red-connection.png)
<!-- Placeholder: add a screenshot of the red "Voice Connected" indicator as docs/red-connection.png -->

## Features

- **Detects a dead voice connection** using only Discord's own connection state:
  - connection quality stays **bad** (the red bars) for longer than `badDurationSeconds`
  - **no ping updates** arrive for longer than `staleSeconds` although the state is "connected"
  - the connection is **stuck** in Connecting / No Route / ICE Checking / DTLS Connecting for longer than `stuckConnectingSeconds`
- **Reacts** the way you want: notification (with optional sound), automatic leave + rejoin of the same channel, or both.
- **Keeps mute / deafen** (they are global client settings) and your camera state.
- **Never fights you:** no detection during a grace period after joining, when you leave or switch channels yourself, or while its own reconnect is running.
- **Loop protection:** cooldown between reconnects and at most `maxAttempts` per `attemptWindowMinutes`. After that it pauses and tells you to check your connection.
- **Manual reconnect** from the [Vencord Toolbox](https://github.com/Vendicated/Vencord/tree/main/src/plugins/vencordToolbox) ("Reconnect voice now").
- **Self check on start:** if Discord changed its internals, you get one clear message ("incompatible with current Discord version, please update the plugin") instead of a plugin that silently does nothing.
- **No code patches.** The plugin only reads Discord stores and listens to Flux events, which makes it much more robust against Discord updates.
- No telemetry, no network requests, no access to your token or account data.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `mode` | `notifyAndReconnect` | `notify`, `reconnect` or `notifyAndReconnect` |
| `playSound` | on | Short alert sound with notifications (generated locally) |
| `badDurationSeconds` | 5 | Seconds the quality must stay bad before acting |
| `staleSeconds` | 8 | Seconds without ping updates while connected before acting |
| `stuckConnectingSeconds` | 15 | Seconds stuck in a connecting state before acting |
| `graceSeconds` | 10 | Grace period after joining a channel |
| `reconnectDelayMs` | 1000 | Pause between leaving and rejoining |
| `cooldownSeconds` | 30 | Minimum time between automatic reconnects (between notifications in `notify` mode) |
| `maxAttempts` | 3 | Max. automatic reconnects per attempt window |
| `attemptWindowMinutes` | 5 | Length of the attempt window |
| `debugLogging` | off | Log state, ping and quality changes to the DevTools console |

If you get false alarms on a slow or jittery connection, raise `staleSeconds` and `badDurationSeconds` first.

## Installation (userplugin)

Custom plugins require building Vencord from source. Follow the official guides first:
[Installing from source](https://docs.vencord.dev/installing/) and
[Installing custom plugins](https://docs.vencord.dev/installing/custom-plugins/).

Requirements: [git](https://git-scm.com), [Node.js](https://nodejs.org) ≥ 22 and [pnpm](https://pnpm.io/installation).

### Option A: update script (recommended)

The scripts clone or update Vencord, copy the plugin into `src/userplugins/`, build and inject. Run them again whenever you want to update.

```powershell
# Windows (PowerShell)
git clone https://github.com/VentumPhoenix/voice-auto-reconnect.git
cd voice-auto-reconnect
.\scripts\update.ps1                         # Vencord in %USERPROFILE%\Vencord
.\scripts\update.ps1 -VencordDir D:\Vencord  # custom location
.\scripts\update.ps1 -NoInject               # build only
```

```bash
# Linux / macOS
git clone https://github.com/VentumPhoenix/voice-auto-reconnect.git
cd voice-auto-reconnect
./scripts/update.sh                          # Vencord in ~/Vencord (or $VENCORD_DIR)
./scripts/update.sh --vencord-dir ~/src/Vencord --no-inject
```

If PowerShell refuses to run the script, allow it for the current session only:
`Set-ExecutionPolicy -Scope Process Bypass`.

### Option B: manually

1. Copy the folder `src/voiceAutoReconnect` of this repository to `Vencord/src/userplugins/voiceAutoReconnect`.
2. In the Vencord folder run `pnpm build` and then `pnpm inject` (pick your Discord install).
3. Fully restart Discord and enable **VoiceAutoReconnect** in *Settings → Vencord → Plugins*.

## FAQ

**Why is this not in the official Vencord plugin list?**
It is new and needs real-world testing first. It also automates a voice action (leave/rejoin), which is exactly the kind of behaviour that should prove itself before it is proposed upstream. Until then it is a userplugin.

**Does it work with Vesktop?**
The plugin itself uses nothing desktop-specific, so it should work wherever your own Vencord build runs. Vesktop ships its own Vencord build, so you have to point Vesktop to your locally built Vencord (`dist` folder) in Vesktop's settings for custom Vencord location. This setup has not been tested yet; feedback is welcome.

**I get "VoiceAutoReconnect: incompatible with current Discord version, please update the plugin". What now?**
Discord renamed or removed something the plugin relies on. The plugin then stays inactive on purpose. Update the plugin and Vencord (`scripts/update.ps1` / `scripts/update.sh`). Check the [issues labelled `compat`](https://github.com/VentumPhoenix/voice-auto-reconnect/issues?q=label%3Acompat): a daily CI job builds the plugin against the latest Vencord and opens such an issue automatically. If there is none, please open a bug report and include the console line that lists the missing internals.

**Where do I see what the plugin does?**
Open DevTools (Ctrl+Shift+I / Cmd+Option+I), go to *Console* and filter for `VoiceAutoReconnect`. Enable `debugLogging` for detailed output.

## Limitations

- It **fixes the symptom, not the cause.** Your network or the voice server is still the reason the connection dies.
- It depends on Discord internals (`RTCConnectionStore`, Flux event names, the voice channel action module). Discord can change them at any time; the self check and the daily compatibility CI exist for exactly that reason.
- A reconnect briefly drops you from the channel: others hear the leave/join sounds, and a running screen share (Go Live) ends.
- The thresholds are heuristics. Very bad but still working connections can trigger a reconnect; raise the thresholds if that happens.
- The alert sound plays on your system's default output device, not necessarily the output device selected in Discord.

## Fixing the actual cause

If your voice connection dies regularly, it is worth looking for the root cause:

- **Voice region:** for servers you manage, set the voice channel's region (*Edit Channel → Region Override*) to a nearby region instead of "Automatic".
- **QoS:** try toggling *Settings → Voice & Video → "Enable Quality of Service High Packet Priority"*. Some routers handle the tagged packets badly.
- **Wi-Fi / Powerline:** short drops or interference kill UDP streams first. Try a cable.
- **Firewall / router UDP timeouts:** some routers and firewalls drop idle or long-running UDP mappings (NAT timeout). Look for UDP session timeout settings or firmware updates.
- **VPN without UDP support:** many VPNs or proxies only tunnel TCP. Discord voice needs UDP.

## Disclaimer

Client modifications are against Discord's Terms of Service. Using Vencord and this plugin is at your own risk. This project is not affiliated with Discord or Vencord.

## Development

```bash
npm ci
npm run check     # lint + typecheck + unit tests with coverage
```

- `src/voiceAutoReconnect/logic.ts`: pure, Discord-independent state machine (fully unit-tested in `tests/logic.test.ts`)
- `src/voiceAutoReconnect/index.ts`: Vencord plugin glue (Flux events, stores, actions)
- `src/voiceAutoReconnect/settings.ts`: plugin settings
- `scripts/ci/vencord-check.sh <vencord-dir>`: builds, type-checks and lints the plugin inside a Vencord checkout (used by CI, also runnable locally)

The CI never logs into Discord. Automated tests with a real account or token would be a selfbot and violate Discord's Terms of Service.

### Possible extensions

- A reconnect button directly in the voice connection panel. Today that would need a webpack code patch, which this plugin deliberately avoids. It will be added if Vencord offers an API for it.

## License

[GPL-3.0-or-later](LICENSE), same as Vencord.
