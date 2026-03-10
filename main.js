'use strict';

/**
 * ioBroker adapter: lgtv-full
 * Pełna obsługa LG WebOS TV (OLED G-series i inne)
 * Obsługuje: Picture Mode, Sound Mode, Inputs, Channels, Remote, Screen Off, WoL
 *
 * Zależności: lgtv2, wake_on_lan, @iobroker/adapter-core
 */

// LG webOS 6+ (2021, w tym G4) używa WSS z certyfikatem self-signed
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const utils      = require('@iobroker/adapter-core');
const lgtv2      = require('lgtv2');
const wol        = require('wake_on_lan');
const path       = require('path');

// ─── Słowniki dostępnych trybów ──────────────────────────────────────────────

const PICTURE_MODES = {
    'vivid':                 'Vivid',
    'standard':              'Standard',
    'eco':                   'Eco / APS',
    'cinema':                'Cinema',
    'sport':                 'Sport',
    'game':                  'Game',
    'filmMaker':             'Filmmaker Mode',
    'hdrStandard':           'HDR Standard',
    'hdrCinema':             'HDR Cinema',
    'hdrFilmMaker':          'HDR Filmmaker',
    'hdrGame':               'HDR Game',
    'hdrSport':              'HDR Sport',
    'dolbyHdrVivid':         'Dolby Vision Vivid',
    'dolbyHdrStandard':      'Dolby Vision Standard',
    'dolbyHdrCinema':        'Dolby Vision Cinema',
    'dolbyHdrCinemaBright':  'Dolby Vision Cinema Bright',
    'dolbyHdrFilmMaker':     'Dolby Vision Filmmaker',
    'dolbyHdrGame':          'Dolby Vision Game',
};

const SOUND_MODES = {
    'standard':   'Standard',
    'music':      'Music',
    'cinema':     'Cinema',
    'sport':      'Sport / Stadium',
    'game':       'Game',
    'aiSound':    'AI Sound',
    'aiSoundPro': 'AI Sound Pro',
};

const SOUND_OUTPUTS = {
    'tv_speaker':              'TV Speaker',
    'external_arc':            'HDMI ARC / eARC',
    'external_optical':        'Optical Out',
    'bt_soundbar':             'Bluetooth Soundbar',
    'headphone':               'Headphone',
    'lineout':                 'Line Out',
    'tv_external_speaker':     'TV + External Speaker',
    'tv_speaker_headphone':    'TV Speaker + Headphone',
};

const REMOTE_BUTTONS = [
    'LEFT', 'RIGHT', 'UP', 'DOWN', 'OK',
    'HOME', 'BACK', 'MENU', 'EXIT', 'INFO', 'GUIDE', 'MYAPPS',
    'RED', 'GREEN', 'YELLOW', 'BLUE',
    'VOLUMEUP', 'VOLUMEDOWN', 'MUTE',
    'CHANNELUP', 'CHANNELDOWN',
    'PLAY', 'PAUSE', 'STOP', 'FASTFORWARD', 'REWIND',
    '0', '1', '2', '3', '4', '5', '6', '7', '8', '9',
    'DASH', 'ENTER', 'CC', 'QMENU', 'ASPECT_RATIO', 'RECENT', 'SEARCH',
    'NETFLIX', 'AMAZON', 'DISNEY',
];

// ─── Główna klasa adaptera ───────────────────────────────────────────────────

class LgtvFullAdapter extends utils.Adapter {

    constructor(options) {
        super({ ...options, name: 'lgtv-full' });

        this.tv           = null;   // instancja lgtv2
        this.inputSocket  = null;   // socket pilota
        this.connected    = false;
        this.reconnTimer  = null;
        this.inputs       = {};     // mapa appId → label
        this.channels     = [];     // lista kanałów

        this.on('ready',       this.onReady.bind(this));
        this.on('stateChange', this.onStateChange.bind(this));
        this.on('unload',      this.onUnload.bind(this));
    }

    // ── Inicjalizacja ────────────────────────────────────────────────────────

