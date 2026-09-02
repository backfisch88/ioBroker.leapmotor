'use strict';
Object.defineProperty(exports,"__esModule",{value:true});
const crypto=require('node:crypto');
const https=require('node:https');
const forge=require('node-forge');
const axios=require('axios');
const {deriveAccountP12Password,deriveSignKey,deriveSessionDeviceId,encryptOperatePassword,buildLoginHeaders,buildSignedHeaders,buildRemoteCtlWriteHeaders,buildRemoteCtlWriteHeadersWithoutPin,buildRemoteCtlResultHeaders,buildOperpwdVerifyHeaders,buildConsumptionLastWeekHeaders}=require('./leapmotor-crypto');
const KNOWN_PASSWORDS=['','leapmotor','leap123'];

// The vehicle status endpoint path segment does not always match the
// vehicle's own carType 1:1. Models that share the same underlying
// platform/backend as another model (e.g. B10 sits on the same LEAP
// platform family as the C10) use that other model's endpoint segment
// instead of their own name. CONFIRMED for B10->c10 via a real B10 owner
// running probe-status-endpoint.js (2026-07): the "c10" segment returned
// real vehicle data (GPS/signal values), not just a generic 200 response.
// Unmapped models fall back to their own carType, lowercased (this is
// what already works for T03).
const STATUS_ENDPOINT_OVERRIDES={
    B10:'c10',
    // B05, C16 are suspected to share the same C10-family endpoint but this
    // is UNCONFIRMED - add/adjust here once verified by an owner via
    // probe-status-endpoint.js.
};

function mapCarTypeToStatusEndpoint(carType){
    const ct=String(carType||'').trim();
    const override=STATUS_ENDPOINT_OVERRIDES[ct.toUpperCase()];
    return (override||ct).toLowerCase();
}

// C10/B10 (and presumably other C-/B-platform models) return status data as a
// flat "signal" dictionary of numeric IDs plus a separate "config" object,
// instead of T03's human-readable named fields. This table converts the
// known signal IDs into the same named fields the rest of the adapter
// already expects (matching the T03 response shape), so writeStatusStates()
// in main.js works unmodified regardless of model.
//
// Source: cross-referenced between two independent community reverse-
// engineering projects (leapmotor-api's docs/vehicles.md and the more
// mature leapmotor-ha Home Assistant integration's api.py, which explicitly
// live-verified some of these against a real C10/B10), plus a real B10
// status dump obtained via probe-status-endpoint.js, 2026-07. Signal IDs
// without a confirmed meaning are intentionally left unmapped rather than
// guessed. Some named T03 fields (outdoor temperature, AC wind direction,
// AC fan speed setting, AC cooling/heating mode chip, Bluetooth/hotspot
// on-off state, door-control-allowed flag, PTC preheat active-state) appear
// to genuinely not be present in the C10/B10 signal response at all - both
// reference projects only ever read those via named top-level fields,
// never via a signal ID, which only exist on the T03-style response.
const SIGNAL_FIELD_MAP={
    // Battery and charging
    '1204':'soc',
    '1178':'batteryCurrent',
    '1177':'batteryVoltage',
    '1200':'chargeRemainTime',
    '1197':'dcInputFastCharge',
    '1149':'chargeState',
    '1182':'minSingleTemp',
    // Driving and movement
    '1319':'speed',
    '1318':'totalMileage',
    '1010':'gearStatus',
    '3260':'expectedMileage',
    // GPS location (3724/3725 preferred, 2190/2191 used as fallback below)
    '3725':'latitude',
    '3724':'longitude',
    '2190':'latitudeFallback',
    '2191':'longitudeFallback',
    // Climate
    '1938':'acSwitch',
    '2183':'acSetting',
    '1941':'acAirVolume',
    '1943':'acCircleMode',
    // Air distribution / vent direction. Community-confirmed via a real B10
    // owner's before/after tests, 2026-07: 0=face, 2=feet, 4=windshield,
    // 6=face+feet+windshield combined. This numeric encoding is specific to
    // the C10/B10 signal response and passed through as-is; T03's own
    // acWindDirection field (if it uses different values) is unaffected
    // since T03 doesn't go through this signal-mapping path at all.
    '1944':'acWindDirection',
    // Ignition (used to derive key_position)
    '1256':'bcmKeyPositionOn1',
    '1258':'bcmKeyPositionOn3',
    // Doors and locks
    '1298':'driverDoorLockStatus',
    '1277':'lbcmDriverDoorStatus',
    '1278':'rbcmDriverDoorStatus',
    '1279':'lbcmLeftRearDoorStatus',
    '1280':'rbcmRightRearDoorStatus',
    '1281':'bbcmBackDoorStatus',
    // Windows
    '3727':'leftFrontWindowPercent',
    '3728':'rightFrontWindowPercent',
    '1879':'leftRearWindowPercent',
    '1880':'rightRearWindowPercent',
    '1693':'driverWindowStatus',
    '1694':'rightFrontWindowStatus',
    '1695':'leftRearWindowStatus',
    '1696':'rightRearWindowStatus',
    // Electric sunroof/skylight opening (confirmed on B10, cross-referenced
    // between leapmotor-api docs and leapmotor-ha project as "roofOpening"/
    // "skylight_open"). Written to the same status.sun_shade datapoint as
    // T03's flat sunShade field.
    '1724':'sunShade',
    // Tire pressure (raw kPa*100, converted like T03 elsewhere via tire())
    // NOTE: these 4 IDs were corrected 2026-07 after cross-referencing against
    // the leapmotor-ha project's live-verified mapping - our first pass had
    // front/rear diagonally swapped (2646 is front-left, not rear-left).
    '2646':'leftFrontTirePressure',
    '2653':'rightFrontTirePressure',
    '2660':'leftRearTirePressure',
    '2667':'rightRearTirePressure',
    '2641':'leftFrontTirePressureState',
    '2648':'rightFrontTirePressureState',
    '2655':'leftRearTirePressureState',
    '2662':'rightRearTirePressureState',
    // Battery preheat power (confirmed via leapmotor-ha project, 2026-07)
    '1348':'ptcPowerSettingValue',
};

