'use strict';
const utils=require('@iobroker/adapter-core');
const {LeapmotorClient}=require('./leapmotor-client');
const fs=require('fs');
const path=require('path');
const CERT_DIR=path.join(__dirname,'..','certs');
const PICTURE_CACHE=path.join(__dirname,'..','pictures_cache.json');

// ── Farben für composite_html ────────────────────────────────
const C={
    bg:'#070d1a', bg2:'#0d1520', border:'#1e2d45',
    text:'#c8ddf0', textDim:'#2a4060',
    accent:'#00d4ff', green:'#00ff88', yellow:'#ffcc00',
    red:'#ff4444', orange:'#ff9900',
    heat:'#ff6644', cool:'#00d4ff', vent:'#7c6aff',
    carBg1:'#111f35', carBg2:'#070d1a',
};

class LeapmotorAdapter extends utils.Adapter{
    constructor(options={}){
        super({...options,name:'leapmotor'});
        this.client=null;this.vehicles=[];this.pollTimer=null;this.isPolling=false;
        this.on('ready',this.onReady.bind(this));
        this.on('stateChange',this.onStateChange.bind(this));
        this.on('unload',this.onUnload.bind(this));
    }

    async onReady(){
        this.setState('info.connection',false,true);
        const cfg=this.config;
        if(!cfg.email||!cfg.password){this.log.error('E-Mail und Passwort müssen konfiguriert sein!');return}
        let appCertPem,appKeyPem;
        try{appCertPem=fs.readFileSync(path.join(CERT_DIR,'app.crt'),'utf8');appKeyPem=fs.readFileSync(path.join(CERT_DIR,'app.key'),'utf8')}
        catch(e){this.log.error(`Zertifikate nicht gefunden: ${e}`);return}
        this.client=new LeapmotorClient({username:cfg.email,password:cfg.password,appCertPem,appKeyPem,operationPassword:cfg.operationPassword||undefined,language:cfg.language||'en-GB'});
        try{this.log.info('Verbinde mit Leapmotor Cloud...');await this.client.login();this.log.info('Login erfolgreich.');this.setState('info.connection',true,true)}
        catch(e){this.log.error(`Login fehlgeschlagen: ${e}`);return}
        try{
            this.vehicles=await this.client.getVehicleList();
            this.log.info(`${this.vehicles.length} Fahrzeug(e) gefunden.`);
            for(const v of this.vehicles){this.log.info(`  → ${v.name} (${v.carType}) VIN: ${v.vin}`);await this.createVehicleObjects(v);await this.subscribeStatesAsync(`${v.vin}.cmd.*`)}
        }catch(e){this.log.error(`Fahrzeugliste fehlgeschlagen: ${e}`);return}
        await this.pollAll();
        for(const v of this.vehicles)await this.updatePictures(v);
        const interval=Math.max(1,cfg.pollingInterval||5)*60*1000;
        this.pollTimer=setInterval(()=>this.pollAll(),interval);
        this.log.info(`Polling alle ${cfg.pollingInterval||5} Minuten.`);
    }

    async pollAll(){
        if(this.isPolling||!this.client)return;
        this.isPolling=true;
        try{
            for(const v of this.vehicles)await this.updateVehicleStatus(v);
        }catch(e){
            const msg=String(e);
            if(msg.includes('ungültig')||msg.includes('Token')||msg.includes('401')){
                this.log.debug('Token abgelaufen – re-login...');
                try{await this.client.login();this.log.debug('Re-Login erfolgreich.');for(const v of this.vehicles)await this.updateVehicleStatus(v);}
                catch(e2){this.log.error('Re-Login fehlgeschlagen: '+e2);}
            }else{this.log.warn('Polling Fehler: '+e);}
        }finally{this.isPolling=false;}
    }

    async updateVehicleStatus(vehicle){
        if(!this.client)return;
        try{
            const s=await this.client.getVehicleStatus(vehicle);
            await this.writeStatusStates(vehicle.vin,s);
            this.log.debug(`${vehicle.vin}: SOC=${s.soc}% Range=${s.expectedMileage}km`);
            await this.buildCompositeHtml(vehicle.vin,s,vehicle.name);
        }catch(e){
            const msg=String(e);
            if(msg.includes('ungültig')||msg.includes('Token')||msg.includes('401')){throw e;}
            this.log.warn('Status Fehler '+vehicle.vin+': '+e);
        }
        try{await this.updateConsumption(vehicle)}catch(e){this.log.warn(`Verbrauch Fehler: ${e}`)}
    }

