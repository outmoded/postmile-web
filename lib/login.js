// Load modules

var Boom = require('boom');
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

        return reply.redirect('/tos' + (request.query.next && request.query.next.charAt(0) === '/' ? '?next=' + encodeURIComponent(request.query.next) : ''));
    }

    return reply.redirect(request.query.next || request.auth.credentials.profile.view);
};


// Logout

exports.logout = function (request, reply) {

    request.auth.session.clear();
    return reply.redirect('/');
};


// Third party authentication

exports.auth = function (request, reply) {

    var self = this;

    var credentials = request.auth.credentials;

    // Check if user logged-in to Postmile

    request.server.auth.test('session', request, function (err, session) {

        // Login

        if (err) {
            var destination = (credentials.query.x_next && credentials.query.x_next.charAt(0) === '/' ? credentials.query.x_next : undefined);  // Prevent being used an open redirector
            return exports.loginCall(self, credentials.provider, credentials.profile.id, request, destination, credentials, reply);
        }

        // Link account

        return self.api.clientCall('POST', '/user/' + session.profile.id + '/link/' + credentials.provider, { id: credentials.profile.id }, function (err, code, payload) {

            return reply.redirect('/account/linked');
        });
    });
};


// Unlink account

exports.unlink = function (request, reply) {

    if (['twitter', 'facebook', 'yahoo'].indexOf(request.payload.network) === -1) {
        return reply.redirect('/account/linked');
    }

    this.api.clientCall('DELETE', '/user/' + request.auth.credentials.profile.id + '/link/' + request.payload.network, '', function (err, code, payload) {

        return reply.redirect('/account/linked');
    });
};


// Email token login

exports.emailToken = function (request, reply) {

    exports.loginCall(this, 'email', request.params.token, request, null, null, reply);
};


// Login common function

exports.loginCall = function (env, type, id, request, destination, credentials, reply) {

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
                return reply.redirect('/');
            }

            // Sign-up

            if (credentials) {
                var account = {
                    network: credentials.provider,
                    id: credentials.profile.id,
                    username: credentials.profile.username || '',
                    name: credentials.profile.displayName || '',
                    email: credentials.profile.email || ''
                };

                request.session.set('signup', account);
                return reply.redirect('/signup/register');
            }

            // Failed to login or register

            return reply.redirect('/');
        }

        // Registered user

        env.api.clientCall('POST', '/oz/rsvp', { rsvp: payload.rsvp }, function (err, code, ticket) {

            if (err) {
                return reply(Boom.internal('Unexpected API response', err));
            }

            if (code !== 200) {

                // Failed to login or register

                return reply.redirect('/');
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

                    return reply.redirect('/tos' + (destination ? '?next=' + encodeURIComponent(destination) : ''));
                }

                return reply.redirect(destination || '/');
            });
        });
    });
};


