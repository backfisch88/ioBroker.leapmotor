'use strict';
Object.defineProperty(exports,"__esModule",{value:true});
const crypto=require('crypto');
const https=require('https');
const forge=require('node-forge');
const axios=require('axios');
const {deriveAccountP12Password,deriveSignKey,deriveSessionDeviceId,encryptOperatePassword,buildLoginHeaders,buildSignedHeaders,buildRemoteCtlWriteHeaders,buildRemoteCtlWriteHeadersWithoutPin,buildRemoteCtlResultHeaders,buildOperpwdVerifyHeaders}=require('./leapmotor-crypto');
const KNOWN_PASSWORDS=['','leapmotor','leap123'];
class LeapmotorClient{
    constructor(config){
        this.userId=null;this.token=null;this.signIkm=null;this.signSalt=null;this.signInfo=null;
        this.accountCertPem=null;this.accountKeyPem=null;
        this.config={baseUrl:config.baseUrl||'https://appgateway.leapmotor-international.de',timeout:config.timeout||30000,language:config.language||'en-GB',operationPassword:config.operationPassword||'',...config};
        this.deviceId=crypto.randomUUID().replace(/-/g,'');
        this.appCertPem=config.appCertPem;
        this.appKeyPem=config.appKeyPem;
        this.http=this._createHttpClient(config.appCertPem,config.appKeyPem);
    }
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
        const ct=vehicle.carType.trim().toLowerCase();
        const h={...this._h(buildSignedHeaders({signKey:this._signKey,deviceId:this.deviceId,vin:vehicle.vin,language:this.config.language})),...this._authHeaders()};
        const resp=await this.http.post(`/carownerservice/oversea/vehicle/v1/status/get/${ct}`,`vin=${encodeURIComponent(vehicle.vin)}`,{headers:h});
        return this._parseResponse(resp.data,'vehicle status').data||{};
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
        const crypto=require('crypto');
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
    async getCarPictureKey(vehicle){
        const crypto=require('crypto');
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
        const crypto=require('crypto');
        const https=require('https');
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
            await new Promise(r=>setTimeout(r,interval));
            const h={...this._h(buildRemoteCtlResultHeaders({signKey:this._signKey,deviceId:this.deviceId,remoteCtlId:id,language:this.config.language})),...this._authHeaders()};
            const resp=await this.http.post('/carownerservice/oversea/vehicle/v1/app/remote/ctl/result/query',`remoteCtlId=${encodeURIComponent(id)}`,{headers:h});
            if(this._parseResponse(resp.data,'remote poll').data===1)return;
        }
    }
}
exports.LeapmotorClient=LeapmotorClient;
