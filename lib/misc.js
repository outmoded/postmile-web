// Load modules

var Hoek = require('hoek');
var Boom = require('boom');
var Email = require('emailjs');


// Declare internals

var internals = {};


// Home page

exports.home = function (request, reply) {

    if (request.auth.credentials &&
        request.auth.credentials.profile) {

        return reply.redirect(request.auth.credentials.profile.view);
    }
    else {
        var locals = {
            logo: false,
            env: {
                message: request.session.get('message', true) || ''
            }
        };

        return reply.view('home', locals);
    }
};


// Welcome page

exports.welcome = function (request, reply) {

    return reply.redirect(request.auth.credentials.profile.view);
};


// About page

exports.about = function (request, reply) {

    return reply.view('about');
};


// Developer page

exports.developer = function (request, reply) {

    return reply.view('developer', { theme: 'developer' });
};


// Developer Console

exports.console = function (request, reply) {

    return reply.view('console');
};


// Set I'm with stupid cookie

exports.stupid = function (request, reply) {

    request.state('imwithstupid', 'true', { path: '/' });
    return reply.redirect('/');
};


// Feedback page

exports.feedback = function (request, reply) {

    if (request.method === 'get') {
        return reply.view('feedback');
    }
    else {
        var feedback = 'From: ' + (request.payload.username ? request.payload.username : request.payload.name + ' <' + request.payload.email + '>') + '\n\n' + request.payload.message;
        internals.send(this.config, 'Posmile site feedback', feedback);

        return reply.view('feedback', { env: { message: 'Your feedback has been received!' } });
    }
};


// Client configuration script

exports.config = function (request, reply) {

    reply('var postmile = ' + JSON.stringify(this.config.server) + ';');
};


// Socket.IO Script Proxy

exports.socketio = function (request, reply) {

    return reply.redirect(this.config.server.api.uri + '/socket.io/socket.io.js');
};


// Send message

internals.send = function (config, subject, text, html, callback) {

    var headers = {
        from: config.email.fromName + ' <' + config.email.replyTo + '>',
        to: config.email.feedback,
        subject: subject,
        text: text
    };

    var message = Email.message.create(headers);

    if (html) {
        message.attach_alternative(html);
    }

    var mailer = Email.server.connect(config.email.server);
    mailer.send(message, function (err, message) {

        if (err) {
            if (!callback) {
                return console.log('Email error: ' + JSON.stringify(err));
            }

            return callback(Boom.internal('Failed sending email: ' + JSON.stringify(err)));
        }

        if (callback) {
            return callback(null);
        }
    });
};

