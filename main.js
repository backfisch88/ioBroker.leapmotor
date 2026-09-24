'use strict';
const utils=require('@iobroker/adapter-core');
const {LeapmotorClient}=require('./lib/leapmotor-client');
const axios=require('axios');
const suncalc=require('suncalc');
const fs=require('node:fs');
const path=require('node:path');
const CERT_DIR=path.join(__dirname,'certs');

const C={
    bg:'#070d1a',bg2:'#0d1520',border:'#1e2d45',
    text:'#c8ddf0',textDim:'#2a4060',
    accent:'#00d4ff',green:'#00ff88',yellow:'#ffcc00',
    red:'#ff4444',orange:'#ff9900',
    heat:'#ff6644',cool:'#00d4ff',vent:'#7c6aff',
    carBg1:'#111f35',carBg2:'#070d1a',
};

const DEFAULT_BATTERY_CAPACITY_KWH={
    T03:36.0,   // 37.3 kWh brutto / 36.0 kWh netto
    B10:56.2,   // Basisversion; Pro Max Variante hat 67.1 kWh
    C10:69.9,   // Standardversion; AWD-Variante hat 81.9 kWh, REEV-Variante 52.9 kWh
    C16:69.9,   // Vorlaeufige Schaetzung basierend auf C10 Plattform-Aehnlichkeit, noch nicht verifiziert
};
function getDefaultBatteryCapacity(carType){
    return DEFAULT_BATTERY_CAPACITY_KWH[String(carType||'').toUpperCase()]||36.0;
}
// Window remote-control commands use a 0-10 native scale on B05/B10/C10
// instead of the 0-100 scale used natively on T03. Our own datapoints are
// always exposed as 0-100 percent to the user; this converts to whatever
// scale the specific vehicle's API actually expects. Community-confirmed
// via leapmotor-ha (Home Assistant integration).
const WINDOW_POSITION_SCALE={B05:10,B10:10,B11:10,C10:10};
function toNativeWindowPosition(carType,percent){
    const fullOpenValue=WINDOW_POSITION_SCALE[String(carType||'').toUpperCase()]||100;
    return Math.round((Number(percent)||0)/100*fullOpenValue);
}
// A chargeState of 1/2/3 normally means charging, but the cloud can
// occasionally report a stale/phantom charging state while the vehicle is
// actually being driven or is simply powered-on and ready - which is
// physically impossible while genuinely charging. Community-confirmed via
// leapmotor-ha: reject the charging flag in that case.
// Great-circle distance in meters between two lat/lon points (haversine).
// Used to classify a charging session as home vs public.
// Retention is time-based (days), not a fixed count - configurable in
// Settings, 0 = keep forever. A hard safety cap still applies regardless of
// the configured retention, so a "keep forever" choice combined with years
// of daily driving can't grow a single ioBroker state without bound.
const TRIP_HISTORY_HARD_CAP=5000;
const ROUTE_HISTORY_HARD_CAP=2000;
function pruneByAge(items,getTimeMs,retentionDays,hardCap){
    let result=items;
    if(retentionDays>0){
        const cutoff=Date.now()-retentionDays*86400000;
        result=result.filter(item=>getTimeMs(item)>=cutoff);
    }
    if(result.length>hardCap)result=result.slice(-hardCap);
    return result;
}
function haversineMeters(lat1,lon1,lat2,lon2){
    const R=6371000;
    const toRad=d=>d*Math.PI/180;
    const dLat=toRad(lat2-lat1);
    const dLon=toRad(lon2-lon1);
    const a=Math.sin(dLat/2)**2+Math.cos(toRad(lat1))*Math.cos(toRad(lat2))*Math.sin(dLon/2)**2;
    return R*2*Math.atan2(Math.sqrt(a),Math.sqrt(1-a));
}
function isActuallyCharging(chargeState,gearStatus,speed,vehicleReady){
    if(chargeState==null||![1,2,3].includes(chargeState))return false;
    const precludesCharging=[1,2,3].includes(gearStatus)||(speed!=null&&speed>0)||vehicleReady===true;
    return !precludesCharging;
}
// Leapmotor has no dedicated "software update available" endpoint - the
// cloud delivers it as an inbox MESSAGE. Word-anchored (\b) and pairing a
// generic "update" word with a software/vehicle word, so it doesn't match
// inside "quota"/"nota" or unrelated membership/ToS notices (ported from
// leapmotor-ha community project leapmotor-mate's hardened pattern set,
// after their bare-substring version false-positived 5 of 6 real titles).
const OTA_MESSAGE_RE=new RegExp([
    '\\b(?:ota|fota)\\b',
    '\\bfirmware\\b',
    '\\bsoftware[\\s-]?(?:update|upgrade|aktualisierung|updaten)\\b',
    '\\b(?:system|vehicle|car|fahrzeug)[\\s-]?update\\b',
    '\\bupdate\\s+available\\b',
    '\\baktualisierung\\b(?:\\W+\\w+){0,3}\\W+\\b(?:software|fahrzeug|system)\\b',
].join('|'),'iu');
// The cloud's getEC energy endpoint anchors a trip's whole energy to a SINGLE
// instant - roughly the vehicle's "Ready-on"/power-on moment - and only
// returns data when the query's [begin,end] window contains that instant
// (community findings: leapmotor-mate, kerniger/leapmotor-ha#50/#117). Our
// trip start is detected from actual movement, which is normally somewhat
// AFTER Ready-on (unlock, get in, start, then pull away), so querying with
// begin=tripStart alone misses the anchor almost every time. This picks a
// begin that's guaranteed to be at/before the anchor: the end of the
// previous trip (nothing else could have powered the car on in between),
// falling back to a flat 30-minute lookback - long enough to clear a full
// pre-conditioning cycle (~20 min) - for the very first tracked trip, or
// when the previous trip is too old (>24h) for an unbounded window to make
// sense. Trip detection/start/end logic itself is untouched by this -
// startTimeMs here is only used for this query, never for the trip's own
// recorded start time or km attribution.
function computeEnergyQueryBeginMs(startTimeMs,history){
    const THIRTY_MIN_MS=30*60*1000;
    const TWENTY_FOUR_H_MS=24*3600*1000;
    let prevEnd=null;
    for(const t of history||[]){
        if(t.endTimeMs!=null&&t.endTimeMs<=startTimeMs){
            if(prevEnd==null||t.endTimeMs>prevEnd)prevEnd=t.endTimeMs;
        }
    }
    if(prevEnd!=null&&(startTimeMs-prevEnd)<=TWENTY_FOUR_H_MS)return prevEnd;
    return startTimeMs-THIRTY_MIN_MS;
}
class LeapmotorAdapter extends utils.Adapter{
    constructor(options={}){
        super({...options,name:'leapmotor'});
        this.client=null;this.vehicles=[];this.pollTimer=null;this.isPolling=false;this.pictureCache={};this.lastStatus={};
        this.on('ready',this.onReady.bind(this));
        this.on('stateChange',this.onStateChange.bind(this));
        this.on('message',this.onMessage.bind(this));
        this.on('unload',this.onUnload.bind(this));
    }

    // Backend for the Settings tab's notification-adapter dropdown: lists
    // only INSTALLED instances that match a known notify-capable adapter -
    // same whitelist-and-filter approach as our laundrylens adapter's
    // getNotifAdapters command, so the user picks from what's actually
    // there instead of typing an instance ID by hand.
    async onMessage(obj){
        if(!obj)return;
        if(obj.command==='getNotifAdapters'){
            const notifyAdapterNames=['telegram','pushover','signal-cbots','whatsapp-cmb','matrix-org','notify-my-android','prowl','email'];
            let found=[];
            try{
                const objs=await this.getObjectViewAsync('system','instance',{startkey:'system.adapter.',endkey:'system.adapter.\u9999'});
                for(const item of objs?.rows||[]){
                    const id=item.id.replace('system.adapter.','');
                    if(notifyAdapterNames.some(n=>id.startsWith(n))){
                        found.push({id,name:item.value?.common?.name||id});
                    }
                }
            }catch(e){
                this.log.debug(`getNotifAdapters failed: ${e}`);
            }
            if(obj.callback)this.sendTo(obj.from,obj.command,{adapters:found},obj.callback);
            return;
        }
        if(obj.command==='testNotification'){
            const notifyAdapter=obj.message?.notifyAdapter;
            const target=obj.message?.target;
            if(!notifyAdapter){
                if(obj.callback)this.sendTo(obj.from,obj.command,{ok:false,error:'No adapter selected'},obj.callback);
                return;
            }
            try{
                await this.deliverNotification(notifyAdapter,target,this.notificationText('test',{}));
                if(obj.callback)this.sendTo(obj.from,obj.command,{ok:true},obj.callback);
            }catch(e){
                if(obj.callback)this.sendTo(obj.from,obj.command,{ok:false,error:String(e)},obj.callback);
            }
            return;
        }
        if(obj.callback)this.sendTo(obj.from,obj.command,{adapters:[]},obj.callback);
    }

    // Shared by sendNotification() (real, category-gated events) and the
    // Settings tab's "Test" button (obj.command==='testNotification' above,
    // bypasses the category gate on purpose - a test should work regardless
    // of which categories are currently enabled).
    async deliverNotification(notifyAdapter,target,text,severity='info'){
        // telegrammenu2 has its own native notify command with a "type"
        // (info/warn/error) that controls bundling: info-type messages get
        // collected and sent as one batch, warn/error bypass that and go
        // out immediately (confirmed in its own source - groupableExcludeTypes
        // defaults to ['warn','error']). Worth using for genuinely
        // time-sensitive things like the window-left-open warning, so it
        // doesn't sit queued in a batch. "area" must match one the user has
        // already approved in telegrammenu2 - defaults to the vehicle's own
        // name (their own shift-schedule script already uses that area),
        // overridable via config.notify_telegrammenu2_area.
        if(notifyAdapter.startsWith('telegrammenu2')){
            const areaOverrideState=await this.getStateAsync('config.notify_telegrammenu2_area');
            const vehicle=this.vehicles[0];
            const area=areaOverrideState?.val||vehicle?.name||'Leapmotor';
            await this.sendToAsync(notifyAdapter,'notify',{area,type:severity,text});
            return;
        }
        const isEmail=notifyAdapter.startsWith('email');
        const payload=isEmail
            ?{text,subject:'Leapmotor',...(target?{to:target}:{})}
            :(target?{text,chatId:target}:text);
        await this.sendToAsync(notifyAdapter,payload);
    }

    // Sends a push notification via any ioBroker notify-capable adapter
    // (Telegram, Pushover, Signal, WhatsApp, Matrix, notify-my-android,
    // Prowl, email, ...) - same generic sendTo() pattern as our laundrylens
    // adapter, so this isn't locked to one specific notification service.
    // `category` gates the send against its matching config checkbox, so
    // each notification type can be turned on/off independently.
    // Ported from the user's own standalone script: warn once (not every
    // poll) if the car is parked with the ignition off but a window is
    // still open. Debounced in memory per VIN - resets once windows close
    // or the car starts moving/ignition comes back on, so a genuinely new
    // "left open" event notifies again.
    async checkWindowWarning(vehicle,parked,keyPosition,pct){
        const vin=vehicle.vin;
        if(!this._windowWarned)this._windowWarned={};
        const anyOpen=pct.fl>0||pct.fr>0||pct.rl>0||pct.rr>0;
        const carOff=parked===true&&keyPosition!==true;
        if(carOff&&anyOpen){
            if(!this._windowWarned[vin]){
                const open=[];
                if(pct.fl>0)open.push(`FL (${pct.fl}%)`);
                if(pct.fr>0)open.push(`FR (${pct.fr}%)`);
                if(pct.rl>0)open.push(`RL (${pct.rl}%)`);
                if(pct.rr>0)open.push(`RR (${pct.rr}%)`);
                const sent=await this.sendNotification('window_open',this.notificationText('window_open',{windows:open.join(', ')}),'warn');
                if(sent)this._windowWarned[vin]=true;
            }
        }else{
            this._windowWarned[vin]=false;
        }
    }

    // Ignition-on edge (not just "is on") triggers this, based on
    // prevKeyPosition captured before this poll's status overwrote
    // this.lastStatus - so it only fires once per get-in, not every poll
    // while already driving. Mirrors the user's own shift-schedule script's
    // temperature logic (heat below cold threshold, cool above hot
    // threshold, vent in between) but triggered by getting in, not a clock.
    // Rough elevation gain estimate for a trip: two-point lookup (start/end
    // GPS) via Open-Meteo's free elevation API, no API key or account
    // needed. This is NOT a route-integrated climb (a there-and-back trip
    // over a hill would show ~0m gain) - just enough to flag "that trip
    // ended noticeably higher/lower than it started".
    // Estimates battery State of Health from OFFICIAL cloud energy data per
    // trip (energyDrivingKwh+AC+Other) against the SoC used for that trip -
    // deliberately NOT using our own charging-cost kWh estimate, since that
    // is itself derived FROM the configured/nominal capacity and would just
    // circularly confirm whatever capacity is already configured. The
    // cloud's getEC energy is an independent measurement.
    // capacity_estimate = trip_energy_kwh / (soc_used_percent/100)
    // Noisy for small SoC deltas (rounding on a 1%-granularity SoC field
    // dominates), so trips using under 5% SoC are skipped. Keeps the last
    // 30 estimates and uses their MEDIAN (robust against occasional outliers
    // from a single odd trip) as the current capacity estimate.
    async recordSohSample(vin,energyKwh,socUsed){
        if(socUsed==null||socUsed<5||energyKwh==null||energyKwh<=0)return;
        const capacityEstimate=energyKwh/(socUsed/100);
        if(!isFinite(capacityEstimate)||capacityEstimate<=0||capacityEstimate>200)return; // sanity bounds
        const stateId=`${vin}.battery.soh_samples_json`;
        const cur=await this.getStateAsync(stateId);
        let samples=[];
        try{samples=JSON.parse(cur?.val||'[]')}catch{samples=[]}
        samples.push({ts:Date.now(),capacityKwh:Math.round(capacityEstimate*100)/100});
        samples=samples.slice(-30);
        await this.setStateAsync(stateId,{val:JSON.stringify(samples),ack:true});
        if(samples.length<3)return; // wait for a few samples before publishing anything
        const sorted=samples.map(s=>s.capacityKwh).sort((a,b)=>a-b);
        const median=sorted.length%2===1?sorted[(sorted.length-1)/2]:(sorted[sorted.length/2-1]+sorted[sorted.length/2])/2;
        const capState=await this.getStateAsync(`${vin}.config.battery_capacity_kwh`);
        const vehicleForCapacity=this.vehicles.find(v=>v.vin===vin);
        const nominalCapacity=Number(capState?.val)||getDefaultBatteryCapacity(vehicleForCapacity?.carType);
        const sohPercent=Math.max(50,Math.min(105,Math.round((median/nominalCapacity)*1000)/10));
        await this.setStateAsync(`${vin}.battery.estimated_capacity_kwh`,{val:Math.round(median*100)/100,ack:true});
        await this.setStateAsync(`${vin}.battery.soh_percent`,{val:sohPercent,ack:true});
        await this.setStateAsync(`${vin}.battery.soh_sample_count`,{val:samples.length,ack:true});
    }

    async fetchElevationGain(lat1,lon1,lat2,lon2){
        const resp=await axios.get('https://api.open-meteo.com/v1/elevation',{
            params:{latitude:`${lat1},${lat2}`,longitude:`${lon1},${lon2}`},
            timeout:5000,
        });
        const elev=resp.data?.elevation;
        if(!Array.isArray(elev)||elev.length<2)return null;
        return Math.round(elev[1]-elev[0]);
    }

    async checkPrepareToDrive(vin,s,prevKeyPosition){
        const enabledState=await this.getStateAsync('config.prepare_to_drive_enabled');
        if(!enabledState?.val)return;
        const keyPosition=s.bcmKeyPositionOn1||s.bcmKeyPositionOn3;
        if(!(prevKeyPosition===false&&keyPosition===true))return; // only the on-edge
        const alreadyMoving=(s.speed!=null&&s.speed>0)||[1,2,3].includes(s.gearStatus);
        if(s.driverDoorLockStatus===true&&!alreadyMoving){
            // Ignition can flicker false->true while the car is genuinely
            // locked and untouched (a cloud/CAN quirk, same category as the
            // spurious readings seen elsewhere in this codebase). BUT: many
            // vehicles auto-lock themselves once actually moving, so after a
            // long cloud sleep gap the FIRST report we see after getting in
            // can already show Locked=true + gear=Drive + real speed all at
            // once (confirmed in practice: a 3h+ collectTime gap collapsed
            // unlock+entry+drive-off into one poll). Speed/gear already
            // indicating real motion is much stronger evidence than lock
            // state, so only treat "locked" as the phantom-reading signal
            // when there's no such corroborating movement.
            this.log.debug('Prepare-to-drive: ignition edge seen but vehicle still locked with no movement yet - ignoring (likely a spurious reading)');
            return;
        }
        const lastCmdAt=this._lastCommandSentAt?.[vin]||0;
        if(Date.now()-lastCmdAt<120000){
            // Any remote command (ours, a user script's, a manual one) can
            // itself cause a transient ignition-on reading as the vehicle
            // wakes to execute it - confirmed in practice: the user's own
            // shift-schedule script sending ac_vent immediately re-triggered
            // this exact feature right after. 2min cooldown after ANY
            // executed command, not just our own Prepare-to-Drive action.
            this.log.debug('Prepare-to-drive: ignition edge within 2min of a command being sent - ignoring (likely the vehicle waking to execute it, not a real get-in)');
            return;
        }
        try{
            await this.applyClimatePrep(vin,s,'prepare_to_drive');
        }catch(e){
            this.log.warn(`Prepare-to-drive command failed: ${e}`);
        }
    }

    // Shared by Prepare-to-Drive (ignition-on edge trigger) and
    // Prepare-to-Work (explicit datapoint trigger, for coupling to a shift
    // schedule/calendar - see the user's own standalone script this
    // replaces). Same temp-threshold decision (heat/cool/vent) and optional
    // sunshade handling, just under a different config prefix so the two
    // features can have independent settings.
    // Shared free-weather fallback (Open-Meteo, no API key) used whenever
    // the vehicle's own outdoorTemp isn't usable - either because the model
    // doesn't report it at all (confirmed absent on B10), or it currently
    // reflects wherever the car is sitting (e.g. an underground garage)
    // rather than real outside conditions. Falls back to the configured
    // home location if no GPS fix is available.
    // Single shared cache (not per-vin - it's the same sky over one home
    // area for a single-vehicle setup): refreshed at most every 30min, and
    // on ANY failure (503, timeout, network blip, whatever) falls back to
    // the last known-good reading rather than giving up - a somewhat stale
    // temperature is always better than none for a heat/cool/vent decision.
    // Only returns null if there has truly never been a successful fetch.
    async fetchWeatherTemp(lat,lon){
        if(!this._weatherTempCache)this._weatherTempCache={temp:null,at:0};
        const cache=this._weatherTempCache;
        if(cache.temp!=null&&Date.now()-cache.at<1800000){
            return cache.temp;
        }
        try{
            if(lat==null||lon==null){
                const homeLatState=await this.getStateAsync('config.home_latitude');
                const homeLonState=await this.getStateAsync('config.home_longitude');
                lat=Number(homeLatState?.val)||null;
                lon=Number(homeLonState?.val)||null;
            }
            if(lat==null||lon==null)return cache.temp; // no position at all - stale (or null) is all we have
            const resp=await axios.get('https://api.open-meteo.com/v1/forecast',{
                params:{latitude:lat,longitude:lon,current:'temperature_2m'},
                timeout:5000,
            });
            const temp=resp.data?.current?.temperature_2m;
            if(temp!=null){
                this._weatherTempCache={temp,at:Date.now()};
                return temp;
            }
            return cache.temp;
        }catch(e){
            this.log.debug(`Weather lookup failed, using last known temperature (${cache.temp}): ${e}`);
            return cache.temp;
        }
    }