    async onReady() {
        this.log.info('Adapter uruchomiony');
        await this.setStateAsync('info.connection', false, true);
        await this.createAllObjects();
        this.connect();
    }

    // ── Tworzenie obiektów w ioBroker ────────────────────────────────────────

    async createAllObjects() {
        const ch  = (id, name) => this.setObjectNotExistsAsync(id, { type: 'channel', common: { name }, native: {} });
        const st  = (id, name, type, role, write, extra = {}) =>
            this.setObjectNotExistsAsync(id, {
                type: 'state',
                common: { name, type, role, read: true, write, ...extra },
                native: {},
            });
        const btn = (id, name) =>
            this.setObjectNotExistsAsync(id, {
                type: 'state',
                common: { name, type: 'boolean', role: 'button', read: false, write: true },
                native: {},
            });

        // ── Info ──
        await ch('info', 'Information');
        await this.setObjectNotExistsAsync('info.connection', {
            type: 'state',
            common: { name: 'Połączony', type: 'boolean', role: 'indicator.connected', read: true, write: false, def: false },
            native: {},
        });

        // ── Zasilanie / ekran ──
        await st('power',      'Zasilanie (WoL)',        'boolean', 'switch.power',   true);
        await st('screenOff',  'Ekran wygaszony',        'boolean', 'switch',         true);
        await st('screenSaver','Wygaszacz ekranu aktywny','boolean','indicator',      false);

        // ── Audio ──
        await ch('audio', 'Audio');
        await st('audio.volume', 'Głośność',     'number', 'level.volume', true, { min: 0, max: 100, unit: '%' });
        await st('audio.mute',   'Wyciszenie',   'boolean','media.mute',   true);
        await this.setObjectNotExistsAsync('audio.soundMode', {
            type: 'state',
            common: { name: 'Tryb dźwięku', type: 'string', role: 'text', read: true, write: true, states: SOUND_MODES },
            native: {},
        });
        await this.setObjectNotExistsAsync('audio.soundOutput', {
            type: 'state',
            common: { name: 'Wyjście audio', type: 'string', role: 'text', read: true, write: true, states: SOUND_OUTPUTS },
            native: {},
        });

        // ── Obraz ──
        await ch('picture', 'Obraz');
        await this.setObjectNotExistsAsync('picture.mode', {
            type: 'state',
            common: { name: 'Tryb obrazu', type: 'string', role: 'text', read: true, write: true, states: PICTURE_MODES },
            native: {},
        });
        await st('picture.brightness', 'Jasność',           'number', 'level', true, { min: 0, max: 100 });
        await st('picture.contrast',   'Kontrast',          'number', 'level', true, { min: 0, max: 100 });
        await st('picture.backlight',  'Podświetlenie / OLED Light', 'number', 'level', true, { min: 0, max: 100 });
        await st('picture.color',      'Nasycenie kolorów', 'number', 'level', true, { min: 0, max: 100 });
        await st('picture.sharpness',  'Ostrość',           'number', 'level', true, { min: 0, max: 50  });

        // ── Wejście / źródło ──
        await ch('input', 'Wejście');
        await st('input.current', 'Aktualne wejście', 'string', 'text', true);
        await st('input.list',    'Lista wejść (JSON)', 'string', 'json', false);

        // ── Kanały TV ──
        await ch('channel', 'Kanał TV');
        await st('channel.number', 'Numer kanału',   'string', 'text', true);
        await st('channel.name',   'Nazwa kanału',   'string', 'text', false);
        await st('channel.list',   'Lista kanałów (JSON)', 'string', 'json', false);

        // ── Aplikacje ──
        await ch('app', 'Aplikacje');
        await st('app.current', 'Bieżąca aplikacja (ID)', 'string', 'text', false);
        await st('app.launch',  'Uruchom aplikację (ID)', 'string', 'text', true);

        // ── Media ──
        await ch('media', 'Media');
        await st('media.state', 'Stan odtwarzania', 'string', 'media.state', false);

        // ── Pilot ──
        await ch('remote', 'Pilot zdalnego sterowania');
        for (const btnName of REMOTE_BUTTONS) {
            await btn(`remote.${btnName}`, `Przycisk ${btnName}`);
        }

        this.subscribeStates('*');
        this.log.info('Wszystkie obiekty utworzone');
    }

