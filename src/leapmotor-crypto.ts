/**
 * Leapmotor Cryptographic Operations
 *
 * Verified constants (from leapmotor-api==0.3.1):
 *   APP_VERSION = '1.12.3'
 *   CHANNEL     = '1'
 *   DEVICE_TYPE = '1'
 *   SOURCE      = 'leapmotor'
 *   POLICY_ID   = '20260204'
 *   LANGUAGE    = 'en-GB'
 */

import * as crypto from 'crypto';

// ── SM4 Tables ───────────────────────────────────────────────

const SM4_SBOX = new Uint8Array([
    0xD6, 0x90, 0xE9, 0xFE, 0xCC, 0xE1, 0x3D, 0xB7, 0x16, 0xB6, 0x14, 0xC2, 0x28, 0xFB, 0x2C, 0x05,
    0x2B, 0x67, 0x9A, 0x76, 0x2A, 0xBE, 0x04, 0xC3, 0xAA, 0x44, 0x13, 0x26, 0x49, 0x86, 0x06, 0x99,
    0x9C, 0x42, 0x50, 0xF4, 0x91, 0xEF, 0x98, 0x7A, 0x33, 0x54, 0x0B, 0x43, 0xED, 0xCF, 0xAC, 0x62,
    0xE4, 0xB3, 0x1C, 0xA9, 0xC9, 0x08, 0xE8, 0x95, 0x80, 0xDF, 0x94, 0xFA, 0x75, 0x8F, 0x3F, 0xA6,
    0x47, 0x07, 0xA7, 0xFC, 0xF3, 0x73, 0x17, 0xBA, 0x83, 0x59, 0x3C, 0x19, 0xE6, 0x85, 0x4F, 0xA8,
    0x68, 0x6B, 0x81, 0xB2, 0x71, 0x64, 0xDA, 0x8B, 0xF8, 0xEB, 0x0F, 0x4B, 0x70, 0x56, 0x9D, 0x35,
    0x1E, 0x24, 0x0E, 0x5E, 0x63, 0x58, 0xD1, 0xA2, 0x25, 0x22, 0x7C, 0x3B, 0x01, 0x21, 0x78, 0x87,
    0xD4, 0x00, 0x46, 0x57, 0x9F, 0xD3, 0x27, 0x52, 0x4C, 0x36, 0x02, 0xE7, 0xA0, 0xC4, 0xC8, 0x9E,
    0xEA, 0xBF, 0x8A, 0xD2, 0x40, 0xC7, 0x38, 0xB5, 0xA3, 0xF7, 0xF2, 0xCE, 0xF9, 0x61, 0x15, 0xA1,
    0xE0, 0xAE, 0x5D, 0xA4, 0x9B, 0x34, 0x1A, 0x55, 0xAD, 0x93, 0x32, 0x30, 0xF5, 0x8C, 0xB1, 0xE3,
    0x1D, 0xF6, 0xE2, 0x2E, 0x82, 0x66, 0xCA, 0x60, 0xC0, 0x29, 0x23, 0xAB, 0x0D, 0x53, 0x4E, 0x6F,
    0xD5, 0xDB, 0x37, 0x45, 0xDE, 0xFD, 0x8E, 0x2F, 0x03, 0xFF, 0x6A, 0x72, 0x6D, 0x6C, 0x5B, 0x51,
    0x8D, 0x1B, 0xAF, 0x92, 0xBB, 0xDD, 0xBC, 0x7F, 0x11, 0xD9, 0x5C, 0x41, 0x1F, 0x10, 0x5A, 0xD8,
    0x0A, 0xC1, 0x31, 0x88, 0xA5, 0xCD, 0x7B, 0xBD, 0x2D, 0x74, 0xD0, 0x12, 0xB8, 0xE5, 0xB4, 0xB0,
    0x89, 0x69, 0x97, 0x4A, 0x0C, 0x96, 0x77, 0x7E, 0x65, 0xB9, 0xF1, 0x09, 0xC5, 0x6E, 0xC6, 0x84,
    0x18, 0xF0, 0x7D, 0xEC, 0x3A, 0xDC, 0x4D, 0x20, 0x79, 0xEE, 0x5F, 0x3E, 0xD7, 0xCB, 0x39, 0x48,
]);

const P12_SM4_ROUND_KEYS = new Uint32Array([
    0x818FA553, 0xEBA3318D, 0x5FC3C93A, 0xBD1DADD9,
    0xBB61CAB9, 0x000FD7EA, 0xDC6E0166, 0xDA937279,
    0x607EE786, 0xB548754C, 0x107330E4, 0xEA17C186,
    0x0F56F74B, 0xB21E443C, 0xE1210FE2, 0x009995C8,
    0xE7529A48, 0x6EF474F6, 0x2AB06DF6, 0x43B11BE8,
    0x359D4A14, 0xC29E2CDE, 0x30CF6A3E, 0x79D1C806,
    0x7C502387, 0xAAAB9BC6, 0xF0FE744B, 0x1CAFC872,
    0x95A9D075, 0x88070D58, 0x22800475, 0x8391938B,
]);