    async updateConsumption(vehicle){
        if(!this.client)return;
        const vin=vehicle.vin;
        try{
            const m=await this.client.getMileageEnergyDetail(vehicle);
            const d=m.data||{};
            await this.ensureAndSet(`${vin}.consumption.mileage_total_km`,d.totalmileage,'number','km','Gesamtkilometer');
            await this.ensureAndSet(`${vin}.consumption.delivery_days`,d.deliveryDays,'number','Tage','Liefertage');
        }catch(e){this.log.warn('Mileage Fehler: '+e)}
        try{
            const w=await this.client.getConsumptionWeeklyRank(vehicle);
            const d=w.data||{};
            const rank=d.rankResult||d.rank||{};
            await this.ensureAndSet(`${vin}.consumption.kwh_100km`,rank.hundredKmEC||rank.hundredKmEc||rank.hundred_km_ec,'number','kWh/100km','Ø Verbrauch');
            await this.ensureAndSet(`${vin}.consumption.rank`,rank.rank,'string','','Ranking');
            const weekly=d.weeklyEC||d.weekly||[];
            for(let i=0;i<weekly.length;i++){
                const wb=`${vin}.consumption.week_${i+1}`;
                await this.ensureAndSet(`${wb}.week_start`,weekly[i].weekStart||weekly[i].week_start,'string','','Start');
                await this.ensureAndSet(`${wb}.week_end`,weekly[i].weekEnd||weekly[i].week_end,'string','','Ende');
                await this.ensureAndSet(`${wb}.kwh_100km`,weekly[i].hundredKmEC||weekly[i].hundredKmEc||weekly[i].hundred_km_ec,'number','kWh/100km','Verbrauch');
            }
        }catch(e){this.log.warn('Weekly Fehler: '+e)}
    }

    async ensureAndSet(id,val,type,unit,name){
        if(val===null||val===undefined)return;
        await this.setObjectNotExistsAsync(id,{type:'state',common:{name,type,unit,role:'value',read:true,write:false},native:{}});
        await this.setStateAsync(id,{val,ack:true});
    }

    // ── Fahrzeugbilder ───────────────────────────────────────

    async updatePictures(vehicle){
        if(!this.client)return;
        const vin=vehicle.vin;
        let cache={};
        try{if(fs.existsSync(PICTURE_CACHE))cache=JSON.parse(fs.readFileSync(PICTURE_CACHE,'utf8'))}catch{}
        if(cache[vin]&&Object.keys(cache[vin]).length>0){
            this.log.info(`${vin}: Bilder aus Cache (${Object.keys(cache[vin]).length} Bilder)`);
            await this.writePictures(vin,cache[vin]);
            return;
        }
        try{
            const keyResp=await this.client.getCarPictureKey(vehicle);
            const key=(keyResp.data||{}).key;
            if(!key){this.log.warn('Kein Bild-Key');return}
            this.log.info(`${vin}: Lade Fahrzeugbilder...`);
            const zipBuf=await this.client.downloadCarPictureZip(key);
            const AdmZip=require('adm-zip');
            const zip=new AdmZip(zipBuf);
            const pics={};
            zip.getEntries().forEach(e=>{
                if(e.entryName.startsWith('android/xxhdpi/')&&e.entryName.endsWith('.png')){
                    const name=e.entryName.split('/').pop().replace('.png','');
                    pics[name]='data:image/png;base64,'+e.getData().toString('base64');
                }
            });
            cache[vin]=pics;
            fs.writeFileSync(PICTURE_CACHE,JSON.stringify(cache));
            this.log.info(`${vin}: ${Object.keys(pics).length} Bilder gecacht`);
            await this.writePictures(vin,pics);
        }catch(e){this.log.warn('Bilder Fehler: '+e);}
    }

