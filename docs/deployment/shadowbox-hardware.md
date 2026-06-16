# Shadowbox Hardware Deployment

This is the Phase 5 install/update path for running ShadowscoreServer beside the existing Shadowbox software on Raspberry Pi hardware.

## Assumptions

- Node.js 20 or newer is installed on the hardware unit.
- The repo lives at `/home/pi/ShadowscoreServer`.
- ShadowscoreServer listens on HTTP port `8790`.
- RNBOOSCQuery is reachable at `http://127.0.0.1:5678/`.
- ShadowScoreClient receives OSC at `127.0.0.1:9000` and message path `/rnbo/inst/2/messages/in/shadowscore`.

Adjust the config files if a unit uses different hostnames, ports, or RNBO message paths.

## Fresh Install

```sh
cd /home/pi
git clone https://github.com/YOUR_ORG/ShadowscoreServer.git
cd /home/pi/ShadowscoreServer
npm install
cp config/shadowbox.hardware-host.json config/shadowbox.local.json
```

Edit `config/shadowbox.local.json` on the selected session host:

- Set `http.publicUrl` to the browsable URL, for example `http://pt5.local:8790`.
- Set `server.advertisedName` and `server.hostIdentity` to the unit name.
- Confirm `rnbo.oscQuery.url`, `rnbo.port`, and `rnbo.address`.

For a peer unit, copy `config/shadowbox.hardware-peer.json` instead and set:

- `registration.sessionHostUrl` to the selected host URL.
- `server.advertisedName` and `server.hostIdentity` to this peer unit.

## Systemd Services

Install the host service on the selected session host:

```sh
sudo cp deploy/systemd/shadowscore-server.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now shadowscore-server.service
```

Install the peer registration agent on non-host units after editing `config/shadowbox.hardware-peer.json`:

```sh
sudo cp deploy/systemd/shadowscore-registration-agent.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now shadowscore-registration-agent.service
```

If a peer should also serve its own local diagnostics page, install both services. Only one hardware unit should be treated as the active classroom session host.

## Update

```sh
cd /home/pi/ShadowscoreServer
git pull --ff-only
npm install
sudo systemctl restart shadowscore-server.service
sudo systemctl restart shadowscore-registration-agent.service
```

It is fine if one of the restart commands reports that the service is not installed on that unit.

## Smoke Test

Run this on a host unit:

```sh
npm run smoke:hardware -- --config config/shadowbox.local.json
```

Run this on a peer unit:

```sh
npm run smoke:hardware -- --config config/shadowbox.hardware-peer.json
```

Useful overrides:

```sh
npm run smoke:hardware -- --config config/shadowbox.local.json --base-url http://pt5.local:8790
npm run smoke:hardware -- --config config/shadowbox.local.json --rnbo-oscquery-url http://127.0.0.1:5678
```

The smoke test checks:

- `/healthz`
- `/session`
- `/rnbo/targets`
- local HTTP port reachability
- RNBOOSCQuery reachability when enabled
- peer visibility on the host when running in peer role

## Checklist

Before students connect:

- `systemctl is-active shadowscore-server.service` reports `active` on the host.
- `journalctl -u shadowscore-server.service -n 80 --no-pager` shows the server listening on `8790`.
- `curl http://127.0.0.1:8790/healthz` returns `"ok":true`.
- A laptop can open `http://<host>.local:8790/`.
- `curl http://127.0.0.1:5678/` returns RNBOOSCQuery JSON on each unit.
- `curl http://<host>.local:8790/rnbo/targets` lists the expected ShadowScoreClient targets.
- `curl http://<host>.local:8790/hardware/units` shows peer units as `online`.
- `data/score.json` exists after a score edit and survives service restart.
- A committed voice edit reaches the assigned RNBO target.

## Logs

```sh
journalctl -u shadowscore-server.service -f
journalctl -u shadowscore-registration-agent.service -f
```

Keep Shadowbox software, RNBO Runner, RNBOOSCQuery, and ShadowscoreServer logs separate when diagnosing failures.