    async applyClimatePrep(vin,s,prefix){
        const vehicle=this.vehicles.find(v=>v.vin===vin);
        if(!vehicle)return;
        const outdoorTemp=await this.fetchWeatherTemp(s.latitude,s.longitude);
        if(outdoorTemp==null){
            this.log.debug(`${prefix}: outdoor temperature unavailable (no GPS/home location or weather lookup failed), skipping`);
            return;
        }
        const coldBelowState=await this.getStateAsync(`config.${prefix}_temp_cold`);
        const hotAboveState=await this.getStateAsync(`config.${prefix}_temp_hot`);
        const targetTempState=await this.getStateAsync(`config.${prefix}_target_temp`);
        const fanSpeedState=await this.getStateAsync(`config.${prefix}_fan_speed`);
        const coldBelow=Number(coldBelowState?.val??14);
        const hotAbove=Number(hotAboveState?.val??23);
        const targetTemp=Number(targetTempState?.val??22);
        const fanSpeed=Number(fanSpeedState?.val??3);
        let cmd,label;
        if(outdoorTemp<coldBelow){cmd='ac_heat';label='heat';}
        else if(outdoorTemp>hotAbove){cmd='ac_cool';label='cool';}
        else{cmd='ac_vent';label='vent';}
        await this.setStateAsync(`${vin}.cmd.ac_temp`,{val:targetTemp,ack:false});
        await this.setStateAsync(`${vin}.cmd.ac_fan_speed`,{val:fanSpeed,ack:false});
        await this.executeCommand(vehicle,cmd);
        this.log.info(`${prefix}: ${label} to ${targetTemp}°C triggered (outdoor ${outdoorTemp}°C).`);
        const sunshadeEnabledState=await this.getStateAsync(`config.${prefix}_sunshade_enabled`);
        if(sunshadeEnabledState?.val){
            const skipDarkState=await this.getStateAsync(`config.${prefix}_sunshade_skip_dark`);
            let isDark=false;
            if(skipDarkState?.val&&s.latitude!=null&&s.longitude!=null){
                try{
                    const times=suncalc.getTimes(new Date(),s.latitude,s.longitude);
                    const now=Date.now();
                    isDark=now<times.sunrise.getTime()||now>times.sunset.getTime();
                }catch(e){
                    this.log.debug(`${prefix}: sunrise/sunset lookup failed: ${e}`);
                }
            }
            // The sunshade is heat/cold insulation via the glass roof,
            // not glare protection. At night there's no solar heat gain
            // through the glass either way, so for heat(cool)/vent the
            // configured position is pointless in the dark - just open
            // it instead. Cold (heat) is the one exception: heat LOSS
            // through the glass at night is still real, so that keeps
            // whatever position the user configured regardless of dark.
            let sunshadePos;
            if(isDark&&label!=='heat'){
                sunshadePos=10;
                this.log.info(`${prefix}: dark outside, opening sunshade instead of the configured ${label} position (heat-loss protection doesn't apply to ${label}).`);
            }else{
                const sunshadePosState=await this.getStateAsync(`config.${prefix}_sunshade_${label}`);
                sunshadePos=Number(sunshadePosState?.val??10);
            }
            try{
                await this.client.sendCommandWithPin(vehicle,'240',JSON.stringify({value:String(sunshadePos)}));
                this.log.info(`${prefix}: sunshade set to ${sunshadePos} (${label}).`);
            }catch(e){
                this.log.warn(`${prefix} sunshade command failed: ${e}`);
            }
        }
        this.sendNotification(prefix,this.notificationText(prefix,{label,temp:targetTemp,outdoor:outdoorTemp}));
    }

    async sendNotification(category,text,severity='info'){
        const enabledState=await this.getStateAsync(`config.notify_${category}`);
        if(!enabledState?.val)return false;
        const notifyAdapterState=await this.getStateAsync('config.notify_adapter');
        const notifyAdapter=notifyAdapterState?.val;
        if(!notifyAdapter){
            this.log.debug(`Notification (${category}) skipped: no notify_adapter configured`);
            return false;
        }
        const notifyTargetState=await this.getStateAsync('config.notify_target');
        const target=notifyTargetState?.val;
        try{
            await this.deliverNotification(notifyAdapter,target,text,severity);
            this.log.info(`Notification sent (${category}) via ${notifyAdapter}.`);
            return true;
        }catch(e){
            this.log.warn(`Notification (${category}) via ${notifyAdapter} failed: ${e}`);
            return false;
        }
    }

    // Localizes push-notification text using the same 4-option language
    // list as "Cloud API Language" in adapter settings - there's no separate
    // notification-language setting, this one doubles as it.
    notificationText(category,vars){
        const lang=(this.config?.language||'en-GB').split('-')[0];
        const templates={
            trip_done:{
                en:v=>`🚗 Trip finished: ${v.km}km in ${v.min}min`,
                de:v=>`🚗 Fahrt beendet: ${v.km}km in ${v.min}min`,
                fr:v=>`🚗 Trajet terminé : ${v.km}km en ${v.min}min`,
                it:v=>`🚗 Viaggio terminato: ${v.km}km in ${v.min}min`,
            },
            charge_done:{
                en:v=>`🔌 Charging finished: ${v.kwh}kWh, ${v.cost}€`,
                de:v=>`🔌 Laden beendet: ${v.kwh}kWh, ${v.cost}€`,
                fr:v=>`🔌 Charge terminée : ${v.kwh}kWh, ${v.cost}€`,
                it:v=>`🔌 Ricarica terminata: ${v.kwh}kWh, ${v.cost}€`,
            },
            ota_update:{
                en:v=>`🔧 Software update available: ${v.title}`,
                de:v=>`🔧 Software-Update verfügbar: ${v.title}`,
                fr:v=>`🔧 Mise à jour logicielle disponible : ${v.title}`,
                it:v=>`🔧 Aggiornamento software disponibile: ${v.title}`,
            },
            window_open:{
                en:v=>`🪟 Windows open while parked: ${v.windows}`,
                de:v=>`🪟 Fenster offen während geparkt: ${v.windows}`,
                fr:v=>`🪟 Fenêtres ouvertes à l'arrêt : ${v.windows}`,
                it:v=>`🪟 Finestrini aperti da fermo: ${v.windows}`,
            },
            prepare_to_drive:{
                en:v=>`🚙 Prepare-to-drive: ${v.label} to ${v.temp}°C (outdoor ${v.outdoor}°C)`,
                de:v=>`🚙 Prepare-to-Drive: ${v.label==='heat'?'Heizung':v.label==='cool'?'Kühlung':'Lüftung'} auf ${v.temp}°C (außen ${v.outdoor}°C)`,
                fr:v=>`🚙 Prêt à conduire : ${v.label} à ${v.temp}°C (extérieur ${v.outdoor}°C)`,
                it:v=>`🚙 Pronto per guidare: ${v.label} a ${v.temp}°C (esterno ${v.outdoor}°C)`,
            },
            prepare_to_work:{
                en:v=>`🏢 Prepare-to-work: ${v.label} to ${v.temp}°C (outdoor ${v.outdoor}°C)`,
                de:v=>`🏢 Prepare-to-Work: ${v.label==='heat'?'Heizung':v.label==='cool'?'Kühlung':'Lüftung'} auf ${v.temp}°C (außen ${v.outdoor}°C)`,
                fr:v=>`🏢 Prêt pour le travail : ${v.label} à ${v.temp}°C (extérieur ${v.outdoor}°C)`,
                it:v=>`🏢 Pronto per il lavoro: ${v.label} a ${v.temp}°C (esterno ${v.outdoor}°C)`,
            },
            new_message:{
                en:v=>`📩 New vehicle message: ${v.title}${v.text?' - '+v.text:''}`,
                de:v=>`📩 Neue Fahrzeug-Nachricht: ${v.title}${v.text?' - '+v.text:''}`,
                fr:v=>`📩 Nouveau message du véhicule : ${v.title}${v.text?' - '+v.text:''}`,
                it:v=>`📩 Nuovo messaggio dal veicolo: ${v.title}${v.text?' - '+v.text:''}`,
            },
            test:{
                en:()=>'🚗 Leapmotor test notification - if you see this, it works!',
                de:()=>'🚗 Leapmotor-Testbenachrichtigung - wenn du das siehst, funktioniert es!',
                fr:()=>'🚗 Notification de test Leapmotor - si vous voyez ceci, ça marche !',
                it:()=>'🚗 Notifica di prova Leapmotor - se vedi questo, funziona!',
            },
        };
        const set=templates[category]||{};
        const build=set[lang]||set.en;
        return build(vars);
    }

    async onReady(){
        this.setState('info.connection',false,true);
        await this.setForeignObjectNotExistsAsync(this.namespace,{type:'meta',common:{name:this.namespace,type:'meta.user'},native:{}});
        const cfg=this.config;
        if(!cfg.email||!cfg.password){this.log.error('Email and password must be configured!');return}
        let appCertPem,appKeyPem;
        try{appCertPem=fs.readFileSync(path.join(CERT_DIR,'app.crt'),'utf8');appKeyPem=fs.readFileSync(path.join(CERT_DIR,'app.key'),'utf8')}
        catch(e){this.log.error(`Certificates not found: ${e}`);return}
        this.client=new LeapmotorClient({username:cfg.email,password:cfg.password,appCertPem,appKeyPem,operationPassword:cfg.operationPassword||undefined,language:cfg.language||'en-GB',adapterInstance:this});
        try{this.log.debug(`Adapter config: language=${cfg.language||'en-GB'}, pin=${cfg.operationPassword?'set':'NOT SET'}`);
        this.log.info('Connecting to Leapmotor cloud...');await this.client.login();this.log.info('Login successful.');this.setState('info.connection',true,true)}
        catch(e){this.log.error(`Login failed: ${e}`);return}
        try{
            this.vehicles=await this.client.getVehicleList();
            this.vehicles.forEach(v=>{v.vin=String(v.vin||'').replace(this.FORBIDDEN_CHARS,'_')});
            // The cloud can list the same vehicle in both "own" and "shared"
            // cars (seen for a main account whose own vehicle also shows up
            // as shared) - without deduping, subscribeStatesAsync below gets
            // registered twice for the same VIN, causing every cmd.* write
            // to fire the onStateChange handler (and its logging/command
            // sending) twice. Keep the first occurrence of each VIN only.
            const seenVins=new Set();
            this.vehicles=this.vehicles.filter(v=>{
                if(seenVins.has(v.vin))return false;
                seenVins.add(v.vin);
                return true;
            });
            this.log.info(`Found ${this.vehicles.length} vehicle(s).`);
            for(const v of this.vehicles){
                this.log.info(`  → ${v.name} (${v.carType}) VIN: ${v.vin}`);
                await this.createVehicleObjects(v);
                await this.subscribeStatesAsync(`${v.vin}.cmd.*`);
                await this.subscribeStatesAsync(`${v.vin}.config.*`);
                await this.subscribeStatesAsync('config.*');
                // Write info datapoints
                await this.setStateAsync(`${v.vin}.info.name`,{val:v.name,ack:true});
                await this.setStateAsync(`${v.vin}.info.vin`,{val:v.vin,ack:true});
                await this.setStateAsync(`${v.vin}.info.model`,{val:v.carType,ack:true});
                if(v.year)await this.setStateAsync(`${v.vin}.info.year`,{val:v.year,ack:true});
                
                if(v.rudder)await this.setStateAsync(`${v.vin}.info.rudder`,{val:v.rudder,ack:true});
                if(v.allocationCode)await this.setStateAsync(`${v.vin}.info.allocation_code`,{val:v.allocationCode,ack:true});
                // Trip tracking lives entirely in memory (this._tripStates),
                // which is empty right after a restart - but the persisted
                // trips.current_trip_active state keeps whatever value it
                // last had. If a trip was active when the adapter stopped,
                // that flag would otherwise stay stuck on "active" forever,
                // since nothing in the normal poll logic re-evaluates it
                // without a matching in-memory entry. The original trip's
                // exact end time/mileage is unrecoverable at this point, so
                // just clear the stale flag rather than leave it hanging.
                const activeState=await this.getStateAsync(`${v.vin}.trips.current_trip_active`);
                if(activeState?.val===true){
                    await this.setStateAsync(`${v.vin}.trips.current_trip_active`,{val:false,ack:true});
                    this.log.info(`${v.vin}: cleared a stale "trip in progress" flag left over from before the last restart.`);
                }
            }
        }catch(e){this.log.error(`Vehicle list failed: ${e}`);return}
        await this.pollAll();
        for(const v of this.vehicles)await this.updatePictures(v);
        // Adaptive polling: poll much faster while any vehicle looks like
        // it's driving, and a slower "parked" cadence otherwise (also used
        // while charging - no separate cadence needed there). Community
        // reference (leapmotor-mate project) runs 10s/30s by default; we
        // start more conservative since our own account has already hit at
        // least one rate-limit-shaped error (code 137) at much lower polling
        // frequency than that. Values are read fresh each cycle from
        // config.polling_interval_*_sec (see scheduleNextPoll), so a change
        // in the admin tab's Settings page takes effect on the next poll -
        // no adapter restart needed.
        this.scheduleNextPoll();
    }

    isAnyVehicleDriving(){
        for(const v of this.vehicles){
            const s=this.lastStatus[v.vin];
            if(!s)continue;
            const keyPosition=s.bcmKeyPositionOn1||s.bcmKeyPositionOn3;
            if((s.speed!=null&&s.speed>0)||keyPosition===true)return true;
        }
        return false;
    }

    async scheduleNextPoll(){
        if(this.pollTimer){this.clearTimeout(this.pollTimer);this.pollTimer=null}
        const driving=this.isAnyVehicleDriving();
        const parkedState=await this.getStateAsync('config.polling_interval_parked_sec');
        const drivingState=await this.getStateAsync('config.polling_interval_driving_sec');
        const parkedMs=Math.min(3600,Math.max(20,Number(parkedState?.val)||60))*1000;
        const drivingMs=Math.min(300,Math.max(5,Number(drivingState?.val)||15))*1000;
        const delay=driving?drivingMs:parkedMs;
        this.pollTimer=this.setTimeout(async()=>{
            await this.pollAll();
            this.scheduleNextPoll();
        },delay);
    }

    async pollAll(){
        if(this.isPolling||!this.client)return;
        this.isPolling=true;
        try{for(const v of this.vehicles)await this.updateVehicleStatus(v);}
        catch(e){
            const msg=String(e);
            const msgLower=msg.toLowerCase();
            if(msgLower.includes('ungültig')||msgLower.includes('token')||msg.includes('401')){
                this.log.debug('Token expired – re-login...');
                try{await this.client.login();this.log.debug('Re-login successful.');for(const v of this.vehicles)await this.updateVehicleStatus(v);}
                catch(e2){this.log.error('Re-login failed: '+e2);}
            }else{this.log.warn('Polling error: '+e);}
        }finally{this.isPolling=false;}
    }

    async updateVehicleStatus(vehicle){
        if(!this.client)return;
        try{
            const s=await this.client.getVehicleStatus(vehicle);
            // Full parsed status dump for diagnosing unsupported/under-tested
            // models (e.g. B05). Only emitted once per VIN per adapter start,
            // at debug level - enable via instance log level to capture field
            // names for a GitHub issue. Remember to redact the VIN before
            // pasting into a public issue.
            if(!this._statusDumped)this._statusDumped=new Set();
            if(!this._statusDumped.has(vehicle.vin)){
                this._statusDumped.add(vehicle.vin);
                this.log.debug(`${vehicle.vin}: raw status dump: ${JSON.stringify(s)}`);
            }
            await this.writeStatusStates(vehicle.vin,s);
            const pollTime=new Date().toLocaleString('de-DE',{timeZone:'Europe/Berlin'});
            await this.setStateAsync(`${vehicle.vin}.status.last_poll_time`,{val:pollTime,ack:true});
            try{await this.updateDailyMileage(vehicle.vin,s.totalMileage)}catch(e){this.log.debug(`Daily mileage error: ${e}`)}
            try{await this.updateTripDetection(vehicle,s.totalMileage,s.speed,s.soc,s.bcmKeyPositionOn1||s.bcmKeyPositionOn3,s.collectTimeMs,s.driverDoorLockStatus,s.latitude,s.longitude,s.outdoorTemp,s.batteryCurrent,s.batteryVoltage,s.chargeState,s.gearStatus,s.bcmKeyPositionOn3)}catch(e){this.log.debug(`Trip detection error: ${e}`)}
            try{await this.recordRoutePoint(vehicle,s)}catch(e){this.log.debug(`Route recording error: ${e}`)}
            try{await this.resolvePendingTripEnergy(vehicle)}catch(e){this.log.debug(`Pending trip energy error: ${e}`)}
            try{await this.updateChargingCost(vehicle.vin,s.soc,s.chargeState,s.gearStatus,s.speed,s.bcmKeyPositionOn3,s.latitude,s.longitude)}catch(e){this.log.debug(`Charging cost error: ${e}`)}
            this.log.debug(`${vehicle.vin}: SOC=${s.soc}% Range=${s.expectedMileage}km Temp=${s.outdoorTemp}°C Locked=${s.driverDoorLockStatus} AC=${s.acSwitch}`);
            await this.buildCompositeHtml(vehicle.vin,s,vehicle.name);
        }catch(e){
            const msg=String(e);
            const msgLower=msg.toLowerCase();
            if(msgLower.includes('ungültig')||msgLower.includes('token')||msg.includes('401')){throw e;}
            // Include the raw server response body (if any) - this is the only
            // diagnostic info available when the request itself fails (e.g. a
            // wrong endpoint name for an unsupported model like B05), since in
            // that case getVehicleStatus() never reaches its own raw-data dump.
            const respBody=e?.response?.data?JSON.stringify(e.response.data):null;
            const reqUrl=e?.config?.url||null;
            this.log.warn('Status error '+vehicle.vin+': '+e+(reqUrl?` | requested URL: ${reqUrl}`:'')+(respBody?` | response body: ${respBody}`:''));
        }
        try{await this.updateConsumption(vehicle)}catch(e){this.log.warn(`Consumption error: ${e}`)}
        const lastScheduleCheck=this._lastScheduleCheck||0;
        if(Date.now()-lastScheduleCheck>300000){
            this._lastScheduleCheck=Date.now();
            try{await this.updateSchedules(vehicle)}catch(e){this.log.warn(`Schedule status error: ${e}`)}
        }
        try{await this.updateMessages()}catch(e){this.log.warn(`Messages error: ${e}`)}
    }

    async updateDailyMileage(vin,totalMileage){
        if(totalMileage==null)return;
        const today=new Date().toISOString().slice(0,10);
        const stateId=`${vin}.trips.daily_km_json`;
        const cur=await this.getStateAsync(stateId);
        let history=[];
        try{history=JSON.parse(cur?.val||'[]')}catch{history=[]}

        let todayEntry=history.find(h=>h.date===today);
        if(!todayEntry){
            todayEntry={date:today,startMileage:totalMileage,km:0};
            history.push(todayEntry);
            history=history.slice(-30);
        }else{
            todayEntry.km=Math.max(0,totalMileage-todayEntry.startMileage);
        }

        await this.setStateAsync(stateId,{val:JSON.stringify(history),ack:true});
        await this.setStateAsync(`${vin}.trips.today_km`,{val:todayEntry.km,ack:true});
    }

    // Buffers GPS points in memory while a trip is active (opt-in via
    // adapter setting, off by default). Rounded to 5 decimals (~1m) to keep
    // storage small. Nothing is buffered unless a trip is currently open, so
    // this costs nothing while parked even when enabled.
    async recordRoutePoint(vehicle,s){
        const enabledState=await this.getStateAsync('config.route_recording_enabled');
        if(!enabledState?.val)return;
        const vin=vehicle.vin;
        if(!this._tripStates?.[vin]?.wasActive)return;
        if(s.latitude==null||s.longitude==null)return;
        if(!this._routeBuffers)this._routeBuffers={};
        if(!this._routeBuffers[vin])this._routeBuffers[vin]=[];
        this._routeBuffers[vin].push([Math.round(s.latitude*1e5)/1e5,Math.round(s.longitude*1e5)/1e5]);
    }

    // Writes the buffered route for a just-finished trip into trips.routes_json,
    // keyed by the trip's startTimeMs so the frontend can match it to the trip.
    // Only the most recent 20 routes are kept - independent of the 50-trip
    // history_json cap - since a route is far bigger per trip than a trip
    // summary, and old routes are rarely looked at again.
    async flushRouteBuffer(vin,startTimeMs){
        const points=this._routeBuffers?.[vin];
        if(this._routeBuffers)this._routeBuffers[vin]=[];
        if(!points||points.length<2)return; // no meaningful route to store
        const stateId=`${vin}.trips.routes_json`;
        const cur=await this.getStateAsync(stateId);
        let routes={};
        try{routes=JSON.parse(cur?.val||'{}')}catch{routes={}}
        routes[startTimeMs]=points;
        const routeRetentionState=await this.getStateAsync('config.route_history_retention_days');
        const routeRetentionDays=Number(routeRetentionState?.val??30);
        let keys=Object.keys(routes).map(Number);
        if(routeRetentionDays>0){
            const cutoff=Date.now()-routeRetentionDays*86400000;
            for(const k of keys){if(k<cutoff)delete routes[k];}
            keys=Object.keys(routes).map(Number);
        }
        keys.sort((a,b)=>a-b);
        while(keys.length>ROUTE_HISTORY_HARD_CAP){delete routes[keys.shift()]}
        await this.setStateAsync(stateId,{val:JSON.stringify(routes),ack:true});
    }