const APP_VERSION    = '1.12.3';
const CHANNEL        = '1';
const DEVICE_TYPE    = '1';
const SOURCE         = 'leapmotor';
const POLICY_ID      = '20260204';
const DEFAULT_LANGUAGE = 'en-GB';

// ── SM4 Primitives ───────────────────────────────────────────

function rotateLeft32(value: number, bits: number): number {
    return ((value << bits) | (value >>> (32 - bits))) >>> 0;
}

function sm4Block(buf: Buffer): Buffer {
    let x0 = buf.readUInt32BE(0), x1 = buf.readUInt32BE(4);
    let x2 = buf.readUInt32BE(8), x3 = buf.readUInt32BE(12);
    for (let i = 0; i < 32; i++) {
        const t = (x1 ^ x2 ^ x3 ^ P12_SM4_ROUND_KEYS[i]) >>> 0;
        const b = ((SM4_SBOX[(t>>>24)&0xFF]<<24)|(SM4_SBOX[(t>>>16)&0xFF]<<16)|(SM4_SBOX[(t>>>8)&0xFF]<<8)|SM4_SBOX[t&0xFF]) >>> 0;
        const n = (x0^b^rotateLeft32(b,2)^rotateLeft32(b,10)^rotateLeft32(b,18)^rotateLeft32(b,24)) >>> 0;
        x0=x1; x1=x2; x2=x3; x3=n;
    }
    const r = Buffer.alloc(16);
    r.writeUInt32BE(x3,0); r.writeUInt32BE(x2,4); r.writeUInt32BE(x1,8); r.writeUInt32BE(x0,12);
    return r;
}

function p12Encode(data: Buffer): Buffer {
    const p = 16 - (data.length % 16);
    const pad = Buffer.alloc(data.length + p);
    data.copy(pad); pad.fill(p, data.length);
    const res = Buffer.alloc(pad.length);
    for (let i = 0; i < pad.length / 16; i++) sm4Block(pad.slice(i*16,(i+1)*16)).copy(res,i*16);
    return res;
}

// ── Exported Crypto Functions ────────────────────────────────

export function deriveAccountP12Password(id: string | number, uid: string): string {
    const cn   = crypto.createHash('md5').update(String(id)).digest('hex');
    const even = cn.split('').filter((_,i) => i%2===0).join('');
    const odd  = uid.split('').filter((_,i) => i%2===1).join('');
    const digest = crypto.createHash('sha256').update(cn+even+odd,'ascii').digest();
    return p12Encode(digest).slice(0,12).toString('base64').slice(0,15);
}

export function deriveSignKey(ikm: string, salt: string, info: string): Buffer {
    return Buffer.from(crypto.hkdfSync('sha256',Buffer.from(ikm),Buffer.from(salt),Buffer.from(info),32));
}

export function encryptOperatePassword(pin: string, token: string | null): string {
    let k='defaultkeydefault', v='defaultivdefault!';
    if (token && token.length >= 64) {
        k = crypto.createHash('md5').update(token.slice(0,32)).digest('hex').slice(8,24);
        v = crypto.createHash('md5').update(token.slice(32,64)).digest('hex').slice(8,24);
    }
    const c = crypto.createCipheriv('aes-128-cbc',Buffer.from(k),Buffer.from(v));
    return Buffer.concat([c.update(Buffer.from(pin)),c.final()]).toString('base64');
}

export function deriveSessionDeviceId(token: string | null, fallback: string): string {
    if (!token) return fallback;
    try {
        const parts = token.split('.');
        if (parts.length < 2) return fallback;
        const pl = JSON.parse(Buffer.from(parts[1],'base64').toString('utf8'));
        const un = String((pl as Record<string,unknown>)?.user_name ?? '');
        const segs = un.split(',');
        if (segs.length >= 4 && segs[2]) return segs[2];
    } catch { /* ignore */ }
    return fallback;
}

// ── Header Types & Builders ──────────────────────────────────

export interface ApiHeaders { nonce:string; deviceId:string; timestamp:string; sign:string; acceptLanguage:string; }

function rn(): string { return String(Math.floor(Math.random()*9900000+100000)); }
function hmacSign(key: Buffer, input: string): string { return crypto.createHmac('sha256',key).update(input).digest('hex'); }

export function buildLoginHeaders(p:{deviceId:string;username:string;password:string;language?:string}): ApiHeaders {
    const lang=p.language??DEFAULT_LANGUAGE, n=rn(), ts=String(Date.now());
    const si=[lang,DEVICE_TYPE,p.deviceId,'1',p.username,'0','1',n,p.password,POLICY_ID,SOURCE,ts,APP_VERSION].join('');
    return{nonce:n,deviceId:p.deviceId,timestamp:ts,sign:crypto.createHash('sha256').update(si).digest('hex'),acceptLanguage:lang};
}