    // ── Połączenie z TV ───────────────────────────────────────────────────────

    connect() {
        if (this.reconnTimer) {
            clearTimeout(this.reconnTimer);
            this.reconnTimer = null;
        }

        const keyFile = path.join(utils.getAbsoluteInstanceDataDir(this), 'lgtvkey.txt');

        // webOS 6+ (2021+, w tym G4/G3/C-series) → WSS port 3001
        // Starsze webOS → WS port 3000
        const useSSL = this.config.useSSL !== false; // domyślnie true
        const port   = useSSL ? 3001 : 3000;
        const proto  = useSSL ? 'wss' : 'ws';
        this.log.info(`Łączenie z TV: ${proto}://${this.config.host}:${port}`);

        this.tv = lgtv2({
            url:       `${proto}://${this.config.host}:${port}`,
            timeout:   5000,
            reconnect: 0,       // zarządzamy reconnect ręcznie
            keyFile:   keyFile,
        });

        this.tv.on('connect', () => {
            this.log.info('Połączono z LG TV!');
            this.connected = true;
            this.setStateAsync('info.connection', true, true);
            this.setStateAsync('power', true, true);
            this.openInputSocket();
            this.subscribeEvents();
            this.requestPictureSettings();
            this.requestSoundSettings();
            this.requestInputList();
            this.requestChannelList();
        });

        this.tv.on('close', () => {
            this.log.info('Rozłączono od LG TV');
            this.connected  = false;
            this.inputSocket = null;
            this.setStateAsync('info.connection', false, true);
            this.setStateAsync('power', false, true);
            const sec = parseInt(this.config.reconnectInterval) || 10;
            this.reconnTimer = setTimeout(() => this.connect(), sec * 1000);
        });

        this.tv.on('error', (err) => {
            this.log.error(`Błąd połączenia: ${err && err.message ? err.message : err}`);
        });

        this.tv.on('prompt', () => {
            this.log.warn('TV prosi o potwierdzenie parowania — zatwierdź na ekranie telewizora!');
        });
    }

    // ── Socket pilota (przyciski) ────────────────────────────────────────────

    openInputSocket() {
        this.tv.getSocket(
            'ssap://com.webos.service.networkinput/getPointerInputService',
            (err, sock) => {
                if (err) {
                    this.log.warn(`Nie można otworzyć socketu pilota: ${err}`);
                    return;
                }
                this.inputSocket = sock;
                this.log.debug('Socket pilota otwarty');
            }
        );
    }

    // ── Subskrypcje zdarzeń TV → ioBroker ───────────────────────────────────

