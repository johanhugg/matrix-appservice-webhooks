var express = require("express");
var bodyParser = require("body-parser");
var LogService = require("./LogService");
var PubSub = require('pubsub-js');
var WebhookStore = require("./storage/WebhookStore");
var ProvisioningService = require("./provisioning/ProvisioningService");
var _ = require("lodash");
var interceptor = require("express-interceptor");

// TODO: Migrate provisioning API out of this class

class WebService {
    constructor() {
        this._app = express();
        this._app.use(bodyParser.json());
        this._app.use(bodyParser.urlencoded());

        // Logging incoming requests
        this._app.use((req, res, next) => {
            LogService.verbose("WebService", "Incoming: " + req.method + " " + req.url);
            next();
        });

        // Make sure everything we return is JSON
        this._installInterceptor();
        this._app.use((err, req, res, next) => {
            LogService.error("WebService", err);

            var status = 500;
            var message = "Internal Server Error";
            if (err.message.startsWith("Unexpected token ") && err.message.includes("in JSON at position")) {
                message = err.message;
                status = 400;
            }

            res.status(status);
            res.set('Content-Type', "application/json");
            res.send(JSON.stringify(this._constructError(res, message)));
            next('Error encountered during hook processing');
        });

        this._app.post("/api/v1/matrix/hook/:hookId", this._postWebhook.bind(this));

        // Provisioning API
        this._app.put("/api/v1/provision/:roomId/hook", this._provisionHook.bind(this));
        this._app.get("/api/v1/provision/:roomId/hooks", this._listHooks.bind(this));
        this._app.delete("/api/v1/provision/:roomId/hook/:hookId", this._deleteHook.bind(this));
    }

    _installInterceptor() {
        var finalParagraphInterceptor = interceptor((req, res) => {
            return {
                isInterceptable: () => {
                    console.log(res.get('Content-Type'));
                    return res.get('Content-Type').startsWith("text/plain") || res.get('Content-Type').startsWith("text/html");
                },
                intercept: (body, send) => {
                    res.set('Content-Type', "application/json");
                    send(JSON.stringify(this._constructError(res, body)));
                }
            };
        });
        this._app.use(finalParagraphInterceptor);
    }

    _constructError(res, body) {
        var contentType = res.get('Content-Type');
        var statusCode = res.statusCode;

        return {
            statusCode: statusCode,
            success: !(statusCode < 200 || statusCode >= 300),
            error: body,
            originalMime: contentType
        };
    }

    _postWebhook(request, response) {
        response.setHeader("Content-Type", "application/json");

        if (request.headers['content-type'].toLowerCase() === 'application/x-www-form-urlencoded') {
            request.body = JSON.parse(request.body.payload || "{}");
        }

        var hookInfo = request.body;
        if (!hookInfo || !(hookInfo["text"] || (hookInfo["attachments"] && hookInfo["attachments"].length > 0))) {
            LogService.error("WebService [Hook " + request.params.hookId + "]", "Invalid message: missing text or attachments");
            response.status(400).send({error: 'Missing message text or attachments', success: false});
            return;
        }

        WebhookStore.getWebhook(request.params.hookId).then(hook => {
            if (!hook) {
                LogService.error("WebService [Hook " + request.params.hookId + "]", "Invalid hook ID");
                response.status(400).send({error: 'Invalid hook ID', success: false});
                return;
            }

            LogService.info("WebService [Hook " + request.params.hookId + "]", "Publishing webhook request for processing");
            PubSub.publish("incoming_webhook", {
                hookId: request.params.hookId,
                hook: hook,
                payload: hookInfo
            });
            response.status(200).send({success: true, queued: true});
        }).catch(error => {
            LogService.error("WebService [Hook " + request.params.hookId + "]", error);
            response.status(500).send({error: 'Unknown error processing webhook', success: false});
        });
    }

    _provisioningApiTest(roomId, userId, token, response, hookId = null, expectingHookId = false) {
        if (!roomId || !userId || !token || (!hookId && expectingHookId)) {
            response.status(400).send({success: false, message: ProvisioningService.PERMISSION_ERROR_MESSAGE});
            return false;
        }

        if (!this._token || this._token !== token) {
            response.status(403).send({success: false, message: ProvisioningService.PERMISSION_ERROR_MESSAGE});
            return false;
        }

        return true;
    }

    _provisioningApiWebhook(webhook) {
        return {
            id: webhook.id,
            userId: webhook.userId,
            roomId: webhook.roomId,
            url: this.getHookUrl(webhook.id),
            type: "incoming", // we don't actually support anything else, this is just in case we do in the future.
        };
    }

    _provisioningApiCatch(error, response) {
        if (error === ProvisioningService.PERMISSION_ERROR_MESSAGE) {
            response.status(400).send({success: false, message: error});
            return;
        }

        LogService.error("WebService", error);
        response.status(500).send({success: false, message: "Unknown error processing request"});
    }

    _provisionHook(request, response) {
        var roomId = request.params.roomId;
        var userId = request.query.userId;
        var token = request.query.token;

        if (!this._provisioningApiTest(roomId, userId, token, response)) return;

        ProvisioningService.createWebhook(roomId, userId).then(webhook => {
            LogService.info("WebService", "Webhook created with provisioning api: " + webhook.id);
            response.status(200).send(this._provisioningApiWebhook(webhook));
        }).catch(error => this._provisioningApiCatch(error, response));
    }

    _listHooks(request, response) {
        var roomId = request.params.roomId;
        var userId = request.query.userId;
        var token = request.query.token;

        if (!this._provisioningApiTest(roomId, userId, token, response)) return;

        ProvisioningService.getWebhooks(roomId, userId).then(webhooks => {
            response.status(200).send({
                success: true,
                results: _.map(webhooks, h => this._provisioningApiWebhook(h))
            });
        }).catch(error => this._provisioningApiCatch(error, response));
    }

    _deleteHook(request, response) {
        var hookId = request.params.hookId;
        var roomId = request.params.roomId;
        var userId = request.query.userId;
        var token = request.query.token;

        if (!this._provisioningApiTest(roomId, userId, token, response, hookId, true)) return;

        ProvisioningService.deleteWebhook(roomId, userId, hookId).then(() => {
            response.status(200).send({success: true});
        }).catch(error => this._provisioningApiCatch(error, response));
    }

    setSharedToken(token) {
        this._token = token;
    }

    start(bindAddress, port, baseAddress) {
        this._baseAddress = baseAddress;
        this._app.listen(port, bindAddress);
        LogService.info("WebService", "API now listening on " + bindAddress + ":" + port);
    }

    getHookUrl(hookId) {
        if (this._baseAddress.endsWith("/"))
            this._baseAddress = this._baseAddress.substring(0, this._baseAddress.length - 1);
        return this._baseAddress + "/api/v1/matrix/hook/" + hookId;
    }
}

module.exports = new WebService();