export function buildSignedHeaders(p:{signKey:Buffer;deviceId:string;vin?:string;language?:string;bodyParams?:Record<string,string>}): ApiHeaders {
    const lang=p.language??DEFAULT_LANGUAGE, n=rn(), ts=String(Date.now());
    const f:Record<string,string>={acceptLanguage:lang,channel:CHANNEL,deviceId:p.deviceId,deviceType:DEVICE_TYPE,nonce:n,source:SOURCE,timestamp:ts,version:APP_VERSION};
    if(p.vin)f.vin=p.vin; if(p.bodyParams)Object.assign(f,p.bodyParams);
    const si=Object.keys(f).sort().map(k=>f[k]).join('');
    return{nonce:n,deviceId:p.deviceId,timestamp:ts,sign:hmacSign(p.signKey,si),acceptLanguage:lang};
}

export function buildOperpwdVerifyHeaders(p:{signKey:Buffer;deviceId:string;vin:string;operationPassword:string;language?:string}): ApiHeaders {
    const lang=p.language??DEFAULT_LANGUAGE, n=rn(), ts=String(Date.now());
    const si=[lang,CHANNEL,p.deviceId,DEVICE_TYPE,n,p.operationPassword,SOURCE,ts,APP_VERSION,p.vin].join('');
    return{nonce:n,deviceId:p.deviceId,timestamp:ts,sign:hmacSign(p.signKey,si),acceptLanguage:lang};
}

export function buildRemoteCtlWriteHeadersWithoutPin(p:{signKey:Buffer;deviceId:string;vin:string;cmdContent:string;cmdId:string;language?:string}): ApiHeaders {
    const lang=p.language??DEFAULT_LANGUAGE, n=rn(), ts=String(Date.now());
    const si=[lang,CHANNEL,p.cmdContent,p.cmdId,p.deviceId,DEVICE_TYPE,n,SOURCE,ts,APP_VERSION,p.vin].join('');
    return{nonce:n,deviceId:p.deviceId,timestamp:ts,sign:hmacSign(p.signKey,si),acceptLanguage:lang};
}

export function buildRemoteCtlWriteHeaders(p:{signKey:Buffer;deviceId:string;vin:string;cmdContent:string;cmdId:string;operationPassword:string;language?:string}): ApiHeaders {
    const lang=p.language??DEFAULT_LANGUAGE, n=rn(), ts=String(Date.now());
    const si=[lang,CHANNEL,p.cmdContent,p.cmdId,p.deviceId,DEVICE_TYPE,n,p.operationPassword,SOURCE,ts,APP_VERSION,p.vin].join('');
    return{nonce:n,deviceId:p.deviceId,timestamp:ts,sign:hmacSign(p.signKey,si),acceptLanguage:lang};
}

export function buildRemoteCtlResultHeaders(p:{signKey:Buffer;deviceId:string;remoteCtlId:string;language?:string}): ApiHeaders {
    const lang=p.language??DEFAULT_LANGUAGE, n=rn(), ts=String(Date.now());
    const si=[lang,CHANNEL,p.deviceId,DEVICE_TYPE,n,p.remoteCtlId,SOURCE,ts,APP_VERSION].join('');
    return{nonce:n,deviceId:p.deviceId,timestamp:ts,sign:hmacSign(p.signKey,si),acceptLanguage:lang};
}

/** carpicture/key: deviceId appears twice in signature */
export function buildCarPictureHeaders(p:{signKey:Buffer;deviceId:string;vin:string;language?:string}): ApiHeaders {
    const lang=p.language??DEFAULT_LANGUAGE, n=rn(), ts=String(Date.now());
    const si=[lang,p.deviceId,CHANNEL,p.deviceId,DEVICE_TYPE,n,SOURCE,ts,APP_VERSION,p.vin].join('');
    return{nonce:n,deviceId:p.deviceId,timestamp:ts,sign:hmacSign(p.signKey,si),acceptLanguage:lang};
}

/** carpicture/package: uses pictureKey in signature */
export function buildCarPicturePackageHeaders(p:{signKey:Buffer;deviceId:string;pictureKey:string;language?:string}): ApiHeaders {
    const lang=p.language??DEFAULT_LANGUAGE, n=rn(), ts=String(Date.now());
    const si=[lang,CHANNEL,p.deviceId,DEVICE_TYPE,p.pictureKey,n,SOURCE,ts,APP_VERSION].join('');
    return{nonce:n,deviceId:p.deviceId,timestamp:ts,sign:hmacSign(p.signKey,si),acceptLanguage:lang};
}

/** consumption weekly rank: uses carvin in signature */
export function buildConsumptionWeeklyRankHeaders(p:{signKey:Buffer;deviceId:string;carvin:string;language?:string}): ApiHeaders {
    const lang=p.language??DEFAULT_LANGUAGE, n=rn(), ts=String(Date.now());
    const si=[lang,p.carvin,CHANNEL,p.deviceId,DEVICE_TYPE,n,SOURCE,ts,APP_VERSION].join('');
    return{nonce:n,deviceId:p.deviceId,timestamp:ts,sign:hmacSign(p.signKey,si),acceptLanguage:lang};
}
