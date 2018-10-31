require('array.prototype.find');

function nuheat(config) {

    if ( !(this instanceof nuheat) ){
        return new nuheat(config);
    }

    const redis = require('redis');
    let moment = require('moment');

    let pub = redis.createClient(
        {
            host: process.env.REDIS || global.config.redis || '127.0.0.1' ,
            socket_keepalive: true,
            retry_unfulfilled_commands: true
        }
    );

    pub.on('end', function(e){
        console.log('Redis hung up, committing suicide');
        process.exit(1);
    });

    let NodeCache = require( "node-cache" );

    let deviceCache = new NodeCache();
    let statusCache = new NodeCache();

    let merge = require('deepmerge');

    let request = require('request');

    let jar = request.jar();

    request = request.defaults({jar: jar});

    let https = require('https');
    let keepAliveAgent = new https.Agent({ keepAlive: true });
    /*
     require('request').debug = true
     require('request-debug')(request);
     */

    deviceCache.on( 'set', function( key, value ){
        let data = JSON.stringify( { module: 'nuheat', id : key, value : value });
        console.log( 'sentinel.device.insert => ' + data );
        pub.publish( 'sentinel.device.insert', data);
    });

    deviceCache.on( 'delete', function( key ){
        let data = JSON.stringify( { module: 'nuheat', id : key });
        console.log( 'sentinel.device.delete => ' + data );
        pub.publish( 'sentinel.device.delete', data);
    });

    statusCache.on( 'set', function( key, value ){
        let data = JSON.stringify( { module: 'nuheat', id : key, value : value });
        console.log( 'sentinel.device.update => ' + data );
        pub.publish( 'sentinel.device.update', data);
    });

    let api = {
        'login'      : 'authenticate/user',
        'system'     : 'thermostats?sessionid={securityToken}',
        'thermostat' : 'thermostat?sessionid={securityToken}',
        'change'     : 'groups/change?sessionid={securityToken}'
    };

    for( let k in api ){
        api[k] = api[k].replace('{appId}', config.appid).replace('{culture}', config.culture);
    }

    let that = this;

    let securityToken = null;

    let typeNameCache = { 'devices' : {}, 'attributes' : {} };

    let celsiusToFahrenheit = function (c) {
        return Math.round(c * (9.0 / 5.0) + 32.0);
    };

    let fahrenheitToCelcius = function (f) {
        return Math.round( (f - 32.0) * (5.0/9.0) );
    };


    function processDevice( d ){
        let device = { 'current' : {} };
        device['name'] = d.Room;
        device['id'] = d.SerialNumber;
        device['type'] = 'heater.floor';
        device['current'] = { 'temperature' : { 'heat' : {} } };
        device['current']['state'] = (d.Heating ? 'heat' : 'off');
        device['current']['temperature']['heat']['set'] = celsiusToFahrenheit( d.SetPointTemp / 100 );
        device['current']['temperature']['current'] = celsiusToFahrenheit( d.Temperature / 100 );
        //device['current']['online'] = d.Online;
        return device;
    }

    function call(url, method, data, type){

        return new Promise( (fulfill, reject) => {

            type = type || 'application/json';

            if ( url !== api.login && securityToken == null ) {

                let auth = {
                    'Email': config.email,
                    'Password': config.password,
                    'Application': 0
                };

                call(api.login, 'POST', auth, 'application/json')
                    .then((result) => {

                        securityToken = result.SessionId;

                        call(url, method, data)
                            .then((result) => {
                                fulfill(result);
                            })
                            .catch((err) => {
                                reject(err);
                            });
                    })
                    .catch((err) => {
                        reject(err);
                    });

                return;
            }

            let options = {
                url : 'https://' + config.server + '/api/' + url.replace('{securityToken}', securityToken),
                method : method,
                encoding : null,
                headers : {
                    'accept' : 'application/json',
                    'User-Agent' : 'Mozilla/5.0'
                },
                timeout : 90000,
                agent : keepAliveAgent,
                followRedirect: false
            };

            if ( data === undefined )
                data = null;

            if ( data !== null ){
                if ( type === 'application/json' )
                    data = JSON.stringify(data);

                options['body'] = data;
                options['headers']['content-type'] = type;
            }

            //console.log( options.url );
            //console.log( data );

            request(options, (err, response, body) => {

                //console.log(body.toString('utf8'));
                if ( err ) {
                    reject(err);
                    return;
                }

                if ( response.statusCode === 401 ){
                    securityToken = null;
                    reject(err);
                    return;
                }

                try {
                    if ( response.headers['content-type'].indexOf('application/json') != -1) {
                        body = JSON.parse(body);
                    }
                }catch(e){
                    console.error(err);
                    reject(e);
                    return;
                }

                fulfill( body );

            });
        });
    }
/*
    this.setValue = ( id, data ) => {

        let url = api.change + '?&serialnumber=' + id;

        return call( url, 'POST', data );
    };
*/
    this.setValue = ( id, data ) => {

        let url = api.thermostat + '&serialnumber=' + id;
        return call( url, 'POST', data );

    };

    this.setTemperature = ( id, f ) => {

        let data = {
            SetPointTemp: fahrenheitToCelcius(f) * 10,
            ScheduleMode: 2,
            HoldSetPointDateTime: moment.utc().add( 1, 'h' ).format('ddd, Do MMM YYYY HH:mm:ss z')
        };

        return this.setValue( id, data );
    };

    this.setHold = (id) => {

        let data = {
            ScheduleMode: 3,
            HoldSetPointDateTime: moment.utc().add( 1, 'h' ).format('ddd, Do MMM YYYY HH:mm:ss z')
        };

        return this.setValue( id, data );
    };

    this.resumeProgram = (id) => {

        let data = {
            ScheduleMode: 1
        };

        return that.setValue( id, data );
    };

    this.setAway = (id) => {
/*
        let data = {
            "GroupId": 3295,
            "AwayMode": true,
            "GroupName": "Home",
            "SerialNumbers": [id]
        };
*/

        let data = {
            SetPointTemp: 500,
            ScheduleMode: 3,
            HoldSetPointDateTime: moment.utc().add( 1, 'h' ).format('ddd, Do MMM YYYY HH:mm:ss z')
        };

        return this.setValue( id, data );
    };

    this.setMode = ( id, mode ) => {

        switch (mode){
            case 'home':
            case 'auto':
                return this.resumeProgram(id);
            case 'away':
            case 'off':
                return this.setAway(id);
        }

    };
/*
    this.setHold = ( id, params ) => {
        return that.callFunction( id, 'setHold', params );
    };

    {"ScheduleMode":3,"HoldSetPointDateTime":"Sun, 15 Oct 2017 01:03:13 GMT"}


    {"GroupId":3295,"AwayMode":true,"GroupName":"Home","SerialNumbers":["45837","327333","327315"]}

    {"SetPointTemp":"2606","ScheduleMode":2,"HoldSetPointDateTime":"Sun, 15 Oct 2017 00:00:17 GMT"}
*/


    this.getDevices = () => {

        return new Promise( (fulfill, reject) => {
            deviceCache.keys( ( err, ids ) => {
                if (err)
                    return reject(err);

                deviceCache.mget( ids, (err,values) =>{
                    if (err)
                        return reject(err);

                    statusCache.mget( ids, (err, statuses) => {
                        if (err)
                            return reject(err);

                        let data = [];

                        for (let key in values) {
                            let v = values[key];

                            if ( statuses[key] ) {
                                v.current = statuses[key];
                                data.push(v);
                            }
                        }

                        fulfill(data);
                    });

                });
            });
        });
    };

    this.getDeviceStatus = (id) => {

        return new Promise( (fulfill, reject) => {
            try {
                statusCache.get(id, (err, value) => {
                    if (err)
                        return reject(err);

                    fulfill(value);
                }, true);
            }catch(err){
                reject(err);
            }
        });

    };


    function updateStatus() {
        return new Promise( ( fulfill, reject ) => {
            call( api.system, 'get' )
                .then( (results) => {

                    for( let x in results.Groups ) {
                        let group = results.Groups[x];

                        for( let y in group.Thermostats ) {
                            let device = group.Thermostats[y];
                            let d = processDevice(device);
                            statusCache.set(d.id, d.current);
                        }
                    }
                    fulfill();
                })
                .catch( (err) =>{
                    reject(err);
                });
        });
    }

    this.Reload = () => {
        return new Promise( (fulfill,reject) => {
            fulfill([]);
        });
    };

    function loadSystem(){
        return new Promise( ( fulfill, reject ) => {
            call( api.system, 'get' )
                .then( (results) => {
                    let devices = [];
                    for( let x in results.Groups ) {
                        let group = results.Groups[x];

                        for( let y in group.Thermostats ) {
                            let device = group.Thermostats[y];

                            let d = processDevice(device);

                            statusCache.set(d.id, d.current);
                            delete d.current;
                            deviceCache.set(d.id, d);
                            devices.push(d);
                        }
                    }

                    fulfill(devices);
                })
                .catch( (err) =>{
                    reject(err);
                });
        });
    }

    loadSystem()

        .then( () => {

            function pollSystem() {
                updateStatus()
                    .then((devices) => {
                        setTimeout(pollSystem, 10000);
                    })
                    .catch((err) => {
                        console.error(err);
                        setTimeout(pollSystem, 60000);
                    });

            }

            setTimeout(pollSystem, 10000);

        })
        .catch((err) => {
            console.error(err);
            process.exit(1);
        });
    /*
     this.raw = function( params, success, failed ){
     let url = api.system;
     call( url, "get", null, function(data){
     success(data);
     });
     };
     */
    this.system = function( params, success, failed ){
        that.status( null, function( status ){
            let devices = [];

            status.Devices.map( function(d){
                let device = {};

                //if ( d.MyQDeviceTypeName !== undefined )
                //    typeNameCache.devices[d.MyQDeviceTypeId] = d.MyQDeviceTypeName;

                if ( d.MyQDeviceTypeId !== 1 /*Gateway*/ ) {
                    devices.push( processDevice( d ) );
                }
            });

            success( devices );
        });
    };

    return this;
}

module.exports = nuheat;