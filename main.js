'use strict';

/**
 * ioBroker adapter: lgtv-full
 * Pełna obsługa LG WebOS TV (OLED G-series i inne, webOS 6+)
 * Własna implementacja WebSocket — bez zależności od lgtv2
 *
 * Zależności: ws, wake_on_lan, @iobroker/adapter-core
 */

const utils = require('@iobroker/adapter-core');
const wol   = require('wake_on_lan');
const path  = require('path');
const fs    = require('fs');
const WebSocket = require('ws');

// ─── LG WebOS manifest (wymagany do rejestracji) ────────────────────────────

const LG_MANIFEST = {
    manifestVersion: 1,
    appVersion: '1.1',
    signed: {
        created: '20140509',
        appId: 'com.lge.test',
        vendorId: 'com.lge',
        localizedAppNames: { '': 'LG Remote App', 'ko-KR': '리모컨 앱' },
        localizedVendorNames: { '': 'LG Electronics' },
        permissions: [
            'TEST_SECURE', 'CONTROL_INPUT_TEXT', 'CONTROL_MOUSE_AND_KEYBOARD',
            'READ_INSTALLED_APPS', 'READ_LGE_SDX', 'READ_NOTIFICATIONS', 'SEARCH',
            'READ_SETTINGS', 'WRITE_SETTINGS', 'WRITE_NOTIFICATION_ALERT', 'CONTROL_POWER',
            'READ_CURRENT_CHANNEL', 'READ_RUNNING_APPS', 'READ_UPDATE_INFO',
            'UPDATE_FROM_REMOTE_APP', 'READ_LGE_TV_INPUT_EVENTS', 'READ_TV_CURRENT_TIME',
        ],
        serial: '2f930e2d2cfe083771f68e4fe7bb07',
    },
    permissions: [
        'LAUNCH', 'LAUNCH_WEBAPP', 'APP_TO_APP', 'CLOSE', 'TEST_OPEN', 'TEST_PROTECTED',
        'CONTROL_AUDIO', 'CONTROL_DISPLAY', 'CONTROL_INPUT_JOYSTICK',
        'CONTROL_INPUT_MEDIA_RECORDING', 'CONTROL_INPUT_MEDIA_PLAYBACK',
        'CONTROL_INPUT_TV', 'CONTROL_POWER', 'READ_APP_STATUS',
        'READ_CURRENT_CHANNEL', 'READ_INPUT_DEVICE_LIST', 'READ_NETWORK_STATE',
        'READ_RUNNING_APPS', 'READ_TV_CHANNEL_LIST', 'WRITE_NOTIFICATION_TOAST',
        'READ_POWER_STATE', 'READ_COUNTRY_INFO', 'READ_SETTINGS',
    ],
    signatures: [{ signatureVersion: 1, signature: 'eyJhbGdvcml0aG0iOiJSU0EtU0hBMjU2In0=' }],
};

// ─── Klasa połączenia z LG WebOS TV ─────────────────────────────────────────

class LgTvSocket {
    constructor(config) {
        this.url      = config.url;
        this.keyFile  = config.keyFile;
        this.timeout  = config.timeout || 5000;
        this.ws       = null;
        this.msgId    = 0;
        this.pending  = {};   // id → callback (jednorazowe)
        this.subs     = {};   // id → callback (subskrypcje)
        this.clientKey = null;

        this._onConnect = () => {};
        this._onClose   = () => {};
        this._onError   = () => {};
        this._onPrompt  = () => {};
    }

    on(event, fn) {
        if (event === 'connect') this._onConnect = fn;
        if (event === 'close')   this._onClose   = fn;
        if (event === 'error')   this._onError   = fn;
        if (event === 'prompt')  this._onPrompt  = fn;
        return this;
    }