    async writePictures(vin,pics){
        for(const[name,data]of Object.entries(pics)){
            await this.ensureAndSet(`${vin}.pictures.${name}`,data,'string','','Bild: '+name);
        }
    }

    // ── Composite HTML ───────────────────────────────────────

    async buildCompositeHtml(vin,s,vehicleName){
        // Bilder aus Cache lesen
        let pics={};
        try{
            let cache={};
            if(fs.existsSync(PICTURE_CACHE))cache=JSON.parse(fs.readFileSync(PICTURE_CACHE,'utf8'));
            pics=cache[vin]||{};
        }catch{}
        if(!pics['carpic_for_tripsum']&&!pics['carpic_body'])return;

        const soc=s.soc||0;
        const socColor=soc>50?C.green:soc>20?C.yellow:C.red;
        const anyDoor=s.lbcmDriverDoorStatus||s.rbcmDriverDoorStatus||s.lbcmLeftRearDoorStatus||s.rbcmRightRearDoorStatus;
        const anyOpen=anyDoor||s.bbcmBackDoorStatus;
        const windowOpen=(s.leftFrontWindowPercent>0)||(s.rightFrontWindowPercent>0)||(s.leftRearWindowPercent>0)||(s.rightRearWindowPercent>0);
        const charging=s.chargeState!=null&&[1,2,3].includes(s.chargeState);
        const plugged=s.chargeState>0;

        // Bild-Layer
        const lay='position:absolute;top:0;left:0;width:100%;height:100%;object-fit:contain;';
        const layers=[];
        if(!anyOpen&&!charging&&!plugged){
            layers.push(pics['carpic_for_tripsum']||'');
        }else{
            layers.push(pics['carpic_body']||'');
            layers.push(pics['carpic_hood_close']||'');
            layers.push(s.lbcmDriverDoorStatus?(pics['carpic_leftfront_open']||''):(pics['carpic_leftfront_close']||''));
            layers.push(s.lbcmLeftRearDoorStatus?(pics['carpic_leftbehind_open']||''):(pics['carpic_leftbehind_close']||''));
            if(s.rbcmDriverDoorStatus)layers.push(pics['carpic_rightfront_open']||'');
            if(s.rbcmRightRearDoorStatus)layers.push(pics['carpic_rightbehind_open']||'');
            if(s.bbcmBackDoorStatus)layers.push(pics['carpic_tailgate_open']||'');
            if(plugged||charging)layers.push(pics['carpic_charge_open']||'');
        }

        let imgTags=layers.filter(Boolean).map(src=>`<img src="${src}" style="${lay}">`).join('');

        // Ladeanimation CSS
        if(charging){
            const n=15,dur=0.12,total=(n*dur).toFixed(2);
            const pOn=(1/n*100).toFixed(1),pOff=(2/n*100).toFixed(1);
            let css='',fImgs='';
            for(let i=0;i<n;i++){
                const src=pics[`carpic_charge${i+1}`]||'';if(!src)continue;
                const a=`chf${i}`,d=(i*dur).toFixed(2);
                css+=`@keyframes ${a}{0%{opacity:0}${pOn}%{opacity:1}${pOff}%{opacity:0}100%{opacity:0}}`;
                fImgs+=`<img src="${src}" style="${lay}opacity:0;animation:${a} ${total}s ${d}s infinite;">`;
            }
            imgTags+=`<style>${css}</style>${fImgs}`;
        }

        // Badges
        const locked=s.driverDoorLockStatus;
        const acOn=s.acSwitch;
        const badges=[
            locked?`<span style="background:${C.accent}15;border:1px solid ${C.accent}33;border-radius:5px;padding:2px 7px;font-size:9px;color:${C.accent};font-family:monospace">🔒 GESPERRT</span>`:'',
            charging?`<span style="background:${C.green}15;border:1px solid ${C.green}33;border-radius:5px;padding:2px 7px;font-size:9px;color:${C.green};font-family:monospace">⚡ LÄDT</span>`:'',
            acOn?`<span style="background:${C.vent}15;border:1px solid ${C.vent}33;border-radius:5px;padding:2px 7px;font-size:9px;color:${C.vent};font-family:monospace">❄ KLIMA</span>`:'',
            windowOpen?`<span style="background:${C.orange}15;border:1px solid ${C.orange}33;border-radius:5px;padding:2px 7px;font-size:9px;color:${C.orange};font-family:monospace">🪟 FENSTER</span>`:'',
        ].filter(Boolean).join('');

        // Temp
        const temp=(s.outdoorTemp||0)+'&deg;C';
        const range=(s.expectedMileage||0)+' km';

        // Status-Kacheln
        const tile=(label,val,color)=>`<div style="background:${C.bg2};border:1px solid ${C.border};border-radius:10px;padding:10px;text-align:center"><div style="font-size:8px;color:${C.textDim};letter-spacing:0.1em;margin-bottom:3px">${label}</div><div style="font-size:12px;font-weight:800;color:${color||C.text}">${val}</div></div>`;

        const tiles=`<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:6px;margin-bottom:8px">
            ${tile('AUSSEN',(s.outdoorTemp||0)+'°C',C.text)}
            ${tile('REICHWEITE',(s.expectedMileage||0)+' km',C.accent)}
            ${tile('STATUS',s.speed===0?'🅿 Geparkt':'▶ '+(s.speed||0)+' km/h',s.speed===0?C.green:C.yellow)}
            ${tile('LADEN',charging?'⚡ '+(s.chargeRemainTime||0)+' min':'— —',charging?C.green:C.textDim)}
            ${tile('TÜREN',anyOpen?'🚪 Offen':'✓ Zu',anyOpen?C.red:C.green)}
            ${tile('SCHLOSS',locked?'🔒 Zu':'🔓 Offen',locked?C.accent:C.red)}
        </div>`;

        // Klima-Buttons (servConn.setState für VIS)
        const ns=`leapmotor.${this.instance}.${vin}`;
        const sdp=(dp,val)=>`servConn.setState('${ns}.${dp}',${val})`;
        const acMode=acOn?(s.acSetting>=23?'kuehl':(s.acSetting<20?'heiz':'luft')):'';
        const bs=(color,active)=>`background:${active?color+'22':C.bg2};border:1px solid ${active?color+'55':C.border};border-radius:10px;padding:10px 4px;color:${active?color:C.textDim};font-size:10px;font-weight:700;cursor:pointer;font-family:monospace;display:flex;flex-direction:column;align-items:center;gap:3px;width:100%`;

        const acTemp=(()=>{try{return 22;}catch{return 22;}})();

        const climateRow=`<div style="display:grid;grid-template-columns:repeat(4,1fr);gap:6px;margin-bottom:8px">
            <button style="${bs(C.heat,acMode==='heiz')}" onclick="${sdp('cmd.ac_heiz','true')}"><span style="font-size:16px">🔥</span>Heizung</button>
            <button style="${bs(C.cool,acMode==='kuehl')}" onclick="${sdp('cmd.ac_kuehl','true')}"><span style="font-size:16px">❄️</span>Kühlung</button>
            <button style="${bs(C.vent,acMode==='luft')}" onclick="${sdp('cmd.ac_luft','true')}"><span style="font-size:16px">💨</span>Lüftung</button>
            <button style="${bs(C.red,!acOn)}" onclick="${sdp('cmd.ac_off','true')}"><span style="font-size:16px">⏹</span>Aus</button>
        </div>`;

        const tempRow=`<div style="display:flex;align-items:center;justify-content:space-between;background:${C.bg2};border-radius:10px;padding:8px 12px;margin-bottom:8px;border:1px solid ${C.border}">
            <span style="font-size:9px;color:${C.textDim};letter-spacing:0.12em;text-transform:uppercase">Zieltemperatur</span>
            <div style="display:flex;align-items:center;gap:12px">
                <button onclick="${sdp('cmd.ac_temp',Math.max(16,(s.acSetting||22)-1))}" style="background:${C.border};border:none;border-radius:6px;color:${C.text};font-size:18px;width:30px;height:30px;cursor:pointer;font-weight:700">−</button>
                <span style="font-size:18px;font-weight:800;color:${C.accent};min-width:40px;text-align:center">${s.acSetting||22}°C</span>
                <button onclick="${sdp('cmd.ac_temp',Math.min(30,(s.acSetting||22)+1))}" style="background:${C.border};border:none;border-radius:6px;color:${C.text};font-size:18px;width:30px;height:30px;cursor:pointer;font-weight:700">+</button>
            </div>
        </div>`;

        const lockRow=`<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:6px">
            <button style="${bs(C.accent,locked)}" onclick="${sdp('cmd.lock','true')}"><span style="font-size:16px">🔒</span>Sperren</button>
            <button style="${bs(C.orange,!locked)}" onclick="${sdp('cmd.unlock','true')}"><span style="font-size:16px">🔓</span>Öffnen</button>
            <button style="${bs(C.textDim,false)}" onclick="${sdp('cmd.refresh','true')}"><span style="font-size:16px">🔄</span>Refresh</button>
        </div>`;

        const html=`<div style="font-family:monospace;background:${C.bg};border-radius:18px;overflow:hidden;border:1px solid #1a2a40;box-shadow:0 24px 64px rgba(0,0,0,0.6)">
            <div style="padding:12px 14px 0;display:flex;justify-content:space-between;align-items:flex-end">
                <div>
                    <div style="font-size:9px;color:${C.textDim};letter-spacing:0.25em;text-transform:uppercase;margin-bottom:2px">LEAPMOTOR T03</div>
                    <div style="font-size:20px;font-weight:800;color:${C.text}">${vehicleName||vin}</div>
                </div>
                <div style="text-align:right">
                    <div style="font-size:9px;color:${C.textDim};letter-spacing:0.15em;margin-bottom:2px">AKKUSTAND</div>
                    <div style="font-size:16px;font-weight:700;color:${socColor}">${soc}%</div>
                </div>
            </div>
            <div style="position:relative;width:100%;padding-bottom:46%;background:radial-gradient(ellipse at center,${C.carBg1} 0%,${C.carBg2} 70%)">
                ${imgTags}
                <div style="position:absolute;bottom:8px;left:10px;display:flex;gap:5px">${badges}</div>
                <div style="position:absolute;top:8px;right:10px;font-size:10px;color:${C.textDim}">${temp}</div>
            </div>
            <div style="padding:6px 14px 0">
                <div style="background:${C.bg2};border-radius:3px;height:4px;overflow:hidden">
                    <div style="height:100%;width:${soc}%;background:linear-gradient(90deg,${socColor}88,${socColor});border-radius:3px"></div>
                </div>
            </div>
            <div style="padding:10px 14px 14px">
                ${tiles}${climateRow}${tempRow}${lockRow}
            </div>
        </div>`;

        await this.ensureAndSet(`${vin}.pictures.composite_html`,html,'string','','Fahrzeug Dashboard HTML');
    }