    subscribeEvents() {

        // Głośność i wyciszenie
        this.tv.subscribe('ssap://audio/getVolume', (err, res) => {
            if (err || !res) return;
            if (res.volume !== undefined) this.setStateAsync('audio.volume', res.volume, true);
            if (res.muted  !== undefined) this.setStateAsync('audio.mute',   res.muted,  true);
        });

        // Aktywna aplikacja (foreground)
        this.tv.subscribe('ssap://com.webos.applicationManager/getForegroundAppInfo', (err, res) => {
            if (err || !res || !res.appId) return;
            this.setStateAsync('app.current', res.appId, true);
        });

        // Bieżący kanał
        this.tv.subscribe('ssap://tv/getCurrentChannel', (err, res) => {
            if (err || !res || res.errorCode) return;
            if (res.channelNumber !== undefined) this.setStateAsync('channel.number', res.channelNumber, true);
            if (res.channelName   !== undefined) this.setStateAsync('channel.name',   res.channelName,   true);
        });

        // Stan odtwarzania mediów
        this.tv.subscribe('ssap://com.webos.media/getForegroundAppMediaStatus', (err, res) => {
            if (err || !res) return;
            if (res.playState !== undefined) this.setStateAsync('media.state', res.playState, true);
        });

        // Wyjście audio
        this.tv.subscribe('ssap://audio/getSoundOutput', (err, res) => {
            if (err || !res) return;
            if (res.soundOutput) this.setStateAsync('audio.soundOutput', res.soundOutput, true);
        });

        // Wygaszacz ekranu
        this.tv.subscribe('ssap://com.webos.service.screenSaver/getStatus', (err, res) => {
            if (err || !res) return;
            const active = res.actived === true || res.screenSaverRunning === true;
            this.setStateAsync('screenSaver', active, true);
        });

        // Tryb obrazu — subskrypcja przez getSystemSettings
        this.tv.subscribe('ssap://settings/getSystemSettings',
            { category: 'picture', keys: ['pictureMode'] },
            (err, res) => {
                if (err || !res || !res.settings) return;
                if (res.settings.pictureMode) {
                    this.setStateAsync('picture.mode', res.settings.pictureMode, true);
                }
            }
        );

        // Tryb dźwięku — subskrypcja
        this.tv.subscribe('ssap://settings/getSystemSettings',
            { category: 'sound', keys: ['soundMode'] },
            (err, res) => {
                if (err || !res || !res.settings) return;
                if (res.settings.soundMode) {
                    this.setStateAsync('audio.soundMode', res.settings.soundMode, true);
                }
            }
        );
    }

    // ── Jednorazowe zapytania przy połączeniu ────────────────────────────────

    requestPictureSettings() {
        this.tv.request('ssap://settings/getSystemSettings', {
            category: 'picture',
            keys: ['pictureMode', 'brightness', 'contrast', 'backlight', 'color', 'sharpness'],
        }, (err, res) => {
            if (err || !res || !res.settings) return;
            const s = res.settings;
            if (s.pictureMode !== undefined) this.setStateAsync('picture.mode',       s.pictureMode,         true);
            if (s.brightness  !== undefined) this.setStateAsync('picture.brightness', parseInt(s.brightness), true);
            if (s.contrast    !== undefined) this.setStateAsync('picture.contrast',   parseInt(s.contrast),   true);
            if (s.backlight   !== undefined) this.setStateAsync('picture.backlight',  parseInt(s.backlight),  true);
            if (s.color       !== undefined) this.setStateAsync('picture.color',      parseInt(s.color),      true);
            if (s.sharpness   !== undefined) this.setStateAsync('picture.sharpness',  parseInt(s.sharpness),  true);
        });
    }

    requestSoundSettings() {
        this.tv.request('ssap://settings/getSystemSettings', {
            category: 'sound',
            keys: ['soundMode'],
        }, (err, res) => {
            if (err || !res || !res.settings) return;
            if (res.settings.soundMode) this.setStateAsync('audio.soundMode', res.settings.soundMode, true);
        });
    }

    requestInputList() {
        this.tv.request('ssap://tv/getExternalInputList', (err, res) => {
            if (err || !res || !res.devices) return;
            const states = {};
            this.inputs  = {};
            res.devices.forEach(d => {
                const label = d.label || d.id || d.appId;
                states[d.appId] = label;
                this.inputs[d.appId] = d;
            });
            this.extendObject('input.current', { common: { states } });
            this.setStateAsync('input.list', JSON.stringify(states), true);
            this.log.info(`Wejścia: ${Object.values(states).join(', ')}`);
        });
    }

    requestChannelList() {
        this.tv.request('ssap://tv/getChannelList', (err, res) => {
            if (err || !res || !res.channelList) return;
            this.channels = res.channelList;
            const map = {};
            this.channels.forEach(c => { map[c.channelNumber] = c.channelName; });
            this.setStateAsync('channel.list', JSON.stringify(map), true);
            this.log.info(`Kanałów znaleziono: ${this.channels.length}`);
        });
    }

    // ── Obsługa komend z ioBroker → TV ───────────────────────────────────────