    async updateTripDetection(vehicle,totalMileage,speed,soc,keyPosition,vehicleTimeMs,locked,latitude,longitude,outdoorTemp,batteryCurrent,batteryVoltage,chargeState,gearStatus,vehicleReady){
        const vin=vehicle.vin;
        if(totalMileage==null)return;
        // Note: the grace-period elapsed-time logic below deliberately uses
        // our OWN poll wall-clock (Date.now()), not vehicleTimeMs. The
        // vehicle's own reported timestamp can go long stretches (observed:
        // hours) without updating once the car is parked/asleep, so gating
        // the 10-minute countdown on it risked trips hanging open far longer
        // than intended. vehicleTimeMs is only used for the trip's recorded
        // end time (see below), for an accurate energy-breakdown query window.
        // A trip is only ever STARTED by actual movement (speed>0), never by
        // ignition alone - otherwise remote pre-conditioning (heating/cooling
        // the car before getting in, which turns the ignition/key on without
        // the car moving) gets misdetected as the trip beginning, inflating
        // the recorded duration with pure preheat time.
        const isMoving=speed!=null&&speed>0;
        // Once a trip IS already active, it stays active as long as EITHER
        // the car is moving OR the ignition/key is still on - not just
        // speed>0. Without the ignition check, a brief stop (traffic light,
        // waiting at the curb) with the engine still running would end the
        // trip right there, splitting one continuous drive into several and
        // mis-attributing part of it to "Sonstige" (undetected) km once it
        // resumes.
        const activelyCharging=isActuallyCharging(chargeState,gearStatus,speed,vehicleReady);
        const isDriving=(isMoving||keyPosition===true)&&!activelyCharging;
        // bcmKeyPositionOn1 (one of the two signals OR'd into keyPosition)
        // stays true for the ENTIRE duration of a charging session, even
        // hours parked and locked - confirmed in practice: a 76min public
        // charging stop mid-errand never registered as stopped, keeping one
        // "trip" running the whole time and, worse, feeding the charging
        // current straight into the regen/drive power integration below
        // (charging current is easily 10x a driving current, so this wasn't
        // a small error). A vehicle actually plugged in and charging is
        // stationary by definition, overriding keyPosition regardless of
        // what it claims. Uses the same isActuallyCharging() heuristic as
        // the charging-cost tracker (not a bare chargeState check) because
        // chargeState briefly flips to a nonzero value during normal
        // driving too (looks like a regen/DC-DC transient, unrelated to
        // being plugged in) - a naive chargeState>0 guard would have wiped
        // out real driving regen right along with the charging-current bug.
        // Grace period before actually closing a trip once isDriving goes
        // false: complements the ignition check above as a backstop for
        // cases where key_position briefly misreports (or a model doesn't
        // expose it reliably). A trip is only finalized once isDriving has
        // stayed false for this long straight; if driving resumes before
        // that, the trip simply continues uninterrupted.
        const TRIP_END_GRACE_MS=600000; // 10 minutes
        if(!this._tripStates)this._tripStates={};
        if(!this._lastKnownMileage)this._lastKnownMileage={};
        const prev=this._tripStates[vin]||{wasActive:false,startMileage:null,startTime:null,startSoc:null,pendingEndSince:null,hasMoved:false,sawUnlockAfterMoving:false};
        const lastMileage=this._lastKnownMileage[vin];
        // Second, independent fast-path signal: the vehicle auto-locks while
        // driving, so getting out at the destination requires an unlock -
        // followed by a re-lock (manual or auto) once the driver walks away.
        // A full "moved, then unlocked, then locked again" cycle is just as
        // definitive as ignition-off - and doesn't depend on a model
        // reliably reporting ignition state at all. hasMoved/
        // sawUnlockAfterMoving persist across polls in _tripStates so this
        // works even if the actual unlock happened several polls before the
        // final re-lock is seen.
        const hasMoved=prev.wasActive?(prev.hasMoved||isMoving):isMoving;
        const sawUnlockAfterMoving=prev.wasActive?(prev.sawUnlockAfterMoving||(hasMoved&&locked===false)):false;
        if(prev.wasActive){
            const tempMin=outdoorTemp!=null?Math.min(prev.tempMin??outdoorTemp,outdoorTemp):prev.tempMin;
            const tempMax=outdoorTemp!=null?Math.max(prev.tempMax??outdoorTemp,outdoorTemp):prev.tempMax;
            // Regen estimate: trapezoidal integration of battery power
            // (voltage x current) between this poll and the last one during
            // this trip. Sign convention (positive=discharging while
            // driving, negative=regen/charging back in) is the vehicle's own
            // and hasn't been independently confirmed - if regen numbers
            // ever come out backwards from reality, flip driveKwh/regenKwh
            // below. Only feasible at all now that driving polls at 15s
            // instead of 5min (~80 samples for a 20min trip vs ~4 before).
            let driveKwh=prev.driveKwh??0;
            let regenKwh=prev.regenKwh??0;
            let lastPowerSample=prev.lastPowerSample;
            if(batteryCurrent!=null&&batteryVoltage!=null&&vehicleTimeMs!=null&&!activelyCharging){
                if(lastPowerSample){
                    const dtHours=(vehicleTimeMs-lastPowerSample.tMs)/3600000;
                    if(dtHours>0&&dtHours<0.1){ // skip absurd gaps (e.g. after a reconnect)
                        const avgPowerKw=((lastPowerSample.voltage*lastPowerSample.current)+(batteryVoltage*batteryCurrent))/2/1000;
                        const energyKwh=avgPowerKw*dtHours;
                        if(energyKwh>=0)driveKwh+=energyKwh;
                        else regenKwh+=-energyKwh;
                    }
                }
                lastPowerSample={tMs:vehicleTimeMs,current:batteryCurrent,voltage:batteryVoltage};
            }
            this._tripStates[vin]={...prev,hasMoved,sawUnlockAfterMoving,tempMin,tempMax,driveKwh,regenKwh,lastPowerSample};
        }
        const lockCycleComplete=sawUnlockAfterMoving&&locked===true;
        // Fast path: if the ignition is EXPLICITLY off (not just missing/
        // undefined - a real false reading) AND the vehicle is locked, that's
        // about as strong a "the trip is really over" signal as we can get -
        // nobody drives off again from a locked, key-off state without
        // unlocking first, which we'd see on the very next poll anyway. Skip
        // the 10-minute wait entirely in that case so the trip closes on the
        // same poll it's first detected as stopped, instead of up to 10
        // minutes (2 poll cycles) later. The completed lock-unlock-lock
        // cycle above is an equally strong, independent alternative signal.
        const definitelyStopped=(keyPosition===false&&locked===true)||lockCycleComplete;

        if(isMoving&&!prev.wasActive){
            // Die Fahrt wird erst jetzt erkannt, aber der Kilometerstand kann sich
            // bereits seit dem letzten Poll (bis zu 5 Minuten zuvor) erhoeht haben,
            // ohne dass wir es als Fahrt erfasst hatten ("Sonstige" km im Dashboard).
            // Wir rechnen den Fahrtbeginn auf den letzten bekannten Kilometerstand
            // zurueck, damit diese km der Fahrt zugeschlagen werden, und schaetzen
            // die Startzeit anhand der durchschnittlichen Geschwindigkeit zurueck.
            let startMileage=totalMileage;
            let startTime=Date.now();
            if(lastMileage!=null&&lastMileage.mileage<totalMileage){
                const missedKm=totalMileage-lastMileage.mileage;
                const elapsedMs=Date.now()-lastMileage.ts;
                // Nur zurueckrechnen wenn die Luecke plausibel ist (max. 15 Minuten,
                // sonst war es vermutlich keine durchgehende Fahrt sondern ein Stop)
                if(elapsedMs<=900000&&missedKm>0&&missedKm<50){
                    startMileage=lastMileage.mileage;
                    // Geschaetzte Startzeit: aktuelle Geschwindigkeit als Annahme fuer
                    // die Durchschnittsgeschwindigkeit der verpassten Strecke nutzen
                    const avgSpeedKmh=speed>0?speed:30;
                    const missedTimeMs=Math.min(elapsedMs,(missedKm/avgSpeedKmh)*3600000);
                    startTime=Date.now()-missedTimeMs;
                }
            }
            this._tripStates[vin]={wasActive:true,startMileage,startTime,startSoc:soc,pendingEndSince:null,hasMoved:true,sawUnlockAfterMoving:false,startLat:latitude??null,startLon:longitude??null,tempMin:outdoorTemp??null,tempMax:outdoorTemp??null,driveKwh:0,regenKwh:0,lastPowerSample:(batteryCurrent!=null&&batteryVoltage!=null&&vehicleTimeMs!=null)?{tMs:vehicleTimeMs,current:batteryCurrent,voltage:batteryVoltage}:null};
            if(!this._routeBuffers)this._routeBuffers={};
            this._routeBuffers[vin]=[];
            await this.setStateAsync(`${vin}.trips.current_trip_active`,{val:true,ack:true});
            this.log.debug(`Trip started at ${startMileage}km (current: ${totalMileage}km)`);
        }else if(isDriving&&prev.wasActive&&prev.pendingEndSince){
            // False alarm: driving resumed before the grace period elapsed.
            // Clear the pending-end marker so the trip continues uninterrupted.
            this._tripStates[vin]={...prev,pendingEndSince:null,hasMoved,sawUnlockAfterMoving};
        }else if(!isDriving&&prev.wasActive){
            if(!prev.pendingEndSince){
                // First poll where the car looks stopped: start the grace
                // countdown instead of ending the trip immediately - UNLESS
                // it's already definitively stopped (locked + ignition off),
                // in which case fall through to end it right away below.
                if(!definitelyStopped){
                    // Capture the vehicle's own reported time now (if
                    // available) - this is when the car actually stopped,
                    // and becomes the trip's recorded end time once the
                    // grace period elapses below.
                    this._tripStates[vin]={...prev,pendingEndSince:Date.now(),pendingEndVehicleTime:vehicleTimeMs||null,hasMoved,sawUnlockAfterMoving};
                    this._lastKnownMileage[vin]={mileage:totalMileage,ts:Date.now()};
                    return;
                }
                this._tripStates[vin]={...prev,pendingEndSince:Date.now(),pendingEndVehicleTime:vehicleTimeMs||null,hasMoved,sawUnlockAfterMoving};
            }
            if(!definitelyStopped&&Date.now()-(this._tripStates[vin].pendingEndSince)<TRIP_END_GRACE_MS){
                // Still within the grace period - keep waiting, trip stays open.
                this._lastKnownMileage[vin]={mileage:totalMileage,ts:Date.now()};
                return;
            }
            const km=Math.max(0,totalMileage-(prev.startMileage??totalMileage));
            const accurateEndTimeMs=this._tripStates[vin].pendingEndVehicleTime||this._tripStates[vin].pendingEndSince;
            const durationMin=Math.round((accurateEndTimeMs-(prev.startTime??accurateEndTimeMs))/60000);
            const socUsed=prev.startSoc!=null&&soc!=null?Math.max(0,prev.startSoc-soc):null;
            if(km>=0.5){
                const startTimeMs=prev.startTime??accurateEndTimeMs;
                const endTimeMs=accurateEndTimeMs;
                const trip={
                    date:new Date(startTimeMs).toISOString().slice(0,10),
                    startTime:new Date(startTimeMs).toLocaleString('de-DE',{timeZone:'Europe/Berlin'}),
                    endTime:new Date(endTimeMs).toLocaleString('de-DE',{timeZone:'Europe/Berlin'}),
                    startTimeMs,
                    endTimeMs,
                    km:Math.round(km*10)/10,
                    durationMin,
                    socUsed,
                };
                if(prev.tempMin!=null&&prev.tempMax!=null){
                    trip.tempMinC=prev.tempMin;
                    trip.tempMaxC=prev.tempMax;
                }
                if(prev.regenKwh!=null&&prev.regenKwh>0.01){
                    trip.regenKwh=Math.round(prev.regenKwh*100)/100;
                }
                // Elevation gain via Open-Meteo (free, no API key) using the
                // trip's start/end GPS position - a rough gain estimate from
                // two points, not a true route-integrated climb, but good
                // enough to flag "that was a hilly one" without needing the
                // opt-in route recording to be on.
                if(prev.startLat!=null&&prev.startLon!=null&&latitude!=null&&longitude!=null){
                    try{
                        const elev=await this.fetchElevationGain(prev.startLat,prev.startLon,latitude,longitude);
                        if(elev!=null)trip.elevGainM=elev;
                    }catch(e){this.log.debug(`Elevation lookup failed: ${e}`)}
                }
                // Load history now (before pushing this trip) so the previous
                // trip's end is available for the energy query window below.
                const stateId=`${vin}.trips.history_json`;
                const cur=await this.getStateAsync(stateId);
                let history=[];
                try{history=JSON.parse(cur?.val||'[]')}catch{history=[]}
                // Try to get the cloud's OFFICIAL driving/AC/other energy split for this
                // trip's exact time window. The cloud sometimes needs a while to finish
                // aggregating a just-completed trip, so this can legitimately come back
                // empty right away - in that case we mark the trip as pending and retry
                // a few times on later poll cycles (see resolvePendingTripEnergy()).
                // See computeEnergyQueryBeginMs() above for why the window start isn't
                // simply the trip's own start time.
                const ecBeginMs=computeEnergyQueryBeginMs(startTimeMs,history);
                try{
                    const breakdown=await this.client.getEnergyBreakdown(vehicle,Math.floor(ecBeginMs/1000),Math.floor(endTimeMs/1000));
                    if(breakdown){
                        trip.energyDrivingKwh=Math.round(breakdown.driving*100)/100;
                        trip.energyAcKwh=Math.round(breakdown.ac*100)/100;
                        trip.energyOtherKwh=Math.round(breakdown.other*100)/100;
                        trip.energyOfficial=true;
                        try{await this.recordSohSample(vin,trip.energyDrivingKwh+trip.energyAcKwh+trip.energyOtherKwh,trip.socUsed);}catch(e){this.log.debug(`SoH sample error: ${e}`)}
                    }else{
                        trip.energyPending=true;
                    }
                }catch(e){
                    this.log.debug(`Energy breakdown fetch failed for trip: ${e}`);
                    trip.energyPending=true;
                }
                history.push(trip);
                const tripRetentionState=await this.getStateAsync('config.trip_history_retention_days');
                const tripRetentionDays=Number(tripRetentionState?.val??365);
                history=pruneByAge(history,t=>t.startTimeMs,tripRetentionDays,TRIP_HISTORY_HARD_CAP);
                await this.setStateAsync(stateId,{val:JSON.stringify(history),ack:true});
                this.log.info(`Trip ended: ${trip.km}km in ${durationMin}min`);
                this.sendNotification('trip_done',this.notificationText('trip_done',{km:trip.km,min:durationMin}));
                if(trip.energyPending){
                    if(!this._pendingEnergyTrips)this._pendingEnergyTrips={};
                    if(!this._pendingEnergyTrips[vin])this._pendingEnergyTrips[vin]=[];
                    this._pendingEnergyTrips[vin].push({startTimeMs,endTimeMs,ecBeginMs,date:trip.date,startTime:trip.startTime,attempts:0});
                }
                try{await this.flushRouteBuffer(vin,startTimeMs);}catch(e){this.log.debug(`Route flush error: ${e}`)}
            }
            this._tripStates[vin]={wasActive:false,startMileage:null,startTime:null,startSoc:null,pendingEndSince:null,pendingEndVehicleTime:null};
            await this.setStateAsync(`${vin}.trips.current_trip_active`,{val:false,ack:true});
        }
        this._lastKnownMileage[vin]={mileage:totalMileage,ts:Date.now()};
    }

    // Retries fetching the official energy breakdown for trips whose cloud data
    // wasn't ready yet when they first ended. Runs once per poll cycle; each
    // pending trip is retried up to 12 times (~1 hour at the default 5-minute
    // polling interval) before being given up on permanently.
    //
    // The retry queue (_pendingEnergyTrips) lives only in memory and is lost
    // on every adapter restart. Without reconciliation, a trip that was still
    // pending at restart time would be orphaned forever: still marked
    // energyPending in the stored history, but no longer tracked anywhere to
    // be retried or given up on. So on every call we first re-discover any
    // energyPending trips in the stored history that aren't currently in the
    // queue and re-add them (fresh attempt budget), before processing.
    async resolvePendingTripEnergy(vehicle){
        const vin=vehicle.vin;
        const stateId=`${vin}.trips.history_json`;
        const cur=await this.getStateAsync(stateId);
        let history=[];
        try{history=JSON.parse(cur?.val||'[]')}catch{history=[]}

        if(!this._pendingEnergyTrips)this._pendingEnergyTrips={};
        if(!this._pendingEnergyTrips[vin])this._pendingEnergyTrips[vin]=[];
        const tracked=new Set(this._pendingEnergyTrips[vin].map(p=>`${p.date}|${p.startTime}`));
        for(const t of history){
            const key=`${t.date}|${t.startTime}`;
            if(t.energyPending&&!tracked.has(key)){
                // Older trip entries (created before this field was added)
                // won't have raw epoch timestamps - fall back to "an hour
                // ago" so the retry at least has a plausible-ish window
                // rather than crashing; it will simply fail to find a
                // breakdown and get marked unavailable after 12 attempts.
                const startTimeMs=t.startTimeMs??(Date.now()-3600000);
                const endTimeMs=t.endTimeMs??Date.now();
                const ecBeginMs=t.ecBeginMs??computeEnergyQueryBeginMs(startTimeMs,history);
                this._pendingEnergyTrips[vin].push({startTimeMs,endTimeMs,ecBeginMs,date:t.date,startTime:t.startTime,attempts:0});
                tracked.add(key);
            }
        }

        const pending=this._pendingEnergyTrips?.[vin];
        if(!pending||pending.length===0)return;
        let changed=false;
        const stillPending=[];
        for(const p of pending){
            p.attempts=(p.attempts||0)+1;
            let resolved=false;
            try{
                const ecBeginMs=p.ecBeginMs??computeEnergyQueryBeginMs(p.startTimeMs,history);
                const breakdown=await this.client.getEnergyBreakdown(vehicle,Math.floor(ecBeginMs/1000),Math.floor(p.endTimeMs/1000));
                if(breakdown){
                    const entry=history.find(t=>t.date===p.date&&t.startTime===p.startTime);
                    if(entry){
                        entry.energyDrivingKwh=Math.round(breakdown.driving*100)/100;
                        entry.energyAcKwh=Math.round(breakdown.ac*100)/100;
                        entry.energyOtherKwh=Math.round(breakdown.other*100)/100;
                        entry.energyOfficial=true;
                        delete entry.energyPending;
                        changed=true;
                        try{await this.recordSohSample(vin,entry.energyDrivingKwh+entry.energyAcKwh+entry.energyOtherKwh,entry.socUsed);}catch(e){this.log.debug(`SoH sample error: ${e}`)}
                    }
                    resolved=true;
                }
            }catch(e){this.log.debug(`Pending energy breakdown retry failed: ${e}`)}
            if(!resolved&&p.attempts>=12){
                // Retry budget exhausted - stop retrying, but also update the
                // stored trip entry so the UI stops showing "not yet
                // available" forever. Without this, a trip whose official
                // breakdown never arrives (e.g. cloud aggregation failure)
                // stays stuck on the "still loading" message indefinitely.
                const entry=history.find(t=>t.date===p.date&&t.startTime===p.startTime);
                if(entry){
                    delete entry.energyPending;
                    entry.energyUnavailable=true;
                    changed=true;
                }
            }
            if(!resolved&&p.attempts<12)stillPending.push(p);
        }
        this._pendingEnergyTrips[vin]=stillPending;
        if(changed)await this.setStateAsync(stateId,{val:JSON.stringify(history),ack:true});
    }

    // Reads the current electricity price. If config.energyPriceStateId is
    // set (an external ioBroker state - e.g. a dynamic/hourly tariff adapter
    // like Tibber/aWATTar/EPEX), that live value is used, so a mid-session
    // price change is picked up on the very next poll during charging.
    // Falls back to the manually-edited config.energy_price_eur_kwh if the
    // external state is unset, unreadable, or not a number.
    async getPricePerKwh(){
        const externalIdState=await this.getStateAsync('config.energy_price_state_id');
        const externalId=externalIdState?.val;
        if(externalId){
            try{
                const ext=await this.getForeignStateAsync(externalId);
                const extVal=Number(ext?.val);
                if(ext&&!isNaN(extVal))return extVal;
                this.log.debug(`energyPriceStateId (${externalId}) unreadable or not a number, falling back to manual price`);
            }catch(e){
                this.log.debug(`energyPriceStateId (${externalId}) read failed: ${e}, falling back to manual price`);
            }
        }
        const manual=await this.getStateAsync(`config.energy_price_eur_kwh`);
        return Number(manual?.val)||0.30;
    }

    // Separate manual price for PUBLIC charging - deliberately not tied to
    // the dynamic-tariff state (that reflects the user's own home
    // electricity contract, not a public charge-point operator's rate).
    async getPublicPricePerKwh(){
        const manual=await this.getStateAsync('config.energy_price_public_eur_kwh');
        return Number(manual?.val)||0.55;
    }