    // ── Objekte anlegen ──────────────────────────────────────

    async createVehicleObjects(vehicle){
        await this.setObjectNotExistsAsync(vehicle.vin,{type:'device',common:{name:`${vehicle.name} (${vehicle.carType})`},native:{vin:vehicle.vin,carType:vehicle.carType}});
        const states=[
            ['status.battery_soc','Ladestand','number','value.battery','%'],
            ['status.battery_current','Batteriestrom','number','value','A'],
            ['status.battery_voltage','Batteriespannung','number','value.voltage','V'],
            ['status.battery_energy_kwh','Energie verbleibend','number','value','kWh'],
            ['status.range_km','Reichweite','number','value.distance','km'],
            ['status.mileage_total','Gesamtkilometer','number','value.distance','km'],
            ['status.temp_outdoor','Außentemperatur','number','value.temperature','°C'],
            ['status.temp_battery_min','Min. Zellentemp.','number','value.temperature','°C'],
            ['status.charging_active','Lädt gerade','boolean','indicator.charging',''],
            ['status.charging_state','Ladestatus','number','value',''],
            ['status.charging_soc_limit','Ladelimit','number','value','%'],
            ['status.charging_remain_min','Restladezeit','number','value','min'],
            ['status.charging_plugged','Kabel eingesteckt','boolean','indicator',''],
            ['status.dc_fast_charge','DC Schnellladen','boolean','indicator',''],
            ['status.ac_on','Klimaanlage an','boolean','indicator',''],
            ['status.ac_temp','Klima Solltemp.','number','value.temperature','°C'],
            ['status.drive_speed','Geschwindigkeit','number','value.speed','km/h'],
            ['status.drive_parked','Geparkt','boolean','indicator',''],
            ['status.gear','Gang','number','value',''],
            ['status.security_locked','Verriegelt','boolean','indicator',''],
            ['status.door_driver','Fahrertür offen','boolean','indicator.door',''],
            ['status.door_front_right','Vordertür re offen','boolean','indicator.door',''],
            ['status.door_rear_left','Hintertür li offen','boolean','indicator.door',''],
            ['status.door_rear_right','Hintertür re offen','boolean','indicator.door',''],
            ['status.door_trunk','Kofferraum offen','boolean','indicator.door',''],
            ['status.window_fl_pct','Fenster vl','number','value','%'],
            ['status.window_fr_pct','Fenster vr','number','value','%'],
            ['status.window_rl_pct','Fenster hl','number','value','%'],
            ['status.window_rr_pct','Fenster hr','number','value','%'],
            ['status.location_lat','GPS Breitengrad','number','value.gps.latitude',''],
            ['status.location_lon','GPS Längengrad','number','value.gps.longitude',''],
            ['status.tire_fl','Reifendruck vl','number','value','bar'],
            ['status.tire_fr','Reifendruck vr','number','value','bar'],
            ['status.tire_rl','Reifendruck hl','number','value','bar'],
            ['status.tire_rr','Reifendruck hr','number','value','bar'],
            ['status.bluetooth_on','Bluetooth aktiv','boolean','indicator',''],
            ['status.hotspot_on','Hotspot aktiv','boolean','indicator',''],
            ['status.collect_time','Fahrzeug-Zeitstempel','string','text',''],
        ];
        for(const[id,name,type,role,unit]of states){const common={name,type,role,read:true,write:false};if(unit)common.unit=unit;await this.setObjectNotExistsAsync(`${vehicle.vin}.${id}`,{type:'state',common,native:{}})}
        const cmds=['ac_kuehl','ac_heiz','ac_luft','ac_off','defrost','windows_open','windows_close','find','battery_preheat','battery_preheat_off','lock','unlock','trunk_open','trunk_close','refresh'];
        for(const cmd of cmds)await this.setObjectNotExistsAsync(`${vehicle.vin}.cmd.${cmd}`,{type:'state',common:{name:cmd,type:'boolean',role:'button',read:true,write:true,def:false},native:{}});
        await this.setObjectNotExistsAsync(`${vehicle.vin}.cmd.ac_temp`,{type:'state',common:{name:'Zieltemperatur',type:'number',role:'value.temperature',read:true,write:true,min:16,max:30,unit:'°C',def:22},native:{}});
    }