function mergeSignalToNamed(data){
    const signal=data.signal||{};
    const config=data.config||{};
    const named={privacyGPS:data.privacyGPS,privacyData:data.privacyData};

    for(const [id,fieldName] of Object.entries(SIGNAL_FIELD_MAP)){
        if(signal[id]!==undefined)named[fieldName]=signal[id];
    }
    // GPS fallback: use 2190/2191 only if the primary 3724/3725 pair is missing
    if(named.latitude===undefined&&named.latitudeFallback!==undefined)named.latitude=named.latitudeFallback;
    if(named.longitude===undefined&&named.longitudeFallback!==undefined)named.longitude=named.longitudeFallback;

    // Charge plan lives in config.3 (not in signal) on C10/B10
    const plan=config['3'];
    if(plan){
        if(plan.percent!==undefined)named.chargesocSetting=plan.percent;
        if(plan.beginTime!==undefined&&plan.endTime!==undefined)named.chargeTimeSetting=`${plan.beginTime}-${plan.endTime}`;
    }
    // Bluetooth MAC lives in config.4 on C10/B10
    const bt=config['4'];
    if(bt&&bt.mac!==undefined)named.bluetoothAddr=bt.mac;

    // Timestamp: "sts" is epoch ms, T03 reports a formatted string instead
    if(signal.sts!==undefined){
        named.collectTimeMs=signal.sts;
        named.collectTime=new Date(signal.sts).toLocaleString('de-DE',{timeZone:'Europe/Berlin'});
    }

    return named;
}