    async updateChargingCost(vin,soc,chargeState,gearStatus,speed,vehicleReady,latitude,longitude){
        const charging=isActuallyCharging(chargeState,gearStatus,speed,vehicleReady);
        if(!this._chargingSessions)this._chargingSessions={};
        const prev=this._chargingSessions[vin]||{wasCharging:false,startSoc:null,accumulatedCost:0,accumulatedKwh:0,lastSoc:null,location:'unknown'};

        // Battery capacity: falls back to the model-specific default (see getDefaultBatteryCapacity), overridable via datapoint
        const capState=await this.getStateAsync(`${vin}.config.battery_capacity_kwh`);
        const vehicleForCapacity=this.vehicles.find(v=>v.vin===vin);
        const capacity=Number(capState?.val)||getDefaultBatteryCapacity(vehicleForCapacity?.carType);

        if(charging&&!prev.wasCharging){
            // Neue Ladesession beginnt - classify home vs public once, from
            // the GPS position at session start (compared against the
            // configured home coordinates + radius). "unknown" if no home
            // location is configured or GPS is unavailable right now.
            const location=await this.classifyChargingLocation(latitude,longitude);
            this._chargingSessions[vin]={wasCharging:true,startSoc:soc,accumulatedCost:0,accumulatedKwh:0,lastSoc:soc,location};
            await this.setStateAsync(`${vin}.charging.session_active`,{val:true,ack:true});
            await this.setStateAsync(`${vin}.charging.session_cost`,{val:0,ack:true});
            await this.setStateAsync(`${vin}.charging.session_kwh`,{val:0,ack:true});
            await this.setStateAsync(`${vin}.charging.session_location`,{val:location,ack:true});
            this.log.debug(`Charging session started at SOC=${soc}% (location: ${location})`);
        }else if(charging&&prev.wasCharging){
            // Laufende Session: Energie seit letztem Poll mit AKTUELLEM Preis verrechnen
            const socDelta=soc!=null&&prev.lastSoc!=null?Math.max(0,soc-prev.lastSoc):0;
            const kwhDelta=(socDelta/100)*capacity;
            const currentPrice=prev.location==='public'?await this.getPublicPricePerKwh():await this.getPricePerKwh();
            const costDelta=kwhDelta*currentPrice;

            const updated={
                wasCharging:true,
                startSoc:prev.startSoc,
                accumulatedCost:prev.accumulatedCost+costDelta,
                accumulatedKwh:prev.accumulatedKwh+kwhDelta,
                lastSoc:soc,
                location:prev.location,
            };
            this._chargingSessions[vin]=updated;
            await this.setStateAsync(`${vin}.charging.session_cost`,{val:Math.round(updated.accumulatedCost*100)/100,ack:true});
            await this.setStateAsync(`${vin}.charging.session_kwh`,{val:Math.round(updated.accumulatedKwh*100)/100,ack:true});
        }else if(!charging&&prev.wasCharging){
            // Session beendet
            await this.setStateAsync(`${vin}.charging.session_active`,{val:false,ack:true});
            this.log.info(`Charging session ended: ${prev.accumulatedKwh.toFixed(2)}kWh, ${prev.accumulatedCost.toFixed(2)}€ (${prev.location})`);
            this.sendNotification('charge_done',this.notificationText('charge_done',{kwh:prev.accumulatedKwh.toFixed(2),cost:prev.accumulatedCost.toFixed(2)}));
            // Roll this session's totals into the matching lifetime bucket
            // (home/public/unknown) - three separate running totals, so
            // "what did charging at home cost me this year" is answerable
            // without needing a full session-by-session history.
            if(prev.accumulatedKwh>0){
                const bucket=prev.location==='home'?'home':(prev.location==='public'?'public':'unknown');
                const kwhId=`${vin}.charging.${bucket}_total_kwh`;
                const costId=`${vin}.charging.${bucket}_total_cost`;
                const prevKwh=Number((await this.getStateAsync(kwhId))?.val)||0;
                const prevCost=Number((await this.getStateAsync(costId))?.val)||0;
                await this.setStateAsync(kwhId,{val:Math.round((prevKwh+prev.accumulatedKwh)*100)/100,ack:true});
                await this.setStateAsync(costId,{val:Math.round((prevCost+prev.accumulatedCost)*100)/100,ack:true});
            }
            this._chargingSessions[vin]={wasCharging:false,startSoc:null,accumulatedCost:0,accumulatedKwh:0,lastSoc:null,location:'unknown'};
        }
    }

    // Compares the given GPS position against the configured home location
    // + radius. Returns 'home', 'public', or 'unknown' if either the home
    // location isn't set or the position is unavailable right now.
    async classifyChargingLocation(latitude,longitude){
        if(latitude==null||longitude==null)return'unknown';
        const homeLatState=await this.getStateAsync('config.home_latitude');
        const homeLonState=await this.getStateAsync('config.home_longitude');
        const homeLat=Number(homeLatState?.val);
        const homeLon=Number(homeLonState?.val);
        if(!homeLat&&!homeLon)return'unknown';
        const radiusState=await this.getStateAsync('config.home_radius_m');
        const radiusM=Number(radiusState?.val)||300;
        const distM=haversineMeters(latitude,longitude,homeLat,homeLon);
        return distM<=radiusM?'home':'public';
    }

    async updateMessages(){
        if(!this.client)return;
        try{
            const list=await this.client.getMessageList(1,10);
            const messages=list.list||list.messages||[];
            const unread=messages.filter(m=>m.readFlag===false||m.readFlag===0||m.read_flag===false||m.read_flag===0).length;
            await this.setStateAsync('messages.unread_count',{val:unread,ack:true});
            if(messages.length>0){
                const latest=messages[0];
                const time=latest.sendTime?new Date(Number(latest.sendTime)).toLocaleString('de-DE',{timeZone:'Europe/Berlin'}):'';
                const prevTimeState=await this.getStateAsync('messages.latest_time');
                const isNewMessage=latest.sendTime!=null&&time!==''&&prevTimeState?.val!==time&&prevTimeState?.val;
                await this.setStateAsync('messages.latest_title',{val:latest.title||'',ack:true});
                await this.setStateAsync('messages.latest_text',{val:latest.message||latest.content||'',ack:true});
                await this.setStateAsync('messages.latest_time',{val:time,ack:true});
                // Separate from the OTA-specific notification below - this
                // is for ANY new inbox message from the vehicle (service
                // reminders, recall notices, etc.), not just software
                // updates. Guarded on prevTimeState already having a value
                // so the very first poll after an adapter restart doesn't
                // re-notify about a message that was already there before.
                if(isNewMessage){
                    this.sendNotification('new_message',this.notificationText('new_message',{title:latest.title||'',text:latest.message||latest.content||''}));
                }
            }
            await this.setStateAsync('messages.json',{val:JSON.stringify(messages),ack:true});
            // OTA/software-update detection: Leapmotor has no dedicated
            // "update available" endpoint - the ONLY signal is this exact
            // wording appearing as an inbox message (word-anchored pattern
            // match, ported from the community leapmotor-mate project's
            // hard-won multi-language pattern set - a bare substring match
            // false-positived on "quota"/"nota" and membership offers).
            const otaMatch=messages.find(m=>OTA_MESSAGE_RE.test(`${m.title||''} ${m.message||m.content||''}`));
            const otaPrevState=await this.getStateAsync('messages.ota_update_available');
            const otaWasKnown=otaPrevState?.val===true;
            await this.setStateAsync('messages.ota_update_available',{val:!!otaMatch,ack:true});
            if(otaMatch&&!otaWasKnown){
                this.sendNotification('ota_update',this.notificationText('ota_update',{title:otaMatch.title||'(no title)'}));
            }
            if(otaMatch){
                await this.setStateAsync('messages.ota_update_title',{val:otaMatch.title||'',ack:true});
                const otaTime=otaMatch.sendTime?new Date(Number(otaMatch.sendTime)).toLocaleString('de-DE',{timeZone:'Europe/Berlin'}):'';
                await this.setStateAsync('messages.ota_update_time',{val:otaTime,ack:true});
            }
        }catch(e){this.log.debug(`Message list error: ${e}`)}
    }

    async updateSchedules(vehicle){
        if(!this.client)return;
        const vin=vehicle.vin;
        try{
            const climateData=await this.client.getAppointment(vehicle,'171');
            const controls=climateData?.controls||[];
            const active=controls.length>0&&controls.some(c=>c.on==='1'||c.on===1);
            const dayNames=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
            const info=controls.length>0?controls.map(c=>{
                const time=(c.start_time||'').split(' ')[1]||'';
                const timeShort=time.slice(0,5);
                const days=Array.isArray(c.days)?c.days.map(d=>dayNames[d]||d).join(', '):'daily';
                return `${c.mode} ${c.temperature}°C @ ${timeShort} (${days})`;
            }).join(', '):'';
            await this.setStateAsync(`${vin}.status.climate_schedule_active`,{val:active,ack:true});
            await this.setStateAsync(`${vin}.status.climate_schedule_info`,{val:info,ack:true});
        }catch(e){this.log.debug(`Climate schedule status error: ${e}`)}
        try{
            const chargeData=await this.client.getAppointment(vehicle,'190');
            const active=chargeData&&Number(chargeData.chargeEnable)===1;
            const info=chargeData?`${chargeData.starttime||''}-${chargeData.endtime||''} (${chargeData.chargesoc||''}%)`:'';
            await this.setStateAsync(`${vin}.status.charge_schedule_active`,{val:!!active,ack:true});
            await this.setStateAsync(`${vin}.status.charge_schedule_info`,{val:info,ack:true});
        }catch(e){this.log.debug(`Charge schedule status error: ${e}`)}
    }

    async updateConsumption(vehicle){
        if(!this.client)return;
        const vin=vehicle.vin;
        try{
            const m=await this.client.getMileageEnergyDetail(vehicle);
            const d=m.data||{};
            await this.setObjectNotExistsAsync(`${vin}.consumption`,{type:'channel',common:{name:'Consumption & Statistics'},native:{}});
            await this.ensureAndSet(`${vin}.consumption.mileage_total_km`,d.totalmileage,'number','km','Total Mileage');
            await this.ensureAndSet(`${vin}.consumption.mileage_total_miles`,d.totalmileageMile,'string','mi','Total Mileage (miles)');
            await this.ensureAndSet(`${vin}.consumption.delivery_days`,d.deliveryDays,'number','days','Days since Delivery');
        }catch(e){this.log.debug(`Mileage error: ${e}`)}
        try{
            const w=await this.client.getConsumptionWeeklyRank(vehicle);
            const d=w.data||{};
            const rank=d.rankResult||d.rank||{};
            await this.setObjectNotExistsAsync(`${vin}.consumption`,{type:'channel',common:{name:'Consumption & Statistics'},native:{}});
            await this.ensureAndSet(`${vin}.consumption.kwh_100km`,rank.hundredKmEC||rank.hundredKmEc,'number','kWh/100km','Avg. Consumption');
            await this.ensureAndSet(`${vin}.consumption.rank`,rank.rank,'string','','Efficiency Rank');
            const weekly=d.weeklyEC||d.weekly||[];
            for(let i=0;i<weekly.length;i++){
                const wb=`${vin}.consumption.week_${i+1}`;
                await this.setObjectNotExistsAsync(wb,{type:'channel',common:{name:`Week ${i+1}`},native:{}});
                await this.ensureAndSet(`${wb}.week_start`,weekly[i].weekStart,'string','','Week Start');
                await this.ensureAndSet(`${wb}.week_end`,weekly[i].weekEnd,'string','','Week End');
                await this.ensureAndSet(`${wb}.kwh_100km`,weekly[i].hundredKmEC||weekly[i].hundredKmEc,'number','kWh/100km','Consumption');
            }
        }catch(e){this.log.debug(`Weekly error: ${e}`)}
    }

    async ensureAndSet(id,val,type,unit,name,role){
        if(val===null||val===undefined)return;
        if(!role)role=type==='string'?'text':'value';
        await this.setObjectNotExistsAsync(id,{type:'state',common:{name,type,unit,role,read:true,write:false},native:{}});
        await this.setStateAsync(id,{val,ack:true});
    }

    async loadPictureCacheFromStorage(){
        try{
            const res=await this.readFileAsync(this.namespace,'pictures_cache.json');
            const content=(res&&typeof res==='object'&&'file'in res)?res.file:res;
            return JSON.parse(content)||{};
        }catch(e){
            return {};
        }
    }

    async savePictureCacheToStorage(cache){
        try{
            await this.writeFileAsync(this.namespace,'pictures_cache.json',JSON.stringify(cache));
        }catch(e){
            this.log.warn(`Could not persist picture cache: ${e}`);
        }
    }

    async updatePictures(vehicle){
        if(!this.client)return;
        const vin=vehicle.vin;
        let cache=await this.loadPictureCacheFromStorage();
        if(cache[vin]&&Object.keys(cache[vin]).length>0){
            this.pictureCache[vin]=cache[vin];
            this.log.info(`${vin}: Pictures from cache (${Object.keys(cache[vin]).length})`);
            await this.writePictures(vin,cache[vin]);return;
        }
        try{
            const keyResp=await this.client.getCarPictureKey(vehicle);
            const key=(keyResp.data||{}).key;
            if(!key){this.log.warn('No picture key');return}
            this.log.info(`${vin}: Downloading vehicle pictures...`);
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
            await this.savePictureCacheToStorage(cache);
            this.pictureCache[vin]=pics;
            this.log.info(`${vin}: ${Object.keys(pics).length} pictures cached`);
            await this.writePictures(vin,pics);
        }catch(e){this.log.warn('Pictures error: '+e);}
    }

    async writePictures(vin,pics){
        await this.setObjectNotExistsAsync(`${vin}.pictures`,{type:'channel',common:{name:'Vehicle Pictures'},native:{}});
        for(const[name,data]of Object.entries(pics)){
            await this.ensureAndSet(`${vin}.pictures.${name}`,data,'string','','Picture: '+name,'text.url');
        }
    }

    _t(lang,key){
        const t={
            'OUTDOOR':    {'de':'AUSSEN',   'fr':'EXTÉRIEUR','it':'ESTERNO','es':'EXTERIOR','nl':'BUITEN'},
            'RANGE':      {'de':'REICHWEITE','fr':'AUTONOMIE','it':'AUTONOMIA','es':'AUTONOMÍA','nl':'BEREIK'},
            'STATUS':     {'de':'STATUS',   'fr':'STATUT',   'it':'STATO',   'es':'ESTADO',  'nl':'STATUS'},
            'CHARGING':   {'de':'LADEN',    'fr':'CHARGE',   'it':'CARICA',  'es':'CARGA',   'nl':'LADEN'},
            'DOORS':      {'de':'TÜREN',    'fr':'PORTES',   'it':'PORTE',   'es':'PUERTAS', 'nl':'DEUREN'},
            'LOCK':       {'de':'SCHLOSS',  'fr':'VERROUILLAGE','it':'BLOCCO','es':'CERRADURA','nl':'SLOT'},
            'Parked':     {'de':'Geparkt',  'fr':'Garé',     'it':'Parcheggiato','es':'Aparcado','nl':'Geparkeerd'},
            'BATTERY':    {'de':'AKKU',     'fr':'BATTERIE', 'it':'BATTERIA','es':'BATERÍA', 'nl':'BATTERIJ'},
            'LOCKED':     {'de':'GESPERRT', 'fr':'VERROUILLÉ','it':'BLOCCATO','es':'BLOQUEADO','nl':'VERGRENDELD'},
            'CHARGING2':  {'de':'LÄDT',     'fr':'EN CHARGE','it':'IN CARICA','es':'CARGANDO','nl':'LADEN'},
            'CLIMATE':    {'de':'KLIMA',    'fr':'CLIMAT',   'it':'CLIMA',   'es':'CLIMA',   'nl':'KLIMAAT'},
            'WINDOWS':    {'de':'FENSTER',  'fr':'FENÊTRES', 'it':'FINESTRE','es':'VENTANAS','nl':'RAMEN'},
            'Open':       {'de':'Offen',    'fr':'Ouvert',   'it':'Aperto',  'es':'Abierto', 'nl':'Open'},
            'Closed':     {'de':'Zu',       'fr':'Fermé',    'it':'Chiuso',  'es':'Cerrado', 'nl':'Gesloten'},
            'Heat':       {'de':'Heizung',  'fr':'Chauffage','it':'Riscaldamento','es':'Calefacción','nl':'Verwarming'},
            'Cool':       {'de':'Kühlung',  'fr':'Refroidissement','it':'Raffreddamento','es':'Refrigeración','nl':'Koeling'},
            'Vent':       {'de':'Lüftung',  'fr':'Ventilation','it':'Ventilazione','es':'Ventilación','nl':'Ventilatie'},
            'Off':        {'de':'Aus',      'fr':'Arrêt',    'it':'Spento',  'es':'Apagado', 'nl':'Uit'},
            'Target Temp':{'de':'Zieltemp.','fr':'Temp. cible','it':'Temp. target','es':'Temp. objetivo','nl':'Doeltemp.'},
            'Lock':       {'de':'Sperren',  'fr':'Verrouiller','it':'Bloccare','es':'Bloquear','nl':'Vergrendelen'},
            'Unlock':     {'de':'Öffnen',   'fr':'Déverrouiller','it':'Sbloccare','es':'Desbloquear','nl':'Ontgrendelen'},
            'Refresh':    {'de':'Refresh',  'fr':'Actualiser','it':'Aggiorna','es':'Actualizar','nl':'Vernieuwen'},
        };
        const l=lang?lang.split('-')[0]:'en';
        return (t[key]&&t[key][l])||key;
    }

    async buildCompositeHtml(vin,s,vehicleName){
        // Reines, animiertes Fahrzeugbild als eigenstaendiges HTML-Snippet.
        // Gedacht zum direkten Einbetten in VIS oder andere Visualisierungen
        // (z.B. per iframe-Widget), OHNE Dashboard-Buttons oder Statuswerte -
        // die liefert das React Admin-Tab. Animationslogik identisch zur
        // Lade-Animation in VehicleImage.jsx.
        const pics=this.pictureCache[vin]||{};
        if(!pics['carpic_for_tripsum']&&!pics['carpic_body'])return;
        const anyDoor=s.lbcmDriverDoorStatus||s.rbcmDriverDoorStatus||s.lbcmLeftRearDoorStatus||s.rbcmRightRearDoorStatus;
        const anyOpen=anyDoor||s.bbcmBackDoorStatus;
        const charging=isActuallyCharging(s.chargeState,s.gearStatus,s.speed,s.bcmKeyPositionOn3);
        const plugged=s.chargeState>0;
        const lay='position:absolute;top:0;left:0;width:100%;height:100%;object-fit:contain;';
        const layers=[];
        if(!anyOpen&&!charging&&!plugged){
            layers.push(pics['carpic_for_tripsum']||'');
        }else{
            // Right-side doors are the far side from this camera angle, so
            // their open-door overlays must sit underneath the body/hood
            // layers - otherwise they render on top and look like they're
            // floating in front of the car instead of behind it.
            if(s.rbcmRightRearDoorStatus)layers.push(pics['carpic_rightbehind_open']||'');
            if(s.rbcmDriverDoorStatus)layers.push(pics['carpic_rightfront_open']||'');
            layers.push(pics['carpic_body']||'');
            layers.push(pics['carpic_hood_close']||'');
            layers.push(s.lbcmLeftRearDoorStatus?(pics['carpic_leftbehind_open']||''):(pics['carpic_leftbehind_close']||''));
            layers.push(s.lbcmDriverDoorStatus?(pics['carpic_leftfront_open']||''):(pics['carpic_leftfront_close']||''));
            // Window-closed overlays: only meaningful when the corresponding door is
            // itself shown closed AND the window is fully up, otherwise the composite
            // looks like the windows are permanently rolled down even when they aren't.
            if(!s.lbcmLeftRearDoorStatus&&(s.leftRearWindowPercent??0)===0)layers.push(pics['carpic_leftbehind_window_close']||'');
            if(!s.lbcmDriverDoorStatus&&(s.leftFrontWindowPercent??0)===0)layers.push(pics['carpic_leftfront_window_close']||'');
            if(s.bbcmBackDoorStatus)layers.push(pics['carpic_tailgate_open']||'');
            if(plugged||charging)layers.push(pics['carpic_charge_open']||'');
        }
        let imgTags=layers.filter(Boolean).map(src=>`<img src="${src}" style="${lay}">`).join('');
        if(charging){
            const n=15,dur=0.12,total=(n*dur).toFixed(2);
            const pOn=(1/n*100).toFixed(1),pOff=(2/n*100).toFixed(1);
            let css='',fImgs='';
            for(let i=0;i<n;i++){
                const src=pics[`carpic_charge${i+1}`]||'';if(!src)continue;
                const a=`chf${i}`,d=((n-1-i)*dur).toFixed(2);
                css+=`@keyframes ${a}{0%{opacity:0}${pOn}%{opacity:1}${pOff}%{opacity:0}100%{opacity:0}}`;
                fImgs+=`<img src="${src}" style="${lay}opacity:0;animation:${a} ${total}s ${d}s infinite;">`;
            }
            imgTags+=`<style>${css}</style>${fImgs}`;
        }
        const html=`<div style="position:relative;width:100%;padding-bottom:46%;background:transparent">${imgTags}</div>`;
        await this.setObjectNotExistsAsync(`${vin}.pictures`,{type:'channel',common:{name:'Vehicle Pictures'},native:{}});
        await this.ensureAndSet(`${vin}.pictures.composite_html`,html,'string','','Vehicle Image (animated, embeddable)','html');
    }

