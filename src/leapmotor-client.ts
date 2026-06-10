/**
 * Leapmotor API Client
 * Tested on T03 with EU gateway: appgateway.leapmotor-international.de
 */

import * as crypto from 'node:crypto';
import * as https from 'node:https';
import * as forge from 'node-forge';
import axios, { AxiosInstance } from 'axios';
import {
    ApiHeaders,
    deriveAccountP12Password, deriveSignKey, deriveSessionDeviceId, encryptOperatePassword,
    buildLoginHeaders, buildSignedHeaders, buildOperpwdVerifyHeaders,
    buildRemoteCtlWriteHeaders, buildRemoteCtlWriteHeadersWithoutPin, buildRemoteCtlResultHeaders,
    buildCarPictureHeaders, buildCarPicturePackageHeaders, buildConsumptionWeeklyRankHeaders,
} from './leapmotor-crypto';

const BASE_URL = 'https://appgateway.leapmotor-international.de';
const KNOWN_P12_PASSWORDS = ['', 'leapmotor', 'leap123'];

export interface LeapmotorClientConfig {
    username: string;
    password: string;
    appCertPem: string;
    appKeyPem: string;
    operationPassword?: string;
    baseUrl?: string;
    language?: string;
}

export interface Vehicle {
    vin: string;
    carType: string;
    name: string;
    raw: Record<string, unknown>;
}

export class LeapmotorClient {
    private config: Required<LeapmotorClientConfig>;
    private http: AxiosInstance;
    private appHttp!: AxiosInstance;

    // Auth state
    userId: string | null = null;
    token: string | null = null;
    deviceId: string;
    signIkm: string | null = null;
    signSalt: string | null = null;
    signInfo: string | null = null;
    accountCertPem: string | null = null;
    accountKeyPem: string | null = null;

    constructor(config: LeapmotorClientConfig) {
        this.config = {
            baseUrl: config.baseUrl ?? BASE_URL,
            language: config.language ?? 'en-GB',
            operationPassword: config.operationPassword ?? '',
            ...config,
        };
        this.deviceId = crypto.randomUUID().replace(/-/g, '');
        this.http = this._createHttpClient(config.appCertPem, config.appKeyPem);
    }

    private _createHttpClient(certPem: string, keyPem: string): AxiosInstance {
        const agent = new https.Agent({ cert: certPem, key: keyPem, rejectUnauthorized: false });
        return axios.create({
            baseURL: this.config.baseUrl,
            timeout: 30000,
            httpsAgent: agent,
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        });
    }

    get _signKey(): Buffer {
        if (!this.signIkm) throw new Error('Not authenticated');
        return deriveSignKey(this.signIkm, this.signSalt!, this.signInfo!);
    }

    private _authHeaders(): Record<string, string> {
        if (!this.userId || !this.token) throw new Error('Not authenticated');
        return { userId: this.userId, token: this.token };
    }

    private _h(h: ApiHeaders): Record<string, string> {
        return {
            nonce: h.nonce, deviceId: h.deviceId, timestamp: h.timestamp,
            sign: h.sign, acceptLanguage: h.acceptLanguage,
            channel: '1', source: 'leapmotor', deviceType: '1', version: '1.12.3',
        };
    }

    private _parseResponse(data: unknown, label: string): Record<string, unknown> {
        const d = data as Record<string, unknown>;
        if (d.code !== 0) throw new Error(`${label} failed: ${d.message ?? JSON.stringify(d)}`);
        return d;
    }