    // ── Status schreiben ─────────────────────────────────────

    async writeStatusStates(vin,s){
        const set=async(id,val)=>{if(val!==null&&val!==undefined)await this.setStateAsync(`${vin}.${id}`,{val,ack:true})};
        const tire=v=>v!=null?Math.round(v)/100:null;
        await set('status.battery_soc',s.soc);await set('status.battery_current',s.batteryCurrent);
        await set('status.battery_voltage',s.batteryVoltage);
        await set('status.battery_energy_kwh',s.dumpEnergy!=null?Math.round(s.dumpEnergy/100)/10:null);
        await set('status.range_km',s.expectedMileage);await set('status.mileage_total',s.totalMileage);
        await set('status.temp_outdoor',s.outdoorTemp);await set('status.temp_battery_min',s.minSingleTemp);
        await set('status.charging_active',s.chargeState!=null?[1,2,3].includes(s.chargeState):null);
        await set('status.charging_state',s.chargeState);await set('status.charging_soc_limit',s.chargesocSetting);
        await set('status.charging_remain_min',s.chargeRemainTime);
        await set('status.charging_plugged',s.chargeState!=null?s.chargeState>0:null);
        await set('status.dc_fast_charge',s.dcInputFastCharge!=null?s.dcInputFastCharge===1:null);
        await set('status.ac_on',s.acSwitch);await set('status.ac_temp',s.acSetting);
        await set('status.drive_speed',s.speed);await set('status.drive_parked',s.speed!=null?s.speed===0:null);
        await set('status.gear',s.gearStatus);await set('status.security_locked',s.driverDoorLockStatus);
        await set('status.door_driver',s.lbcmDriverDoorStatus);await set('status.door_front_right',s.rbcmDriverDoorStatus);
        await set('status.door_rear_left',s.lbcmLeftRearDoorStatus);await set('status.door_rear_right',s.rbcmRightRearDoorStatus);
        await set('status.door_trunk',s.bbcmBackDoorStatus);
        await set('status.window_fl_pct',s.leftFrontWindowPercent);await set('status.window_fr_pct',s.rightFrontWindowPercent);
        await set('status.window_rl_pct',s.leftRearWindowPercent);await set('status.window_rr_pct',s.rightRearWindowPercent);
        await set('status.location_lat',s.latitude);await set('status.location_lon',s.longitude);
        await set('status.tire_fl',tire(s.leftFrontTirePressure));await set('status.tire_fr',tire(s.rightFrontTirePressure));
        await set('status.tire_rl',tire(s.leftRearTirePressure));await set('status.tire_rr',tire(s.rightRearTirePressure));
        await set('status.bluetooth_on',s.bluetoothState);await set('status.hotspot_on',s.hotspotState);
        await set('status.collect_time',s.collectTime);
    }