    async createVehicleObjects(vehicle){
        await this.setObjectNotExistsAsync(vehicle.vin,{type:'device',common:{name:`${vehicle.name} (${vehicle.carType})`},native:{vin:vehicle.vin,carType:vehicle.carType}});

        // Info channel
        await this.setObjectNotExistsAsync(`${vehicle.vin}.info`,{type:'channel',common:{name:'Vehicle Information'},native:{}});
        const infoStates=[
            ['info.name','Vehicle Name','string','text',''],
            ['info.vin','VIN','string','text',''],
            ['info.model','Model','string','text',''],
            ['info.year','Year','number','value',''],
            ['info.rudder','Steering Side','string','text',''],
            ['info.allocation_code','Allocation Code','number','value',''],
        ];
        for(const[id,name,type,role,unit]of infoStates){
            const common={name,type,role,read:true,write:false};if(unit)common.unit=unit;
            await this.setObjectNotExistsAsync(`${vehicle.vin}.${id}`,{type:'state',common,native:{}});
        }

        // Status channel
        await this.setObjectNotExistsAsync(`${vehicle.vin}.status`,{type:'channel',common:{name:'Vehicle Status'},native:{}});
        const statusStates=[
            // Battery
            ['status.battery_soc','Battery SOC','number','value.battery','%'],
            ['status.battery_current','Battery Current','number','value','A'],
            ['status.battery_voltage','Battery Voltage','number','value.voltage','V'],
            ['status.battery_energy_kwh','Remaining Energy','number','value','kWh'],
            // Range
            ['status.range_km','Range','number','value.distance','km'],
            ['status.range_miles','Range','number','value.distance','mi'],
            ['status.mileage_total','Total Mileage','number','value.distance','km'],
            // Temperature
            ['status.temp_outdoor','Outdoor Temperature','number','value.temperature','°C'],
            ['status.temp_battery_min','Min Cell Temperature','number','value.temperature','°C'],
            // Charging
            ['status.charging_active','Charging Active','boolean','indicator',''],
            ['status.charging_state','Charging State','number','value',''],
            ['status.charging_soc_limit','Charge Limit','number','value','%'],
            ['status.charging_remain_min','Charge Time Remaining','number','value','min'],
            ['status.charging_plugged','Cable Connected','boolean','indicator',''],
            ['status.dc_fast_charge','DC Fast Charging','boolean','indicator',''],
            ['status.charge_time_setting','Scheduled Charge Time','string','text',''],
            // Climate
            ['status.ac_on','Climate Active','boolean','indicator',''],
            ['status.ac_temp','Climate Target Temp','number','value.temperature','°C'],
            ['status.ac_fan_speed','Fan Speed','number','value',''],
            ['status.ac_fan_speed_setting','Fan Speed Setting','number','value',''],
            ['status.ac_wind_direction','Air Direction','number','value',''],
            ['status.ac_recirculate','Recirculate Air','boolean','indicator',''],
            ['status.ac_cooling_heating','Climate Mode','number','value',''],
            ['status.ptc_state','PTC Heater State','number','value',''],
            ['status.ptc_power','PTC Heater Power','number','value',''],
            // Drive
            ['status.drive_speed','Speed','number','value.speed','km/h'],
            ['status.drive_parked','Parked','boolean','indicator',''],
            ['status.gear','Gear','number','value',''],
            ['status.key_position','Ignition On','boolean','indicator',''],
            // Security
            ['status.security_locked','Locked','boolean','indicator',''],
            ['status.door_ctrl_allow','Door Control Allowed','boolean','indicator',''],
            // Doors
            ['status.door_driver','Driver Door Open','boolean','indicator',''],
            ['status.door_front_right','Front Right Door Open','boolean','indicator',''],
            ['status.door_rear_left','Rear Left Door Open','boolean','indicator',''],
            ['status.door_rear_right','Rear Right Door Open','boolean','indicator',''],
            ['status.door_trunk','Trunk Open','boolean','indicator',''],
            // Windows
            ['status.window_fl_pct','Window Front Left','number','value','%'],
            ['status.window_fr_pct','Window Front Right','number','value','%'],
            ['status.window_rl_pct','Window Rear Left','number','value','%'],
            ['status.window_rr_pct','Window Rear Right','number','value','%'],
            ['status.window_driver_open','Driver Window Open','boolean','indicator',''],
            ['status.window_fr_open','Front Right Window Open','boolean','indicator',''],
            ['status.window_rl_open','Rear Left Window Open','boolean','indicator',''],
            ['status.window_rr_open','Rear Right Window Open','boolean','indicator',''],
            ['status.sun_shade','Sun Shade','number','value',''],
            // Tires
            ['status.tire_fl','Tire Pressure FL','number','value','bar'],
            ['status.tire_fr','Tire Pressure FR','number','value','bar'],
            ['status.tire_rl','Tire Pressure RL','number','value','bar'],
            ['status.tire_rr','Tire Pressure RR','number','value','bar'],
            ['status.tire_fl_state','Tire State FL','number','value',''],
            ['status.tire_fr_state','Tire State FR','number','value',''],
            ['status.tire_rl_state','Tire State RL','number','value',''],
            ['status.tire_rr_state','Tire State RR','number','value',''],
            // Location
            ['status.location_lat','GPS Latitude','number','value.gps.latitude',''],
            ['status.location_lon','GPS Longitude','number','value.gps.longitude',''],
            ['status.privacy_gps','GPS Privacy','number','value',''],
            ['status.privacy_data','Data Privacy','number','value',''],
            // Connectivity
            ['status.bluetooth_on','Bluetooth Active','boolean','indicator',''],
            ['status.bluetooth_addr','Bluetooth Address','string','text',''],
            ['status.hotspot_on','Hotspot Active','boolean','indicator',''],
            // Timestamps
            ['status.collect_time','Data Timestamp','string','text',''],
            ['status.collect_time_ms','Data Timestamp ms','number','value',''],
            ['status.data_age_min','Data Age','number','value','min'],
            ['status.data_stale','Data Stale (>30min old - car likely asleep, cloud serving cached frame)','boolean','indicator',''],
        ];
        for(const[id,name,type,role,unit]of statusStates){
            const common={name,type,role,read:true,write:false};if(unit)common.unit=unit;
            await this.setObjectNotExistsAsync(`${vehicle.vin}.${id}`,{type:'state',common,native:{}});
        }

        // Commands channel
        await this.setObjectNotExistsAsync(`${vehicle.vin}.cmd`,{type:'channel',common:{name:'Commands'},native:{}});
        const cmds={
            'ac_cool':            'Start Cooling',
            'ac_heat':            'Start Heating',
            'ac_vent':            'Start Ventilation',
            'ac_off':             'Stop Climate',
            'defrost':            'Windshield Defrost',
            'windows_open':       'Open Windows',
            'windows_close':      'Close Windows',
            'find':               'Find Vehicle',
            'battery_preheat':    'Battery Preheat On',
            'battery_preheat_off':'Battery Preheat Off',
            'lock':               'Lock Vehicle',
            'unlock':             'Unlock Vehicle',
            'trunk_open':         'Open Trunk',
            'trunk_close':        'Close Trunk',
            'refresh':            'Refresh Status',
        };
        for(const[cmd,name]of Object.entries(cmds)){
            await this.setObjectNotExistsAsync(`${vehicle.vin}.cmd.${cmd}`,{type:'state',common:{name,type:'boolean',role:'button',read:false,write:true,def:false},native:{}});
        }
        await this.setObjectNotExistsAsync(`${vehicle.vin}.cmd.ac_temp`,{type:'state',common:{name:'Target Temperature',type:'number',role:'level.temperature',read:true,write:true,min:16,max:30,unit:'°C',def:22},native:{}});
        await this.setObjectNotExistsAsync(`${vehicle.vin}.cmd.ac_fan_speed`,{type:'state',common:{name:'Fan Speed',type:'number',role:'level',read:true,write:true,min:1,max:7,def:3},native:{}});
        await this.setObjectNotExistsAsync(`${vehicle.vin}.cmd.ac_position`,{type:'state',common:{name:'Air Position',type:'string',role:'text',read:true,write:true,states:{all:'All',up:'Upper',down:'Lower',front:'Front',rear:'Rear'},def:'all'},native:{}});
        await this.setObjectNotExistsAsync(`${vehicle.vin}.cmd.sunshade_open`,{type:'state',common:{name:'Open Sunshade',type:'boolean',role:'button',read:false,write:true,def:false},native:{}});
        await this.setObjectNotExistsAsync(`${vehicle.vin}.cmd.sunshade_close`,{type:'state',common:{name:'Close Sunshade',type:'boolean',role:'button',read:false,write:true,def:false},native:{}});
        await this.setObjectNotExistsAsync(`${vehicle.vin}.cmd.hotspot_on`,{type:'state',common:{name:'Hotspot On',type:'boolean',role:'button',read:false,write:true,def:false},native:{}});
        await this.setObjectNotExistsAsync(`${vehicle.vin}.cmd.hotspot_off`,{type:'state',common:{name:'Hotspot Off',type:'boolean',role:'button',read:false,write:true,def:false},native:{}});
        await this.extendObjectAsync(`${vehicle.vin}.cmd.defrost_level`,{type:'state',common:{name:'Windshield Defrost Stage (0=off,1=weak,2=strong)',type:'number',role:'level',read:true,write:true,min:0,max:2,def:0},native:{}});
        await this.setObjectNotExistsAsync(`${vehicle.vin}.cmd.windows_set`,{type:'state',common:{name:'Windows Position (0-100)',type:'number',role:'level.blind',read:true,write:true,min:0,max:100,def:0},native:{}});
        await this.setObjectNotExistsAsync(`${vehicle.vin}.cmd.charge_limit_set`,{type:'state',common:{name:'Charge Limit SOC (50-100)',type:'number',role:'level',read:true,write:true,min:50,max:100,def:80},native:{}});
        await this.setObjectNotExistsAsync(`${vehicle.vin}.cmd.charge_schedule_enable`,{type:'state',common:{name:'Charge Schedule Enabled',type:'boolean',role:'switch',read:true,write:true,def:false},native:{}});
        await this.setObjectNotExistsAsync(`${vehicle.vin}.cmd.charge_schedule_start`,{type:'state',common:{name:'Charge Schedule Start (HH:MM)',type:'string',role:'text',read:true,write:true,def:'00:00'},native:{}});
        await this.setObjectNotExistsAsync(`${vehicle.vin}.cmd.charge_schedule_end`,{type:'state',common:{name:'Charge Schedule End (HH:MM)',type:'string',role:'text',read:true,write:true,def:'08:00'},native:{}});
        await this.setObjectNotExistsAsync(`${vehicle.vin}.cmd.charge_schedule_apply`,{type:'state',common:{name:'Apply Charge Schedule',type:'boolean',role:'button',read:false,write:true,def:false},native:{}});
        await this.setObjectNotExistsAsync(`${vehicle.vin}.cmd.climate_schedule_enable`,{type:'state',common:{name:'Climate Schedule Enabled',type:'boolean',role:'switch',read:true,write:true,def:false},native:{}});
        await this.setObjectNotExistsAsync(`${vehicle.vin}.cmd.climate_schedule_time`,{type:'state',common:{name:'Climate Schedule Time (HH:MM)',type:'string',role:'text',read:true,write:true,def:'07:00'},native:{}});
        await this.setObjectNotExistsAsync(`${vehicle.vin}.cmd.climate_schedule_mode`,{type:'state',common:{name:'Climate Schedule Mode',type:'string',role:'text',read:true,write:true,states:{cold:'Cool',hot:'Heat',wind:'Vent'},def:'hot'},native:{}});
        await this.setObjectNotExistsAsync(`${vehicle.vin}.cmd.climate_schedule_apply`,{type:'state',common:{name:'Apply Climate Schedule',type:'boolean',role:'button',read:false,write:true,def:false},native:{}});
        await this.setObjectNotExistsAsync(`${vehicle.vin}.cmd.climate_schedule_cancel`,{type:'state',common:{name:'Cancel Climate Schedule',type:'boolean',role:'button',read:false,write:true,def:false},native:{}});
        await this.setObjectNotExistsAsync(`${vehicle.vin}.cmd.climate_schedule_days`,{type:'state',common:{name:'Climate Schedule Days (comma-separated 0=Sun..6=Sat)',type:'string',role:'text',read:true,write:true,def:'0,1,2,3,4,5,6'},native:{}});
        await this.setObjectNotExistsAsync(`${vehicle.vin}.status.climate_schedule_active`,{type:'state',common:{name:'Climate Schedule Active',type:'boolean',role:'indicator',read:true,write:false,def:false},native:{}});
        await this.setObjectNotExistsAsync(`${vehicle.vin}.status.climate_schedule_info`,{type:'state',common:{name:'Climate Schedule Info',type:'string',role:'text',read:true,write:false,def:''},native:{}});
        await this.setObjectNotExistsAsync(`${vehicle.vin}.status.charge_schedule_active`,{type:'state',common:{name:'Charge Schedule Active',type:'boolean',role:'indicator',read:true,write:false,def:false},native:{}});
        await this.setObjectNotExistsAsync(`${vehicle.vin}.status.charge_schedule_info`,{type:'state',common:{name:'Charge Schedule Info',type:'string',role:'text',read:true,write:false,def:''},native:{}});
        await this.setObjectNotExistsAsync(`${vehicle.vin}.status.last_poll_time`,{type:'state',common:{name:'Last Successful Adapter Poll',type:'string',role:'date',read:true,write:false,def:''},native:{}});
        await this.setObjectNotExistsAsync(`${vehicle.vin}.cmd.sentry_mode_on`,{type:'state',common:{name:'Sentry Mode On',type:'boolean',role:'button',read:false,write:true,def:false},native:{}});
        await this.setObjectNotExistsAsync(`${vehicle.vin}.cmd.sentry_mode_off`,{type:'state',common:{name:'Sentry Mode Off',type:'boolean',role:'button',read:false,write:true,def:false},native:{}});
        await this.setObjectNotExistsAsync(`${vehicle.vin}.cmd.speed_limit_set`,{type:'state',common:{name:'Speed Limit (km/h, 0=off)',type:'number',role:'level',read:true,write:true,min:0,max:150,def:0},native:{}});
        await this.setObjectNotExistsAsync(`${vehicle.vin}.cmd.seat_heat_driver`,{type:'state',common:{name:'Driver Seat Heat Level (0-3)',type:'number',role:'level',read:true,write:true,min:0,max:3,def:0},native:{}});
        await this.setObjectNotExistsAsync(`${vehicle.vin}.cmd.seat_heat_copilot`,{type:'state',common:{name:'Copilot Seat Heat Level (0-3)',type:'number',role:'level',read:true,write:true,min:0,max:3,def:0},native:{}});
        await this.setObjectNotExistsAsync(`${vehicle.vin}.cmd.seat_ventilation_driver`,{type:'state',common:{name:'Driver Seat Ventilation Level (0-3)',type:'number',role:'level',read:true,write:true,min:0,max:3,def:0},native:{}});
        await this.setObjectNotExistsAsync(`${vehicle.vin}.cmd.seat_ventilation_copilot`,{type:'state',common:{name:'Copilot Seat Ventilation Level (0-3)',type:'number',role:'level',read:true,write:true,min:0,max:3,def:0},native:{}});
        await this.setObjectNotExistsAsync(`${vehicle.vin}.cmd.steering_wheel_heat_on`,{type:'state',common:{name:'Steering Wheel Heat On',type:'boolean',role:'button',read:false,write:true,def:false},native:{}});
        await this.setObjectNotExistsAsync(`${vehicle.vin}.cmd.steering_wheel_heat_off`,{type:'state',common:{name:'Steering Wheel Heat Off',type:'boolean',role:'button',read:false,write:true,def:false},native:{}});
        await this.setObjectNotExistsAsync(`${vehicle.vin}.cmd.mirror_heat_on`,{type:'state',common:{name:'Mirror/Rear Window Heat On',type:'boolean',role:'button',read:false,write:true,def:false},native:{}});
        await this.setObjectNotExistsAsync(`${vehicle.vin}.cmd.mirror_heat_off`,{type:'state',common:{name:'Mirror/Rear Window Heat Off',type:'boolean',role:'button',read:false,write:true,def:false},native:{}});
        // Community-test additions (2026-09): verified against two independent
        // community reverse-engineering projects, not against real hardware
        // here - this T03 may not support all of these. Kept in for other
        // models/regions; please report back via a GitHub issue whether these
        // work (or don't) on your vehicle.
        await this.setObjectNotExistsAsync(`${vehicle.vin}.cmd.charge_start`,{type:'state',common:{name:'Start Charging',type:'boolean',role:'button',read:false,write:true,def:false},native:{}});
        await this.setObjectNotExistsAsync(`${vehicle.vin}.cmd.charge_stop`,{type:'state',common:{name:'Stop Charging',type:'boolean',role:'button',read:false,write:true,def:false},native:{}});
        await this.setObjectNotExistsAsync(`${vehicle.vin}.cmd.unlock_charger`,{type:'state',common:{name:'Unlock Charging Connector',type:'boolean',role:'button',read:false,write:true,def:false},native:{}});
        await this.setObjectNotExistsAsync(`${vehicle.vin}.cmd.healthy_charging_on`,{type:'state',common:{name:'Healthy Charging Mode On',type:'boolean',role:'button',read:false,write:true,def:false},native:{}});
        await this.setObjectNotExistsAsync(`${vehicle.vin}.cmd.healthy_charging_off`,{type:'state',common:{name:'Healthy Charging Mode Off',type:'boolean',role:'button',read:false,write:true,def:false},native:{}});
        // Fuel-heater (REEV/range-extender variants only, e.g. C10 EREV) -
        // no effect expected on pure-BEV models like this T03.
        await this.setObjectNotExistsAsync(`${vehicle.vin}.cmd.fuel_heating_on`,{type:'state',common:{name:'Fuel Heater On (REEV models only)',type:'boolean',role:'button',read:false,write:true,def:false},native:{}});
        await this.setObjectNotExistsAsync(`${vehicle.vin}.cmd.fuel_heating_off`,{type:'state',common:{name:'Fuel Heater Off (REEV models only)',type:'boolean',role:'button',read:false,write:true,def:false},native:{}});
        // Send a navigation destination to the vehicle's built-in nav system.
        await this.setObjectNotExistsAsync(`${vehicle.vin}.cmd.destination_address`,{type:'state',common:{name:'Destination Address',type:'string',role:'text',read:true,write:true,def:''},native:{}});
        await this.setObjectNotExistsAsync(`${vehicle.vin}.cmd.destination_latitude`,{type:'state',common:{name:'Destination Latitude',type:'number',role:'value.gps.latitude',read:true,write:true,def:0},native:{}});
        await this.setObjectNotExistsAsync(`${vehicle.vin}.cmd.destination_longitude`,{type:'state',common:{name:'Destination Longitude',type:'number',role:'value.gps.longitude',read:true,write:true,def:0},native:{}});
        await this.setObjectNotExistsAsync(`${vehicle.vin}.cmd.destination_send`,{type:'state',common:{name:'Send Destination To Vehicle',type:'boolean',role:'button',read:false,write:true,def:false},native:{}});
        await this.setObjectNotExistsAsync(`messages`,{type:'channel',common:{name:'Vehicle Messages'},native:{}});
        await this.setObjectNotExistsAsync(`messages.unread_count`,{type:'state',common:{name:'Unread Messages',type:'number',role:'value',read:true,write:false,def:0},native:{}});
        await this.setObjectNotExistsAsync(`messages.latest_title`,{type:'state',common:{name:'Latest Message Title',type:'string',role:'text',read:true,write:false,def:''},native:{}});
        await this.setObjectNotExistsAsync(`messages.latest_text`,{type:'state',common:{name:'Latest Message Text',type:'string',role:'text',read:true,write:false,def:''},native:{}});
        await this.setObjectNotExistsAsync(`messages.latest_time`,{type:'state',common:{name:'Latest Message Time',type:'string',role:'date',read:true,write:false,def:''},native:{}});
        await this.setObjectNotExistsAsync(`messages.json`,{type:'state',common:{name:'All Messages (JSON, last 10)',type:'string',role:'json',read:true,write:false,def:''},native:{}});
        await this.setObjectNotExistsAsync(`messages.ota_update_available`,{type:'state',common:{name:'Software Update Available (best-effort, from inbox message wording)',type:'boolean',role:'indicator.update',read:true,write:false,def:false},native:{}});
        await this.setObjectNotExistsAsync(`messages.ota_update_title`,{type:'state',common:{name:'Software Update Message Title',type:'string',role:'text',read:true,write:false,def:''},native:{}});
        await this.setObjectNotExistsAsync(`messages.ota_update_time`,{type:'state',common:{name:'Software Update Message Time',type:'string',role:'date',read:true,write:false,def:''},native:{}});
        await this.setObjectNotExistsAsync(`config`,{type:'channel',common:{name:'Adapter Configuration Values'},native:{}});
        await this.setObjectNotExistsAsync(`config.energy_price_eur_kwh`,{type:'state',common:{name:'Electricity Price (EUR/kWh) - manually editable',type:'number',role:'level',read:true,write:true,unit:'€/kWh',min:0,max:2,def:0.30},native:{}});
        await this.setObjectNotExistsAsync(`config.energy_price_public_eur_kwh`,{type:'state',common:{name:'Public Charging Price (EUR/kWh) - used for sessions classified as "public" (outside the home radius)',type:'number',role:'level',read:true,write:true,unit:'€/kWh',min:0,max:2,def:0.55},native:{}});
        // Moved here from adapter instance settings (2026-09) so they take
        // effect immediately without an instance restart, and so the admin
        // tab's own Settings page can read/write them like any other
        // datapoint instead of needing the ioBroker config dialog.
        await this.setObjectNotExistsAsync(`config.energy_price_state_id`,{type:'state',common:{name:'Dynamic electricity price state ID (optional) - external state (e.g. Tibber/aWATTar/EPEX) reporting live EUR/kWh; overrides the manual price above when set',type:'string',role:'text',read:true,write:true,def:''},native:{}});
        await this.setObjectNotExistsAsync(`config.route_recording_enabled`,{type:'state',common:{name:'Record GPS route during trips (opt-in) - only the last 20 routes are kept',type:'boolean',role:'switch',read:true,write:true,def:false},native:{}});
        await this.setObjectNotExistsAsync(`config.polling_interval_parked_sec`,{type:'state',common:{name:'Polling interval when parked/charging (seconds)',type:'number',role:'level',read:true,write:true,min:20,max:3600,def:60},native:{}});
        await this.setObjectNotExistsAsync(`config.polling_interval_driving_sec`,{type:'state',common:{name:'Polling interval while driving (seconds)',type:'number',role:'level',read:true,write:true,min:5,max:300,def:15},native:{}});
        await this.setObjectNotExistsAsync(`config.notify_adapter`,{type:'state',common:{name:'Notification adapter instance (e.g. telegram.0) - any sendTo-capable adapter',type:'string',role:'text',read:true,write:true,def:''},native:{}});
        await this.setObjectNotExistsAsync(`config.notify_target`,{type:'state',common:{name:'Notification target (chat ID / recipient, optional)',type:'string',role:'text',read:true,write:true,def:''},native:{}});
        await this.setObjectNotExistsAsync(`config.notify_telegrammenu2_area`,{type:'state',common:{name:'telegrammenu2 area name (optional - must already be approved in telegrammenu2; defaults to the vehicle name)',type:'string',role:'text',read:true,write:true,def:''},native:{}});
        await this.setObjectNotExistsAsync(`config.notify_trip_done`,{type:'state',common:{name:'Notify when a trip ends',type:'boolean',role:'switch',read:true,write:true,def:false},native:{}});
        await this.setObjectNotExistsAsync(`config.notify_charge_done`,{type:'state',common:{name:'Notify when charging finishes',type:'boolean',role:'switch',read:true,write:true,def:false},native:{}});
        await this.setObjectNotExistsAsync(`config.notify_ota_update`,{type:'state',common:{name:'Notify on software update available',type:'boolean',role:'switch',read:true,write:true,def:false},native:{}});
        await this.setObjectNotExistsAsync(`config.notify_new_message`,{type:'state',common:{name:'Notify when the vehicle sends a new inbox message (service reminders, recalls, etc. - separate from the software-update notification)',type:'boolean',role:'switch',read:true,write:true,def:false},native:{}});
        await this.setObjectNotExistsAsync(`config.notify_window_open`,{type:'state',common:{name:'Notify if a window is left open while parked with ignition off',type:'boolean',role:'switch',read:true,write:true,def:false},native:{}});
        await this.setObjectNotExistsAsync(`config.prepare_to_drive_enabled`,{type:'state',common:{name:'Prepare-to-Drive: auto-climate on ignition-on (opt-in)',type:'boolean',role:'switch',read:true,write:true,def:false},native:{}});
        await this.setObjectNotExistsAsync(`config.prepare_to_drive_temp_cold`,{type:'state',common:{name:'Prepare-to-Drive: heat below this outdoor temp (°C)',type:'number',role:'level.temperature',read:true,write:true,unit:'°C',def:14},native:{}});
        await this.setObjectNotExistsAsync(`config.prepare_to_drive_temp_hot`,{type:'state',common:{name:'Prepare-to-Drive: cool above this outdoor temp (°C)',type:'number',role:'level.temperature',read:true,write:true,unit:'°C',def:23},native:{}});
        await this.setObjectNotExistsAsync(`config.prepare_to_drive_target_temp`,{type:'state',common:{name:'Prepare-to-Drive: target cabin temperature (°C)',type:'number',role:'level.temperature',read:true,write:true,unit:'°C',def:22},native:{}});
        await this.setObjectNotExistsAsync(`config.prepare_to_drive_fan_speed`,{type:'state',common:{name:'Prepare-to-Drive: fan speed, 1-7',type:'number',role:'level',read:true,write:true,min:1,max:7,def:3},native:{}});
        await this.setObjectNotExistsAsync(`config.notify_prepare_to_drive`,{type:'state',common:{name:'Notify when Prepare-to-Drive triggers',type:'boolean',role:'switch',read:true,write:true,def:false},native:{}});
        await this.setObjectNotExistsAsync(`config.prepare_to_drive_sunshade_enabled`,{type:'state',common:{name:'Prepare-to-Drive: also control sunshade',type:'boolean',role:'switch',read:true,write:true,def:false},native:{}});
        await this.setObjectNotExistsAsync(`config.prepare_to_drive_sunshade_heat`,{type:'state',common:{name:'Prepare-to-Drive: sunshade position when heating (cold), 0-10',type:'number',role:'level',read:true,write:true,min:0,max:10,def:0},native:{}});
        await this.setObjectNotExistsAsync(`config.prepare_to_drive_sunshade_cool`,{type:'state',common:{name:'Prepare-to-Drive: sunshade position when cooling (hot), 0-10',type:'number',role:'level',read:true,write:true,min:0,max:10,def:0},native:{}});
        await this.setObjectNotExistsAsync(`config.prepare_to_drive_sunshade_vent`,{type:'state',common:{name:'Prepare-to-Drive: sunshade position when venting (mild), 0-10',type:'number',role:'level',read:true,write:true,min:0,max:10,def:10},native:{}});
        await this.setObjectNotExistsAsync(`config.prepare_to_drive_sunshade_skip_dark`,{type:'state',common:{name:'Prepare-to-Drive: skip sunshade movement when it is dark (sunrise/sunset at vehicle location)',type:'boolean',role:'switch',read:true,write:true,def:false},native:{}});
        // Prepare-to-Work: same core climate decision as Prepare-to-Drive,
        // but triggered explicitly via cmd.prepare_to_work (write true) -
        // for coupling to a shift schedule, calendar event, etc. instead of
        // the ignition-on edge. Own independent settings, since a "getting
        // in the car" comfort target and a "have it ready before I leave for
        // work" one may reasonably differ.
        await this.setObjectNotExistsAsync(`config.prepare_to_work_enabled`,{type:'state',common:{name:'Prepare-to-Work: enable the cmd.prepare_to_work trigger (opt-in)',type:'boolean',role:'switch',read:true,write:true,def:false},native:{}});
        await this.setObjectNotExistsAsync(`config.prepare_to_work_temp_cold`,{type:'state',common:{name:'Prepare-to-Work: heat below this outdoor temp (°C)',type:'number',role:'level.temperature',read:true,write:true,unit:'°C',def:14},native:{}});
        await this.setObjectNotExistsAsync(`config.prepare_to_work_temp_hot`,{type:'state',common:{name:'Prepare-to-Work: cool above this outdoor temp (°C)',type:'number',role:'level.temperature',read:true,write:true,unit:'°C',def:23},native:{}});
        await this.setObjectNotExistsAsync(`config.prepare_to_work_target_temp`,{type:'state',common:{name:'Prepare-to-Work: target cabin temperature (°C)',type:'number',role:'level.temperature',read:true,write:true,unit:'°C',def:22},native:{}});
        await this.setObjectNotExistsAsync(`config.prepare_to_work_fan_speed`,{type:'state',common:{name:'Prepare-to-Work: fan speed, 1-7',type:'number',role:'level',read:true,write:true,min:1,max:7,def:3},native:{}});
        await this.setObjectNotExistsAsync(`config.prepare_to_work_sunshade_enabled`,{type:'state',common:{name:'Prepare-to-Work: also control sunshade',type:'boolean',role:'switch',read:true,write:true,def:false},native:{}});
        await this.setObjectNotExistsAsync(`config.prepare_to_work_sunshade_heat`,{type:'state',common:{name:'Prepare-to-Work: sunshade position when heating (cold), 0-10',type:'number',role:'level',read:true,write:true,min:0,max:10,def:0},native:{}});
        await this.setObjectNotExistsAsync(`config.prepare_to_work_sunshade_cool`,{type:'state',common:{name:'Prepare-to-Work: sunshade position when cooling (hot), 0-10',type:'number',role:'level',read:true,write:true,min:0,max:10,def:0},native:{}});
        await this.setObjectNotExistsAsync(`config.prepare_to_work_sunshade_vent`,{type:'state',common:{name:'Prepare-to-Work: sunshade position when venting (mild), 0-10',type:'number',role:'level',read:true,write:true,min:0,max:10,def:10},native:{}});
        await this.setObjectNotExistsAsync(`config.prepare_to_work_sunshade_skip_dark`,{type:'state',common:{name:'Prepare-to-Work: skip sunshade movement when it is dark (sunrise/sunset at vehicle location)',type:'boolean',role:'switch',read:true,write:true,def:false},native:{}});
        await this.setObjectNotExistsAsync(`config.notify_prepare_to_work`,{type:'state',common:{name:'Notify when Prepare-to-Work triggers',type:'boolean',role:'switch',read:true,write:true,def:false},native:{}});
        await this.setObjectNotExistsAsync(`config.home_latitude`,{type:'state',common:{name:'Home location latitude (for home/public charging classification, optional)',type:'number',role:'value.gps.latitude',read:true,write:true,def:0},native:{}});
        await this.setObjectNotExistsAsync(`config.home_longitude`,{type:'state',common:{name:'Home location longitude (for home/public charging classification, optional)',type:'number',role:'value.gps.longitude',read:true,write:true,def:0},native:{}});
        await this.setObjectNotExistsAsync(`config.home_radius_m`,{type:'state',common:{name:'Home location radius in meters - charging within this counts as "home"',type:'number',role:'value',unit:'m',read:true,write:true,def:300},native:{}});
        // Retention: 0 = keep forever (a hard safety cap still applies - see
        // TRIP_HISTORY_HARD_CAP/ROUTE_HISTORY_HARD_CAP - so this never grows
        // truly unbounded even on "never delete"). Trip history entries are
        // small (a few fields each); GPS routes are much heavier per trip,
        // hence the separate, shorter default.
        await this.setObjectNotExistsAsync(`config.trip_history_retention_days`,{type:'state',common:{name:'Trip history retention in days (0 = keep forever, capped at 5000 trips regardless)',type:'number',role:'value',unit:'d',read:true,write:true,def:365},native:{}});
        await this.setObjectNotExistsAsync(`config.route_history_retention_days`,{type:'state',common:{name:'GPS route history retention in days (0 = keep forever, capped at 2000 routes regardless) - separate from trip history since routes are much larger',type:'number',role:'value',unit:'d',read:true,write:true,def:30},native:{}});
        const defaultCapacity=getDefaultBatteryCapacity(vehicle.carType);
        await this.setObjectNotExistsAsync(`${vehicle.vin}.config`,{type:'channel',common:{name:'Vehicle Configuration Values'},native:{}});
        await this.setObjectNotExistsAsync(`${vehicle.vin}.config.battery_capacity_kwh`,{type:'state',common:{name:'Battery Capacity (kWh, net) - adjust if your battery variant differs from the model default',type:'number',role:'level',read:true,write:true,unit:'kWh',min:10,max:150,def:defaultCapacity},native:{}});
        await this.setObjectNotExistsAsync(`${vehicle.vin}.trips`,{type:'channel',common:{name:'Trips & Daily Kilometers'},native:{}});
        await this.setObjectNotExistsAsync(`${vehicle.vin}.trips.daily_km_json`,{type:'state',common:{name:'Daily Kilometers (JSON, last 30 days)',type:'string',role:'json',read:true,write:false,def:'[]'},native:{}});
        await this.setObjectNotExistsAsync(`${vehicle.vin}.trips.today_km`,{type:'state',common:{name:'Kilometers Driven Today',type:'number',role:'value',read:true,write:false,unit:'km',def:0},native:{}});
        await this.setObjectNotExistsAsync(`${vehicle.vin}.trips.history_json`,{type:'state',common:{name:'Trip History (JSON, last 50 trips)',type:'string',role:'json',read:true,write:false,def:'[]'},native:{}});
        await this.setObjectNotExistsAsync(`${vehicle.vin}.trips.current_trip_active`,{type:'state',common:{name:'Trip Currently In Progress',type:'boolean',role:'indicator',read:true,write:false,def:false},native:{}});
        await this.setObjectNotExistsAsync(`${vehicle.vin}.cmd.trips_merge`,{type:'state',common:{name:'Merge Trip Into Previous (write the trip startTimeMs to merge)',type:'string',role:'text',read:false,write:true,def:''},native:{}});
        await this.setObjectNotExistsAsync(`${vehicle.vin}.cmd.trips_merge_undo`,{type:'state',common:{name:'Undo Last Trip Merge (one-slot, lost on adapter restart)',type:'boolean',role:'button',read:false,write:true,def:false},native:{}});
        await this.setObjectNotExistsAsync(`${vehicle.vin}.cmd.prepare_to_work`,{type:'state',common:{name:'Trigger Prepare-to-Work (write true - couple to a shift schedule/calendar script)',type:'boolean',role:'button',read:false,write:true,def:false},native:{}});
        await this.setObjectNotExistsAsync(`${vehicle.vin}.trips.last_merge_startms`,{type:'state',common:{name:'startTimeMs of the currently undo-able merged trip (0 = none)',type:'number',role:'value',read:true,write:false,def:0},native:{}});
        await this.setObjectNotExistsAsync(`${vehicle.vin}.battery.soh_samples_json`,{type:'state',common:{name:'Battery SoH raw capacity samples (JSON, last 30, internal)',type:'string',role:'json',read:true,write:false,def:'[]'},native:{}});
        await this.setObjectNotExistsAsync(`${vehicle.vin}.battery.estimated_capacity_kwh`,{type:'state',common:{name:'Estimated Battery Capacity (median of recent trips, from official cloud energy data)',type:'number',role:'value',read:true,write:false,unit:'kWh',def:0},native:{}});
        await this.setObjectNotExistsAsync(`${vehicle.vin}.battery.soh_percent`,{type:'state',common:{name:'Estimated Battery State of Health (rough estimate from official per-trip energy data - not a manufacturer diagnostic figure)',type:'number',role:'value',read:true,write:false,unit:'%',def:0},native:{}});
        await this.setObjectNotExistsAsync(`${vehicle.vin}.battery.soh_sample_count`,{type:'state',common:{name:'Number of trips contributing to the current SoH estimate',type:'number',role:'value',read:true,write:false,def:0},native:{}});
        await this.setObjectNotExistsAsync(`${vehicle.vin}.trips.routes_json`,{type:'state',common:{name:'GPS Routes for last 20 trips with recording enabled (JSON, keyed by trip startTimeMs)',type:'string',role:'json',read:true,write:false,def:'{}'},native:{}});
        await this.setObjectNotExistsAsync(`${vehicle.vin}.charging`,{type:'channel',common:{name:'Charging Session'},native:{}});
        await this.setObjectNotExistsAsync(`${vehicle.vin}.charging.session_cost`,{type:'state',common:{name:'Current/Last Charging Session Cost',type:'number',role:'value',read:true,write:false,unit:'€',def:0},native:{}});
        await this.setObjectNotExistsAsync(`${vehicle.vin}.charging.session_kwh`,{type:'state',common:{name:'Current/Last Charging Session Energy (estimated)',type:'number',role:'value',read:true,write:false,unit:'kWh',def:0},native:{}});
        await this.setObjectNotExistsAsync(`${vehicle.vin}.charging.session_active`,{type:'state',common:{name:'Charging Session In Progress',type:'boolean',role:'indicator',read:true,write:false,def:false},native:{}});
        await this.setObjectNotExistsAsync(`${vehicle.vin}.charging.session_location`,{type:'state',common:{name:'Current/Last Charging Session Location (home/public/unknown)',type:'string',role:'text',read:true,write:false,def:'unknown'},native:{}});
        await this.setObjectNotExistsAsync(`${vehicle.vin}.charging.home_total_kwh`,{type:'state',common:{name:'Lifetime Energy Charged At Home',type:'number',role:'value',read:true,write:false,unit:'kWh',def:0},native:{}});
        await this.setObjectNotExistsAsync(`${vehicle.vin}.charging.home_total_cost`,{type:'state',common:{name:'Lifetime Cost Charged At Home',type:'number',role:'value',read:true,write:false,unit:'€',def:0},native:{}});
        await this.setObjectNotExistsAsync(`${vehicle.vin}.charging.public_total_kwh`,{type:'state',common:{name:'Lifetime Energy Charged At Public Stations',type:'number',role:'value',read:true,write:false,unit:'kWh',def:0},native:{}});
        await this.setObjectNotExistsAsync(`${vehicle.vin}.charging.public_total_cost`,{type:'state',common:{name:'Lifetime Cost Charged At Public Stations',type:'number',role:'value',read:true,write:false,unit:'€',def:0},native:{}});
        await this.setObjectNotExistsAsync(`${vehicle.vin}.charging.unknown_total_kwh`,{type:'state',common:{name:'Lifetime Energy Charged (location unknown - no home location configured, or GPS unavailable at session start)',type:'number',role:'value',read:true,write:false,unit:'kWh',def:0},native:{}});
        await this.setObjectNotExistsAsync(`${vehicle.vin}.charging.unknown_total_cost`,{type:'state',common:{name:'Lifetime Cost Charged (location unknown)',type:'number',role:'value',read:true,write:false,unit:'€',def:0},native:{}});
        await this.setObjectNotExistsAsync(`${vehicle.vin}.cmd.defrost_cycle`,{type:'state',common:{name:'Cycle Windshield Defrost (off/weak/strong)',type:'boolean',role:'button',read:false,write:true,def:false},native:{}});
        await this.setObjectNotExistsAsync(`${vehicle.vin}.cmd.quick_cool`,{type:'state',common:{name:'Quick Cool',type:'boolean',role:'button',read:false,write:true,def:false},native:{}});
        await this.setObjectNotExistsAsync(`${vehicle.vin}.cmd.quick_heat`,{type:'state',common:{name:'Quick Heat',type:'boolean',role:'button',read:false,write:true,def:false},native:{}});
        await this.setObjectNotExistsAsync(`${vehicle.vin}.cmd.sunshade_set`,{type:'state',common:{name:'Sunshade Position (0-10)',type:'number',role:'level.blind',read:true,write:true,min:0,max:10,def:0},native:{}});
                await this.setObjectNotExistsAsync(`${vehicle.vin}.cmd.ac_recirculate`,{type:'state',common:{name:'Recirculate Air',type:'boolean',role:'switch',read:true,write:true,def:false},native:{}});
    }

