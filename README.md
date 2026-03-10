# ioBroker Adapter: lgtv-full

Pełny adapter do sterowania **LG WebOS TV** (OLED G-series i inne) w ioBroker.
Zastępuje homebridge-lgwebos-tv — obsługuje Picture Mode, Sound Mode, wejścia HDMI, kanały, pilota i więcej.

---

## Wymagania

- ioBroker z js-controller ≥ 3.0
- Node.js ≥ 14
- LG WebOS TV (2014+) podłączony do tej samej sieci LAN
- Stały adres IP telewizora (ustaw DHCP reservation w routerze)

---

## Instalacja

### Metoda 1 — przez terminal (zalecana)

```bash
# 1. Przejdź do katalogu adapterów ioBroker
cd /opt/iobroker/node_modules

# 2. Skopiuj folder adaptera (lub sklonuj z repozytorium)
cp -r /ścieżka/do/iobroker.lgtv-full ./iobroker.lgtv-full

# 3. Zainstaluj zależności
cd iobroker.lgtv-full
npm install --production

# 4. Wróć do katalogu ioBroker i zarejestruj adapter
cd /opt/iobroker
iobroker upload lgtv-full

# 5. Dodaj instancję
iobroker add lgtv-full
```

### Metoda 2 — przez ioBroker Admin (GUI)

1. Otwórz **Admin → Adaptery → Instalacja z własnego URL**
2. Wpisz ścieżkę do folderu lub URL GitHub
3. Kliknij „Instaluj"

---

## Konfiguracja

Po zainstalowaniu otwórz instancję adaptera w Admin:

| Pole | Opis |
|------|------|
| **Adres IP telewizora** | np. `192.168.1.105` — ustaw stały IP w routerze |
| **Adres MAC** | Do funkcji Wake-on-LAN (włączanie TV z sieci). Znajdziesz w TV: Ustawienia → Połączenie → Sieć → Zaawansowane |
| **Interwał ponownego łączenia** | Sekundy między próbami reconnect (domyślnie: 10) |

### Pierwsze połączenie

Przy pierwszym uruchomieniu na ekranie TV pojawi się **prośba o parowanie** — zatwierdź ją na pilocie. Klucz jest zapisywany automatycznie (plik `lgtvkey.txt` w danych instancji), więc parowanie jest jednorazowe.

---

## Dostępne obiekty ioBroker

### Zasilanie / Ekran
| Obiekt | Typ | Opis |
|--------|-----|------|
| `power` | boolean R/W | Włącz (WoL) / Wyłącz TV |
| `screenOff` | boolean R/W | Wygasz ekran bez wyłączania TV |
| `screenSaver` | boolean R | Czy wygaszacz ekranu jest aktywny |

### Audio
| Obiekt | Typ | Opis |
|--------|-----|------|
| `audio.volume` | number 0–100 R/W | Głośność |
| `audio.mute` | boolean R/W | Wyciszenie |
| `audio.soundMode` | string R/W | Tryb dźwięku (Standard, Music, Cinema, Sport, Game, AI Sound...) |
| `audio.soundOutput` | string R/W | Wyjście audio (TV Speaker, HDMI ARC, Optical, Bluetooth...) |

### Obraz
| Obiekt | Typ | Opis |
|--------|-----|------|
| `picture.mode` | string R/W | Tryb obrazu (Vivid, Standard, Cinema, Game, Filmmaker, Dolby Vision...) |
| `picture.brightness` | number R/W | Jasność |
| `picture.contrast` | number R/W | Kontrast |
| `picture.backlight` | number R/W | Podświetlenie / OLED Light |
| `picture.color` | number R/W | Nasycenie kolorów |
| `picture.sharpness` | number R/W | Ostrość |

### Wejście / Źródło
| Obiekt | Typ | Opis |
|--------|-----|------|
| `input.current` | string R/W | Aktywne wejście (lista HDMI pojawia się po połączeniu) |
| `input.list` | JSON R | Lista dostępnych wejść |

### Kanały TV
| Obiekt | Typ | Opis |
|--------|-----|------|
| `channel.number` | string R/W | Numer kanału — wpisz numer aby przełączyć |
| `channel.name` | string R | Nazwa bieżącego kanału |
| `channel.list` | JSON R | Lista wszystkich kanałów |

### Aplikacje
| Obiekt | Typ | Opis |
|--------|-----|------|
| `app.current` | string R | ID bieżącej aplikacji (np. `netflix`, `youtube`) |
| `app.launch` | string W | Uruchom aplikację przez jej ID |

### Media
| Obiekt | Typ | Opis |
|--------|-----|------|
| `media.state` | string R | Stan odtwarzania: `play`, `pause`, `stop` |

### Pilot (remote.*)
Przyciski: `LEFT`, `RIGHT`, `UP`, `DOWN`, `OK`, `HOME`, `BACK`, `MENU`, `EXIT`, `INFO`, `GUIDE`, `RED`, `GREEN`, `YELLOW`, `BLUE`, `VOLUMEUP`, `VOLUMEDOWN`, `MUTE`, `CHANNELUP`, `CHANNELDOWN`, `PLAY`, `PAUSE`, `STOP`, `FASTFORWARD`, `REWIND`, `0`–`9`, `NETFLIX`, `AMAZON`, `DISNEY` i inne.

Ustaw przycisk na `true` aby go wcisnąć.

---

## Integracja z MQTT / Loxone

Aby wysyłać stany do LoxBerry przez MQTT, zainstaluj adapter **ioBroker.mqtt** jako klient i skieruj go na brokera Mosquitto na LoxBerry. W ioBroker możesz następnie w **Blockly** lub **JavaScript** mapować stany `lgtv-full.0.*` na tematy MQTT, np.:

```javascript
// Przykład: wysyłaj tryb obrazu do Loxone przez MQTT
on({ id: 'lgtv-full.0.picture.mode', change: 'any' }, (obj) => {
    setState('mqtt.0.send.lgtv/pictureMode', obj.state.val);
});
```

---

## Przykładowe ID aplikacji (app.launch)

| Aplikacja | ID |
|-----------|-----|
| Netflix | `netflix` |
| YouTube | `youtube.leanback.v4` |
| Amazon Prime | `amazon` |
| Disney+ | `disneyplus` |
| Spotify | `spotify-beehive` |
| Przeglądarka | `com.webos.app.browser` |
| TV (antena) | `com.webos.app.livetv` |

---

## Rozwiązywanie problemów

**TV nie odpowiada na WoL**
- Sprawdź MAC adres (Settings → Network → Wired/Wi-Fi → Advanced)
- Włącz „Turn on via Wi-Fi (WoL)" w ustawieniach TV: Menu → Ogólne → Urządzenia zewnętrzne → Szybkie uruchomienie + Włącz via sieć

**Parowanie się nie pojawia**
- Sprawdź czy IP jest poprawne i TV jest w tej samej sieci
- Sprawdź logi adaptera w ioBroker Admin

**Tryb obrazu nie zmienia się**
- Niektóre tryby (HDR, Dolby Vision) są dostępne tylko przy odpowiednim sygnale źródłowym — TV może zignorować komendę

**`screenOff` nie działa**
- Wymaga webOS ≥ 4.0 (LG 2019+). G4 OLED obsługuje tę funkcję.
