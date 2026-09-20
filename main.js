'use strict';
const utils=require('@iobroker/adapter-core');
const {LeapmotorClient}=require('./lib/leapmotor-client');
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
function isActuallyCharging(chargeState,gearStatus,speed,vehicleReady){
    if(chargeState==null||![1,2,3].includes(chargeState))return false;
    const precludesCharging=[1,2,3].includes(gearStatus)||(speed!=null&&speed>0)||vehicleReady===true;
    return !precludesCharging;
}
class LeapmotorAdapter extends utils.Adapter{
    constructor(options={}){
        super({...options,name:'leapmotor'});
        this.client=null;this.vehicles=[];this.pollTimer=null;this.isPolling=false;this.pictureCache={};this.lastStatus={};
        this.on('ready',this.onReady.bind(this));
        this.on('stateChange',this.onStateChange.bind(this));
        this.on('unload',this.onUnload.bind(this));
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
        try{this.log.debug(`Adapter config: language=${cfg.language||'en-GB'}, polling=${cfg.pollingInterval||5}min, pin=${cfg.operationPassword?'set':'NOT SET'}`);
        this.log.info('Connecting to Leapmotor cloud...');await this.client.login();this.log.info('Login successful.');this.setState('info.connection',true,true)}
        catch(e){this.log.error(`Login failed: ${e}`);return}
        try{
            this.vehicles=await this.client.getVehicleList();
            this.vehicles.forEach(v=>{v.vin=String(v.vin||'').replace(this.FORBIDDEN_CHARS,'_')});
            this.log.info(`Found ${this.vehicles.length} vehicle(s).`);
            for(const v of this.vehicles){
                this.log.info(`  → ${v.name} (${v.carType}) VIN: ${v.vin}`);
                // Diagnostic for intermittent-permission issues (e.g. sunshade):
                // the cloud grants a subset of remote-command rights per
                // vehicle/account/sharing-level in "rightList" (community
                // reverse-engineered, see leapmotor-api's VehicleRight enum).
                // 161=SUNSHADE, 230=WINDOWS, 240=SKYLIGHT, 110=LOCK, 130=TRUNK.
                // We don't enforce this - just logging it to see whether it's
                // actually static or changes between successful/failed attempts.
                if(v.raw?.rightList!==undefined){
                    this.log.debug(`  ${v.vin} rightList: ${v.raw.rightList}`);
                }
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
            }
        }catch(e){this.log.error(`Vehicle list failed: ${e}`);return}
        await this.pollAll();
        for(const v of this.vehicles)await this.updatePictures(v);
        const interval=Math.min(60,Math.max(1,cfg.pollingInterval||5))*60*1000;
        this.pollTimer=this.setInterval(()=>this.pollAll(),interval);
        this.log.info(`Polling every ${cfg.pollingInterval||5} minutes.`);
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
            try{await this.updateTripDetection(vehicle,s.totalMileage,s.speed,s.soc,s.bcmKeyPositionOn1||s.bcmKeyPositionOn3,s.collectTimeMs,s.driverDoorLockStatus)}catch(e){this.log.debug(`Trip detection error: ${e}`)}
            try{await this.resolvePendingTripEnergy(vehicle)}catch(e){this.log.debug(`Pending trip energy error: ${e}`)}
            try{await this.updateChargingCost(vehicle.vin,s.soc,s.chargeState,s.gearStatus,s.speed,s.bcmKeyPositionOn3)}catch(e){this.log.debug(`Charging cost error: ${e}`)}
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

    async updateTripDetection(vehicle,totalMileage,speed,soc,keyPosition,vehicleTimeMs,locked){
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
        const isDriving=isMoving||keyPosition===true;
        // Grace period before actually closing a trip once isDriving goes
        // false: complements the ignition check above as a backstop for
        // cases where key_position briefly misreports (or a model doesn't
        // expose it reliably). A trip is only finalized once isDriving has
        // stayed false for this long straight; if driving resumes before
        // that, the trip simply continues uninterrupted.
        const TRIP_END_GRACE_MS=600000; // 10 minutes
        // Fast path: if the ignition is EXPLICITLY off (not just missing/
        // undefined - a real false reading) AND the vehicle is locked, that's
        // about as strong a "the trip is really over" signal as we can get -
        // nobody drives off again from a locked, key-off state without
        // unlocking first, which we'd see on the very next poll anyway. Skip
        // the 10-minute wait entirely in that case so the trip closes on the
        // same poll it's first detected as stopped, instead of up to 10
        // minutes (2 poll cycles) later.
        const definitelyStopped=keyPosition===false&&locked===true;
        if(!this._tripStates)this._tripStates={};
        if(!this._lastKnownMileage)this._lastKnownMileage={};
        const prev=this._tripStates[vin]||{wasActive:false,startMileage:null,startTime:null,startSoc:null,pendingEndSince:null};
        const lastMileage=this._lastKnownMileage[vin];

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
            this._tripStates[vin]={wasActive:true,startMileage,startTime,startSoc:soc,pendingEndSince:null};
            await this.setStateAsync(`${vin}.trips.current_trip_active`,{val:true,ack:true});
            this.log.debug(`Trip started at ${startMileage}km (current: ${totalMileage}km)`);
        }else if(isDriving&&prev.wasActive&&prev.pendingEndSince){
            // False alarm: driving resumed before the grace period elapsed.
            // Clear the pending-end marker so the trip continues uninterrupted.
            this._tripStates[vin]={...prev,pendingEndSince:null};
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
                    this._tripStates[vin]={...prev,pendingEndSince:Date.now(),pendingEndVehicleTime:vehicleTimeMs||null};
                    this._lastKnownMileage[vin]={mileage:totalMileage,ts:Date.now()};
                    return;
                }
                this._tripStates[vin]={...prev,pendingEndSince:Date.now(),pendingEndVehicleTime:vehicleTimeMs||null};
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
                // Try to get the cloud's OFFICIAL driving/AC/other energy split for this
                // trip's exact time window. The cloud sometimes needs a while to finish
                // aggregating a just-completed trip, so this can legitimately come back
                // empty right away - in that case we mark the trip as pending and retry
                // a few times on later poll cycles (see resolvePendingTripEnergy()).
                try{
                    const breakdown=await this.client.getEnergyBreakdown(vehicle,Math.floor(startTimeMs/1000),Math.floor(endTimeMs/1000));
                    if(breakdown){
                        trip.energyDrivingKwh=Math.round(breakdown.driving*100)/100;
                        trip.energyAcKwh=Math.round(breakdown.ac*100)/100;
                        trip.energyOtherKwh=Math.round(breakdown.other*100)/100;
                        trip.energyOfficial=true;
                    }else{
                        trip.energyPending=true;
                    }
                }catch(e){
                    this.log.debug(`Energy breakdown fetch failed for trip: ${e}`);
                    trip.energyPending=true;
                }
                const stateId=`${vin}.trips.history_json`;
                const cur=await this.getStateAsync(stateId);
                let history=[];
                try{history=JSON.parse(cur?.val||'[]')}catch{history=[]}
                history.push(trip);
                history=history.slice(-50);
                await this.setStateAsync(stateId,{val:JSON.stringify(history),ack:true});
                this.log.debug(`Trip ended: ${trip.km}km in ${durationMin}min`);
                if(trip.energyPending){
                    if(!this._pendingEnergyTrips)this._pendingEnergyTrips={};
                    if(!this._pendingEnergyTrips[vin])this._pendingEnergyTrips[vin]=[];
                    this._pendingEnergyTrips[vin].push({startTimeMs,endTimeMs,date:trip.date,startTime:trip.startTime,attempts:0});
                }
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
                this._pendingEnergyTrips[vin].push({startTimeMs,endTimeMs,date:t.date,startTime:t.startTime,attempts:0});
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
                const breakdown=await this.client.getEnergyBreakdown(vehicle,Math.floor(p.startTimeMs/1000),Math.floor(p.endTimeMs/1000));
                if(breakdown){
                    const entry=history.find(t=>t.date===p.date&&t.startTime===p.startTime);
                    if(entry){
                        entry.energyDrivingKwh=Math.round(breakdown.driving*100)/100;
                        entry.energyAcKwh=Math.round(breakdown.ac*100)/100;
                        entry.energyOtherKwh=Math.round(breakdown.other*100)/100;
                        entry.energyOfficial=true;
                        delete entry.energyPending;
                        changed=true;
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

    async updateChargingCost(vin,soc,chargeState,gearStatus,speed,vehicleReady){
        const charging=isActuallyCharging(chargeState,gearStatus,speed,vehicleReady);
        if(!this._chargingSessions)this._chargingSessions={};
        const prev=this._chargingSessions[vin]||{wasCharging:false,startSoc:null,accumulatedCost:0,accumulatedKwh:0,lastSoc:null};

        // Battery capacity: falls back to the model-specific default (see getDefaultBatteryCapacity), overridable via datapoint
        const capState=await this.getStateAsync(`${vin}.config.battery_capacity_kwh`);
        const vehicleForCapacity=this.vehicles.find(v=>v.vin===vin);
        const capacity=Number(capState?.val)||getDefaultBatteryCapacity(vehicleForCapacity?.carType);

        if(charging&&!prev.wasCharging){
            // Neue Ladesession beginnt
            this._chargingSessions[vin]={wasCharging:true,startSoc:soc,accumulatedCost:0,accumulatedKwh:0,lastSoc:soc};
            await this.setStateAsync(`${vin}.charging.session_active`,{val:true,ack:true});
            await this.setStateAsync(`${vin}.charging.session_cost`,{val:0,ack:true});
            await this.setStateAsync(`${vin}.charging.session_kwh`,{val:0,ack:true});
            this.log.debug(`Charging session started at SOC=${soc}%`);
        }else if(charging&&prev.wasCharging){
            // Laufende Session: Energie seit letztem Poll mit AKTUELLEM Preis verrechnen
            const socDelta=soc!=null&&prev.lastSoc!=null?Math.max(0,soc-prev.lastSoc):0;
            const kwhDelta=(socDelta/100)*capacity;
            const currentPriceState=await this.getStateAsync(`config.energy_price_eur_kwh`);
            const currentPrice=Number(currentPriceState?.val)||0.30;
            const costDelta=kwhDelta*currentPrice;

            const updated={
                wasCharging:true,
                startSoc:prev.startSoc,
                accumulatedCost:prev.accumulatedCost+costDelta,
                accumulatedKwh:prev.accumulatedKwh+kwhDelta,
                lastSoc:soc,
            };
            this._chargingSessions[vin]=updated;
            await this.setStateAsync(`${vin}.charging.session_cost`,{val:Math.round(updated.accumulatedCost*100)/100,ack:true});
            await this.setStateAsync(`${vin}.charging.session_kwh`,{val:Math.round(updated.accumulatedKwh*100)/100,ack:true});
        }else if(!charging&&prev.wasCharging){
            // Session beendet
            await this.setStateAsync(`${vin}.charging.session_active`,{val:false,ack:true});
            this.log.debug(`Charging session ended: ${prev.accumulatedKwh.toFixed(2)}kWh, ${prev.accumulatedCost.toFixed(2)}€`);
            this._chargingSessions[vin]={wasCharging:false,startSoc:null,accumulatedCost:0,accumulatedKwh:0,lastSoc:null};
        }
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
                await this.setStateAsync('messages.latest_title',{val:latest.title||'',ack:true});
                await this.setStateAsync('messages.latest_text',{val:latest.message||latest.content||'',ack:true});
                await this.setStateAsync('messages.latest_time',{val:time,ack:true});
            }
            await this.setStateAsync('messages.json',{val:JSON.stringify(messages),ack:true});
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
        await this.setObjectNotExistsAsync(`config`,{type:'channel',common:{name:'Adapter Configuration Values'},native:{}});
        await this.setObjectNotExistsAsync(`config.energy_price_eur_kwh`,{type:'state',common:{name:'Electricity Price (EUR/kWh) - manually editable',type:'number',role:'level',read:true,write:true,unit:'€/kWh',min:0,max:2,def:0.30},native:{}});
        const defaultCapacity=getDefaultBatteryCapacity(vehicle.carType);
        await this.setObjectNotExistsAsync(`${vehicle.vin}.config`,{type:'channel',common:{name:'Vehicle Configuration Values'},native:{}});
        await this.setObjectNotExistsAsync(`${vehicle.vin}.config.battery_capacity_kwh`,{type:'state',common:{name:'Battery Capacity (kWh, net) - adjust if your battery variant differs from the model default',type:'number',role:'level',read:true,write:true,unit:'kWh',min:10,max:150,def:defaultCapacity},native:{}});
        await this.setObjectNotExistsAsync(`${vehicle.vin}.trips`,{type:'channel',common:{name:'Trips & Daily Kilometers'},native:{}});
        await this.setObjectNotExistsAsync(`${vehicle.vin}.trips.daily_km_json`,{type:'state',common:{name:'Daily Kilometers (JSON, last 30 days)',type:'string',role:'json',read:true,write:false,def:'[]'},native:{}});
        await this.setObjectNotExistsAsync(`${vehicle.vin}.trips.today_km`,{type:'state',common:{name:'Kilometers Driven Today',type:'number',role:'value',read:true,write:false,unit:'km',def:0},native:{}});
        await this.setObjectNotExistsAsync(`${vehicle.vin}.trips.history_json`,{type:'state',common:{name:'Trip History (JSON, last 50 trips)',type:'string',role:'json',read:true,write:false,def:'[]'},native:{}});
        await this.setObjectNotExistsAsync(`${vehicle.vin}.trips.current_trip_active`,{type:'state',common:{name:'Trip Currently In Progress',type:'boolean',role:'indicator',read:true,write:false,def:false},native:{}});
        await this.setObjectNotExistsAsync(`${vehicle.vin}.charging`,{type:'channel',common:{name:'Charging Session'},native:{}});
        await this.setObjectNotExistsAsync(`${vehicle.vin}.charging.session_cost`,{type:'state',common:{name:'Current/Last Charging Session Cost',type:'number',role:'value',read:true,write:false,unit:'€',def:0},native:{}});
        await this.setObjectNotExistsAsync(`${vehicle.vin}.charging.session_kwh`,{type:'state',common:{name:'Current/Last Charging Session Energy (estimated)',type:'number',role:'value',read:true,write:false,unit:'kWh',def:0},native:{}});
        await this.setObjectNotExistsAsync(`${vehicle.vin}.charging.session_active`,{type:'state',common:{name:'Charging Session In Progress',type:'boolean',role:'indicator',read:true,write:false,def:false},native:{}});
        await this.setObjectNotExistsAsync(`${vehicle.vin}.cmd.defrost_cycle`,{type:'state',common:{name:'Cycle Windshield Defrost (off/weak/strong)',type:'boolean',role:'button',read:false,write:true,def:false},native:{}});
        await this.setObjectNotExistsAsync(`${vehicle.vin}.cmd.quick_cool`,{type:'state',common:{name:'Quick Cool',type:'boolean',role:'button',read:false,write:true,def:false},native:{}});
        await this.setObjectNotExistsAsync(`${vehicle.vin}.cmd.quick_heat`,{type:'state',common:{name:'Quick Heat',type:'boolean',role:'button',read:false,write:true,def:false},native:{}});
        await this.setObjectNotExistsAsync(`${vehicle.vin}.cmd.sunshade_set`,{type:'state',common:{name:'Sunshade Position (0-10)',type:'number',role:'level.blind',read:true,write:true,min:0,max:10,def:0},native:{}});
                await this.setObjectNotExistsAsync(`${vehicle.vin}.cmd.ac_recirculate`,{type:'state',common:{name:'Recirculate Air',type:'boolean',role:'switch',read:true,write:true,def:false},native:{}});
    }

    async writeStatusStates(vin,s){
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
        await set('status.temp_outdoor',s.outdoorTemp);
        await set('status.temp_battery_min',s.minSingleTemp);
        // Charging
        await set('status.charging_active',s.chargeState!=null?isActuallyCharging(s.chargeState,s.gearStatus,s.speed,s.bcmKeyPositionOn3):null);
        await set('status.charging_state',s.chargeState);
        await set('status.charging_soc_limit',s.chargesocSetting);
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
        await set('status.collect_time',s.collectTime);
        await set('status.collect_time_ms',s.collectTimeMs);
    }

    async onStateChange(id,state){
        if(!state||state.ack||!this.client)return;
        if(id===`${this.namespace}.config.energy_price_eur_kwh`||id.endsWith('.config.battery_capacity_kwh')){
            await this.setStateAsync(id,{val:state.val,ack:true});
            return;
        }
        const parts=id.replace(`${this.namespace}.`,'').split('.');
        if(parts.length<3||parts[1]!=='cmd')return;
        const vin=parts[0],cmd=parts[2];
        const vehicle=this.vehicles.find(v=>v.vin===vin);if(!vehicle)return;
        if(cmd==='ac_temp'||cmd==='ac_fan_speed'||cmd==='ac_position'||cmd==='ac_recirculate'){
            await this.setStateAsync(id,{val:state.val,ack:true});
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
            }catch(e){this.log.error(`speed_limit_set failed: ${e}`)}
            return;
        }
        if(cmd==='seat_heat_driver'||cmd==='seat_heat_copilot'){
            await this.setStateAsync(id,{val:state.val,ack:true});
            const seatPos=cmd==='seat_heat_driver'?'driver':'copilot';
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
            }catch(e){this.log.error(`${cmd} failed: ${e}`)}
            return;
        }
        if(cmd==='seat_ventilation_driver'||cmd==='seat_ventilation_copilot'){
            await this.setStateAsync(id,{val:state.val,ack:true});
            const seatPos=cmd==='seat_ventilation_driver'?'driver':'copilot';
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
                try{
                    await this.client.sendCommandWithoutPin(vehicle,'180',content);
                }catch(e){
                    if(String(e).includes('ngültig')||String(e).includes('token')){
                        await this.client.login();
                        await this.client.sendCommandWithoutPin(vehicle,'180',content);
                    }else{throw e}
                }
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
                try{
                    await this.client.sendCommandWithPin(vehicle,'190',content);
                }catch(e){
                    if(String(e).includes('ngültig')||String(e).includes('token')){
                        await new Promise(r=>this.setTimeout(r,500));
                        await this.client.login();
                        await this.client.sendCommandWithPin(vehicle,'190',content);
                    }else{throw e}
                }
                await this.setStateAsync(`${vin}.status.charging_soc_limit`,{val:state.val,ack:true});
            }catch(e){this.log.error(`charge_limit_set failed: ${e}`)}
            return;
        }
        if(cmd==='climate_schedule_enable'||cmd==='climate_schedule_time'||cmd==='climate_schedule_mode'||cmd==='climate_schedule_days'){
            await this.setStateAsync(id,{val:state.val,ack:true});
            return;
        }
        if(cmd==='climate_schedule_cancel'&&state.val===true){
            await this.setStateAsync(id,{val:false,ack:true});
            await this.setStateAsync(`${vin}.cmd.climate_schedule_enable`,{val:false,ack:true});
            try{
                const content=JSON.stringify({controls:[]});
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
                const limit=Number(limitState?.val??80);
                const content=JSON.stringify({chargeEnable:enabled,chargesoc:limit,circulation:0,cycles:'1,2,3,4,5,6,7',endtime:end,recharge:0,starttime:start});
                try{
                    await this.client.sendCommandWithPin(vehicle,'190',content);
                }catch(e){
                    if(String(e).includes('ngültig')||String(e).includes('token')){
                        await new Promise(r=>this.setTimeout(r,500));
                        await this.client.login();
                        await this.client.sendCommandWithPin(vehicle,'190',content);
                    }else{throw e}
                }
                this.log.debug(`charge_schedule_apply: enabled=${enabled} start=${start} end=${end} limit=${limit}`);
            }catch(e){this.log.error(`charge_schedule_apply failed: ${e}`)}
            return;
        }
        if(cmd==='defrost_level'){
            await this.setStateAsync(id,{val:state.val,ack:true});
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
                await sendDefrost(JSON.stringify({circle:circle2,mode:mode2,operate:operate2,position:pos2,temperature:temp2,windlevel:fan2,wshld:wshldVal}));
                this.log.debug(`defrost_cycle: stage ${cur} -> ${next} (wshld=${wshldVal}, mode=${mode2})`);
            }catch(e){this.log.error(`defrost_cycle failed: ${e}`)}
            return;
        }
        if(cmd==='refresh'&&state.val===true){this._lastScheduleCheck=0;
            await this.updateVehicleStatus(vehicle);
            await this.setStateAsync(id,{val:false,ack:true});return;
        }
        if(state.val===true){await this.executeCommand(vehicle,cmd);await this.setStateAsync(id,{val:false,ack:true})}
    }

    async executeCommand(vehicle,cmd){
        if(!this.client)return;
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
            // Fetch real status in the background after 10s
            this.setTimeout(()=>this.updateVehicleStatus(vehicle),10000);
        }catch(e){this.log.error(`Command ${cmd} failed: ${e}`)}
    }

    onUnload(callback){if(this.pollTimer){this.clearInterval(this.pollTimer);this.pollTimer=null}this.setState('info.connection',false,true);callback()}
}
if(require.main!==module){module.exports=options=>new LeapmotorAdapter(options)}
else{new LeapmotorAdapter()}
