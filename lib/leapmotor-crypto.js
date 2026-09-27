'use strict';
Object.defineProperty(exports, '__esModule', { value: true });
const crypto = require('node:crypto');
const SM4_SBOX = new Uint8Array([
    0xd6, 0x90, 0xe9, 0xfe, 0xcc, 0xe1, 0x3d, 0xb7, 0x16, 0xb6, 0x14, 0xc2, 0x28, 0xfb, 0x2c, 0x05, 0x2b, 0x67, 0x9a,
    0x76, 0x2a, 0xbe, 0x04, 0xc3, 0xaa, 0x44, 0x13, 0x26, 0x49, 0x86, 0x06, 0x99, 0x9c, 0x42, 0x50, 0xf4, 0x91, 0xef,
    0x98, 0x7a, 0x33, 0x54, 0x0b, 0x43, 0xed, 0xcf, 0xac, 0x62, 0xe4, 0xb3, 0x1c, 0xa9, 0xc9, 0x08, 0xe8, 0x95, 0x80,
    0xdf, 0x94, 0xfa, 0x75, 0x8f, 0x3f, 0xa6, 0x47, 0x07, 0xa7, 0xfc, 0xf3, 0x73, 0x17, 0xba, 0x83, 0x59, 0x3c, 0x19,
    0xe6, 0x85, 0x4f, 0xa8, 0x68, 0x6b, 0x81, 0xb2, 0x71, 0x64, 0xda, 0x8b, 0xf8, 0xeb, 0x0f, 0x4b, 0x70, 0x56, 0x9d,
    0x35, 0x1e, 0x24, 0x0e, 0x5e, 0x63, 0x58, 0xd1, 0xa2, 0x25, 0x22, 0x7c, 0x3b, 0x01, 0x21, 0x78, 0x87, 0xd4, 0x00,
    0x46, 0x57, 0x9f, 0xd3, 0x27, 0x52, 0x4c, 0x36, 0x02, 0xe7, 0xa0, 0xc4, 0xc8, 0x9e, 0xea, 0xbf, 0x8a, 0xd2, 0x40,
    0xc7, 0x38, 0xb5, 0xa3, 0xf7, 0xf2, 0xce, 0xf9, 0x61, 0x15, 0xa1, 0xe0, 0xae, 0x5d, 0xa4, 0x9b, 0x34, 0x1a, 0x55,
    0xad, 0x93, 0x32, 0x30, 0xf5, 0x8c, 0xb1, 0xe3, 0x1d, 0xf6, 0xe2, 0x2e, 0x82, 0x66, 0xca, 0x60, 0xc0, 0x29, 0x23,
    0xab, 0x0d, 0x53, 0x4e, 0x6f, 0xd5, 0xdb, 0x37, 0x45, 0xde, 0xfd, 0x8e, 0x2f, 0x03, 0xff, 0x6a, 0x72, 0x6d, 0x6c,
    0x5b, 0x51, 0x8d, 0x1b, 0xaf, 0x92, 0xbb, 0xdd, 0xbc, 0x7f, 0x11, 0xd9, 0x5c, 0x41, 0x1f, 0x10, 0x5a, 0xd8, 0x0a,
    0xc1, 0x31, 0x88, 0xa5, 0xcd, 0x7b, 0xbd, 0x2d, 0x74, 0xd0, 0x12, 0xb8, 0xe5, 0xb4, 0xb0, 0x89, 0x69, 0x97, 0x4a,
    0x0c, 0x96, 0x77, 0x7e, 0x65, 0xb9, 0xf1, 0x09, 0xc5, 0x6e, 0xc6, 0x84, 0x18, 0xf0, 0x7d, 0xec, 0x3a, 0xdc, 0x4d,
    0x20, 0x79, 0xee, 0x5f, 0x3e, 0xd7, 0xcb, 0x39, 0x48,
]);
const RK = new Uint32Array([
    0x818fa553, 0xeba3318d, 0x5fc3c93a, 0xbd1dadd9, 0xbb61cab9, 0x000fd7ea, 0xdc6e0166, 0xda937279, 0x607ee786,
    0xb548754c, 0x107330e4, 0xea17c186, 0x0f56f74b, 0xb21e443c, 0xe1210fe2, 0x009995c8, 0xe7529a48, 0x6ef474f6,
    0x2ab06df6, 0x43b11be8, 0x359d4a14, 0xc29e2cde, 0x30cf6a3e, 0x79d1c806, 0x7c502387, 0xaaab9bc6, 0xf0fe744b,
    0x1cafc872, 0x95a9d075, 0x88070d58, 0x22800475, 0x8391938b,
]);
function rl(v, b) {
    return ((v << b) | (v >>> (32 - b))) >>> 0;
}
function sm4Block(buf) {
    let x0 = buf.readUInt32BE(0),
        x1 = buf.readUInt32BE(4),
        x2 = buf.readUInt32BE(8),
        x3 = buf.readUInt32BE(12);
    for (let i = 0; i < 32; i++) {
        const t = (x1 ^ x2 ^ x3 ^ RK[i]) >>> 0;
        const b =
            ((SM4_SBOX[(t >>> 24) & 0xff] << 24) |
                (SM4_SBOX[(t >>> 16) & 0xff] << 16) |
                (SM4_SBOX[(t >>> 8) & 0xff] << 8) |
                SM4_SBOX[t & 0xff]) >>>
            0;
        const n = (x0 ^ b ^ rl(b, 2) ^ rl(b, 10) ^ rl(b, 18) ^ rl(b, 24)) >>> 0;
        x0 = x1;
        x1 = x2;
        x2 = x3;
        x3 = n;
    }
    const r = Buffer.alloc(16);
    r.writeUInt32BE(x3, 0);
    r.writeUInt32BE(x2, 4);
    r.writeUInt32BE(x1, 8);
    r.writeUInt32BE(x0, 12);
    return r;
}
function p12Encode(data) {
    const p = 16 - (data.length % 16);
    const pad = Buffer.alloc(data.length + p);
    data.copy(pad);
    pad.fill(p, data.length);
    const res = Buffer.alloc(pad.length);
    for (let i = 0; i < pad.length / 16; i++) {
        sm4Block(pad.slice(i * 16, (i + 1) * 16)).copy(res, i * 16);
    }
    return res;
}
function deriveAccountP12Password(id, uid) {
    const cn = crypto.createHash('md5').update(String(id)).digest('hex');
    const even = cn
        .split('')
        .filter((_, i) => i % 2 === 0)
        .join('');
    const odd = uid
        .split('')
        .filter((_, i) => i % 2 === 1)
        .join('');
    const digest = crypto
        .createHash('sha256')
        .update(cn + even + odd, 'ascii')
        .digest();
    return p12Encode(digest).slice(0, 12).toString('base64').slice(0, 15);
}
function deriveSignKey(ikm, salt, info) {
    return Buffer.from(crypto.hkdfSync('sha256', Buffer.from(ikm), Buffer.from(salt), Buffer.from(info), 32));
}
function deriveOperpwdKeyIv(token) {
    if (!token || token.length < 64) {
        return ['defaultkeydefault', 'defaultivdefault!'];
    }
    const k = crypto.createHash('md5').update(token.slice(0, 32)).digest('hex').slice(8, 24);
    const v = crypto.createHash('md5').update(token.slice(32, 64)).digest('hex').slice(8, 24);
    return [k, v];
}
function encryptOperatePassword(pin, token) {
    const [k, v] = deriveOperpwdKeyIv(token);
    const c = crypto.createCipheriv('aes-128-cbc', Buffer.from(k), Buffer.from(v));
    return Buffer.concat([c.update(Buffer.from(pin)), c.final()]).toString('base64');
}
function deriveSessionDeviceId(token, fallback) {
    if (!token) {
        return fallback;
    }
    try {
        const p = token.split('.');
        if (p.length < 2) {
            return fallback;
        }
        const pl = JSON.parse(Buffer.from(p[1], 'base64').toString('utf8'));
        const un = String(pl?.user_name ?? '');
        const s = un.split(',');
        if (s.length >= 4 && s[2]) {
            return s[2];
        }
    } catch {
        // fall through to fallback below
    }
    return fallback;
}
const VER = '1.12.3',
    CH = '1',
    DT = '1',
    SRC = 'leapmotor';
