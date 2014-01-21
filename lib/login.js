// Load modules

var Url = require('url');
var OAuth = require('oauth');
var Https = require('https');
var QueryString = require('querystring');
var Hoek = require('hoek');
var Boom = require('boom');
var Cryptiles = require('cryptiles');
var Session = require('./session');
var Tos = require('./tos');


// Declare internals

var internals = {};


// Login page

exports.login = function (request, reply) {

    if (!request.auth.credentials ||
        !request.auth.credentials.profile) {

        return reply.view('login', { logo: false, env: { next: (request.query.next ? encodeURIComponent(request.query.next) : '') } });
    }

    if (request.auth.credentials.restriction === 'tos' ||
        !request.auth.credentials.ext.tos ||
        request.auth.credentials.ext.tos < Tos.minimumTOS) {

        return reply().redirect('/tos' + (request.query.next && request.query.next.charAt(0) === '/' ? '?next=' + encodeURIComponent(request.query.next) : ''));
    }

    return reply().redirect(request.query.next || request.auth.credentials.profile.view);
};


// Logout

exports.logout = function (request, reply) {

    request.auth.session.clear();
    return reply().redirect('/');
};


// Third party authentication (OAuth 1.0/2.0 callback URI)

exports.auth = function (request, reply) {

    var self = this;

    var entry = function () {

        // Preserve parameters for OAuth authorization callback

        if (request.query.x_next &&
            request.query.x_next.charAt(0) === '/') {        // Prevent being used an open redirector

            request.session.set('auth', { next: request.query.x_next });
        }

        if (['twitter', 'facebook', 'yahoo'].indexOf(request.params.network) === -1) {
            return reply(Boom.internal('Unknown third party network authentication', request.params.network));
        }

        switch (request.params.network) {

            case 'twitter': twitter(); break;
            case 'facebook': facebook(); break;
            case 'yahoo': yahoo(); break;
        }
    };

    var twitter = function () {

        if (!request.server.app.twitterClient) {
            request.server.app.twitterClient = new OAuth.OAuth('https://api.twitter.com/oauth/request_token',
                                                      'https://api.twitter.com/oauth/access_token',
                                                       self.vault.twitter.clientId,
                                                       self.vault.twitter.clientSecret,
                                                       '1.0',
                                                       self.config.server.web.uri + '/auth/twitter',
                                                       'HMAC-SHA1');
        }

        // Sign-in Initialization

        if (!request.query.oauth_token) {
            return request.server.app.twitterClient.getOAuthRequestToken(function (err, token, secret, authorizeUri, params) {

                if (err) {
                    return reply(Boom.internal('Failed to obtain a Twitter request token', err));
                }

                request.session.set('twitter', { token: token, secret: secret });
                return reply().redirect('https://api.twitter.com/oauth/authenticate?oauth_token=' + token);
            });
        }

        // Authorization callback

        if (!request.query.oauth_verifier) {
            return reply(Boom.internal('Missing verifier parameter in Twitter authorization response'));
        }

        var credentials = request.session.get('twitter', true);
        if (!credentials) {
            return reply(Boom.internal('Missing Twitter request token cookie'));
        }

        if (request.query.oauth_token !== credentials.token) {
            return reply(Boom.internal('Twitter authorized request token mismatch'));
        }

        request.server.app.twitterClient.getOAuthAccessToken(credentials.token, credentials.secret, request.query.oauth_verifier, function (err, token, secret, params) {

            if (err) {
                return reply(Boom.internal('Failed to obtain a Twitter access token', err));
            }

            if (!params.user_id) {
                return reply(Boom.internal('Invalid Twitter access token response', err));
            }

            var account = {
                network: 'twitter',
                id: params.user_id,
                username: params.screen_name || ''
            };

            if (request.auth.credentials &&
                request.auth.credentials.profile) {

                return finalizedLogin(account);
            }

            request.server.app.twitterClient.getProtectedResource('http://api.twitter.com/1/account/verify_credentials.json', 'GET', token, secret, function (err, response) {

                if (!err) {
                    var data = null;
                    try {
                        data = JSON.parse(response);
                    }
                    catch (e) { }

                    if (data &&
                        data.name) {

                        account.name = data.name;
                    }
                }

                return finalizedLogin(account);
            });
        });
    };

    var facebook = function () {

        // Sign-in Initialization

        if (!request.query.code) {
            var request = {
                protocol: 'https:',
                host: 'graph.facebook.com',
                pathname: '/oauth/authorize',
                query: {
                    client_id: self.vault.facebook.clientId,
                    response_type: 'code',
                    scope: 'email',
                    redirect_uri: self.config.server.web.uri + '/auth/facebook',
                    state: Cryptiles.randomString(22),
                    display: request.plugins.scooter.os.family === 'iOS' ? 'touch' : 'page'
                }
            };

            request.session.set('facebook', { state: request.query.state });
            return reply().redirect(Url.format(request));
        }


        // Authorization callback

        var facebookSession = request.session.get('facebook', true);
        if (!facebookSession ||
            !facebookSession.state) {

            return reply(Boom.internal('Missing Facebook state cookie'));
        }

        if (facebookSession.state !== request.query.state) {
            return reply(Boom.internal('Facebook incorrect state parameter'));
        }

        var query = {
            client_id: self.vault.facebook.clientId,
            client_secret: self.vault.facebook.clientSecret,
            grant_type: 'authorization_code',
            code: request.query.code,
            redirect_uri: self.config.server.web.uri + '/auth/facebook'
        };

        var body = QueryString.stringify(query);
        facebookRequest('POST', '/oauth/access_token', body, function (err, data) {

            if (!data) {
                return reply(err);
            }

            facebookRequest('GET', '/me?' + QueryString.stringify({ oauth_token: data.access_token }), null, function (err, data) {

                if (err) {
                    return reply(err);
                }

                if (!data ||
                    !data.id) {

                    return reply(Boom.internal('Invalid Facebook profile response', err));
                }

                var account = {
                    network: 'facebook',
                    id: data.id,
                    name: data.name || '',
                    username: data.username || '',
                    email: (data.email && !data.email.match(/proxymail\.facebook\.com$/) ? data.email : '')
                };

                finalizedLogin(account);
            });
        });
    };

    var facebookRequest = function (method, path, body, callback) {

        var options = {
            host: 'graph.facebook.com',
            port: 443,
            path: path,
            method: method
        };

        var hreq = Https.request(options, function (hres) {

            if (!hres) {
                return callback(Boom.internal('Failed sending Facebook token request'));
            }

            var response = '';

            hres.setEncoding('utf8');
            hres.on('data', function (chunk) {

                response += chunk;
            });

            hres.on('end', function () {

                var data = null;
                var error = null;

                try {
                    data = JSON.parse(response);
                }
                catch (err) {
                    data = QueryString.parse(response);     // Hack until Facebook fixes their OAuth implementation
                    // error = 'Invalid response body from Facebook token endpoint: ' + response + '(' + err + ')';
                }

                if (error) {
                    return callback(Boom.internal(error));
                }

                if (hres.statusCode !== 200) {
                    return callback(Boom.internal('Facebook returned OAuth error on token request', data));
                }

                return callback(null, data);
            });
        });

        hreq.on('error', function (err) {

            callback(Boom.internal('HTTP socket error', err));
        });

        if (body !== null) {
            hreq.setHeader('Content-Type', 'application/x-www-form-urlencoded');
            hreq.write(body);
        }

        hreq.end();
    };

    var yahoo = function () {

        if (!request.server.app.yahooClient) {
            request.server.app.yahooClient = new OAuth.OAuth('https://oauth03.member.mud.yahoo.com/oauth/v2/get_request_token',
                                                    'https://oauth03.member.mud.yahoo.com/oauth/v2/get_token',
                                                    self.vault.yahoo.clientId,
                                                    self.vault.yahoo.clientSecret,
                                                    '1.0',
                                                    self.config.server.web.uri + '/auth/yahoo',
                                                    'HMAC-SHA1');
        }

        // Sign-in Initialization

        if (!request.query.oauth_token) {
            request.server.app.yahooClient.getOAuthRequestToken(function (err, token, secret, authorizeUri, params) {

                if (err) {
                    return reply(Boom.internal('Failed to obtain a Yahoo! request token', err));
                }

                request.session.set('yahoo', { token: token, secret: secret });
                return reply().redirect('https://api.login.yahoo.com/oauth/v2/request_auth?oauth_token=' + token);
            });
        }

        // Authorization callback

        if (!request.query.oauth_verifier) {
            return reply(Boom.internal('Missing verifier parameter in Yahoo authorization response'));
        }

        credentials = request.session.get('yahoo', true);
        if (!credentials) {
            return reply(Boom.internal('Missing Yahoo request token cookie'));
        }

        if (request.query.oauth_token !== credentials.token) {
            return reply(Boom.internal('Yahoo authorized request token mismatch'));
        }

        request.server.app.yahooClient.getOAuthAccessToken(credentials.token, credentials.secret, request.query.oauth_verifier, function (err, token, secret, params) {

            if (err) {
                return reply(Boom.internal('Failed to obtain a Yahoo access token', err));
            }

            if (!params ||
                !params.xoauth_yahoo_guid) {

                return reply(Boom.internal('Invalid Yahoo access token response', params));
            }

            var account = {
                network: 'yahoo',
                id: params.xoauth_yahoo_guid
            };

            if (request.auth.credentials &&
                request.auth.credentials.profile) {

                return finalizedLogin(account);
            }

            request.server.app.yahooClient.getProtectedResource('http://social.yahooapis.com/v1/user/' + params.xoauth_yahoo_guid + '/profile?format=json', 'GET', token, secret, function (err, response) {

                if (!err) {
                    var data = null;
                    try {
                        data = JSON.parse(response);
                    }
                    catch (e) { }

                    if (data && data.profile && data.profile.nickname) {
                        account.name = data.profile.nickname;
                    }
                }

                return finalizedLogin(account);
            });
        });
    };

    var finalizedLogin = function (account) {

        if (request.auth.isAuthenticated &&
            request.auth.credentials &&
            request.auth.credentials.profile) {

            // Link

            self.api.clientCall('POST', '/user/' + request.auth.credentials.profile.id + '/link/' + account.network, { id: account.id }, function (err, code, payload) {

                return reply().redirect('/account/linked');
            });
        }
        else {

            // Login

            var authSession = request.session.get('auth', true);
            var destination = (authSession && authSession.next);
            exports.loginCall(self, account.network, account.id, request, destination, account, reply);
        }
    };

    entry();
};


