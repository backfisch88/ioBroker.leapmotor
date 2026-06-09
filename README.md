# ioBroker.leapmotor

[![Version](https://img.shields.io/badge/version-0.2.0-blue.svg)](https://github.com/YOUR_GITHUB/ioBroker.leapmotor)

Leapmotor electric vehicle integration for ioBroker. Tested on T03.

## Features

- Vehicle status (SOC, range, temperature, tire pressure, GPS, doors, windows)
- Remote control: climate (heat/cool/vent), lock/unlock, windows, trunk, find
- Consumption statistics with weekly history
- Dynamic vehicle dashboard (composite HTML with live status + controls)
- Automatic token refresh
- Picture cache (downloaded once, stored locally)

## Tested vehicles

- Leapmotor T03 ✅

## Installation

```bash
cd /opt/iobroker/node_modules
unzip ioBroker.leapmotor.zip
mv iobroker-leapmotor iobroker.leapmotor
chown -R iobroker:iobroker /opt/iobroker/node_modules/iobroker.leapmotor
su iobroker -c "cd /opt/iobroker/node_modules/iobroker.leapmotor && npm install --production"
cd /opt/iobroker && iobroker add leapmotor --allow-root
```

## Configuration

| Setting | Description |
|---------|-------------|
| Email | Leapmotor app email |
| Password | Leapmotor app password |
| Vehicle PIN | 4-digit PIN (for lock/unlock) |
| Polling interval | Status update interval in minutes (default: 5) |

## Datapoints

```
leapmotor.0.<VIN>.status.*           → Vehicle status (read-only)
leapmotor.0.<VIN>.consumption.*      → Consumption & statistics (read-only)
leapmotor.0.<VIN>.pictures.*         → Vehicle images (read-only)
leapmotor.0.<VIN>.pictures.composite_html → Full dashboard HTML widget
leapmotor.0.<VIN>.cmd.*              → Commands (writable)
```

### VIS Dashboard Widget

Add a **basic - string (unescaped)** widget in VIS:
- Object ID: `leapmotor.0.<VIN>.pictures.composite_html`

## Disclaimer

Unofficial adapter based on reverse engineering. Use at your own risk.

## License

MIT © Henrik Schönhofen