    connect() {
        // Wczytaj zapisany klucz parowania
        try {
            if (fs.existsSync(this.keyFile)) {
                this.clientKey = fs.readFileSync(this.keyFile, 'utf8').trim();
            }
        } catch (e) { /* brak pliku — pierwsze parowanie */ }

        this.ws = new WebSocket(this.url, { rejectUnauthorized: false });

        const timer = setTimeout(() => {
            if (this.ws) this.ws.terminate();
        }, this.timeout);

        this.ws.on('open', () => {
            clearTimeout(timer);
            // Wyślij żądanie rejestracji
            const payload = {
                forcePairing: false,
                pairingType: 'PROMPT',
                manifest: LG_MANIFEST,
            };
            if (this.clientKey) payload['client-key'] = this.clientKey;
            this._send({ type: 'register', id: 'register0', payload });
        });

        this.ws.on('message', (raw) => {
            let msg;
            try { msg = JSON.parse(raw); } catch (e) { return; }

            // Log wszystkich wiadomości z TV (debug)
            if (this._logger) this._logger(`TV→ [${msg.type}][${msg.id || '-'}] ${JSON.stringify(msg.payload || msg.error || '').substring(0, 200)}`);

            if (msg.type === 'registered') {
                if (msg.payload && msg.payload['client-key']) {
                    this.clientKey = msg.payload['client-key'];
                    try { fs.writeFileSync(this.keyFile, this.clientKey, 'utf8'); } catch (e) {}
                }
                this._onConnect();

            } else if (msg.type === 'error') {
                if (msg.id === 'register0') {
                    this._onPrompt();
                } else {
                    // Obsłuż błędy dla oczekujących callbacków
                    const cb = this.pending[msg.id];
                    if (cb) {
                        delete this.pending[msg.id];
                        cb(new Error(msg.error || JSON.stringify(msg)), null);
                    }
                }

            } else if (msg.type === 'response' || msg.type === 'subscription') {
                const cb = this.pending[msg.id] || this.subs[msg.id];
                if (cb) {
                    if (msg.type === 'response') delete this.pending[msg.id];
                    const err = (msg.payload && msg.payload.returnValue === false)
                        ? new Error(msg.payload.errorText || 'TV error') : null;
                    cb(err, msg.payload || {});
                }
            }
        });

        this.ws.on('close',  ()  => { clearTimeout(timer); this._onClose(); });
        this.ws.on('error',  (e) => { clearTimeout(timer); this._onError(e); });
    }

    request(uri, payload, cb) {
        if (typeof payload === 'function') { cb = payload; payload = {}; }
        const id = String(++this.msgId);
        if (cb) this.pending[id] = cb;
        this._send({ type: 'request', id, uri, payload: payload || {} });
    }

    subscribe(uri, payload, cb) {
        if (typeof payload === 'function') { cb = payload; payload = {}; }
        const id = 'sub_' + (++this.msgId);
        if (cb) this.subs[id] = cb;
        this._send({ type: 'subscribe', id, uri, payload: payload || {} });
    }

    // Zwraca obiekt z metodą send() do wysyłania przycisków pilota
    getSocket(uri, cb) {
        this.request(uri, (err, res) => {
            if (err || !res || !res.socketPath) {
                return cb(err || new Error('Brak socketPath'));
            }
            const sock = new WebSocket(res.socketPath, { rejectUnauthorized: false });
            sock.on('open',  ()  => cb(null, { send: (type, p) => sock.send(JSON.stringify({ type, ...p })) }));
            sock.on('error', (e) => cb(e));
        });
    }

    disconnect() {
        if (this.ws) { try { this.ws.close(); } catch (e) {} }
    }

    _send(msg) {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify(msg));
        }
    }
}

// ─── Słowniki ────────────────────────────────────────────────────────────────

const PICTURE_MODES = {
    'vivid': 'Vivid', 'standard': 'Standard', 'eco': 'Eco / APS',
    'cinema': 'Cinema', 'sport': 'Sport', 'game': 'Game',
    'filmMaker': 'Filmmaker Mode',
    'hdrStandard': 'HDR Standard', 'hdrCinema': 'HDR Cinema',
    'hdrFilmMaker': 'HDR Filmmaker', 'hdrGame': 'HDR Game', 'hdrSport': 'HDR Sport',
    'dolbyHdrVivid': 'Dolby Vision Vivid', 'dolbyHdrStandard': 'Dolby Vision Standard',
    'dolbyHdrCinema': 'Dolby Vision Cinema', 'dolbyHdrCinemaBright': 'Dolby Vision Cinema Bright',
    'dolbyHdrFilmMaker': 'Dolby Vision Filmmaker', 'dolbyHdrGame': 'Dolby Vision Game',
};