// Unlink account

exports.unlink = function (request, reply) {

    if (['twitter', 'facebook', 'yahoo'].indexOf(request.payload.network) === -1) {
        return reply().redirect('/account/linked');
    }

    this.api.clientCall('DELETE', '/user/' + request.auth.credentials.profile.id + '/link/' + request.payload.network, '', function (err, code, payload) {

        return reply().redirect('/account/linked');
    });
};


// Email token login

exports.emailToken = function (request, reply) {

    exports.loginCall(this, 'email', request.params.token, request, null, null, reply);
};


// Login common function

exports.loginCall = function (env, type, id, request, destination, account, reply) {

    var payload = {
        type: type,
        id: id
    };

    env.api.clientCall('POST', '/oz/login', payload, function (err, code, payload) {

        if (err) {
            return reply(Boom.internal('Unexpected API response', err));
        }

        if (code !== 200) {
            request.auth.session.clear();

            // Bad email invite

            if (type === 'email') {
                request.session.set('message', payload.message);
                return reply().redirect('/');
            }

            // Sign-up

            if (account) {
                request.session.set('signup', account);
                return reply().redirect('/signup/register');
            }

            // Failed to login or register

            return reply().redirect('/');
        }

        // Registered user

        env.api.clientCall('POST', '/oz/rsvp', { rsvp: payload.rsvp }, function (err, code, ticket) {

            if (err) {
                return reply(Boom.internal('Unexpected API response', err));
            }

            if (code !== 200) {

                // Failed to login or register

                return reply().redirect('/');
            }

            Session.set(request, ticket, function (isValid, restriction) {

                if (!isValid) {
                    return reply(Boom.internal('Invalid response parameters from API server'));
                }

                if (payload.ext &&
                    payload.ext.action &&
                    payload.ext.action.type) {

                    switch (payload.ext.action.type) {
                        case 'reminder':
                            request.session.set('message', 'You made it in! Now link your account to Facebook, Twitter, or Yahoo! to make sign-in easier next time.');
                            destination = '/account/linked';
                            break;
                        case 'verify':
                            request.session.set('message', 'Email address verified');
                            destination = '/account/emails';
                            break;
                    }
                }

                if (restriction === 'tos' &&
                    (!destination || destination.indexOf('/account') !== 0)) {

                    return reply().redirect('/tos' + (destination ? '?next=' + encodeURIComponent(destination) : ''));
                }

                return reply().redirect(destination || '/');
            });
        });
    });
};