    private _loadAccountCert(ld: Record<string, unknown>): void {
        const p12Der = Buffer.from(String(ld.base64Cert ?? ''), 'base64');
        const p12Asn1 = forge.asn1.fromDer(forge.util.createBuffer(p12Der));
        const pwds: string[] = [];
        try { pwds.push(deriveAccountP12Password(String(ld.id), String(ld.uid))); } catch { /* ignore */ }
        pwds.push(...KNOWN_P12_PASSWORDS);
        for (const pwd of pwds) {
            try {
                const p12 = forge.pkcs12.pkcs12FromAsn1(p12Asn1, pwd);
                const cb = p12.getBags({ bagType: forge.pki.oids.certBag });
                const kb = p12.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag });
                const cert = cb[forge.pki.oids.certBag]?.[0]?.cert;
                const key  = kb[forge.pki.oids.pkcs8ShroudedKeyBag]?.[0]?.key;
                if (cert && key) {
                    this.accountCertPem = forge.pki.certificateToPem(cert);
                    this.accountKeyPem  = forge.pki.privateKeyToPem(key);
                    return;
                }
            } catch { /* try next */ }
        }
        throw new Error('Could not open account certificate');
    }

    // ── Auth ─────────────────────────────────────────────────

    async login(): Promise<void> {
        // Always login with app cert (not account cert)
        const loginHttp = this.appHttp ?? this.http;
        const h = this._h(buildLoginHeaders({
            deviceId: this.deviceId, username: this.config.username,
            password: this.config.password, language: this.config.language,
        }));
        const body = new URLSearchParams({
            isRecoverAcct: '0', password: this.config.password,
            policyId: '20260204', loginMethod: '1', email: this.config.username,
        }).toString();
        const resp = await loginHttp.post('/carownerservice/oversea/acct/v1/login', body, { headers: h });
        const data = this._parseResponse(resp.data, 'login');
        const ld = (data.data ?? {}) as Record<string, unknown>;
        this.userId   = String(ld.id);
        this.token    = String(ld.token);
        this.deviceId = deriveSessionDeviceId(this.token, this.deviceId);
        this.signIkm  = String(ld.signIkm);
        this.signSalt = String(ld.signSalt);
        this.signInfo = String(ld.signInfo);
        this._loadAccountCert(ld);
        // Switch to account cert, keep app cert for re-login
        this.appHttp = this._createHttpClient(this.config.appCertPem, this.config.appKeyPem);
        this.http    = this._createHttpClient(this.accountCertPem!, this.accountKeyPem!);
    }

    // ── Vehicle ──────────────────────────────────────────────

    async getVehicleList(): Promise<Vehicle[]> {
        const h = { ...this._h(buildSignedHeaders({ signKey: this._signKey, deviceId: this.deviceId, language: this.config.language })), ...this._authHeaders() };
        const resp = await this.http.post('/carownerservice/oversea/vehicle/v1/list', '', { headers: h });
        const data = this._parseResponse(resp.data, 'vehicle list');
        const d = (data.data ?? {}) as Record<string, unknown>;
        const list = [...((d.bindcars as unknown[]) ?? []), ...((d.sharedcars as unknown[]) ?? [])];
        return list.filter((i: unknown) => (i as Record<string,unknown>)?.vin).map((i: unknown) => {
            const item = i as Record<string, unknown>;
            return { vin: String(item.vin), carType: String(item.carType ?? item.carAlias ?? 'T03'),
                     name: String(item.vinNickname ?? item.name ?? item.vin), raw: item };
        });
    }

    async getVehicleStatus(vehicle: Vehicle): Promise<Record<string, unknown>> {
        const ct = vehicle.carType.trim().toLowerCase();
        const h = { ...this._h(buildSignedHeaders({ signKey: this._signKey, deviceId: this.deviceId, vin: vehicle.vin, language: this.config.language })), ...this._authHeaders() };
        const resp = await this.http.post(`/carownerservice/oversea/vehicle/v1/status/get/${ct}`, `vin=${encodeURIComponent(vehicle.vin)}`, { headers: h });
        return (this._parseResponse(resp.data, 'vehicle status').data ?? {}) as Record<string, unknown>;
    }

    // ── Commands ─────────────────────────────────────────────

    async sendCommandWithoutPin(vehicle: Vehicle, cmdId: string, cmdContent: string): Promise<unknown> {
        const h = { ...this._h(buildRemoteCtlWriteHeadersWithoutPin({ signKey: this._signKey, deviceId: this.deviceId, vin: vehicle.vin, cmdContent, cmdId, language: this.config.language })), ...this._authHeaders() };
        const body = `cmdContent=${encodeURIComponent(cmdContent)}&vin=${encodeURIComponent(vehicle.vin)}&cmdId=${encodeURIComponent(cmdId)}`;
        const resp = await this.http.post('/carownerservice/oversea/vehicle/v1/app/remote/ctl', body, { headers: h });
        const result = this._parseResponse(resp.data, `remote ${cmdId}`);
        await this._pollResult(result);
        return result;
    }

    async sendCommandWithPin(vehicle: Vehicle, cmdId: string, cmdContent: string): Promise<unknown> {
        if (!this.config.operationPassword) throw new Error('operationPassword required');
        const ep = encryptOperatePassword(this.config.operationPassword, this.token);
        const vh = { ...this._h(buildOperpwdVerifyHeaders({ signKey: this._signKey, deviceId: this.deviceId, vin: vehicle.vin, operationPassword: ep, language: this.config.language })), ...this._authHeaders() };
        await this.http.post('/carownerservice/oversea/vehicle/v1/operPwd/verify', `operatePassword=${encodeURIComponent(ep)}&vin=${encodeURIComponent(vehicle.vin)}`, { headers: vh });
        const h = { ...this._h(buildRemoteCtlWriteHeaders({ signKey: this._signKey, deviceId: this.deviceId, vin: vehicle.vin, cmdContent, cmdId, operationPassword: ep, language: this.config.language })), ...this._authHeaders() };
        const body = `cmdContent=${encodeURIComponent(cmdContent)}&vin=${encodeURIComponent(vehicle.vin)}&cmdId=${encodeURIComponent(cmdId)}&operatePassword=${encodeURIComponent(ep)}`;
        const resp = await this.http.post('/carownerservice/oversea/vehicle/v1/app/remote/ctl', body, { headers: h });
        const result = this._parseResponse(resp.data, `remote ${cmdId}`);
        await this._pollResult(result);
        return result;
    }

    private async _pollResult(result: Record<string, unknown>): Promise<void> {
        const rd = (result.data ?? {}) as Record<string, unknown>;
        const id = String(rd.remoteCtlId ?? '');
        if (!id) return;
        const deadline = Date.now() + Math.max(Number(rd.queryRemoteCtlResultTimeout ?? 30000), 1000);
        const interval = Number(rd.queryInterval ?? 2000);
        while (Date.now() < deadline) {
            await new Promise(r => setTimeout(r, interval));
            const h = { ...this._h(buildRemoteCtlResultHeaders({ signKey: this._signKey, deviceId: this.deviceId, remoteCtlId: id, language: this.config.language })), ...this._authHeaders() };
            const resp = await this.http.post('/carownerservice/oversea/vehicle/v1/app/remote/ctl/result/query', `remoteCtlId=${encodeURIComponent(id)}`, { headers: h });
            if (this._parseResponse(resp.data, 'remote poll').data === 1) return;
        }
    }

    // ── Consumption ──────────────────────────────────────────

    async getMileageEnergyDetail(vehicle: Vehicle): Promise<Record<string, unknown>> {
        const h = { ...this._h(buildSignedHeaders({ signKey: this._signKey, deviceId: this.deviceId, vin: vehicle.vin, language: this.config.language })), ...this._authHeaders() };
        const resp = await this.http.post('/carownerservice/oversea/drivingRecord/v1/mileage/energy/detail', `vin=${encodeURIComponent(vehicle.vin)}`, { headers: h });
        return this._parseResponse(resp.data, 'mileage energy');
    }

    async getConsumptionWeeklyRank(vehicle: Vehicle): Promise<Record<string, unknown>> {
        const h = { ...this._h(buildConsumptionWeeklyRankHeaders({ signKey: this._signKey, deviceId: this.deviceId, carvin: vehicle.vin, language: this.config.language })), ...this._authHeaders() };
        const resp = await this.http.post('/carownerservice/oversea/drivingRecord/v1/getLastNweeks100kmECAndRank', `carvin=${encodeURIComponent(vehicle.vin)}`, { headers: h });
        return this._parseResponse(resp.data, 'consumption weekly');
    }

    // ── Pictures ─────────────────────────────────────────────

    async getCarPictureKey(vehicle: Vehicle): Promise<Record<string, unknown>> {
        const h = { ...this._h(buildCarPictureHeaders({ signKey: this._signKey, deviceId: this.deviceId, vin: vehicle.vin, language: this.config.language })), ...this._authHeaders() };
        const body = `deviceID=${encodeURIComponent(this.deviceId)}&vin=${encodeURIComponent(vehicle.vin)}`;
        const resp = await this.http.post('/carownerservice/oversea/vehicle/v1/carpicture/key', body, { headers: h });
        return this._parseResponse(resp.data, 'car picture key');
    }

    async downloadCarPictureZip(key: string): Promise<Buffer> {
        const h = { ...this._h(buildCarPicturePackageHeaders({ signKey: this._signKey, deviceId: this.deviceId, pictureKey: key, language: this.config.language })), ...this._authHeaders() };
        const body = `key=${encodeURIComponent(key)}`;
        const certPem = this.accountCertPem!;
        const keyPem  = this.accountKeyPem!;
        return new Promise((resolve, reject) => {
            const agent = new https.Agent({ cert: certPem, key: keyPem, rejectUnauthorized: false });
            const req = https.request({
                hostname: 'appgateway.leapmotor-international.de',
                path: '/carownerservice/oversea/vehicle/v1/carpicture/package',
                method: 'POST',
                agent,
                headers: { ...h, 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) },
                timeout: 60000,
            }, (res) => {
                const chunks: Buffer[] = [];
                res.on('data', c => chunks.push(c));
                res.on('end', () => resolve(Buffer.concat(chunks)));
                res.on('error', reject);
            });
            req.on('error', reject);
            req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
            req.write(body);
            req.end();
        });
    }
}