    async writeStatusStates(vin,s){
        const prevKeyPosition=this.lastStatus[vin]?(this.lastStatus[vin].bcmKeyPositionOn1||this.lastStatus[vin].bcmKeyPositionOn3):undefined;
        this.lastStatus[vin]=s;
        const set=async(id,val)=>{if(val!==null&&val!==undefined)await this.setStateAsync(`${vin}.${id}`,{val,ack:true})};
        const tire=v=>v!=null?Math.round(v)/100:null;
        // Battery
        await set('status.battery_soc',s.soc);
        await set('status.battery_current',s.batteryCurrent);
        await set('status.battery_voltage',s.batteryVoltage);
        let batteryEnergyKwh=s.dumpEnergy!=null?Math.round(s.dumpEnergy/100)/10:null;
        if(batteryEnergyKwh===null&&s.soc!=null){
            // No direct signal for remaining energy on this model (e.g. C10/B10) -
            // estimate it from SOC and the configured/default battery capacity instead.
            const capState=await this.getStateAsync(`${vin}.config.battery_capacity_kwh`);
            const vehicleForCapacity=this.vehicles.find(v=>v.vin===vin);
            const capacity=Number(capState?.val)||getDefaultBatteryCapacity(vehicleForCapacity?.carType);
            batteryEnergyKwh=Math.round((s.soc/100)*capacity*10)/10;
        }
        await set('status.battery_energy_kwh',batteryEnergyKwh);
        // Range
        await set('status.range_km',s.expectedMileage);
        await set('status.range_miles',s.expectedMileageMile!=null?parseFloat(s.expectedMileageMile):(s.expectedMileage!=null?Math.round(s.expectedMileage*0.621371*10)/10:null));
        await set('status.mileage_total',s.totalMileage);
        // Temperature
        let temp_outdoor=s.outdoorTemp;
        if(temp_outdoor==null){
            // Some models don't report this at all (confirmed absent on
            // B10). fetchWeatherTemp caches internally (30min) and falls
            // back to its last known-good value on any API error, so this
            // is safe to call on every poll.
            temp_outdoor=await this.fetchWeatherTemp(s.latitude,s.longitude);
        }
        await set('status.temp_outdoor',temp_outdoor);
        await set('status.temp_battery_min',s.minSingleTemp);
        // Charging
        await set('status.charging_active',s.chargeState!=null?isActuallyCharging(s.chargeState,s.gearStatus,s.speed,s.bcmKeyPositionOn3):null);
        await set('status.charging_state',s.chargeState);
        await set('status.charging_soc_limit',s.chargesocSetting);
        // Keep the writable cmd.charge_limit_set control in sync with the
        // vehicle's actual current limit. Without this, changing the limit
        // via the official app (instead of this adapter's own control)
        // leaves cmd.charge_limit_set frozen at its creation-time default
        // (80) forever - which then gets silently sent back to the vehicle
        // by charge_schedule_apply, overwriting a real, intentionally
        // different limit (e.g. 100%) the next time that runs.
        if(s.chargesocSetting!=null)await set('cmd.charge_limit_set',s.chargesocSetting);
        await set('status.charging_remain_min',s.chargeRemainTime);
        await set('status.charging_plugged',s.chargeState!=null?s.chargeState>0:null);
        await set('status.dc_fast_charge',s.dcInputFastCharge!=null?s.dcInputFastCharge===1:null);
        await set('status.charge_time_setting',s.chargeTimeSetting);
        // Climate
        await set('status.ac_on',s.acSwitch);
        await set('status.ac_temp',s.acSetting);
        await set('status.ac_fan_speed',s.acAirVolume);
        await set('status.ac_fan_speed_setting',s.acAirVolumeSetting);
        await set('status.ac_wind_direction',s.acWindDirection);
        await set('status.ac_recirculate',s.acCircleMode);
        await set('status.ac_cooling_heating',s.acCoolingAndHeating);
        await set('status.ptc_state',s.ptcState);
        await set('status.ptc_power',s.ptcPowerSettingValue);
        // Drive
        await set('status.drive_speed',s.speed);
        await set('status.drive_parked',s.speed!=null?s.speed===0:null);
        await set('status.gear',s.gearStatus);
        await set('status.key_position',s.bcmKeyPositionOn1||s.bcmKeyPositionOn3);
        // Security
        await set('status.security_locked',s.driverDoorLockStatus);
        await set('status.door_ctrl_allow',s.bcmDoorCtrlAllow);
        // Doors
        await set('status.door_driver',s.lbcmDriverDoorStatus);
        await set('status.door_front_right',s.rbcmDriverDoorStatus);
        await set('status.door_rear_left',s.lbcmLeftRearDoorStatus);
        await set('status.door_rear_right',s.rbcmRightRearDoorStatus);
        await set('status.door_trunk',s.bbcmBackDoorStatus);
        // Windows
        await set('status.window_fl_pct',s.leftFrontWindowPercent);
        await set('status.window_fr_pct',s.rightFrontWindowPercent);
        await set('status.window_rl_pct',s.leftRearWindowPercent);
        await set('status.window_rr_pct',s.rightRearWindowPercent);
        // On T03, the binary window-open flags can unreliably remain at 0
        // even when the window is actually open - fall back to the live
        // position percent in that case. Other models keep the flag-only
        // behavior, matching leapmotor-ha's verified per-model handling.
        const vehicleForWindows=this.vehicles.find(v=>v.vin===vin);
        const isT03=String(vehicleForWindows?.carType||'').toUpperCase()==='T03';
        const windowOpenState=(flag,percent)=>isT03?Boolean(flag||(percent>0)):flag;
        await set('status.window_driver_open',windowOpenState(s.driverWindowStatus,s.leftFrontWindowPercent));
        await set('status.window_fr_open',windowOpenState(s.rightFrontWindowStatus,s.rightFrontWindowPercent));
        await set('status.window_rl_open',windowOpenState(s.leftRearWindowStatus,s.leftRearWindowPercent));
        await set('status.window_rr_open',windowOpenState(s.rightRearWindowStatus,s.rightRearWindowPercent));
        try{await this.checkWindowWarning(vehicleForWindows,s.speed===0,s.bcmKeyPositionOn1||s.bcmKeyPositionOn3,{
            fl:s.leftFrontWindowPercent||0,fr:s.rightFrontWindowPercent||0,
            rl:s.leftRearWindowPercent||0,rr:s.rightRearWindowPercent||0,
        });}catch(e){this.log.debug(`Window warning check error: ${e}`)}
        try{await this.checkPrepareToDrive(vin,s,prevKeyPosition);}catch(e){this.log.debug(`Prepare-to-drive check error: ${e}`)}
        await set('status.sun_shade',s.sunShade);
        // Tires
        await set('status.tire_fl',tire(s.leftFrontTirePressure));
        await set('status.tire_fr',tire(s.rightFrontTirePressure));
        await set('status.tire_rl',tire(s.leftRearTirePressure));
        await set('status.tire_rr',tire(s.rightRearTirePressure));
        await set('status.tire_fl_state',s.leftFrontTirePressureState);
        await set('status.tire_fr_state',s.rightFrontTirePressureState);
        await set('status.tire_rl_state',s.leftRearTirePressureState);
        await set('status.tire_rr_state',s.rightRearTirePressureState);
        // Location
        await set('status.location_lat',s.latitude);
        await set('status.location_lon',s.longitude);
        await set('status.privacy_gps',s.privacyGPS);
        await set('status.privacy_data',s.privacyData);
        // Connectivity
        await set('status.bluetooth_on',s.bluetoothState);
        await set('status.bluetooth_addr',s.bluetoothAddr);
        await set('status.hotspot_on',s.hotspotState);
        // Timestamps
        // The cloud's raw collectTime string has NO timezone marker and is
        // actually UTC - displaying it as-is looks like local time but runs
        // ~2h behind in CEST (confirmed: app showed 3:13, this raw string
        // showed 01:13:49). collectTimeMs IS a real epoch value, so derive
        // the displayed string from that instead, formatted in whatever
        // timezone this ioBroker host itself runs in (no hardcoded zone).
        await set('status.collect_time',s.collectTimeMs!=null?new Date(s.collectTimeMs).toLocaleString('de-DE'):s.collectTime);
        await set('status.collect_time_ms',s.collectTimeMs);
        // Data freshness: the cloud can re-serve its last cached frame while
        // the car is asleep/unreachable, still returning HTTP success - so a
        // "successful" poll doesn't mean the data is current (community
        // finding, leapmotor-mate). collectTimeMs is the VEHICLE's own
        // timestamp for when it captured this data, so comparing it against
        // now shows the real age regardless of when our poll ran.
        if(s.collectTimeMs!=null){
            const ageMin=Math.round((Date.now()-s.collectTimeMs)/60000);
            await set('status.data_age_min',ageMin);
            await set('status.data_stale',ageMin>30);
        }
    }

