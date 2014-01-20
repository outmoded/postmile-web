// Load modules

var Request = require('request');
var Oz = require('oz');


// Declare internals

var internals = {};


module.exports = internals.Client = function (options) {

    this.settings = options;
    this.ticket = null;
};


// Make API call w/ client token

internals.Client.prototype.clientCall = function (method, path, body, callback) {

    var self = this;

    var getTicket = function (next) {

        if (self.ticket) {
            return next();
        }

        var uri = 'http://' + self.options.config.server.api.host + ':' + self.options.config.server.api.port + '/oz/app';
        var header = Oz.client.header(uri, 'POST', self.options.vault.apiClient);
        var options = {
            uri: uri,
            method: 'POST',
            headers: {
                Authorization: header.field
            },
            json: true
        };

        Request(options, function (err, response, body) {

            if (!err &&
                response.statusCode === 200 &&
                body) {

                self.ticket = body;
            }

            return next();
        });
    };

    getTicket(function () {

        exports.call(method, path, body, self.ticket, function (err, code, payload) {

            if (code !== 401) {
                return callback(err, code, payload);
            }

            // Try getting a new client session token

            self.ticket = null;
            getTicket(function () {

                self.call(method, path, body, self.ticket, callback);
            });
        });
    });
};


// Make API call

internals.Client.prototype.call = function (method, path, body, ticket, callback) {

    body = (body !== null ? JSON.stringify(body) : null);

    var uri = 'http://' + this.options.config.server.api.host + ':' + this.optoins.config.server.api.port + path;
    var headers = {};

    if (ticket) {
        var header = Oz.client.header(uri, method, ticket);
        headers.Authorization = header.field;
    }
    
    var options = {
        uri: uri,
        method: method,
        headers: headers,
        body: body
    };

    Request(options, function (err, response, body) {

        if (err) {
            return callback(new Error('Failed sending API server request: ' + err.message));
        }

        var payload = null;
        try {
            payload = JSON.parse(body);
        }
        catch (e) {
            return callback(new Error('Invalid response body from API server: ' + response + '(' + e + ')'));
        }

        return callback(null, response.statusCode, payload);
    });
};
