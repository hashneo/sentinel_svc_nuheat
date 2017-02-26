require('array.prototype.find');

// based off the https://github.com/pfeffed/liftmaster_myq codebase
function myq(config) {

    if ( !(this instanceof myq) ){
        return new myq(config);
    }

    const redis = require('redis');
    var moment = require('moment');

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

    var NodeCache = require( "node-cache" );

    var deviceCache = new NodeCache();
    var statusCache = new NodeCache();

    var merge = require('deepmerge');

    var request = require('request');

    var jar = request.jar();

    request = request.defaults({jar: jar});

    var https = require('https');
    var keepAliveAgent = new https.Agent({ keepAlive: true });
    /*
     require('request').debug = true
     require('request-debug')(request);
     */

    deviceCache.on( "set", function( key, value ){
    });

    statusCache.on( "set", function( key, value ){
        let data = JSON.stringify( { module: 'nuheat', id : key, value : value });
        console.log( data );
        pub.publish("sentinel.device.update",  data);
    });

    var api = {
        'login' : 'authenticate/user',
        'system' : '/thermostats?sessionid={securityToken}'
    };

    for( let k in api ){
        api[k] = api[k].replace('{appId}', config.appid).replace('{culture}', config.culture);
    }

    var that = this;

    var securityToken = null;

    var typeNameCache = { 'devices' : {}, 'attributes' : {} };

    var celsiusToFahrenheit = function (c) {
        return Math.round(c * (9 / 5.0) + 32.0);
    };

    function processDevice( d ){
        var device = { 'current' : {} };
        device['name'] = d.Room;
        device['id'] = d.SerialNumber;
        device['type'] = 'hvac.heater.floor';
        device['current'] = { 'temperature' : { 'heat' : {} } };
        device['current']['state'] = (d.Heating ? 'heating' : 'off');
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

            console.log( options.url );
            //console.log( data );

            request(options, (err, response, body) => {

                console.log(body.toString('utf8'));

                if ( response.statusCode === 401 ){
                    securityToken = null;
                    reject(err);
                }

                if ( err ) {
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

    this.setAttribute = ( id, attr, value ) => {

        return new Promise( (fulfill, reject) => {

            let url = api.set + '?myQDeviceId=' + id + '&attributename=' + attr + '&attributevalue=' + value;
            //https://www.myliftmaster.com/Device/TriggerStateChange?myQDeviceId=653445&attributename=desireddoorstate&attributevalue=1

            return call(url, 'POST' )
                .then( (data) => {
                    let result = {};
                    /*
                     result['id'] = id;
                     result['updated'] = moment(parseInt(data.UpdatedTime)).format();
                     */
                    fulfill(result);
                })
                .catch( (err) =>{
                    reject(err);
                })
        });
    };

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
     var url = api.system;
     call( url, "get", null, function(data){
     success(data);
     });
     };
     */
    this.system = function( params, success, failed ){
        that.status( null, function( status ){
            var devices = [];

            status.Devices.map( function(d){
                var device = {};

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

module.exports = myq;