function nonce() {
    return String(Math.floor(Math.random() * 9900000 + 100000));
}
function buildLoginHeaders({ deviceId, username, password, language = 'en-GB' }) {
    const n = nonce(),
        ts = String(Date.now());
    const si = [language, DT, deviceId, '1', username, '0', '1', n, password, '20260204', SRC, ts, VER].join('');
    return {
        nonce: n,
        deviceId,
        timestamp: ts,
        sign: crypto.createHash('sha256').update(si).digest('hex'),
        acceptLanguage: language,
    };
}
function buildSignedHeaders({ signKey, deviceId, vin, language = 'en-GB', bodyParams }) {
    const n = nonce(),
        ts = String(Date.now());
    const f = {
        acceptLanguage: language,
        channel: CH,
        deviceId,
        deviceType: DT,
        nonce: n,
        source: SRC,
        timestamp: ts,
        version: VER,
    };
    if (vin) {
        f.vin = vin;
    }
    if (bodyParams) {
        Object.assign(f, bodyParams);
    }
    const si = Object.keys(f)
        .sort()
        .map(k => f[k])
        .join('');
    return {
        nonce: n,
        deviceId,
        timestamp: ts,
        sign: crypto.createHmac('sha256', signKey).update(si).digest('hex'),
        acceptLanguage: language,
    };
}
function buildOperpwdVerifyHeaders({ signKey, deviceId, vin, operationPassword, language = 'en-GB' }) {
    const n = nonce(),
        ts = String(Date.now());
    const si = [language, CH, deviceId, DT, n, operationPassword, SRC, ts, VER, vin].join('');
    return {
        nonce: n,
        deviceId,
        timestamp: ts,
        sign: crypto.createHmac('sha256', signKey).update(si).digest('hex'),
        acceptLanguage: language,
    };
}
function buildRemoteCtlWriteHeadersWithoutPin({ signKey, deviceId, vin, cmdContent, cmdId, language = 'en-GB' }) {
    const n = nonce(),
        ts = String(Date.now());
    const si = [language, CH, cmdContent, cmdId, deviceId, DT, n, SRC, ts, VER, vin].join('');
    return {
        nonce: n,
        deviceId,
        timestamp: ts,
        sign: crypto.createHmac('sha256', signKey).update(si).digest('hex'),
        acceptLanguage: language,
    };
}
function buildRemoteCtlWriteHeaders({
    signKey,
    deviceId,
    vin,
    cmdContent,
    cmdId,
    operationPassword,
    language = 'en-GB',
}) {
    const n = nonce(),
        ts = String(Date.now());
    const si = [language, CH, cmdContent, cmdId, deviceId, DT, n, operationPassword, SRC, ts, VER, vin].join('');
    return {
        nonce: n,
        deviceId,
        timestamp: ts,
        sign: crypto.createHmac('sha256', signKey).update(si).digest('hex'),
        acceptLanguage: language,
    };
}
function buildRemoteCtlResultHeaders({ signKey, deviceId, remoteCtlId, language = 'en-GB' }) {
    const n = nonce(),
        ts = String(Date.now());
    const si = [language, CH, deviceId, DT, n, remoteCtlId, SRC, ts, VER].join('');
    return {
        nonce: n,
        deviceId,
        timestamp: ts,
        sign: crypto.createHmac('sha256', signKey).update(si).digest('hex'),
        acceptLanguage: language,
    };
}
function buildConsumptionLastWeekHeaders({ signKey, deviceId, carvin, begintime, endtime, language = 'en-GB' }) {
    const n = nonce(),
        ts = String(Date.now());
    const si = [language, begintime, carvin, CH, deviceId, DT, endtime, n, SRC, ts, VER].join('');
    return {
        nonce: n,
        deviceId,
        timestamp: ts,
        sign: crypto.createHmac('sha256', signKey).update(si).digest('hex'),
        acceptLanguage: language,
    };
}
exports.deriveAccountP12Password = deriveAccountP12Password;
exports.deriveSignKey = deriveSignKey;
exports.encryptOperatePassword = encryptOperatePassword;
exports.deriveSessionDeviceId = deriveSessionDeviceId;
exports.buildLoginHeaders = buildLoginHeaders;
exports.buildSignedHeaders = buildSignedHeaders;
exports.buildOperpwdVerifyHeaders = buildOperpwdVerifyHeaders;
exports.buildRemoteCtlWriteHeadersWithoutPin = buildRemoteCtlWriteHeadersWithoutPin;
exports.buildRemoteCtlWriteHeaders = buildRemoteCtlWriteHeaders;
exports.buildRemoteCtlResultHeaders = buildRemoteCtlResultHeaders;
exports.buildConsumptionLastWeekHeaders = buildConsumptionLastWeekHeaders;
