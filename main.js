'use strict';

/**
 * ioBroker adapter: lgtv-full
 * Full LG WebOS TV control (OLED G-series and others, webOS 6+)
 * Custom WebSocket implementation — no dependency on lgtv2
 *
 * Dependencies: ws, wake_on_lan, mqtt, @iobroker/adapter-core
 */

const utils     = require('@iobroker/adapter-core');
const wol       = require('wake_on_lan');
const path      = require('path');
const fs        = require('fs');
const WebSocket = require('ws');
const mqtt      = require('mqtt');

// ─── LG WebOS pairing manifest ───────────────────────────────────────────────

// Manifest from lgtv2 (merdok/lgtv2) — contains a real RSA-SHA256 signature
// issued by LG Electronics. The TV validates this signature and grants the
// signed.permissions (including WRITE_SETTINGS) which enables setSystemSettings writes.
const LG_MANIFEST = {
    manifestVersion: 1,
    appVersion: '1.1',
    signed: {
        created: '20140509',
        appId: 'com.lge.test',
        vendorId: 'com.lge',
        localizedAppNames: {
            '': 'LG Remote App',
            'ko-KR': '리모컨 앱',
            'zxx-XX': 'ЛГ Rэмotэ AПП',
        },
        localizedVendorNames: { '': 'LG Electronics' },
        permissions: [
            'TEST_SECURE', 'CONTROL_INPUT_TEXT', 'CONTROL_MOUSE_AND_KEYBOARD',
            'READ_INSTALLED_APPS', 'READ_LGE_SDX', 'READ_NOTIFICATIONS', 'SEARCH',
            'WRITE_SETTINGS', 'WRITE_NOTIFICATION_ALERT', 'CONTROL_POWER',
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
        'CONTROL_TV_SCREEN', 'CONTROL_TV_STANBY', 'CONTROL_FAVORITE_GROUP',
        'CONTROL_USER_INFO', 'CHECK_BLUETOOTH_DEVICE', 'CONTROL_BLUETOOTH',
        'CONTROL_TIMER_INFO', 'STB_INTERNAL_CONNECTION', 'CONTROL_RECORDING',
        'READ_RECORDING_STATE', 'WRITE_RECORDING_LIST', 'READ_RECORDING_LIST',
        'READ_RECORDING_SCHEDULE', 'WRITE_RECORDING_SCHEDULE', 'READ_STORAGE_DEVICE_LIST',
        'READ_TV_PROGRAM_INFO', 'CONTROL_BOX_CHANNEL', 'READ_TV_ACR_AUTH_TOKEN',
        'READ_TV_CONTENT_STATE', 'READ_TV_CURRENT_TIME', 'ADD_LAUNCHER_CHANNEL',
        'SET_CHANNEL_SKIP', 'RELEASE_CHANNEL_SKIP', 'CONTROL_CHANNEL_BLOCK',
        'DELETE_SELECT_CHANNEL', 'CONTROL_CHANNEL_GROUP', 'SCAN_TV_CHANNELS',
        'CONTROL_TV_POWER', 'CONTROL_WOL',
    ],
    signatures: [{
        signatureVersion: 1,
        signature: 'eyJhbGdvcml0aG0iOiJSU0EtU0hBMjU2Iiwia2V5SWQiOiJ0ZXN0LXNpZ25pbmctY2VydCIsInNpZ25hdHVyZVZlcnNpb24iOjF9.hrVRgjCwXVvE2OOSpDZ58hR+59aFNwYDyjQgKk3auukd7pcegmE2CzPCa0bJ0ZsRAcKkCTJrWo5iDzNhMBWRyaMOv5zWSrthlf7G128qvIlpMT0YNY+n/FaOHE73uLrS/g7swl3/qH/BGFG2Hu4RlL48eb3lLKqTt2xKHdCs6Cd4RMfJPYnzgvI4BNrFUKsjkcu+WD4OO2A27Pq1n50cMchmcaXadJhGrOqH5YmHdOCj5NSHzJYrsW0HPlpuAx/ECMeIZYDh6RMqaFM2DXzdKX9NmmyqzJ3o/0lkk/N97gfVRLW5hA29yeAwaCViZNCP8iC9aO0q9fQojoa7NQnAtw==',
    }],
};

// ─── LG WebOS WebSocket connection class ─────────────────────────────────────

class LgTvSocket {
    constructor(config) {
        this.url      = config.url;
        this.keyFile  = config.keyFile;
        this.timeout  = config.timeout || 5000;
        this.ws       = null;
        this.msgId    = 0;
        this.pending  = {};   // id → callback (one-shot requests)
        this.subs     = {};   // id → callback (subscriptions)
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
        // Load saved pairing key
        try {
            if (fs.existsSync(this.keyFile)) {
                this.clientKey = fs.readFileSync(this.keyFile, 'utf8').trim();
            }
        } catch (e) { /* no file — first pairing */ }

        this.ws = new WebSocket(this.url, { rejectUnauthorized: false });

        const timer = setTimeout(() => {
            if (this.ws) this.ws.terminate();
        }, this.timeout);

        this.ws.on('open', () => {
            clearTimeout(timer);
            // Send registration request
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

            // Log all TV messages (debug)
            if (this._logger) this._logger(`TV→ [${msg.type}][${msg.id || '-'}] ${JSON.stringify(msg.payload || msg.error || '').substring(0, 200)}`);

            if (msg.type === 'registered') {
                if (msg.payload && msg.payload['client-key']) {
                    this.clientKey = msg.payload['client-key'];
                    try {
                        // Ensure directory exists before writing
                        const dir = path.dirname(this.keyFile);
                        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
                        fs.writeFileSync(this.keyFile, this.clientKey, 'utf8');
                    } catch (e) { /* ignore write errors */ }
                }
                this._onConnect();

            } else if (msg.type === 'error') {
                if (msg.id === 'register0') {
                    this._onPrompt();
                } else {
                    // Handle errors for pending callbacks
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

    // Returns an object with send() for sending remote control buttons
    getSocket(uri, cb) {
        this.request(uri, (err, res) => {
            if (err || !res || !res.socketPath) {
                return cb(err || new Error('Missing socketPath'));
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

// ─── Dictionaries ─────────────────────────────────────────────────────────────

const PICTURE_MODES = {
    'vivid': 'Vivid', 'standard': 'Standard', 'eco': 'Eco / APS',
    'cinema': 'Cinema', 'sport': 'Sport', 'game': 'Game',
    'filmMaker': 'Filmmaker Mode',
    'expert1': 'Expert (Bright Room)', 'expert2': 'Expert (Dark Room)',
    'hdrVivid': 'HDR Vivid', 'hdrStandard': 'HDR Standard', 'hdrCinema': 'HDR Cinema',
    'hdrFilmMaker': 'HDR Filmmaker', 'hdrGame': 'HDR Game', 'hdrSport': 'HDR Sport',
    'hdrCinemaHome': 'HDR Cinema Home',
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

// ─── Numeric mappings (for MQTT / Loxone) ────────────────────────────────────
// Number → key (index starts at 1)
const PICTURE_MODE_KEYS  = Object.keys(PICTURE_MODES);   // index+1 = number
const SOUND_MODE_KEYS    = Object.keys(SOUND_MODES);
const SOUND_OUTPUT_KEYS  = Object.keys(SOUND_OUTPUTS);

// key → number
const PICTURE_MODE_NUM   = Object.fromEntries(PICTURE_MODE_KEYS.map((k, i) => [k, i + 1]));
const SOUND_MODE_NUM     = Object.fromEntries(SOUND_MODE_KEYS.map((k, i)   => [k, i + 1]));
const SOUND_OUTPUT_NUM   = Object.fromEntries(SOUND_OUTPUT_KEYS.map((k, i) => [k, i + 1]));

// Numeric states dictionary (number → "N — Label" for ioBroker dropdown)
const PICTURE_MODES_NUM  = Object.fromEntries(PICTURE_MODE_KEYS.map((k, i)  => [i + 1, `${i + 1} — ${PICTURE_MODES[k]}`]));
const SOUND_MODES_NUM    = Object.fromEntries(SOUND_MODE_KEYS.map((k, i)    => [i + 1, `${i + 1} — ${SOUND_MODES[k]}`]));
const SOUND_OUTPUTS_NUM  = Object.fromEntries(SOUND_OUTPUT_KEYS.map((k, i)  => [i + 1, `${i + 1} — ${SOUND_OUTPUTS[k]}`]));

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

// ─── Adapter ──────────────────────────────────────────────────────────────────

class LgtvFullAdapter extends utils.Adapter {

    constructor(options) {
        super({ ...options, name: 'lgtv-full' });
        this.tv          = null;
        this.inputSocket = null;
        this.connected   = false;
        this.reconnTimer = null;
        this.pollTimer   = null;
        this.inputs      = {};
        this.channels    = [];

        // MQTT
        this.mqttClient  = null;
        this.mqttPrefix  = 'lgtv';

        this.on('ready',       this.onReady.bind(this));
        this.on('stateChange', this.onStateChange.bind(this));
        this.on('unload',      this.onUnload.bind(this));
    }

    /**
     * Override setStateAsync to automatically publish every acknowledged
     * state change to MQTT (when the broker is enabled and connected).
     */
    async setStateAsync(id, val, ack) {
        await super.setStateAsync(id, val, ack);
        // Publish to MQTT only for acknowledged (read) values — skip internal ack=false writes
        if (ack && this.config.mqttEnabled) {
            // Strip instance prefix if present (e.g. "lgtv-full.0.picture.mode" → "picture.mode")
            const key = id.includes('.') && id.split('.')[0] === this.name
                ? id.split('.').slice(2).join('.')
                : id;
            this.mqttPublish(key, typeof val === 'object' && val !== null ? val.val : val);
        }
    }

    async onReady() {
        this.log.info('Adapter started');
        await super.setStateAsync('info.connection', false, true);
        await this.createAllObjects();
        if (this.config.mqttEnabled) this.connectMqtt();
        this.connect();
    }

    async createAllObjects() {
        // Use setObjectAsync (not setObjectNotExistsAsync) to force update names on existing objects
        const ch  = (id, name) => this.setObjectAsync(id, { type: 'channel', common: { name }, native: {} });
        const st  = (id, name, type, role, write, extra = {}) =>
            this.setObjectAsync(id, { type: 'state', common: { name, type, role, read: true, write, ...extra }, native: {} });

        await ch('info', 'Information');
        await this.setObjectAsync('info.connection', {
            type: 'state',
            common: { name: 'Connected', type: 'boolean', role: 'indicator.connected', read: true, write: false, def: false },
            native: {},
        });

        await st('power',       'Power (WoL)',         'boolean', 'switch.power', true);
        await st('screenOff',   'Screen off',          'boolean', 'switch',       true);
        await st('screenSaver', 'Screen saver active', 'boolean', 'indicator',    false);

        await ch('audio', 'Audio');
        await st('audio.volume', 'Volume', 'number', 'level.volume', true, { min: 0, max: 100, unit: '%' });
        await st('audio.mute',   'Mute',   'boolean', 'media.mute',  true);
        await this.setObjectAsync('audio.soundMode',      { type: 'state', common: { name: 'Sound Mode',           type: 'string', role: 'text',  read: true, write: true, states: SOUND_MODES       }, native: {} });
        await this.setObjectAsync('audio.soundModeNum',   { type: 'state', common: { name: 'Sound Mode (number)',   type: 'number', role: 'value', read: true, write: true, states: SOUND_MODES_NUM   }, native: {} });
        await this.setObjectAsync('audio.soundOutput',    { type: 'state', common: { name: 'Sound Output',          type: 'string', role: 'text',  read: true, write: true, states: SOUND_OUTPUTS     }, native: {} });
        await this.setObjectAsync('audio.soundOutputNum', { type: 'state', common: { name: 'Sound Output (number)', type: 'number', role: 'value', read: true, write: true, states: SOUND_OUTPUTS_NUM }, native: {} });

        await ch('picture', 'Picture');
        await this.setObjectAsync('picture.mode',    { type: 'state', common: { name: 'Picture Mode',         type: 'string', role: 'text',  read: true, write: true, states: PICTURE_MODES     }, native: {} });
        await this.setObjectAsync('picture.modeNum', { type: 'state', common: { name: 'Picture Mode (number)', type: 'number', role: 'value', read: true, write: true, states: PICTURE_MODES_NUM }, native: {} });
        await st('picture.brightness', 'Brightness',       'number', 'level', true, { min: 0, max: 100 });
        await st('picture.contrast',   'Contrast',         'number', 'level', true, { min: 0, max: 100 });
        await st('picture.backlight',  'Backlight / OLED', 'number', 'level', true, { min: 0, max: 100 });
        await st('picture.color',      'Color Saturation', 'number', 'level', true, { min: 0, max: 100 });
        await st('picture.sharpness',  'Sharpness',        'number', 'level', true, { min: 0, max: 50  });

        await ch('input', 'Input');
        await st('input.current', 'Current input',      'string', 'text', true);
        await st('input.list',    'Input list (JSON)',  'string', 'json', false);

        await ch('channel', 'TV Channel');
        await st('channel.number', 'Channel number',       'string', 'text', true);
        await st('channel.name',   'Channel name',         'string', 'text', false);
        await st('channel.list',   'Channel list (JSON)',  'string', 'json', false);

        await ch('app', 'Applications');
        await st('app.current', 'Current app (ID)', 'string', 'text', false);
        await st('app.launch',  'Launch app (ID)',  'string', 'text', true);

        await ch('media', 'Media');
        await st('media.state', 'Playback state', 'string', 'media.state', false);

        await ch('remote', 'Remote Control');
        for (const btn of REMOTE_BUTTONS) {
            await this.setObjectAsync(`remote.${btn}`, {
                type: 'state',
                common: { name: `Button ${btn}`, type: 'boolean', role: 'button', read: false, write: true },
                native: {},
            });
        }

        this.subscribeStates('*');
        this.log.info('All objects created');
    }

    connect() {
        if (this.reconnTimer) { clearTimeout(this.reconnTimer); this.reconnTimer = null; }

        const keyFile = path.join(utils.getAbsoluteInstanceDataDir(this), 'lgtvkey.txt');
        const useSSL  = this.config.useSSL !== false;
        const port    = useSSL ? 3001 : 3000;
        const proto   = useSSL ? 'wss' : 'ws';
        const url     = `${proto}://${this.config.host}:${port}`;

        this.log.info(`Connecting to TV: ${url}`);

        this.tv = new LgTvSocket({ url, keyFile, timeout: 5000 });
        this.tv._logger = (msg) => this.log.debug(msg);

        this.tv.on('connect', () => {
            this.log.info('Connected to LG TV!');
            this.connected = true;
            this.setStateAsync('info.connection', true, true);
            this.setStateAsync('power', true, true);
            this.openInputSocket();
            this.subscribeEvents();
            this.requestPictureSettings();
            this.requestSoundSettings();
            this.requestInputList();
            this.requestChannelList();
            // Polling fallback every 60s — in case subscriptions fail
            if (this.pollTimer) clearInterval(this.pollTimer);
            this.pollTimer = setInterval(() => {
                if (this.connected) {
                    this.requestPictureSettings();
                    this.requestSoundSettings();
                }
            }, 60000);
        });

        this.tv.on('close', () => {
            this.log.info('Disconnected from LG TV');
            this.connected   = false;
            this.inputSocket = null;
            if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null; }
            this.setStateAsync('info.connection', false, true);
            this.setStateAsync('power', false, true);
            const sec = parseInt(this.config.reconnectInterval) || 10;
            this.reconnTimer = setTimeout(() => this.connect(), sec * 1000);
        });

        this.tv.on('error', (err) => {
            this.log.error(`Connection error: ${err && err.message ? err.message : err}`);
        });

        this.tv.on('prompt', () => {
            this.log.warn('TV is requesting pairing — please accept on the TV screen!');
        });

        this.tv.connect();
    }

    openInputSocket() {
        this.tv.getSocket('ssap://com.webos.service.networkinput/getPointerInputService', (err, sock) => {
            if (err) { this.log.warn(`Remote socket error: ${err}`); return; }
            this.inputSocket = sock;
            this.log.debug('Remote control socket opened');
        });
    }

    subscribeEvents() {
        this.tv.subscribe('ssap://audio/getVolume', (err, res) => {
            if (err || !res) return;
            this.log.debug(`getVolume response: ${JSON.stringify(res)}`);
            // webOS 6+ (LG 2021+) uses volumeStatus instead of direct fields
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
            if (res.soundOutput) {
                this.setStateAsync('audio.soundOutput', res.soundOutput, true);
                const n = SOUND_OUTPUT_NUM[res.soundOutput];
                if (n !== undefined) this.setStateAsync('audio.soundOutputNum', n, true);
            }
        });

        this.tv.subscribe('ssap://com.webos.service.screenSaver/getStatus', (err, res) => {
            if (err || !res) return;
            this.setStateAsync('screenSaver', res.actived === true || res.screenSaverRunning === true, true);
        });

        // Push subscription for picture settings changes
        this.tv.subscribe('ssap://settings/getSystemSettings',
            { category: 'picture', keys: ['pictureMode', 'brightness', 'contrast', 'backlight', 'color', 'sharpness'] },
            (err, res) => {
                if (err || !res || !res.settings) return;
                const s = res.settings;
                this.log.debug(`Picture push: ${JSON.stringify(s)}`);
                if (s.pictureMode !== undefined) {
                    this.setStateAsync('picture.mode', s.pictureMode, true);
                    const n = PICTURE_MODE_NUM[s.pictureMode];
                    if (n !== undefined) this.setStateAsync('picture.modeNum', n, true);
                }
                if (s.brightness !== undefined) this.setStateAsync('picture.brightness', parseInt(s.brightness), true);
                if (s.contrast   !== undefined) this.setStateAsync('picture.contrast',   parseInt(s.contrast),   true);
                if (s.backlight  !== undefined) this.setStateAsync('picture.backlight',  parseInt(s.backlight),  true);
                if (s.color      !== undefined) this.setStateAsync('picture.color',      parseInt(s.color),      true);
                if (s.sharpness  !== undefined) this.setStateAsync('picture.sharpness',  parseInt(s.sharpness),  true);
            }
        );

        // Push subscription for sound mode changes
        this.tv.subscribe('ssap://settings/getSystemSettings',
            { category: 'sound', keys: ['soundMode'] },
            (err, res) => {
                if (err || !res || !res.settings) return;
                if (res.settings.soundMode) {
                    const mode = res.settings.soundMode;
                    this.log.debug(`Sound mode push: ${mode}`);
                    this.setStateAsync('audio.soundMode', mode, true);
                    const n = SOUND_MODE_NUM[mode];
                    if (n !== undefined) this.setStateAsync('audio.soundModeNum', n, true);
                }
            }
        );
    }

    requestPictureSettings() {
        const applySettings = (s) => {
            if (!s) return;
            this.log.debug(`Picture settings received: ${JSON.stringify(s)}`);
            if (s.pictureMode !== undefined) {
                this.setStateAsync('picture.mode', s.pictureMode, true);
                const n = PICTURE_MODE_NUM[s.pictureMode];
                if (n !== undefined) this.setStateAsync('picture.modeNum', n, true);
            }
            if (s.brightness !== undefined) this.setStateAsync('picture.brightness', parseInt(s.brightness), true);
            if (s.contrast   !== undefined) this.setStateAsync('picture.contrast',   parseInt(s.contrast),   true);
            // oledLight is not allowed as a filter key on LG G4 — use backlight
            const bl = s.oledLight !== undefined ? s.oledLight : s.backlight;
            if (bl !== undefined)            this.setStateAsync('picture.backlight',  parseInt(bl),           true);
            if (s.color      !== undefined) this.setStateAsync('picture.color',      parseInt(s.color),      true);
            if (s.sharpness  !== undefined) this.setStateAsync('picture.sharpness',  parseInt(s.sharpness),  true);
        };

        const KEYS = ['pictureMode', 'brightness', 'contrast', 'backlight', 'color', 'sharpness'];

        this.tv.request('ssap://settings/getSystemSettings',
            { category: 'picture', keys: KEYS },
            (err, res) => {
                if (!err && res && res.settings) { applySettings(res.settings); return; }
                this.log.debug(`getSystemSettings picture error: ${err ? err.message : 'no settings'}`);
            }
        );
    }

    requestSoundSettings() {
        this.tv.request('ssap://settings/getSystemSettings',
            { category: 'sound', keys: ['soundMode'] },
            (err, res) => {
                if (err) { this.log.debug(`getSystemSettings sound error: ${err.message}`); return; }
                if (res && res.settings && res.settings.soundMode) {
                    const mode = res.settings.soundMode;
                    this.setStateAsync('audio.soundMode', mode, true);
                    const n = SOUND_MODE_NUM[mode];
                    if (n !== undefined) this.setStateAsync('audio.soundModeNum', n, true);
                }
            }
        );
    }

    // ─── MQTT ──────────────────────────────────────────────────────────────────

    connectMqtt() {
        const cfg    = this.config;
        this.mqttPrefix = (cfg.mqttTopic || 'lgtv').replace(/\/+$/, '');
        const url    = `mqtt://${cfg.mqttHost || 'localhost'}:${cfg.mqttPort || 1883}`;
        const opts   = { clientId: `iobroker-lgtv-${this.instance}`, clean: true };
        if (cfg.mqttUser)     opts.username = cfg.mqttUser;
        if (cfg.mqttPassword) opts.password = cfg.mqttPassword;

        this.log.info(`MQTT: connecting to ${url} (prefix: ${this.mqttPrefix})`);
        this.mqttClient = mqtt.connect(url, opts);

        this.mqttClient.on('connect', () => {
            this.log.info('MQTT: connected');
            // Subscribe to all set/# commands
            this.mqttClient.subscribe(`${this.mqttPrefix}/set/#`, (err) => {
                if (err) this.log.warn(`MQTT subscribe error: ${err.message}`);
                else     this.log.info(`MQTT: subscribed to ${this.mqttPrefix}/set/#`);
            });
        });

        this.mqttClient.on('message', (topic, message) => {
            const setPrefix = `${this.mqttPrefix}/set/`;
            if (!topic.startsWith(setPrefix)) return;
            const stateKey = topic.slice(setPrefix.length).replace(/\//g, '.');
            const raw      = message.toString();
            let val;
            // Auto-parse booleans and numbers
            if (raw === 'true')       val = true;
            else if (raw === 'false') val = false;
            else if (!isNaN(raw) && raw.trim() !== '') val = Number(raw);
            else val = raw;

            this.log.debug(`MQTT cmd: ${stateKey} = ${val}`);
            this.setStateAsync(stateKey, val, false).catch(() => {
                this.log.warn(`MQTT: unknown state "${stateKey}"`);
            });
        });

        this.mqttClient.on('error',   (e) => this.log.warn(`MQTT error: ${e.message}`));
        this.mqttClient.on('offline', ()  => this.log.info('MQTT: offline'));
        this.mqttClient.on('reconnect', () => this.log.debug('MQTT: reconnecting…'));
    }

    /**
     * Publish a value to MQTT.
     * Topic: {prefix}/state/{key}  e.g. lgtv/state/picture/mode
     */
    mqttPublish(stateKey, val) {
        if (!this.mqttClient || !this.mqttClient.connected) return;
        const topic   = `${this.mqttPrefix}/state/${stateKey.replace(/\./g, '/')}`;
        const payload = val === null || val === undefined ? '' : String(val);
        this.mqttClient.publish(topic, payload, { retain: true });
    }

    /** Write picture settings via SSAP (requires valid signed manifest with WRITE_SETTINGS). */
    _setPictureSetting(settings, cb) {
        this.tv.request('ssap://settings/setSystemSettings',
            { category: 'picture', settings },
            cb
        );
    }

    /** Write sound settings via SSAP. */
    _setSoundSetting(settings, cb) {
        this.tv.request('ssap://settings/setSystemSettings',
            { category: 'sound', settings },
            cb
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
            this.log.info(`Inputs: ${Object.values(states).join(', ')}`);
        });
    }

    requestChannelList() {
        this.tv.request('ssap://tv/getChannelList', (err, res) => {
            if (err || !res || !res.channelList) return;
            this.channels = res.channelList;
            const map = {};
            this.channels.forEach(c => { map[c.channelNumber] = c.channelName; });
            this.setStateAsync('channel.list', JSON.stringify(map), true);
            this.log.info(`Channels: ${this.channels.length}`);
        });
    }

    async onStateChange(id, state) {
        if (!state || state.ack) return;
        const key = id.split('.').slice(2).join('.');
        const val = state.val;
        this.log.debug(`Command: ${key} = ${val}`);

        if (key === 'power') {
            if (!val) {
                if (this.connected) this.tv.request('ssap://system/turnOff');
            } else {
                const mac = this.config.macAddress;
                if (mac) {
                    wol.wake(mac, { num_packets: 5 }, (err) => {
                        if (err) this.log.error(`WoL error: ${err}`);
                        else     this.log.info('WoL packet sent');
                    });
                } else {
                    this.log.warn('No MAC address configured — set it in adapter settings');
                }
            }
            return;
        }

        if (!this.connected) { this.log.warn(`TV not connected, ignoring: ${key}`); return; }

        switch (key) {
            case 'screenOff':
                this.tv.request(val
                    ? 'ssap://com.webos.service.tv.display/setScreenOff'
                    : 'ssap://com.webos.service.tv.display/setScreenOn');
                this.setStateAsync(id, val, true);
                break;
            case 'audio.volume': {
                const v = Math.max(0, Math.min(100, Math.round(val)));
                this.tv.request('ssap://audio/setVolume', { volume: v });
                this.setStateAsync(id, v, true);
                break;
            }
            case 'audio.mute':
                this.tv.request('ssap://audio/setMute', { mute: !!val });
                this.setStateAsync(id, !!val, true);
                break;
            case 'audio.soundMode': {
                this._setSoundSetting({ soundMode: val },
                    (err) => { if (err) this.log.warn(`sound mode write error: ${err.message}`); }
                );
                this.setStateAsync(id, val, true);
                const sn = SOUND_MODE_NUM[val];
                if (sn !== undefined) this.setStateAsync('audio.soundModeNum', sn, true);
                break;
            }
            case 'audio.soundModeNum': {
                const modeKey = SOUND_MODE_KEYS[val - 1];
                if (modeKey) {
                    this._setSoundSetting({ soundMode: modeKey },
                        (err) => { if (err) this.log.warn(`sound modeNum write error: ${err.message}`); }
                    );
                    this.setStateAsync(id, val, true);
                    this.setStateAsync('audio.soundMode', modeKey, true);
                }
                break;
            }
            case 'audio.soundOutput':
                this.tv.request('ssap://audio/changeSoundOutput', { output: val });
                this.setStateAsync(id, val, true);
                break;
            case 'audio.soundOutputNum': {
                const outputKey = SOUND_OUTPUT_KEYS[val - 1];
                if (outputKey) {
                    this.tv.request('ssap://audio/changeSoundOutput', { output: outputKey });
                    this.setStateAsync(id, val, true);
                    this.setStateAsync('audio.soundOutput', outputKey, true);
                }
                break;
            }
            case 'picture.mode': {
                this._setPictureSetting({ pictureMode: val }, (err) => {
                    if (err) this.log.warn(`picture mode write error: ${err.message}`);
                });
                this.setStateAsync(id, val, true);
                const pn = PICTURE_MODE_NUM[val];
                if (pn !== undefined) this.setStateAsync('picture.modeNum', pn, true);
                break;
            }
            case 'picture.modeNum': {
                const picKey = PICTURE_MODE_KEYS[val - 1];
                if (picKey) {
                    this._setPictureSetting({ pictureMode: picKey }, (err) => {
                        if (err) this.log.warn(`picture modeNum write error: ${err.message}`);
                    });
                    this.setStateAsync(id, val, true);
                    this.setStateAsync('picture.mode', picKey, true);
                }
                break;
            }
            case 'picture.brightness':
            case 'picture.contrast':
            case 'picture.backlight':
            case 'picture.color':
            case 'picture.sharpness': {
                const k = key.split('.')[1];
                const rounded = Math.round(val);
                const settingKey = k; // LG G4 uses 'backlight' (not 'oledLight') for OLED light
                this._setPictureSetting({ [settingKey]: String(rounded) },
                    (err) => { if (err) this.log.warn(`${k} write error: ${err.message}`); }
                );
                this.setStateAsync(id, rounded, true);
                break;
            }
            case 'input.current':
                this.tv.request('ssap://tv/switchInput', { inputId: val });
                this.setStateAsync(id, val, true);
                break;
            case 'channel.number': {
                const ch = this.channels.find(c => c.channelNumber === String(val));
                if (ch) {
                    this.tv.request('ssap://tv/openChannel', { channelId: ch.channelId });
                    this.setStateAsync(id, val, true);
                } else {
                    this.log.warn(`Channel ${val} not found`);
                }
                break;
            }
            case 'app.launch':
                this.tv.request('ssap://system.launcher/launch', { id: val });
                this.setStateAsync(id, val, true);
                break;
            default:
                if (key.startsWith('remote.')) {
                    const btn = key.replace('remote.', '');
                    if (this.inputSocket) {
                        this.inputSocket.send('button', { name: btn });
                        // Reset button back to false after press
                        setTimeout(() => this.setStateAsync(id, false, true), 300);
                    } else {
                        this.log.warn(`Remote socket not ready (${btn})`);
                        this.openInputSocket();
                    }
                }
        }
    }

    onUnload(callback) {
        try {
            if (this.reconnTimer) clearTimeout(this.reconnTimer);
            if (this.pollTimer)   clearInterval(this.pollTimer);
            if (this.tv)          this.tv.disconnect();
            if (this.mqttClient)  this.mqttClient.end();
        } catch (e) { this.log.error(e); }
        callback();
    }
}

if (require.main !== module) {
    module.exports = (options) => new LgtvFullAdapter(options);
} else {
    new LgtvFullAdapter();
}