    async onStateChange(id,state){
        if(!state||state.ack||!this.client)return;
        // Any top-level config.* or per-vehicle config.* datapoint is a
        // plain user-editable setting (price, capacity, polling intervals,
        // notification settings, GPS recording toggle, ...) - just mirror
        // the write with ack:true, no vehicle/cmd routing needed.
        const idTail=id.replace(`${this.namespace}.`,'');
        if(idTail.startsWith('config.')||idTail.endsWith('.config.battery_capacity_kwh')){
            await this.setStateAsync(id,{val:state.val,ack:true});
            return;
        }
        const parts=id.replace(`${this.namespace}.`,'').split('.');
        if(parts.length<3||parts[1]!=='cmd')return;
        const vin=parts[0],cmd=parts[2];
        const vehicle=this.vehicles.find(v=>v.vin===vin);if(!vehicle)return;
        if(cmd==='ac_temp'||cmd==='ac_fan_speed'||cmd==='ac_position'||cmd==='ac_recirculate'){
            await this.setStateAsync(id,{val:state.val,ack:true});
            // These just stage a value for the NEXT climate command (ac_heat/
            // ac_cool/etc. read them back) - nothing is sent to the vehicle
            // yet, so this logs "stored", not "successful".
            this.log.debug(`${cmd} stored for ${vehicle.vin} (value=${state.val}) - takes effect on the next climate command`);
            // Status-Datenpunkt synchron halten
            if(cmd==='ac_temp'){
                await this.setStateAsync(`${vin}.status.ac_temp`,{val:state.val,ack:true});
                // HTML sofort neu bauen mit neuem Temp-Wert
                const s=await this.client.getVehicleStatus(vehicle);
                s.acSetting=state.val;
                await this.buildCompositeHtml(vin,s,vehicle.name);
            }
            if(cmd==='ac_fan_speed')await this.setStateAsync(`${vin}.status.ac_fan_speed`,{val:state.val,ack:true});
            return;
        }
        if(cmd==='windows_set'){
            await this.setStateAsync(id,{val:state.val,ack:true});
            const nativeVal=toNativeWindowPosition(vehicle.carType,state.val);
            this.log.debug(`Command: windows_set for ${vehicle.vin} (value=${state.val}%, native=${nativeVal})`);
            try{
                try{
                    await this.client.sendCommandWithPin(vehicle,'230',JSON.stringify({value:String(nativeVal)}));
                }catch(e){
                    if(String(e).includes('ngültig')||String(e).includes('token')){
                        await this.client.login();
                        await this.client.sendCommandWithPin(vehicle,'230',JSON.stringify({value:String(nativeVal)}));
                    }else{throw e}
                }
                this.log.debug(`windows_set successful.`);
                await this.setStateAsync(`${vin}.status.window_fl_pct`,{val:state.val,ack:true});
                await this.setStateAsync(`${vin}.status.window_fr_pct`,{val:state.val,ack:true});
            }catch(e){this.log.error(`windows_set failed: ${e}`)}
            return;
        }
        if(cmd==='sunshade_set'){
            await this.setStateAsync(id,{val:state.val,ack:true});
            this.log.debug(`Command: sunshade_set for ${vehicle.vin} (value=${state.val})`);
            try{
                try{
                    await this.client.sendCommandWithPin(vehicle,'240',JSON.stringify({value:String(state.val)}));
                }catch(e){
                    if(String(e).includes('ngültig')||String(e).includes('token')){
                        await this.client.login();
                        await this.client.sendCommandWithPin(vehicle,'240',JSON.stringify({value:String(state.val)}));
                    }else{throw e}
                }
                this.log.debug(`sunshade_set successful.`);
                await this.setStateAsync(`${vin}.status.sun_shade`,{val:state.val,ack:true});
            }catch(e){this.log.error(`sunshade_set failed: ${e}`)}
            return;
        }
        if(cmd==='speed_limit_set'){
            await this.setStateAsync(id,{val:state.val,ack:true});
            this.log.debug(`Command: speed_limit_set for ${vehicle.vin} (value=${state.val})`);
            try{
                const content=JSON.stringify({value:String(state.val)});
                try{
                    await this.client.sendCommandWithPin(vehicle,'510',content);
                }catch(e){
                    if(String(e).includes('ngültig')||String(e).includes('token')){
                        await new Promise(r=>this.setTimeout(r,500));
                        await this.client.login();
                        await this.client.sendCommandWithPin(vehicle,'510',content);
                    }else{throw e}
                }
                this.log.debug(`speed_limit_set successful.`);
            }catch(e){this.log.error(`speed_limit_set failed: ${e}`)}
            return;
        }
        if(cmd==='seat_heat_driver'||cmd==='seat_heat_copilot'){
            await this.setStateAsync(id,{val:state.val,ack:true});
            const seatPos=cmd==='seat_heat_driver'?'driver':'copilot';
            this.log.debug(`Command: ${cmd} for ${vehicle.vin} (level=${state.val})`);
            try{
                // Verified via leapmotor-ha's live app captures: separate
                // position/level keys, not our previous comma-joined
                // "3,2"-style single value string.
                const content=JSON.stringify({position:seatPos,level:String(state.val)});
                try{
                    await this.client.sendCommandWithPin(vehicle,'301',content);
                }catch(e){
                    if(String(e).includes('ngültig')||String(e).includes('token')){
                        await new Promise(r=>this.setTimeout(r,500));
                        await this.client.login();
                        await this.client.sendCommandWithPin(vehicle,'301',content);
                    }else{throw e}
                }
                this.log.debug(`${cmd} successful.`);
            }catch(e){this.log.error(`${cmd} failed: ${e}`)}
            return;
        }
        if(cmd==='seat_ventilation_driver'||cmd==='seat_ventilation_copilot'){
            await this.setStateAsync(id,{val:state.val,ack:true});
            const seatPos=cmd==='seat_ventilation_driver'?'driver':'copilot';
            this.log.debug(`Command: ${cmd} for ${vehicle.vin} (level=${state.val})`);
            try{
                const content=JSON.stringify({position:seatPos,level:String(state.val)});
                try{
                    await this.client.sendCommandWithPin(vehicle,'370',content);
                }catch(e){
                    if(String(e).includes('ngültig')||String(e).includes('token')){
                        await new Promise(r=>this.setTimeout(r,500));
                        await this.client.login();
                        await this.client.sendCommandWithPin(vehicle,'370',content);
                    }else{throw e}
                }
                this.log.debug(`${cmd} successful.`);
            }catch(e){this.log.error(`${cmd} failed: ${e}`)}
            return;
        }
        if(cmd==='destination_send'&&state.val===true){
            await this.setStateAsync(id,{val:false,ack:true});
            try{
                const addrState=await this.getStateAsync(`${vehicle.vin}.cmd.destination_address`);
                const latState=await this.getStateAsync(`${vehicle.vin}.cmd.destination_latitude`);
                const lonState=await this.getStateAsync(`${vehicle.vin}.cmd.destination_longitude`);
                const address=String(addrState?.val??'').trim();
                const latitude=String(latState?.val??0);
                const longitude=String(lonState?.val??0);
                // Community-test addition (2026-09): payload format verified
                // against two independent community reverse-engineering
                // projects, not against real hardware here. requiresPin is
                // false in both reference sources.
                const content=JSON.stringify({address:address||`${latitude},${longitude}`,addressname:address||`${latitude},${longitude}`,latitude,longitude,linenum:'0'});
                this.log.debug(`Command: destination_send for ${vehicle.vin} (address=${address||'(none)'}, lat=${latitude}, lon=${longitude})`);
                try{
                    await this.client.sendCommandWithoutPin(vehicle,'180',content);
                }catch(e){
                    if(String(e).includes('ngültig')||String(e).includes('token')){
                        await this.client.login();
                        await this.client.sendCommandWithoutPin(vehicle,'180',content);
                    }else{throw e}
                }
                this.log.debug(`destination_send successful.`);
            }catch(e){this.log.error(`${cmd} failed: ${e}`)}
            return;
        }
        if(cmd==='charge_limit_set'){
            await this.setStateAsync(id,{val:state.val,ack:true});
            try{
                // Preserve the vehicle's existing charge schedule (enabled state,
                // recurrence, start/end time) and only change the SOC target.
                // Previously this always sent chargeEnable:0 + fixed default
                // times, silently disabling any active schedule on every limit
                // change - the vehicle then appears to ignore the SOC value
                // entirely and just charges to 100% (confirmed against the
                // reference leapmotor-api project's set_charge_limit(), which
                // fixed this exact issue under its own "issue #18").
                let existing=null;
                try{existing=await this.client.getAppointment(vehicle,'190');}catch(e){this.log.debug(`charge_limit_set: could not read existing schedule, using defaults: ${e}`)}
                const content=JSON.stringify({
                    chargeEnable:existing?.chargeEnable??0,
                    chargesoc:Number(state.val),
                    circulation:existing?.circulation??0,
                    cycles:existing?.cycles||'1,2,3,4,5,6,7',
                    endtime:existing?.endtime||'08:00',
                    recharge:existing?.recharge??0,
                    starttime:existing?.starttime||'00:00',
                });
                this.log.debug(`Command: charge_limit_set for ${vehicle.vin} (limit=${state.val}%)`);
                try{
                    await this.client.sendCommandWithPin(vehicle,'190',content);
                }catch(e){
                    if(String(e).includes('ngültig')||String(e).includes('token')){
                        await new Promise(r=>this.setTimeout(r,500));
                        await this.client.login();
                        await this.client.sendCommandWithPin(vehicle,'190',content);
                    }else{throw e}
                }
                this.log.debug(`charge_limit_set successful.`);
                await this.setStateAsync(`${vin}.status.charging_soc_limit`,{val:state.val,ack:true});
            }catch(e){this.log.error(`charge_limit_set failed: ${e}`)}
            return;
        }
        if(cmd==='climate_schedule_enable'||cmd==='climate_schedule_time'||cmd==='climate_schedule_mode'||cmd==='climate_schedule_days'){
            await this.setStateAsync(id,{val:state.val,ack:true});
            this.log.debug(`${cmd} stored for ${vehicle.vin} (value=${state.val}) - takes effect on climate_schedule_apply`);
            return;
        }
        if(cmd==='climate_schedule_cancel'&&state.val===true){
            await this.setStateAsync(id,{val:false,ack:true});
            await this.setStateAsync(`${vin}.cmd.climate_schedule_enable`,{val:false,ack:true});
            try{
                const content=JSON.stringify({controls:[]});
                this.log.debug(`Command: climate_schedule_cancel for ${vehicle.vin}`);
                try{
                    await this.client.sendCommandWithPin(vehicle,'171',content);
                }catch(e){
                    if(String(e).includes('ngültig')||String(e).includes('token')){
                        await new Promise(r=>this.setTimeout(r,500));
                        await this.client.login();
                        await this.client.sendCommandWithPin(vehicle,'171',content);
                    }else{throw e}
                }
                this.log.debug('climate_schedule_cancel: all schedules deleted');
            }catch(e){this.log.error(`climate_schedule_cancel failed: ${e}`)}
            return;
        }
        if(cmd==='climate_schedule_apply'&&state.val===true){
            await this.setStateAsync(id,{val:false,ack:true});
            try{
                const enState=await this.getStateAsync(`${vin}.cmd.climate_schedule_enable`);
                const timeState=await this.getStateAsync(`${vin}.cmd.climate_schedule_time`);
                const modeState=await this.getStateAsync(`${vin}.cmd.climate_schedule_mode`);
                const daysState=await this.getStateAsync(`${vin}.cmd.climate_schedule_days`);
                const tempState3=await this.getStateAsync(`${vin}.cmd.ac_temp`);
                const fanState3=await this.getStateAsync(`${vin}.cmd.ac_fan_speed`);
                const enabled=enState?.val?'1':'0';
                const timeStr=String(timeState?.val??'07:00');
                const mode=String(modeState?.val??'hot');
                const temp=String(tempState3?.val??22);
                const fan=String(fanState3?.val??3);
                const daysStr=String(daysState?.val??'0,1,2,3,4,5,6');
                const days=daysStr.split(',').map(d=>Number(d.trim())).filter(d=>!isNaN(d));
                const now=new Date();
                const startTime=`${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')} ${timeStr}:00`;
                const setId=`air_set${Date.now()}`;
                const control={mode,on:enabled,operate:'manual',set_id:setId,start_time:startTime,temperature:temp,update_time:String(Date.now()),windlevel:fan,days:days.length>0?days:[0,1,2,3,4,5,6],circle:mode==='wind'?'out':'in',position:'all',wshld:'0'};
                const content=JSON.stringify({controls:[control]});
                try{
                    await this.client.sendCommandWithPin(vehicle,'171',content);
                }catch(e){
                    if(String(e).includes('ngültig')||String(e).includes('token')){
                        await new Promise(r=>this.setTimeout(r,500));
                        await this.client.login();
                        await this.client.sendCommandWithPin(vehicle,'171',content);
                    }else{throw e}
                }
                this.log.debug(`climate_schedule_apply: ${JSON.stringify(control)}`);
            }catch(e){this.log.error(`climate_schedule_apply failed: ${e}`)}
            return;
        }
        if(cmd==='charge_schedule_enable'||cmd==='charge_schedule_start'||cmd==='charge_schedule_end'){
            await this.setStateAsync(id,{val:state.val,ack:true});
            this.log.debug(`${cmd} stored for ${vehicle.vin} (value=${state.val}) - takes effect on charge_schedule_apply`);
            return;
        }
        if(cmd==='charge_schedule_apply'&&state.val===true){
            await this.setStateAsync(id,{val:false,ack:true});
            try{
                const enState=await this.getStateAsync(`${vin}.cmd.charge_schedule_enable`);
                const startState=await this.getStateAsync(`${vin}.cmd.charge_schedule_start`);
                const endState=await this.getStateAsync(`${vin}.cmd.charge_schedule_end`);
                const limitState=await this.getStateAsync(`${vin}.cmd.charge_limit_set`);
                const enabled=enState?.val?1:0;
                const start=String(startState?.val??'00:00');
                const end=String(endState?.val??'08:00');
                // Bug fix: this used to fall back to a hardcoded 80 whenever
                // our own cmd.charge_limit_set object had never been touched
                // (it defaults to 80 at creation, regardless of the
                // vehicle's ACTUAL current limit) - silently overwriting a
                // real 100% (or any other) limit set via the official app
                // every time this ran. Now falls back to the vehicle's own
                // currently active schedule value instead of a fixed number,
                // and only uses 80 if genuinely nothing else is available.
                // (cmd.charge_limit_set is now also kept in sync on every
                // poll - see updateVehicleStatus - so this fallback should
                // rarely even be needed going forward.)
                let existing=null;
                try{existing=await this.client.getAppointment(vehicle,'190');}catch(e){this.log.debug(`charge_schedule_apply: could not read existing schedule: ${e}`)}
                const limit=Number(limitState?.val??existing?.chargesoc??80);
                const content=JSON.stringify({chargeEnable:enabled,chargesoc:limit,circulation:0,cycles:'1,2,3,4,5,6,7',endtime:end,recharge:0,starttime:start});
                this.log.debug(`Command: charge_schedule_apply for ${vehicle.vin} (enabled=${enabled}, start=${start}, end=${end}, limit=${limit}%)`);
                try{
                    await this.client.sendCommandWithPin(vehicle,'190',content);
                }catch(e){
                    if(String(e).includes('ngültig')||String(e).includes('token')){
                        await new Promise(r=>this.setTimeout(r,500));
                        await this.client.login();
                        await this.client.sendCommandWithPin(vehicle,'190',content);
                    }else{throw e}
                }
                this.log.debug(`charge_schedule_apply successful (enabled=${enabled} start=${start} end=${end} limit=${limit}).`);
            }catch(e){this.log.error(`charge_schedule_apply failed: ${e}`)}
            return;
        }
        if(cmd==='defrost_level'){
            await this.setStateAsync(id,{val:state.val,ack:true});
            this.log.debug(`defrost_level stored for ${vehicle.vin} (value=${state.val}) - takes effect on defrost_cycle`);
            return;
        }
        if(cmd==='defrost_cycle'&&state.val===true){
            const curState=await this.getStateAsync(`${vin}.cmd.defrost_level`);
            const cur=curState?.val??0;
            const next=(cur+1)%2;
            await this.setStateAsync(id,{val:false,ack:true});
            await this.setStateAsync(`${vin}.cmd.defrost_level`,{val:next,ack:true});
            const acOnState=await this.getStateAsync(`${vin}.status.ac_on`);
            const acModeState=await this.getStateAsync(`${vin}.status.ac_cooling_heating`);
            const tempState2=await this.getStateAsync(`${vin}.cmd.ac_temp`);
            const fanState2=await this.getStateAsync(`${vin}.cmd.ac_fan_speed`);
            const posState2=await this.getStateAsync(`${vin}.cmd.ac_position`);
            const reciState2=await this.getStateAsync(`${vin}.cmd.ac_recirculate`);
            const temp2=String(tempState2?.val??22);
            const fan2=String(fanState2?.val??3);
            const pos2=String(posState2?.val??'all');
            const reci2=(reciState2?.val===true)?'in':'out';
            const acOn2=acOnState?.val??false;
            const acMode2=acModeState?.val;
            let mode2='wind',circle2=reci2;
            if(acOn2&&acMode2===2){mode2='hot';circle2='in';}
            else if(acOn2&&acMode2===1){mode2='cold';circle2='in';}
            try{
                const sendDefrost=async(payload)=>{
                    try{
                        await this.client.sendCommandWithPin(vehicle,'170',payload);
                    }catch(e){
                        if(String(e).includes('ngültig')||String(e).includes('token')){
                            await this.client.login();
                            await this.client.sendCommandWithPin(vehicle,'170',payload);
                        }else{throw e}
                    }
                };
                const wshldVal=next===1?'1':'0';
                const operate2=acOn2?'manual':'off';
                this.log.debug(`Command: defrost_cycle for ${vehicle.vin} (stage ${cur} -> ${next}, wshld=${wshldVal}, mode=${mode2})`);
                await sendDefrost(JSON.stringify({circle:circle2,mode:mode2,operate:operate2,position:pos2,temperature:temp2,windlevel:fan2,wshld:wshldVal}));
                this.log.debug(`defrost_cycle successful (stage ${cur} -> ${next}).`);
            }catch(e){this.log.error(`defrost_cycle failed: ${e}`)}
            return;
        }
        if(cmd==='trips_merge'&&state.val){
            await this.setStateAsync(id,{val:'',ack:true});
            try{
                const targetStartMs=Number(state.val);
                const stateId=`${vin}.trips.history_json`;
                const cur=await this.getStateAsync(stateId);
                let history=[];
                try{history=JSON.parse(cur?.val||'[]')}catch{history=[]}
                const idx=history.findIndex(t=>t.startTimeMs===targetStartMs);
                if(idx<1){
                    this.log.debug(`trips_merge: trip ${targetStartMs} not found or has no predecessor`);
                }else{
                    const prevTrip=history[idx-1];
                    const thisTrip=history[idx];
                    // Merge into ONE trip spanning prevTrip's start to thisTrip's end.
                    // km/soc simply add; energy only carries over if BOTH sides already
                    // had an official cloud figure, otherwise the merged trip goes back
                    // to pending (its window now covers both, so a retry can pick up the
                    // combined official value cleanly).
                    const merged={
                        date:prevTrip.date,
                        startTime:prevTrip.startTime,
                        endTime:thisTrip.endTime,
                        startTimeMs:prevTrip.startTimeMs,
                        endTimeMs:thisTrip.endTimeMs,
                        km:Math.round(((prevTrip.km||0)+(thisTrip.km||0))*10)/10,
                        durationMin:Math.round((thisTrip.endTimeMs-prevTrip.startTimeMs)/60000),
                        socUsed:(prevTrip.socUsed!=null&&thisTrip.socUsed!=null)?prevTrip.socUsed+thisTrip.socUsed:(prevTrip.socUsed??thisTrip.socUsed??null),
                    };
                    if(prevTrip.energyOfficial&&thisTrip.energyOfficial){
                        merged.energyDrivingKwh=Math.round(((prevTrip.energyDrivingKwh||0)+(thisTrip.energyDrivingKwh||0))*100)/100;
                        merged.energyAcKwh=Math.round(((prevTrip.energyAcKwh||0)+(thisTrip.energyAcKwh||0))*100)/100;
                        merged.energyOtherKwh=Math.round(((prevTrip.energyOtherKwh||0)+(thisTrip.energyOtherKwh||0))*100)/100;
                        merged.energyOfficial=true;
                    }else{
                        merged.energyPending=true;
                        const ecBeginMs=computeEnergyQueryBeginMs(merged.startTimeMs,history.slice(0,idx-1));
                        if(!this._pendingEnergyTrips)this._pendingEnergyTrips={};
                        if(!this._pendingEnergyTrips[vin])this._pendingEnergyTrips[vin]=[];
                        this._pendingEnergyTrips[vin].push({startTimeMs:merged.startTimeMs,endTimeMs:merged.endTimeMs,ecBeginMs,date:merged.date,startTime:merged.startTime,attempts:0});
                    }
                    // Merge GPS routes too (if recorded for either side) -
                    // concatenate chronologically under the merged trip's key,
                    // drop the two old per-trip route entries.
                    const routesStateId=`${vin}.trips.routes_json`;
                    const routesCur=await this.getStateAsync(routesStateId);
                    let routes={};
                    try{routes=JSON.parse(routesCur?.val||'{}')}catch{routes={}}
                    const prevRoute=routes[prevTrip.startTimeMs];
                    const thisRoute=routes[thisTrip.startTimeMs];
                    // merged.startTimeMs === prevTrip.startTimeMs (the merged
                    // trip keeps prevTrip's start), so only thisTrip's key is
                    // actually a DIFFERENT key that needs deleting - deleting
                    // prevTrip's key here would immediately wipe out the
                    // merged route we're about to set on that same key.
                    delete routes[thisTrip.startTimeMs];
                    if(prevRoute||thisRoute){
                        routes[merged.startTimeMs]=[...(prevRoute||[]),...(thisRoute||[])];
                    }else{
                        delete routes[merged.startTimeMs];
                    }
                    await this.setStateAsync(routesStateId,{val:JSON.stringify(routes),ack:true});
                    // One-slot undo backup (in memory only - lost on adapter
                    // restart, which is an acceptable limit for an "oops,
                    // undo that" button rather than a permanent history).
                    if(!this._lastMerge)this._lastMerge={};
                    this._lastMerge[vin]={prevTrip,thisTrip,prevRoute,thisRoute,mergedStartTimeMs:merged.startTimeMs};
                    history.splice(idx-1,2,merged);
                    await this.setStateAsync(stateId,{val:JSON.stringify(history),ack:true});
                    // Tells the frontend WHICH trip (by startTimeMs) can
                    // currently be undone, so the undo icon only shows on
                    // that specific trip's row instead of a fixed global
                    // spot. Cleared on undo.
                    await this.setStateAsync(`${vin}.trips.last_merge_startms`,{val:merged.startTimeMs,ack:true});
                    this.log.info(`trips_merge: merged trip at ${thisTrip.startTime} into the previous one (${merged.km}km total)`);
                }
            }catch(e){this.log.error(`trips_merge failed: ${e}`)}
            return;
        }
        if(cmd==='prepare_to_work'&&state.val===true){
            await this.setStateAsync(id,{val:false,ack:true});
            const enabledState=await this.getStateAsync('config.prepare_to_work_enabled');
            if(!enabledState?.val){
                this.log.debug('prepare_to_work: triggered but feature is disabled in Settings - ignoring');
                return;
            }
            const s=this.lastStatus[vin];
            if(!s){
                this.log.warn('prepare_to_work: no recent vehicle status available yet, cannot decide climate action');
                return;
            }
            try{
                await this.applyClimatePrep(vin,s,'prepare_to_work');
            }catch(e){
                this.log.warn(`prepare_to_work command failed: ${e}`);
            }
            return;
        }
        if(cmd==='trips_merge_undo'&&state.val){
            await this.setStateAsync(id,{val:false,ack:true});
            try{
                const backup=this._lastMerge?.[vin];
                if(!backup){
                    this.log.debug('trips_merge_undo: nothing to undo');
                }else{
                    const stateId=`${vin}.trips.history_json`;
                    const cur=await this.getStateAsync(stateId);
                    let history=[];
                    try{history=JSON.parse(cur?.val||'[]')}catch{history=[]}
                    const idx=history.findIndex(t=>t.startTimeMs===backup.mergedStartTimeMs);
                    if(idx<0){
                        this.log.debug('trips_merge_undo: merged trip no longer in history (maybe merged again since)');
                    }else{
                        history.splice(idx,1,backup.prevTrip,backup.thisTrip);
                        await this.setStateAsync(stateId,{val:JSON.stringify(history),ack:true});
                        const routesStateId=`${vin}.trips.routes_json`;
                        const routesCur=await this.getStateAsync(routesStateId);
                        let routes={};
                        try{routes=JSON.parse(routesCur?.val||'{}')}catch{routes={}}
                        delete routes[backup.mergedStartTimeMs];
                        if(backup.prevRoute)routes[backup.prevTrip.startTimeMs]=backup.prevRoute;
                        if(backup.thisRoute)routes[backup.thisTrip.startTimeMs]=backup.thisRoute;
                        await this.setStateAsync(routesStateId,{val:JSON.stringify(routes),ack:true});
                        this.log.info('trips_merge_undo: restored the two original trips');
                        await this.setStateAsync(`${vin}.trips.last_merge_startms`,{val:0,ack:true});
                    }
                    delete this._lastMerge[vin];
                }
            }catch(e){this.log.error(`trips_merge_undo failed: ${e}`)}
            return;
        }
        if(cmd==='refresh'&&state.val===true){this._lastScheduleCheck=0;
            this.log.debug(`Command: refresh for ${vehicle.vin}`);
            try{
                await this.updateVehicleStatus(vehicle);
                this.log.debug(`refresh successful.`);
            }catch(e){
                const msg=String(e).toLowerCase();
                if(msg.includes('ungültig')||msg.includes('token')||msg.includes('401')){
                    try{
                        await this.client.login();
                        await this.updateVehicleStatus(vehicle);
                        this.log.debug(`refresh successful (after re-login).`);
                    }catch(e2){this.log.error(`refresh failed after re-login: ${e2}`)}
                }else{
                    this.log.error(`refresh failed: ${e}`);
                }
            }
            await this.setStateAsync(id,{val:false,ack:true});return;
        }
        if(state.val===true){await this.executeCommand(vehicle,cmd);await this.setStateAsync(id,{val:false,ack:true})}
    }

