# ioBroker Adapter: lgtv-full

Full-featured **LG WebOS TV** control adapter for ioBroker (OLED G-series and others, webOS 6+).
Replaces homebridge-lgwebos-tv — supports Picture Mode, Sound Mode, HDMI inputs, channels, remote control, Wake-on-LAN and more.

---

## Requirements

- ioBroker with js-controller ≥ 3.0
- Node.js ≥ 14
- LG WebOS TV (2014+) on the same LAN
- Static IP address for the TV (set DHCP reservation in your router)

---

## Installation

### Via ioBroker Admin (recommended)

1. Open **Admin → Adapters → Install from custom URL**
2. Enter: `https://github.com/KPIotr89/iobroker.lgtv-full`
3. Click **Install**

### Auto-update

Add the following URL to **Settings → Repositories** in ioBroker Admin:

```
https://raw.githubusercontent.com/KPIotr89/iobroker.lgtv-full/main/repository.json
```

Enable **Auto-Upgrade** for this repository — ioBroker will automatically update the adapter when a new version is released.

---

## Configuration

After installing, open the adapter instance settings in Admin:

| Field | Description |
|-------|-------------|
| **TV IP Address** | e.g. `192.168.1.105` — assign a static IP in your router |
| **MAC Address** | Used for Wake-on-LAN. Find it in TV: Settings → Connection → Network → Advanced |
| **Reconnect interval** | Seconds between reconnection attempts (default: 10) |

### First connection / Pairing

On the first run, the TV will display a **pairing request** — accept it using the remote.
The client key is saved automatically (`lgtvkey.txt` in the instance data folder) so pairing is only needed once.

---

## Available ioBroker states

### Power / Screen

| State | Type | Description |
|-------|------|-------------|
| `power` | boolean R/W | Turn TV on (WoL) / off |
| `screenOff` | boolean R/W | Turn off screen without powering off TV |
| `screenSaver` | boolean R | Whether screen saver is active |

### Audio

| State | Type | Description |
|-------|------|-------------|
| `audio.volume` | number 0–100 R/W | Volume level |
| `audio.mute` | boolean R/W | Mute |
| `audio.soundMode` | string R/W | Sound mode (Standard, Music, Cinema, Sport, Game, AI Sound…) |
| `audio.soundOutput` | string R/W | Audio output (TV Speaker, HDMI ARC, Optical, Bluetooth…) |

### Picture

| State | Type | Description |
|-------|------|-------------|
| `picture.mode` | string R/W | Picture mode (Vivid, Standard, Cinema, Game, Filmmaker, Expert, Dolby Vision…) |
| `picture.brightness` | number R/W | Brightness |
| `picture.contrast` | number R/W | Contrast |
| `picture.backlight` | number R/W | Backlight / OLED Light level |
| `picture.color` | number R/W | Color saturation |
| `picture.sharpness` | number R/W | Sharpness |

### Input / Source

| State | Type | Description |
|-------|------|-------------|
| `input.current` | string R/W | Active input (HDMI list populated after connection) |
| `input.list` | JSON R | List of available inputs |

### TV Channels

| State | Type | Description |
|-------|------|-------------|
| `channel.number` | string R/W | Channel number — write to switch channel |
| `channel.name` | string R | Current channel name |
| `channel.list` | JSON R | Full channel list |

### Applications

| State | Type | Description |
|-------|------|-------------|
| `app.current` | string R | Current app ID (e.g. `netflix`, `youtube`) |
| `app.launch` | string W | Launch app by its ID |

### Media

| State | Type | Description |
|-------|------|-------------|
| `media.state` | string R | Playback state: `play`, `pause`, `stop` |

### Remote control (remote.*)

Buttons: `LEFT`, `RIGHT`, `UP`, `DOWN`, `OK`, `HOME`, `BACK`, `MENU`, `EXIT`, `INFO`, `GUIDE`,
`RED`, `GREEN`, `YELLOW`, `BLUE`, `VOLUMEUP`, `VOLUMEDOWN`, `MUTE`,
`CHANNELUP`, `CHANNELDOWN`, `PLAY`, `PAUSE`, `STOP`, `FASTFORWARD`, `REWIND`,
`0`–`9`, `NETFLIX`, `AMAZON`, `DISNEY` and more.

Set a button state to `true` to press it.

---

## MQTT / Loxone integration

To forward states to LoxBerry via MQTT, install the **ioBroker.mqtt** adapter as a client pointing to Mosquitto on LoxBerry.
Then use **Blockly** or **JavaScript** to map `lgtv-full.0.*` states to MQTT topics:

```javascript
// Example: send picture mode to Loxone via MQTT
on({ id: 'lgtv-full.0.picture.mode', change: 'any' }, (obj) => {
    setState('mqtt.0.send.lgtv/pictureMode', obj.state.val);
});
```

---

## Common app IDs (app.launch)

| App | ID |
|-----|----|
| Netflix | `netflix` |
| YouTube | `youtube.leanback.v4` |
| Amazon Prime | `amazon` |
| Disney+ | `disneyplus` |
| Spotify | `spotify-beehive` |
| Web Browser | `com.webos.app.browser` |
| Live TV | `com.webos.app.livetv` |

---

## Troubleshooting

**TV does not respond to Wake-on-LAN**
- Verify the MAC address (Settings → Network → Wired/Wi-Fi → Advanced)
- Enable "Turn on via Wi-Fi (WoL)" in TV settings: Menu → General → External Devices → Quick Start + Turn on via network

**No pairing prompt on TV**
- Check that the IP address is correct and the TV is on the same network
- Check adapter logs in ioBroker Admin

**Picture mode does not change**
- Some modes (HDR, Dolby Vision) are only available with a matching source signal — the TV may ignore the command

**screenOff does not work**
- Requires webOS ≥ 4.0 (LG 2019+). G4 OLED supports this feature.

**Picture / sound settings show null after restart**
- The adapter reads all settings on connection. If values are null, check debug logs for `getSystemSettings` errors.
- If you see `401 insufficient permissions`: delete the pairing key file and re-pair the TV.
  Key file location: `/opt/iobroker/iobroker-data/lgtv-full.0/lgtvkey.txt`

---

## License

MIT