    // ── Befehle ──────────────────────────────────────────────

    async onStateChange(id,state){
        if(!state||state.ack||!this.client)return;
        const parts=id.replace(`${this.namespace}.`,'').split('.');
        if(parts.length<3||parts[1]!=='cmd')return;
        const vin=parts[0],cmd=parts[2];
        const vehicle=this.vehicles.find(v=>v.vin===vin);if(!vehicle)return;
        if(cmd==='ac_temp'){await this.setStateAsync(id,{val:state.val,ack:true});return}
        if(cmd==='refresh'&&state.val===true){
            await this.updateVehicleStatus(vehicle);
            await this.setStateAsync(id,{val:false,ack:true});
            return;
        }
        if(state.val===true){await this.executeCommand(vehicle,cmd);await this.setStateAsync(id,{val:false,ack:true})}
    }

    async executeCommand(vehicle,cmd){
        if(!this.client)return;
        this.log.info(`Befehl: ${cmd} für ${vehicle.vin}`);
        const tempState=await this.getStateAsync(`${vehicle.vin}.cmd.ac_temp`);
        const temp=String(tempState?.val??22);
        const ac=(mode,op)=>JSON.stringify({circle:'out',mode,operate:op,position:'all',temperature:temp,windlevel:'3',wshld:'0'});
        const noPinCmds={'find':['120','{}'],'windows_open':['230','{"value":"100"}'],'windows_close':['230','{"value":"0"}']};
        const pinCmds={'ac_kuehl':['170',ac('cold','manual')],'ac_heiz':['170',ac('hot','manual')],'ac_luft':['170',ac('wind','manual')],'ac_off':['170',ac('wind','off')],'defrost':['170',ac('wind','manual')],'battery_preheat':['190','{"operate":"on"}'],'battery_preheat_off':['190','{"operate":"off"}'],'lock':['110','{}'],'unlock':['110','{"operate":"unlock"}'],'trunk_open':['130','{"operate":"open"}'],'trunk_close':['130','{"operate":"close"}']};
        try{
            if(noPinCmds[cmd])await this.client.sendCommandWithoutPin(vehicle,...noPinCmds[cmd]);
            else if(pinCmds[cmd])await this.client.sendCommandWithPin(vehicle,...pinCmds[cmd]);
            else{this.log.warn(`Unbekannter Befehl: ${cmd}`);return}
            this.log.info(`${cmd} erfolgreich.`);
            setTimeout(()=>this.updateVehicleStatus(vehicle),15000);
        }catch(e){this.log.error(`Befehl ${cmd} fehlgeschlagen: ${e}`)}
    }

    onUnload(callback){if(this.pollTimer){clearInterval(this.pollTimer);this.pollTimer=null}this.setState('info.connection',false,true);callback()}
}
if(require.main!==module){module.exports=options=>new LeapmotorAdapter(options)}
else{new LeapmotorAdapter()}
