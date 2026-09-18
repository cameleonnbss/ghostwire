# GhostWire

**A Mullvad-inspired, self-hosted VPN panel. Userspace WireGuard, no root, one runtime.**

Built for anonymity and simplicity: copy-paste a few commands on Linux or Termux,
open the panel, press **Connect**. Runs on **Android (Termux), Linux, Windows and macOS**
with Node.js >= 18 and zero native dependencies.

<p align="center">
  <img src="src/public/favicon.svg" alt="GhostWire icon: yellow padlock on a shield" width="120" />
</p>

> Warning: use GhostWire only for legitimate purposes (privacy, reaching your own
> servers, lawful censorship circumvention). Check the laws that apply to you.

## Highlights

- **Mullvad-style web panel** — dark interface, single yellow accent, one big
  Connect button, green when the tunnel is secured
- **Accounts** — create users (`admin` / `viewer` roles), token sessions, login rate limiting
- **Userspace tunnel** — driven by [wireproxy](https://github.com/pufferffish/wireproxy):
  no root, no TUN device, works inside Termux
- **SOCKS5 + HTTP proxies** — point any app at them and its traffic flows through WireGuard
- **Key manager** — X25519 key pairs, PSK, `.conf` builder, QR code for the mobile WireGuard app
- **Network tools** — Cloudflare speed test, TCP latency, public IP check
- **Windows tray app** (C# / .NET 8) — starts/stops the panel, toggles the system proxy
- **Android app** (Kotlin) — native sign-in screen, then the panel in a WebView
- **Plug-and-play hosting** — copy-paste commands for Termux and Linux below

## Quick start

### Android (Termux) — copy-paste

```bash
pkg update -y && pkg install -y nodejs-lts git
git clone https://github.com/cameleonnbss/ghostwire.git ~/ghostwire
cd ~/ghostwire
npm install --omit=dev --no-audit --no-fund
node bin/ghostwire.js setup
node bin/ghostwire.js useradd admin mypassword
node bin/ghostwire.js start
```

Open `http://127.0.0.1:8080` in the phone browser, sign in, press **Connect**.
Full Android guide (wake-lock, autostart, system-wide VPN):
[docs/termux.md](docs/termux.md)

### Linux — copy-paste

```bash
git clone https://github.com/cameleonnbss/ghostwire.git ~/ghostwire
cd ~/ghostwire
npm install --omit=dev --no-audit --no-fund
node bin/ghostwire.js setup
node bin/ghostwire.js useradd admin mypassword
node bin/ghostwire.js start          # panel on http://<server-ip>:8080
```

One-liner (Linux, macOS, Termux):

```bash
curl -fsSL https://raw.githubusercontent.com/cameleonnbss/ghostwire/main/install.sh | bash
```

As a systemd service:

```bash
sudo tee /etc/systemd/system/ghostwire.service >/dev/null <<'EOF'
[Unit]
Description=GhostWire VPN panel
After=network-online.target
[Service]
WorkingDirectory=/home/YOURUSER/ghostwire
ExecStart=/usr/bin/node bin/ghostwire.js start
Restart=on-failure
[Install]
WantedBy=multi-user.target
EOF
sudo systemctl enable --now ghostwire
```

### Windows

```powershell
git clone https://github.com/cameleonnbss/ghostwire.git
cd ghostwire
npm install --omit=dev
node bin\ghostwire.js setup
node bin\ghostwire.js useradd admin mypassword
node bin\ghostwire.js start
```

Or use the **tray app**: download `ghostwire-windows-tray-*.zip` from Releases,
put `GhostWireTray.exe` next to a `server/` folder (a bundle's content), and run it.
It starts the panel, lives in the tray, and can switch the Windows system proxy
to the tunnel with one click.

### Android app

Install `GhostWire.apk` from Releases, enter your panel address
(`http://<panel-ip>:8080`), your username/password, tap **Connect**.

### Docker

```bash
docker run -d --name ghostwire -p 8080:8080 -v ghostwire-data:/data ghcr.io/cameleonnbss/ghostwire:latest
```

## Using the VPN

1. **Import a config** — paste your WireGuard `.conf` (from your provider or your
   own server) in the *Import* tab, save, then press **Connect**.
2. **Route apps through it** — set the app's proxy to `socks5://127.0.0.1:1080`
   or `http://127.0.0.1:8888`. For system-wide routing on Android use the official
   WireGuard app with the QR code, or a SOCKS-to-VPN app
   (for example [SocksDroid](https://github.com/bndeff/socksdroid), which uses
   Android's `VpnService`) pointed at the panel's SOCKS5 port.
3. **Verify** — hit *Speed test*: the public IP shown should be your VPN server's.

### Connect other devices

- **From a PC or another phone**: open `http://<panel-ip>:8080` on the same Wi-Fi
  (the panel binds `0.0.0.0` by default) and sign in.
- **System-wide VPN on Android**: scan the panel's QR code with the official
  WireGuard app, or run a SOCKS5-to-VPN app pointing at `127.0.0.1:1080` while
  GhostWire runs in Termux.
- **Full guide including autostart and wake-lock**: [docs/termux.md](docs/termux.md)

## Accounts & security

```bash
node bin/ghostwire.js useradd alice mypass123           # first user = admin
node bin/ghostwire.js useradd bob viewpass viewer       # role: viewer
node bin/ghostwire.js passwd alice newpass123           # password change
```

- No account exists -> the panel is **open-mode** (handy on localhost/LAN).
- Once one account exists, every route requires a session (bearer token or cookie).
- Roles: `admin` = everything, `viewer` = read-only status/tools.
- 10 failed logins = 10-minute lockout. Passwords are scrypt-hashed.
- Private keys are masked (`***`) in every API response.

## CLI reference

```
ghostwire start              panel + tunnel
ghostwire setup              download wireproxy for this platform
ghostwire useradd <u> <p>    create an account (first = admin)
ghostwire passwd <u> <p>     change a password
ghostwire genkey             WireGuard key pair
ghostwire import <file>      import a .conf
ghostwire qr                 export config QR code (SVG)
ghostwire status             tunnel state (JSON)
ghostwire doctor             environment diagnostics
```

Start options: `--port 8080` `--host 0.0.0.0` `--data ./data` `--demo`

## Architecture

```
Browser / Android app / Windows tray
        | HTTP + bearer token
        v
src/server.js -- REST API + static UI
src/auth.js   -- accounts, sessions, lockout
src/engine.js -- keys, .conf parsing, wireproxy lifecycle
        | spawn
        v
wireproxy (userspace WireGuard) --UDP--> VPN server
        |
   SOCKS5 :1080 / HTTP :8888 local proxies
```

## Development

```bash
npm install
npm test          # 46 tests (node:test)
npm run check     # syntax check
npm run dev       # start with reload
```

Native apps:

```bash
# Windows tray app (needs .NET 8 SDK)
dotnet build desktop-windows/GhostWireTray

# Android APK (needs Android SDK + JDK 17; downloads kotlinc itself)
scripts/build-android.ps1      # Windows
bash scripts/build-android.sh  # Linux/macOS
```

## Releases

Tagging `v*` triggers GitHub Actions:

- CI: tests on Ubuntu / Windows / macOS (Node 20/22/24) + APK build
- Release: per-platform bundles (linux amd64/arm64/arm, macOS, Termux, Windows)
  with the `wireproxy` binary embedded, the self-contained **Windows tray app**,
  the signed **Android APK**, SHA-256 checksums, and a GitHub Release
- Docker multi-arch image to `ghcr.io`

## License

MIT — see [LICENSE](LICENSE). The [wireproxy](https://github.com/pufferffish/wireproxy)
binary (ISC) is downloaded at setup time, never committed.