    async executeCommand(vehicle,cmd){
        if(!this.client)return;
        // Any remote command (ours, a user's, or a script's) appears to wake
        // the vehicle briefly and can make it report a transient ignition-on
        // signal, even though nobody actually got in - exactly the false
        // positive that fired Prepare-to-Drive right after the user's own
        // shift-schedule script sent a climate command. Track this so
        // checkPrepareToDrive can ignore an ignition edge shortly after any
        // command we sent, ours or otherwise.
        if(!this._lastCommandSentAt)this._lastCommandSentAt={};
        this._lastCommandSentAt[vehicle.vin]=Date.now();
        const tempState=await this.getStateAsync(`${vehicle.vin}.cmd.ac_temp`);
        const fanState=await this.getStateAsync(`${vehicle.vin}.cmd.ac_fan_speed`);
        const temp=String(tempState?.val??22);
        const fan=String(fanState?.val??3);
        const posState=await this.getStateAsync(`${vehicle.vin}.cmd.ac_position`);
        const reciState=await this.getStateAsync(`${vehicle.vin}.cmd.ac_recirculate`);
        const pos=String(posState?.val??'all');
        const reci=(reciState?.val===true)?'in':'out';
        this.log.debug(`Command: ${cmd} for ${vehicle.vin} (temp=${temp}, fan=${fan}, pos=${pos}, recirc=${reci})`);
        const wshldState=await this.getStateAsync(`${vehicle.vin}.cmd.defrost_level`);
        const wshld=(wshldState?.val===2)?'1':'0';
        const noPinCmds={};
        const pinCmds={
            'find':                ['120','{"value":"true"}'],
            'windows_open':        ['230','{"value":"'+toNativeWindowPosition(vehicle.carType,100)+'"}'],
            'windows_close':       ['230','{"value":"0"}'],
            'sunshade_open':       ['240','{"value":"10"}'],
            'sunshade_close':      ['240','{"value":"0"}'],
            'hotspot_on':          ['140','{"value":"on"}'],
            'hotspot_off':         ['140','{"value":"off"}'],
            'ac_cool':             ['170','{"circle":"in","mode":"cold","operate":"manual","position":"'+pos+'","temperature":"'+temp+'","windlevel":"'+fan+'","wshld":"'+wshld+'"}'],
            'ac_heat':             ['170','{"circle":"in","mode":"hot","operate":"manual","position":"'+pos+'","temperature":"'+temp+'","windlevel":"'+fan+'","wshld":"'+wshld+'"}'],
            'ac_vent':             ['170','{"circle":"out","mode":"wind","operate":"manual","position":"'+pos+'","temperature":"'+temp+'","windlevel":"'+fan+'","wshld":"'+wshld+'"}'],
            'ac_off':              ['170','{"circle":"'+reci+'","mode":"wind","operate":"off","position":"'+pos+'","temperature":"'+temp+'","windlevel":"'+fan+'","wshld":"0"}'],
            'defrost':             ['170','{"circle":"in","mode":"hot","operate":"manual","position":"all","temperature":"32","windlevel":"7","wshld":"1"}'],
            'sentry_mode_on':      ['220','{"value":"1"}'],
            'sentry_mode_off':     ['220','{"value":"0"}'],
            // Payloads below verified against two independent community
            // reverse-engineering projects, not against real hardware -
            // this T03 has neither steering-wheel nor seat heat/
            // ventilation, so live confirmation isn't possible here.
            'steering_wheel_heat_on':  ['320','{"level":"2"}'],
            'steering_wheel_heat_off': ['320','{"level":"1"}'],
            // Payload confirmed correct against two independent community
            // sources. Cloud accepts and acks the command, but nothing
            // happens on the vehicle - confirmed also non-functional via
            // the official Leapmotor app on this T03. Not an adapter bug:
            // Leapmotor has not wired mirror heat to the API/app for this
            // vehicle. Left in for models/regions where it may work.
            'mirror_heat_on':      ['440','{"value":"2"}'],
            'mirror_heat_off':     ['440','{"value":"1"}'],
            // Community-test additions (2026-09), same basis as the mirror/
            // steering-wheel comment above.
            'charge_start':        ['193','{"value":"start"}'],
            'charge_stop':         ['193','{"value":"stop"}'],
            'unlock_charger':      ['192','{"operation":"unlock"}'],
            'healthy_charging_on': ['480','{"value":"1"}'],
            'healthy_charging_off':['480','{"value":"0"}'],
            'fuel_heating_on':     ['380','{"value":"1"}'],
            'fuel_heating_off':    ['380','{"value":"0"}'],
            'quick_cool':          ['170','{"circle":"in","mode":"cold","operate":"manual","position":"all","temperature":"18","windlevel":"7","wshld":"0"}'],
            'quick_heat':          ['170','{"circle":"in","mode":"hot","operate":"manual","position":"all","temperature":"32","windlevel":"7","wshld":"0"}'],
            'battery_preheat':     ['160','{"value":"ptcon"}'],
            'battery_preheat_off': ['160','{"value":"ptcoff"}'],
            'lock':                ['110','{"value":"lock"}'],
            'unlock':              ['110','{"value":"unlock"}'],
            'trunk_open':          ['130','{"value":"true"}'],
            'trunk_close':         ['130','{"value":"false"}'],
        };
        const runCmd=async()=>{
            if(noPinCmds[cmd])await this.client.sendCommandWithoutPin(vehicle,...noPinCmds[cmd]);
            else if(pinCmds[cmd])await this.client.sendCommandWithPin(vehicle,...pinCmds[cmd]);
            else{this.log.warn(`Unknown command: ${cmd}`);return false}
            return true;
        };
        try{
            let ran;
            try{
                ran=await runCmd();
            }catch(e){
                if(String(e).includes('Token ist ung')||String(e).includes('token')){
                    this.log.debug(`Token invalid for ${cmd}, re-logging in and retrying once...`);
                    await this.client.login();
                    ran=await runCmd();
                }else{
                    throw e;
                }
            }
            if(!ran)return;
            this.log.debug(`${cmd} successful (without PIN: ${!!noPinCmds[cmd]}).`);
            // Optimistisch sofort setzen + HTML neu bauen
            const optState={};
            if(cmd==='ac_cool'){optState['status.ac_on']=true;optState['status.ac_cooling_heating']=1;}
            if(cmd==='ac_heat'){optState['status.ac_on']=true;optState['status.ac_cooling_heating']=2;}
            if(cmd==='ac_vent'){optState['status.ac_on']=true;optState['status.ac_cooling_heating']=0;}
            if(cmd==='ac_off'){optState['status.ac_on']=false;}
            if(cmd==='lock'){optState['status.security_locked']=true;}
            if(cmd==='unlock'){optState['status.security_locked']=false;}
            if(cmd==='trunk_open'){optState['status.door_trunk']=true;}
            if(cmd==='trunk_close'){optState['status.door_trunk']=false;}
            if(cmd==='windows_open'){optState['status.window_fl_pct']=100;optState['status.window_fr_pct']=100;}
            if(cmd==='windows_close'){optState['status.window_fl_pct']=0;optState['status.window_fr_pct']=0;}
            for(const[k,v]of Object.entries(optState)){
                await this.setStateAsync(`${vehicle.vin}.${k}`,{val:v,ack:true});
            }
            // Letzten bekannten Status für HTML holen und optimistisch überschreiben
            // Aus gecachtem Status - sofort ohne API
            const ls=this.lastStatus[vehicle.vin]||{};
            const fakeS=Object.assign({},ls);
            if('status.ac_on' in optState)fakeS.acSwitch=optState['status.ac_on'];
            if('status.ac_cooling_heating' in optState)fakeS.acCoolingAndHeating=optState['status.ac_cooling_heating'];
            if('status.security_locked' in optState)fakeS.driverDoorLockStatus=optState['status.security_locked'];
            if('status.door_trunk' in optState)fakeS.bbcmBackDoorStatus=optState['status.door_trunk'];
            if('status.window_fl_pct' in optState){fakeS.leftFrontWindowPercent=optState['status.window_fl_pct'];fakeS.rightFrontWindowPercent=optState['status.window_fr_pct'];}
            await this.buildCompositeHtml(vehicle.vin,fakeS,vehicle.name);
            // Fetch real status in the background after 10s. Wrapped in its
            // own try/catch: this runs detached from the outer try/catch
            // (it fires later, via setTimeout), so an unhandled rejection
            // here - e.g. the token expiring in exactly that 10s window -
            // would otherwise crash the whole adapter process.
            this.setTimeout(async()=>{
                try{
                    await this.updateVehicleStatus(vehicle);
                }catch(e){
                    const msg=String(e).toLowerCase();
                    if(msg.includes('ungültig')||msg.includes('token')||msg.includes('401')){
                        try{await this.client.login();await this.updateVehicleStatus(vehicle);}
                        catch(e2){this.log.error(`Delayed refresh failed after re-login: ${e2}`)}
                    }else{
                        this.log.error(`Delayed refresh failed: ${e}`);
                    }
                }
            },10000);
        }catch(e){this.log.error(`Command ${cmd} failed: ${e}`)}
    }

    onUnload(callback){if(this.pollTimer){this.clearTimeout(this.pollTimer);this.pollTimer=null}this.setState('info.connection',false,true);callback()}
}
if(require.main!==module){module.exports=options=>new LeapmotorAdapter(options)}
else{new LeapmotorAdapter()}
