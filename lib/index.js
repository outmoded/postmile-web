// Load modules

var Fs = require('fs');
var Hoek = require('hoek');
var Boom = require('boom');
var Login = require('./login');
var Session = require('./session');
var Routes = require('./routes');
var Api = require('./api');


// Declare internals

var internals = {};


exports.register = function (plugin, options, next) {

    var api = new Api(plugin.app);

    plugin.events.on('request', function (request, event, tags) {
        
        if (tags.error) {
            console.log(request.path, event)
        }
    })

    plugin.bind({
        config: plugin.app.config,
        vault: plugin.app.vault,
        api: api
    });

    plugin.register([
        {
            plugin: require('yar'),
            options: {
                name: 'yar',
                cookieOptions: {
                    isSecure: !!plugin.app.config.server.web.tls,
                    password: plugin.app.vault.yar
                }
            }
        },
        require('crumb'),
        require('scooter'),
        require('hapi-auth-cookie'),
        require('bell')
    ], function (err) {

        Hoek.assert(!err, 'Failed loading plugin: ' + err);
        plugin.ext('onPreResponse', internals.onPreResponse);

        // Authentication

        plugin.auth.strategy('session', 'cookie', 'try', {
            password: plugin.app.vault.session,
            validateFunc: Session.validate(api),
            isSecure: !!plugin.app.config.server.web.tls,
            clearInvalid: true,
            redirectTo: plugin.app.config.server.web.uri + '/login',
            appendNext: true,
            ttl: 365 * 24 * 60 * 60 * 1000                          // 1 Year
        });

        // Third-party login

        var providers = Object.keys(plugin.app.config.login);
        providers.forEach(function (provider) {

            var cred = plugin.app.config.login[provider];
            if (cred.clientId) {
                plugin.auth.strategy(provider, 'bell', {
                    provider: provider,
                    password: plugin.app.vault.session,
                    clientId: cred.clientId,
                    clientSecret: cred.clientSecret,
                    isSecure: !!plugin.app.config.server.web.tls
                });

                plugin.route({
                    method: ['GET', 'POST'],
                    path: '/auth/' + provider,
                    config: {
                        auth: provider,
                        handler: Login.auth,
                        plugins: { crumb: false }
                    }
                });
            }
        });

        // Views

        plugin.views({
            path: __dirname + '/views',
            engines: {
                jade: require('jade')
            },
            compileOptions: {
                colons: true,
                pretty: true
            }
        });

        // Load paths

        plugin.route(Routes.endpoints);
        plugin.route({
            method: 'GET',
            path: '/{path*}',
            config: {
                handler: {
                    directory: {
                        path: __dirname + '/static'
                    }
                },
                auth: false
            }
        });

        return next();
    });
};


exports.register.attributes = {
    pkg: require('../package.json')
};


internals.onPreResponse = function (request, reply) {

    // Leave API responses alone (unformatted)

    if (request.route.app.isAPI) {
        return reply();
    }

    // Return error page

    var response = request.response;
    if (response.isBoom) {
        var error = response;
        var context = {
            profile: request.auth.credentials && request.auth.credentials.profile,
            error: error.message,
            code: error.output.statusCode === 404 ? 404 : 500,
            message: (error.output.statusCode === 404 ? 'the page you were looking for was not found' : 'something went wrong...'),
            env: {},
            server: this.config.server,
            product: this.config.product
        };

        return reply.view('error', context);
    }

    // Set default view context

    if (response.variety === 'view') {

        // Setup view variables

        var context = response.source.context;
        context.env = context.env || {};
        context.server = this.config.server;
        context.profile = request.auth.credentials && request.auth.credentials.profile;
        context.product = this.config.product;
        context.auth = {
            facebook: !!this.config.login.facebook.clientId,
            twitter: !!this.config.login.twitter.clientId,
            yahoo: !!this.config.login.yahoo.clientId
        };
        context.isMobile = false;

        // Set mobile environment

        if (request.plugins.scooter.os.family === 'iOS' &&
            request.route.app.hasMobile) {

            context.layout = 'mobile';
            context.isMobile = true;
        }

        // Render view

        return reply();
    }

    return reply();
};


/*
internals.onRequest = function (request, next) {

    var req = request.raw.req;

    var isNotWithStupid = true;
    if (req.headers['user-agent']) {
        req.api.agent = UserAgent.parse(req.headers['user-agent']);

        if (req.url !== '/imwithstupid' &&
            req.cookies.imwithstupid === undefined) {

            // Check user-agent version

            if (req.api.agent &&
                req.api.agent.name &&
                req.api.agent.version) {

                // Normalize version

                var version = (req.api.agent.name === 'chrome' ? req.api.agent.version.replace(/\.\d+$/, '') : req.api.agent.version);

                if (version.split(/\./g).length - 1 < 2) {
                    version += '.0';
                }

                // Check version

                isNotWithStupid = ((req.api.agent.name === 'chrome' && Semver.satisfies(version, '>= 11.x.x')) ||
                                   (req.api.agent.name === 'safari' && Semver.satisfies(version, '>= 5.x.x')) ||
                                   (req.api.agent.name === 'firefox' && Semver.satisfies(version, '>= 4.x.x')));
            }
        }
    }

    if (!isNotWithStupid) {
        return next(new Response.View(self.server.views, 'stupid', context, options));
    }

    return next();
};
*/