class LeapmotorClient{
    constructor(config){
        this.userId=null;this.token=null;this.signIkm=null;this.signSalt=null;this.signInfo=null;
        this.accountCertPem=null;this.accountKeyPem=null;
        this._rawStatusDumped=new Set();
        this.config={baseUrl:config.baseUrl||'https://appgateway.leapmotor-international.de',timeout:config.timeout||30000,language:config.language||'en-GB',operationPassword:config.operationPassword||'',...config};
        this.deviceId=crypto.randomUUID().replace(/-/g,'');
        this.appCertPem=config.appCertPem;
        this._adapter=config.adapterInstance||null;
        this.appKeyPem=config.appKeyPem;
        this.http=this._createHttpClient(config.appCertPem,config.appKeyPem);
    }
    // NOTE: rejectUnauthorized is intentionally false here. The Leapmotor cloud API uses a
    // client-certificate (mTLS) based authentication scheme with a non-standard/internal CA
    // chain for its server certificate that is not part of the public trust store, so standard
    // certificate validation cannot succeed against this specific first-party endpoint.
    _createHttpClient(certPem,keyPem){const agent=new https.Agent({cert:certPem,key:keyPem,rejectUnauthorized:false});return axios.create({baseURL:this.config.baseUrl,timeout:this.config.timeout,httpsAgent:agent,headers:{'Content-Type':'application/x-www-form-urlencoded'}})}
    get _signKey(){if(!this.signIkm)throw new Error('Not authenticated');return Buffer.from(deriveSignKey(this.signIkm,this.signSalt,this.signInfo))}
    _authHeaders(){if(!this.userId||!this.token)throw new Error('Not authenticated');return{userId:this.userId,token:this.token}}
    _h(h){return{nonce:h.nonce,deviceId:h.deviceId,timestamp:h.timestamp,sign:h.sign,acceptLanguage:h.acceptLanguage,channel:'1',source:'leapmotor',deviceType:'1',version:'1.12.3'}}
    _parseResponse(data,label){if(data.code!==0){const msg=String(data.message||JSON.stringify(data));throw new Error(`${label} failed: ${msg}`)}return data}
    _loadAccountCert(ld){
        const p12Der=Buffer.from(String(ld.base64Cert||''),'base64');
        const p12Asn1=forge.asn1.fromDer(forge.util.createBuffer(p12Der));
        const pwds=[];
        try{pwds.push(deriveAccountP12Password(String(ld.id),String(ld.uid)))}catch{}
        pwds.push(...KNOWN_PASSWORDS);
        for(const pwd of pwds){try{const p12=forge.pkcs12.pkcs12FromAsn1(p12Asn1,pwd);const cb=p12.getBags({bagType:forge.pki.oids.certBag});const kb=p12.getBags({bagType:forge.pki.oids.pkcs8ShroudedKeyBag});const cert=cb[forge.pki.oids.certBag]?.[0]?.cert;const key=kb[forge.pki.oids.pkcs8ShroudedKeyBag]?.[0]?.key;if(cert&&key){this.accountCertPem=forge.pki.certificateToPem(cert);this.accountKeyPem=forge.pki.privateKeyToPem(key);return}}catch{}}
        throw new Error('Could not open account certificate');
    }
    async login(){
        const h=this._h(buildLoginHeaders({deviceId:this.deviceId,username:this.config.username,password:this.config.password,language:this.config.language}));
        const body=new URLSearchParams({isRecoverAcct:'0',password:this.config.password,policyId:'20260204',loginMethod:'1',email:this.config.username}).toString();
        const loginHttp=this.appHttp||this.http;
        const resp=await loginHttp.post('/carownerservice/oversea/acct/v1/login',body,{headers:h});
        const data=this._parseResponse(resp.data,'login');const ld=data.data||{};
        this.userId=String(ld.id);this.token=String(ld.token);
        this.deviceId=deriveSessionDeviceId(this.token,this.deviceId);
        this.signIkm=String(ld.signIkm);this.signSalt=String(ld.signSalt);this.signInfo=String(ld.signInfo);
        this._loadAccountCert(ld);
        this.http=this._createHttpClient(this.accountCertPem,this.accountKeyPem);
        this.appHttp=this._createHttpClient(this.appCertPem,this.appKeyPem);
    }
    async getVehicleList(){
        const h={...this._h(buildSignedHeaders({signKey:this._signKey,deviceId:this.deviceId,language:this.config.language})),...this._authHeaders()};
        const resp=await this.http.post('/carownerservice/oversea/vehicle/v1/list','',{headers:h});
        const data=this._parseResponse(resp.data,'vehicle list');
        const d=data.data||{};
        // API gibt bindcars (eigene) oder sharedcars (geteilte) zurück
        const list=Array.isArray(d)?d:[...(d.bindcars||[]),...(d.sharedcars||[])];
        return list.filter(i=>i?.vin).map(i=>({
            vin:i.vin,
            carType:i.carType||i.carAlias||'T03',
            name:i.vinNickname||i.name||i.vin,
            year:i.year||null,
            carAlias:i.carAlias||'',
            rudder:i.rudder||'',
            allocationCode:i.allocationCode||0,
            raw:i
        }));
    }
    async getVehicleStatus(vehicle){
        const ct=mapCarTypeToStatusEndpoint(vehicle.carType);
        const h={...this._h(buildSignedHeaders({signKey:this._signKey,deviceId:this.deviceId,vin:vehicle.vin,language:this.config.language})),...this._authHeaders()};
        const resp=await this.http.post(`/carownerservice/oversea/vehicle/v1/status/get/${ct}`,`vin=${encodeURIComponent(vehicle.vin)}`,{headers:h});
        const data=this._parseResponse(resp.data,'vehicle status').data||{};
        // Raw pre-merge dump for diagnosing unsupported/under-tested models
        // (e.g. B05). mergeSignalToNamed() below only keeps fields already
        // present in SIGNAL_FIELD_MAP and silently drops everything else, so
        // this is the only place unknown/new signal IDs are ever visible.
        // Only emitted once per VIN per adapter start, at debug level.
        // Remember to redact the VIN before pasting into a public GitHub issue.
        if(!this._rawStatusDumped.has(vehicle.vin)){
            this._rawStatusDumped.add(vehicle.vin);
            this._adapter?.log?.debug(`${vehicle.vin}: raw pre-merge status (endpoint=${ct}): ${JSON.stringify(data)}`);
        }
        return data.signal?mergeSignalToNamed(data):data;
    }
    async sendCommandWithoutPin(vehicle,cmdId,cmdContent){
        const h={...this._h(buildRemoteCtlWriteHeadersWithoutPin({signKey:this._signKey,deviceId:this.deviceId,vin:vehicle.vin,cmdContent,cmdId,language:this.config.language})),...this._authHeaders()};
        const body=`cmdContent=${encodeURIComponent(cmdContent)}&vin=${encodeURIComponent(vehicle.vin)}&cmdId=${encodeURIComponent(cmdId)}`;
        const resp=await this.http.post('/carownerservice/oversea/vehicle/v1/app/remote/ctl',body,{headers:h});
        const result=this._parseResponse(resp.data,`remote ${cmdId}`);await this._pollResult(result);return result;
    }
    async sendCommandWithPin(vehicle,cmdId,cmdContent){
        if(!this.config.operationPassword)throw new Error('operationPassword required');
        const ep=encryptOperatePassword(this.config.operationPassword,this.token);
        const vh={...this._h(buildOperpwdVerifyHeaders({signKey:this._signKey,deviceId:this.deviceId,vin:vehicle.vin,operationPassword:ep,language:this.config.language})),...this._authHeaders()};
        await this.http.post('/carownerservice/oversea/vehicle/v1/operPwd/verify',`operatePassword=${encodeURIComponent(ep)}&vin=${encodeURIComponent(vehicle.vin)}`,{headers:vh});
        const h={...this._h(buildRemoteCtlWriteHeaders({signKey:this._signKey,deviceId:this.deviceId,vin:vehicle.vin,cmdContent,cmdId,operationPassword:ep,language:this.config.language})),...this._authHeaders()};
        const body=`cmdContent=${encodeURIComponent(cmdContent)}&vin=${encodeURIComponent(vehicle.vin)}&cmdId=${encodeURIComponent(cmdId)}&operatePassword=${encodeURIComponent(ep)}`;
        const resp=await this.http.post('/carownerservice/oversea/vehicle/v1/app/remote/ctl',body,{headers:h});
        const result=this._parseResponse(resp.data,`remote ${cmdId}`);await this._pollResult(result);return result;
    }