    async onStateChange(id, state) {
        if (!state || state.ack) return;

        // Klucz bez prefiksu namespace (np. "lgtv-full.0.")
        const key = id.split('.').slice(2).join('.');
        const val = state.val;
        this.log.debug(`Komenda: ${key} = ${val}`);

        // Włączanie przez WoL można wysłać bez połączenia
        if (key === 'power') {
            if (!val) {
                if (this.connected) this.tv.request('ssap://system/turnOff');
            } else {
                const mac = this.config.macAddress;
                if (mac) {
                    wol.wake(mac, { num_packets: 5 }, (err) => {
                        if (err) this.log.error(`WoL error: ${err}`);
                        else     this.log.info('Pakiet WoL wysłany');
                    });
                } else {
                    this.log.warn('Brak adresu MAC — nie można wysłać WoL. Ustaw MAC w konfiguracji adaptera.');
                }
            }
            return;
        }

        if (!this.connected) {
            this.log.warn(`TV nie jest połączony, komenda ${key} zignorowana`);
            return;
        }

        switch (key) {

            // ── Ekran ──
            case 'screenOff':
                this.tv.request(val
                    ? 'ssap://com.webos.service.tv.display/setScreenOff'
                    : 'ssap://com.webos.service.tv.display/setScreenOn'
                );
                break;

            // ── Audio ──
            case 'audio.volume':
                this.tv.request('ssap://audio/setVolume', { volume: Math.max(0, Math.min(100, Math.round(val))) });
                break;

            case 'audio.mute':
                this.tv.request('ssap://audio/setMute', { mute: !!val });
                break;

            case 'audio.soundMode':
                this.tv.request('ssap://settings/setSystemSettings', {
                    settings: { soundMode: val },
                    category: 'sound',
                });
                break;

            case 'audio.soundOutput':
                this.tv.request('ssap://audio/changeSoundOutput', { output: val });
                break;

            // ── Obraz ──
            case 'picture.mode':
                this.tv.request('ssap://settings/setSystemSettings', {
                    settings: { pictureMode: val },
                    category: 'picture',
                });
                break;

            case 'picture.brightness':
            case 'picture.contrast':
            case 'picture.backlight':
            case 'picture.color':
            case 'picture.sharpness': {
                const settingKey = key.split('.')[1]; // np. "brightness"
                this.tv.request('ssap://settings/setSystemSettings', {
                    settings: { [settingKey]: String(Math.round(val)) },
                    category: 'picture',
                });
                break;
            }

            // ── Wejście ──
            case 'input.current':
                this.tv.request('ssap://tv/switchInput', { inputId: val });
                break;

            // ── Kanał ──
            case 'channel.number': {
                const ch = this.channels.find(c => c.channelNumber === String(val));
                if (ch) {
                    this.tv.request('ssap://tv/openChannel', { channelId: ch.channelId });
                } else {
                    this.log.warn(`Kanał ${val} nie znaleziony na liście`);
                }
                break;
            }

            // ── Aplikacja ──
            case 'app.launch':
                this.tv.request('ssap://system.launcher/launch', { id: val });
                break;

            // ── Pilot ──
            default:
                if (key.startsWith('remote.')) {
                    const button = key.replace('remote.', '');
                    this.sendButton(button);
                }
        }
    }

    // ── Wysyłanie przycisku pilota ────────────────────────────────────────────

    sendButton(button) {
        if (this.inputSocket) {
            this.inputSocket.send('button', { name: button });
        } else {
            this.log.warn(`Socket pilota nie jest gotowy (${button}), próba ponownego otwarcia...`);
            this.openInputSocket();
        }
    }

    // ── Zamknięcie adaptera ───────────────────────────────────────────────────

    onUnload(callback) {
        try {
            if (this.reconnTimer) clearTimeout(this.reconnTimer);
            if (this.tv)          this.tv.disconnect();
        } catch (e) {
            this.log.error(`Błąd podczas zamykania: ${e}`);
        }
        callback();
    }
}

// ── Start ────────────────────────────────────────────────────────────────────

if (require.main !== module) {
    module.exports = (options) => new LgtvFullAdapter(options);
} else {
    new LgtvFullAdapter();
}