const SOUND_MODES = {
    'standard': 'Standard', 'music': 'Music', 'cinema': 'Cinema',
    'sport': 'Sport / Stadium', 'game': 'Game',
    'aiSound': 'AI Sound', 'aiSoundPro': 'AI Sound Pro',
};

const SOUND_OUTPUTS = {
    'tv_speaker': 'TV Speaker', 'external_arc': 'HDMI ARC / eARC',
    'external_optical': 'Optical Out', 'bt_soundbar': 'Bluetooth Soundbar',
    'headphone': 'Headphone', 'lineout': 'Line Out',
    'tv_external_speaker': 'TV + External Speaker',
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

// ─── Adapter ─────────────────────────────────────────────────────────────────

class LgtvFullAdapter extends utils.Adapter {

    constructor(options) {
        super({ ...options, name: 'lgtv-full' });
        this.tv          = null;
        this.inputSocket = null;
        this.connected   = false;
        this.reconnTimer = null;
        this.inputs      = {};
        this.channels    = [];

        this.on('ready',       this.onReady.bind(this));
        this.on('stateChange', this.onStateChange.bind(this));
        this.on('unload',      this.onUnload.bind(this));
    }

    async onReady() {
        this.log.info('Adapter uruchomiony');
        await this.setStateAsync('info.connection', false, true);
        await this.createAllObjects();
        this.connect();
    }

    async createAllObjects() {
        const ch  = (id, name) => this.setObjectNotExistsAsync(id, { type: 'channel', common: { name }, native: {} });
        const st  = (id, name, type, role, write, extra = {}) =>
            this.setObjectNotExistsAsync(id, { type: 'state', common: { name, type, role, read: true, write, ...extra }, native: {} });

        await ch('info', 'Information');
        await this.setObjectNotExistsAsync('info.connection', {
            type: 'state',
            common: { name: 'Connected', type: 'boolean', role: 'indicator.connected', read: true, write: false, def: false },
            native: {},
        });

        await st('power',       'Zasilanie (WoL)',          'boolean', 'switch.power', true);
        await st('screenOff',   'Ekran wygaszony',          'boolean', 'switch',       true);
        await st('screenSaver', 'Wygaszacz aktywny',        'boolean', 'indicator',    false);

        await ch('audio', 'Audio');
        await st('audio.volume', 'Głośność', 'number', 'level.volume', true, { min: 0, max: 100, unit: '%' });
        await st('audio.mute',   'Wyciszenie', 'boolean', 'media.mute', true);
        await this.setObjectNotExistsAsync('audio.soundMode',   { type: 'state', common: { name: 'Tryb dźwięku',   type: 'string', role: 'text', read: true, write: true, states: SOUND_MODES   }, native: {} });
        await this.setObjectNotExistsAsync('audio.soundOutput', { type: 'state', common: { name: 'Wyjście audio',  type: 'string', role: 'text', read: true, write: true, states: SOUND_OUTPUTS }, native: {} });

        await ch('picture', 'Obraz');
        await this.setObjectNotExistsAsync('picture.mode', { type: 'state', common: { name: 'Tryb obrazu', type: 'string', role: 'text', read: true, write: true, states: PICTURE_MODES }, native: {} });
        await st('picture.brightness', 'Jasność',            'number', 'level', true, { min: 0, max: 100 });
        await st('picture.contrast',   'Kontrast',           'number', 'level', true, { min: 0, max: 100 });
        await st('picture.backlight',  'Podświetlenie/OLED', 'number', 'level', true, { min: 0, max: 100 });
        await st('picture.color',      'Nasycenie kolorów',  'number', 'level', true, { min: 0, max: 100 });
        await st('picture.sharpness',  'Ostrość',            'number', 'level', true, { min: 0, max: 50  });

        await ch('input', 'Wejście');
        await st('input.current', 'Aktualne wejście', 'string', 'text', true);
        await st('input.list',    'Lista wejść (JSON)', 'string', 'json', false);

        await ch('channel', 'Kanał TV');
        await st('channel.number', 'Numer kanału', 'string', 'text', true);
        await st('channel.name',   'Nazwa kanału', 'string', 'text', false);
        await st('channel.list',   'Lista kanałów (JSON)', 'string', 'json', false);

        await ch('app', 'Aplikacje');
        await st('app.current', 'Bieżąca aplikacja (ID)', 'string', 'text', false);
        await st('app.launch',  'Uruchom aplikację (ID)', 'string', 'text', true);

        await ch('media', 'Media');
        await st('media.state', 'Stan odtwarzania', 'string', 'media.state', false);

        await ch('remote', 'Pilot');
        for (const btn of REMOTE_BUTTONS) {
            await this.setObjectNotExistsAsync(`remote.${btn}`, {
                type: 'state',
                common: { name: `Przycisk ${btn}`, type: 'boolean', role: 'button', read: false, write: true },
                native: {},
            });
        }

        this.subscribeStates('*');
        this.log.info('Wszystkie obiekty utworzone');
    }

    connect() {
        if (this.reconnTimer) { clearTimeout(this.reconnTimer); this.reconnTimer = null; }

        const keyFile = path.join(utils.getAbsoluteInstanceDataDir(this), 'lgtvkey.txt');
        const useSSL  = this.config.useSSL !== false;
        const port    = useSSL ? 3001 : 3000;
        const proto   = useSSL ? 'wss' : 'ws';
        const url     = `${proto}://${this.config.host}:${port}`;

        this.log.info(`Łączenie z TV: ${url}`);

        this.tv = new LgTvSocket({ url, keyFile, timeout: 5000 });
        this.tv._logger = (msg) => this.log.debug(msg);

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
            this.connected   = false;
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
            this.log.warn('TV prosi o parowanie — zatwierdź na ekranie telewizora!');
        });

        this.tv.connect();
    }

    openInputSocket() {
        this.tv.getSocket('ssap://com.webos.service.networkinput/getPointerInputService', (err, sock) => {
            if (err) { this.log.warn(`Socket pilota: ${err}`); return; }
            this.inputSocket = sock;
            this.log.debug('Socket pilota otwarty');
        });
    }

    subscribeEvents() {
        this.tv.subscribe('ssap://audio/getVolume', (err, res) => {
            if (err || !res) return;
            this.log.debug(`getVolume response: ${JSON.stringify(res)}`);
            // webOS 6+ (LG 2021+) używa volumeStatus zamiast bezpośrednich pól
            if (res.volumeStatus) {
                if (res.volumeStatus.volume     !== undefined) this.setStateAsync('audio.volume', res.volumeStatus.volume,     true);
                if (res.volumeStatus.muteStatus !== undefined) this.setStateAsync('audio.mute',   res.volumeStatus.muteStatus, true);
            } else {
                if (res.volume !== undefined) this.setStateAsync('audio.volume', res.volume, true);
                if (res.muted  !== undefined) this.setStateAsync('audio.mute',   res.muted,  true);
            }
        });

        this.tv.subscribe('ssap://com.webos.applicationManager/getForegroundAppInfo', (err, res) => {
            if (err || !res || !res.appId) return;
            this.setStateAsync('app.current', res.appId, true);
        });

        this.tv.subscribe('ssap://tv/getCurrentChannel', (err, res) => {
            if (err || !res || res.errorCode) return;
            if (res.channelNumber !== undefined) this.setStateAsync('channel.number', res.channelNumber, true);
            if (res.channelName   !== undefined) this.setStateAsync('channel.name',   res.channelName,   true);
        });

        this.tv.subscribe('ssap://com.webos.media/getForegroundAppMediaStatus', (err, res) => {
            if (err || !res) return;
            if (res.playState !== undefined) this.setStateAsync('media.state', res.playState, true);
        });

        this.tv.subscribe('ssap://audio/getSoundOutput', (err, res) => {
            if (err || !res) return;
            if (res.soundOutput) this.setStateAsync('audio.soundOutput', res.soundOutput, true);
        });

        this.tv.subscribe('ssap://com.webos.service.screenSaver/getStatus', (err, res) => {
            if (err || !res) return;
            this.setStateAsync('screenSaver', res.actived === true || res.screenSaverRunning === true, true);
        });

        // webOS 6+: ssap://com.webos.service.settings/getSystemSettings ma szersze uprawnienia
        this.tv.subscribe('ssap://com.webos.service.settings/getSystemSettings',
            { category: 'picture', keys: ['pictureMode'] },
            (err, res) => {
                if (err || !res || !res.settings) return;
                if (res.settings.pictureMode) this.setStateAsync('picture.mode', res.settings.pictureMode, true);
            }
        );

        this.tv.subscribe('ssap://com.webos.service.settings/getSystemSettings',
            { category: 'sound', keys: ['soundMode'] },
            (err, res) => {
                if (err || !res || !res.settings) return;
                if (res.settings.soundMode) this.setStateAsync('audio.soundMode', res.settings.soundMode, true);
            }
        );
    }

    requestPictureSettings() {
        const applySettings = (s) => {
            if (!s) return;
            this.log.debug(`Picture settings received: ${JSON.stringify(s)}`);
            if (s.pictureMode !== undefined) this.setStateAsync('picture.mode',       s.pictureMode,              true);
            if (s.brightness  !== undefined) this.setStateAsync('picture.brightness', parseInt(s.brightness),     true);
            if (s.contrast    !== undefined) this.setStateAsync('picture.contrast',   parseInt(s.contrast),       true);
            const bl = s.oledLight !== undefined ? s.oledLight : s.backlight;
            if (bl !== undefined)             this.setStateAsync('picture.backlight',  parseInt(bl),               true);
            if (s.color       !== undefined) this.setStateAsync('picture.color',      parseInt(s.color),          true);
            if (s.sharpness   !== undefined) this.setStateAsync('picture.sharpness',  parseInt(s.sharpness),      true);
        };

        const KEYS = ['pictureMode', 'brightness', 'contrast', 'backlight', 'oledLight', 'color', 'sharpness'];

        // webOS 6+ (G4 i nowsze) wymaga ssap://com.webos.service.settings — spróbuj najpierw
        this.tv.request('ssap://com.webos.service.settings/getSystemSettings',
            { category: 'picture', keys: KEYS },
            (err, res) => {
                if (!err && res && res.settings) { applySettings(res.settings); return; }
                this.log.debug(`com.webos.service.settings picture: ${err ? err.message : 'brak settings'} — próba ssap://settings`);

                // Fallback: stary URI
                this.tv.request('ssap://settings/getSystemSettings',
                    { category: 'picture', keys: KEYS },
                    (err2, res2) => {
                        if (!err2 && res2 && res2.settings) { applySettings(res2.settings); return; }
                        this.log.debug(`ssap://settings picture: ${err2 ? err2.message : 'brak settings'} — próba bez keys`);

                        // Ostatnia próba: bez filtrowania kluczy
                        this.tv.request('ssap://settings/getSystemSettings',
                            { category: 'picture' },
                            (err3, res3) => {
                                if (err3) {
                                    this.log.warn(`getSystemSettings picture: 401 insufficient permissions. Usuń plik klucza i sparuj TV ponownie!`);
                                    return;
                                }
                                applySettings(res3 && res3.settings);
                            }
                        );
                    }
                );
            }
        );
    }

    requestSoundSettings() {
        // webOS 6+ — spróbuj nowego URI
        this.tv.request('ssap://com.webos.service.settings/getSystemSettings',
            { category: 'sound', keys: ['soundMode'] },
            (err, res) => {
                if (!err && res && res.settings && res.settings.soundMode) {
                    this.setStateAsync('audio.soundMode', res.settings.soundMode, true);
                    return;
                }
                this.log.debug(`com.webos.service.settings sound: ${err ? err.message : 'brak settings'} — próba ssap://settings`);

                // Fallback
                this.tv.request('ssap://settings/getSystemSettings',
                    { category: 'sound', keys: ['soundMode'] },
                    (err2, res2) => {
                        if (err2) { this.log.warn(`getSystemSettings sound: ${err2.message}`); return; }
                        if (res2 && res2.settings && res2.settings.soundMode)
                            this.setStateAsync('audio.soundMode', res2.settings.soundMode, true);
                    }
                );
            }
        );
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
            this.log.info(`Kanałów: ${this.channels.length}`);
        });
    }

    async onStateChange(id, state) {
        if (!state || state.ack) return;
        const key = id.split('.').slice(2).join('.');
        const val = state.val;
        this.log.debug(`Komenda: ${key} = ${val}`);

        if (key === 'power') {
            if (!val) {
                if (this.connected) this.tv.request('ssap://system/turnOff');
            } else {
                const mac = this.config.macAddress;
                if (mac) {
                    wol.wake(mac, { num_packets: 5 }, (err) => {
                        if (err) this.log.error(`WoL error: ${err}`);
                        else     this.log.info('WoL pakiet wysłany');
                    });
                } else {
                    this.log.warn('Brak MAC — ustaw w konfiguracji adaptera');
                }
            }
            return;
        }

        if (!this.connected) { this.log.warn(`TV niepołączony, ignoruję: ${key}`); return; }

        switch (key) {
            case 'screenOff':
                this.tv.request(val
                    ? 'ssap://com.webos.service.tv.display/setScreenOff'
                    : 'ssap://com.webos.service.tv.display/setScreenOn');
                break;
            case 'audio.volume':
                this.tv.request('ssap://audio/setVolume', { volume: Math.max(0, Math.min(100, Math.round(val))) });
                break;
            case 'audio.mute':
                this.tv.request('ssap://audio/setMute', { mute: !!val });
                break;
            case 'audio.soundMode':
                // Spróbuj nowego URI, potem starego
                this.tv.request('ssap://com.webos.service.settings/setSystemSettings',
                    { settings: { soundMode: val }, category: 'sound' },
                    (err) => { if (err) this.tv.request('ssap://settings/setSystemSettings', { settings: { soundMode: val }, category: 'sound' }); }
                );
                break;
            case 'audio.soundOutput':
                this.tv.request('ssap://audio/changeSoundOutput', { output: val });
                break;
            case 'picture.mode':
                this.tv.request('ssap://com.webos.service.settings/setSystemSettings',
                    { settings: { pictureMode: val }, category: 'picture' },
                    (err) => { if (err) this.tv.request('ssap://settings/setSystemSettings', { settings: { pictureMode: val }, category: 'picture' }); }
                );
                break;
            case 'picture.brightness':
            case 'picture.contrast':
            case 'picture.backlight':
            case 'picture.color':
            case 'picture.sharpness': {
                const k = key.split('.')[1];
                this.tv.request('ssap://com.webos.service.settings/setSystemSettings',
                    { settings: { [k]: String(Math.round(val)) }, category: 'picture' },
                    (err) => { if (err) this.tv.request('ssap://settings/setSystemSettings', { settings: { [k]: String(Math.round(val)) }, category: 'picture' }); }
                );
                break;
            }
            case 'input.current':
                this.tv.request('ssap://tv/switchInput', { inputId: val });
                break;
            case 'channel.number': {
                const ch = this.channels.find(c => c.channelNumber === String(val));
                if (ch) this.tv.request('ssap://tv/openChannel', { channelId: ch.channelId });
                else    this.log.warn(`Kanał ${val} nie znaleziony`);
                break;
            }
            case 'app.launch':
                this.tv.request('ssap://system.launcher/launch', { id: val });
                break;
            default:
                if (key.startsWith('remote.')) {
                    const btn = key.replace('remote.', '');
                    if (this.inputSocket) this.inputSocket.send('button', { name: btn });
                    else { this.log.warn(`Socket pilota niegotowy (${btn})`); this.openInputSocket(); }
                }
        }
    }

    onUnload(callback) {
        try {
            if (this.reconnTimer) clearTimeout(this.reconnTimer);
            if (this.tv)          this.tv.disconnect();
        } catch (e) { this.log.error(e); }
        callback();
    }
}

if (require.main !== module) {
    module.exports = (options) => new LgtvFullAdapter(options);
} else {
    new LgtvFullAdapter();
}