    async getMessageList(pageNo,pageSize){
        const h={...this._h(buildSignedHeaders({signKey:this._signKey,deviceId:this.deviceId,language:this.config.language,bodyParams:{pageNo:String(pageNo),pageSize:String(pageSize)}})),...this._authHeaders()};
        const body=`pageNo=${pageNo}&pageSize=${pageSize}`;
        const resp=await this.http.post('/carownerservice/oversea/message/v1/list',body,{headers:h});
        const result=this._parseResponse(resp.data,'message list');
        return result.data||{};
    }
    async getUnreadMessageCount(){
        const h={...this._h(buildSignedHeaders({signKey:this._signKey,deviceId:this.deviceId,language:this.config.language})),...this._authHeaders()};
        const resp=await this.http.post('/carownerservice/oversea/message/v1/unreadCount','',{headers:h});
        const result=this._parseResponse(resp.data,'unread count');
        return Number(result.data||0);
    }
    async getAppointment(vehicle,cmdId){
        const h={...this._h(buildSignedHeaders({signKey:this._signKey,deviceId:this.deviceId,vin:vehicle.vin,language:this.config.language,bodyParams:{cmdId}})),...this._authHeaders()};
        const body=`vin=${encodeURIComponent(vehicle.vin)}&cmdId=${encodeURIComponent(cmdId)}`;
        const resp=await this.http.post('/carownerservice/oversea/vehicle/v1/app/remote/ctl/getAppointment',body,{headers:h});
        const result=this._parseResponse(resp.data,'getAppointment');
        let parsed=result.data;
        if(typeof parsed==='string'){
            try{parsed=JSON.parse(parsed)}catch{parsed=null}
        }
        return parsed;
    }
    async getMileageEnergyDetail(vehicle){
        const h={...this._h(require('./leapmotor-crypto').buildSignedHeaders({signKey:this._signKey,deviceId:this.deviceId,vin:vehicle.vin,language:this.config.language})),...this._authHeaders()};
        const resp=await this.http.post('/carownerservice/oversea/drivingRecord/v1/mileage/energy/detail',`vin=${encodeURIComponent(vehicle.vin)}`,{headers:h});
        return this._parseResponse(resp.data,'mileage energy');
    }
    async getConsumptionWeeklyRank(vehicle){
        const crypto=require('node:crypto');
        const n=String(Math.floor(Math.random()*9900000+100000));
        const ts=String(Date.now());
        const lang=this.config.language||'en-GB';
        const vin=vehicle.vin;
        // Spezielle Signatur: language+carvin+channel+deviceId+deviceType+nonce+source+timestamp+version
        const si=[lang,vin,'1',this.deviceId,'1',n,'leapmotor',ts,'1.12.3'].join('');
        const sign=crypto.createHmac('sha256',this._signKey).update(si).digest('hex');
        const h={...this._authHeaders(),nonce:n,deviceId:this.deviceId,timestamp:ts,sign,acceptLanguage:lang,channel:'1',source:'leapmotor',deviceType:'1',version:'1.12.3'};
        const resp=await this.http.post('/carownerservice/oversea/drivingRecord/v1/getLastNweeks100kmECAndRank',`carvin=${encodeURIComponent(vin)}`,{headers:h});
        return this._parseResponse(resp.data,'consumption weekly');
    }
    // Returns the cloud's OFFICIAL energy breakdown (driving/AC/other, in kWh)
    // for an arbitrary time window - despite the endpoint name ("last week"),
    // any begin/end epoch-seconds window works, so this can be called per-trip
    // for a real measured consumption split instead of only estimating it from
    // the battery percentage delta. Community-discovered via the leapmotor-mate
    // project's get_ec_range(), cross-referenced against leapmotor-api's
    // build_consumption_last_week_headers() for the exact (non-alphabetical)
    // header signature field order this specific endpoint requires. 2026-07.
    async getEnergyBreakdown(vehicle,beginSeconds,endSeconds){
        const h={...this._h(buildConsumptionLastWeekHeaders({signKey:this._signKey,deviceId:this.deviceId,carvin:vehicle.vin,begintime:String(beginSeconds),endtime:String(endSeconds),language:this.config.language})),...this._authHeaders()};
        const body=`endtime=${endSeconds}&begintime=${beginSeconds}&carvin=${encodeURIComponent(vehicle.vin)}`;
        const resp=await this.http.post('/carownerservice/oversea/drivingRecord/v1/getLastweekEC',body,{headers:h});
        const parsed=this._parseResponse(resp.data,'energy breakdown');
        const d=parsed.data||{};
        if(!d||Object.keys(d).length===0)return null;
        return{driving:Number(d.driverEC)||0,ac:Number(d.acEC)||0,other:Number(d.otherEC)||0};
    }
    async getCarPictureKey(vehicle){
        const crypto=require('node:crypto');
        const n=String(Math.floor(Math.random()*9900000+100000));
        const ts=String(Date.now());
        const lang=this.config.language||'en-GB';
        // Spezielle Signatur: language+channel+deviceId+deviceId+deviceType+nonce+source+timestamp+version+vin
        const si=[lang,'1',this.deviceId,this.deviceId,'1',n,'leapmotor',ts,'1.12.3',vehicle.vin].join('');
        const sign=crypto.createHmac('sha256',this._signKey).update(si).digest('hex');
        const h={...this._authHeaders(),nonce:n,deviceId:this.deviceId,timestamp:ts,sign,acceptLanguage:lang,channel:'1',source:'leapmotor',deviceType:'1',version:'1.12.3'};
        const body=`deviceID=${encodeURIComponent(this.deviceId)}&vin=${encodeURIComponent(vehicle.vin)}`;
        const resp=await this.http.post('/carownerservice/oversea/vehicle/v1/carpicture/key',body,{headers:h});
        return this._parseResponse(resp.data,'car picture key');
    }
    async downloadCarPictureZip(key){
        const crypto=require('node:crypto');
        const https=require('node:https');
        const n=String(Math.floor(Math.random()*9900000+100000));
        const ts=String(Date.now());
        const lang=this.config.language||'en-GB';
        const si=[lang,'1',this.deviceId,'1',key,n,'leapmotor',ts,'1.12.3'].join('');
        const sign=crypto.createHmac('sha256',this._signKey).update(si).digest('hex');
        const h={...this._authHeaders(),nonce:n,deviceId:this.deviceId,timestamp:ts,sign,
            acceptLanguage:lang,channel:'1',source:'leapmotor',deviceType:'1',version:'1.12.3',
            'Content-Type':'application/x-www-form-urlencoded'};
        const body=`key=${encodeURIComponent(key)}`;
        const certPem=this.accountCertPem;
        const keyPem=this.accountKeyPem;
        return new Promise((resolve,reject)=>{
            const agent=new https.Agent({cert:certPem,key:keyPem,rejectUnauthorized:false});
            const req=https.request({
                hostname:'appgateway.leapmotor-international.de',
                path:'/carownerservice/oversea/vehicle/v1/carpicture/package',
                method:'POST',
                agent,
                headers:{...h,'Content-Length':Buffer.byteLength(body)},
                timeout:60000
            },(res)=>{
                const chunks=[];
                res.on('data',c=>chunks.push(c));
                res.on('end',()=>resolve(Buffer.concat(chunks)));
                res.on('error',reject);
            });
            req.on('error',reject);
            req.on('timeout',()=>{req.destroy();reject(new Error('timeout'))});
            req.write(body);
            req.end();
        });
    }
    async _pollResult(result){
        const rd=result.data||{};const id=String(rd.remoteCtlId||'');if(!id)return;
        const deadline=Date.now()+Math.max(Number(rd.queryRemoteCtlResultTimeout||30000),1000);
        const interval=Number(rd.queryInterval||2000);
        while(Date.now()<deadline){
            await new Promise(r=>this._adapter.setTimeout(r,interval));
            const h={...this._h(buildRemoteCtlResultHeaders({signKey:this._signKey,deviceId:this.deviceId,remoteCtlId:id,language:this.config.language})),...this._authHeaders()};
            const resp=await this.http.post('/carownerservice/oversea/vehicle/v1/app/remote/ctl/result/query',`remoteCtlId=${encodeURIComponent(id)}`,{headers:h});
            if(this._parseResponse(resp.data,'remote poll').data===1)return;
        }
    }
}
exports.LeapmotorClient=LeapmotorClient;
exports.mapCarTypeToStatusEndpoint=mapCarTypeToStatusEndpoint;
