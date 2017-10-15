'use strict';

module.exports.setMode = (req, res) => {

    let id = req.swagger.params.id.value;
    let mode = req.swagger.params.mode.value;

    global.module.setMode(id, mode )
        .then( (status) => {
            res.json( { data: { status: status }, result : 'ok' } );
        })
        .catch( (err) => {
            res.status(500).json( { code: err.code || 0, message: err.message } );
        });
};

module.exports.setTemp = (req, res) => {

    let id = req.swagger.params.id.value;
    let temp = req.swagger.params.temp.value;

    global.module.setTemperature(id, temp)
        .then( (status) => {
            res.json( { data: { status: status }, result : 'ok' } );
        })
        .catch( (err) => {
            res.status(500).json( { code: err.code || 0, message: err.message } );
        });

};
