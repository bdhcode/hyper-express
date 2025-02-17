const status_codes = require('../../constants/status_codes.json');
const mime_types = require('../../constants/mime_types.json');
const cookie = require('cookie');
const signature = require('cookie-signature');

class Response {
    #wrapped_request;
    #raw_response;
    #master_context;
    #upgrade_socket;
    #completed = false;
    #status_written = false;

    constructor(wrapped_request, raw_response, socket, master_context) {
        this.#wrapped_request = wrapped_request;
        this.#raw_response = raw_response;
        this.#upgrade_socket = socket || null;
        this.#master_context = master_context;
        this._bind_abort_handler();
    }

    /**
     * INTERNAL METHOD! This method is an internal method and should NOT be called manually.
     * This method binds an abort handler which will update completed field to lock appropriate operations in Response
     */
    _bind_abort_handler() {
        this.#raw_response.onAborted(() => (this.#completed = true));
    }

    /* Response Methods/Operators */

    /**
     * This method can be used to improve Network IO performance by executing
     * all network operations in a singular atomic structure.
     *
     * @param {Function} handler
     */
    atomic(handler) {
        if (typeof handler !== 'function')
            throw new Error(
                'HyperExpress: atomic(handler) -> handler must be a Javascript function'
            );
        return this.#raw_response.cork(handler);
    }

    /**
     * This method is used to write a custom status code.
     * Note! This method must be called before any other network operations such as
     * writing headers or writing cookies.
     *
     * @param {Number} code Example: response.status(403)
     * @returns {Response} Response (Chainable)
     */
    status(code) {
        // Enforce status() first network method as uWebsockets automatically writes a 200 status code on any other operation
        if (this.#status_written)
            throw new Error(
                'HyperExpress: .status() or .redirect() must be called before any other network actions such as writing headers or cookies.'
            );

        // Match status code Number to a status message and call uWS.Response.writeStatus
        let message = status_codes[code];
        if (!this.#completed)
            this.#raw_response.writeStatus(code + ' ' + message);
        return this;
    }

    /**
     * This method is used to set the response content type header
     * based on the provided mime type. Example: type('json')
     *
     * @param {String} mime_type Mime type
     * @returns {Response} Response (Chainable)
     */
    type(mime_type) {
        let mime_header = mime_types[mime_type] || 'text/plain';
        if (!this.#completed) this.header('content-type', mime_header);
        this.#status_written = true;
        return this;
    }

    /**
     * This method can be used to write a response header and supports chaining.
     *
     * @param {String} name Header Name
     * @param {String} value Header Value
     * @returns {Response} Response (Chainable)
     */
    header(name, value) {
        if (!this.#completed) this.#raw_response.writeHeader(name, value);
        this.#status_written = true;
        return this;
    }

    /**
     * This method is used to write a cookie to incoming request.
     * Note! This method utilized .header() therefore it must be called
     * after setting a custom status code.
     *
     * @param {String} name Cookie Name
     * @param {String} value Cookie Value
     * @param {Number} expiry In milliseconds
     * @param {Object} options Cookie Options
     * @param {Boolean} sign_cookie Enables/Disables Cookie Signing
     * @returns {Response} Response (Chainable)
     */
    cookie(
        name,
        value,
        expiry,
        options = {
            secure: true,
            sameSite: 'none',
            path: '/',
        },
        sign_cookie = true
    ) {
        // Convert expiry to a valid Date object or delete expiry altogether
        if (typeof expiry == 'number') {
            options.expires = new Date(Date.now() + expiry);
        } else {
            delete options.expires;
        }

        // Sign cookie value if signing is enabled and a valid secret is provided
        if (sign_cookie && typeof options.secret == 'string') {
            value = signature.sign(value, options.secret);
            options.encode = false; // Turn off encoding to prevent loss of signature structure
        }

        // Serialize cookie options -> set-cookie header and write header
        let header = cookie.serialize(name, value, options);
        this.header('set-cookie', header);
        this.#status_written = true;
        return this;
    }

    /**
     * This method is used to delete cookies on sender's browser.
     * An appropriate set-cookie header is written with maxAge as 0.
     *
     * @param {String} name Cookie Name
     * @returns {Response} Response
     */
    delete_cookie(name) {
        // null expiry and maxAge 0 will cause browser to unset cookie
        return this.cookie(name, '', null, {
            maxAge: 0,
        });
    }

    /**
     * This method is used to upgrade an incoming upgrade HTTP request to a Websocket connection.
     *
     * @param {Object} user_data Store any information about the websocket connection
     * @returns {Boolean} Boolean (true || false)
     */
    upgrade(user_data) {
        if (!this.#completed) {
            // Ensure a upgrade_socket exists before upgrading ensuring only upgrade handler requests are handled
            if (this.#upgrade_socket == null)
                throw new Error(
                    'You cannot upgrade a request that does not come from an upgrade handler. No upgrade socket was found.'
                );

            // Mark request as completed and call uWS.Response.upgrade() with upgrade_socket
            this.#completed = true;
            let headers = this.#wrapped_request.headers;
            let sec_key = headers['sec-websocket-key'];
            let sec_protocol = headers['sec-websocket-protocol'];
            let sec_extensions = headers['sec-websocket-extensions'];
            this.#raw_response.upgrade(
                user_data,
                sec_key,
                sec_protocol,
                sec_extensions,
                this.#upgrade_socket
            );
            return true;
        }
        return false;
    }

    /**
     * This method can be used to write the body in chunks/parts and .send()
     * must be called to end the request.
     *
     * @param {String} body
     * @returns {Response} Response (Chainable)
     */
    write(body) {
        if (!this.#completed) this.#raw_response.write(body);
        return this;
    }

    /**
     * This method is used to end the current request and send response with specified body and headers.
     *
     * @param {String} body Optional
     * @returns {Boolean} Boolean (true || false)
     */
    send(body) {
        if (!this.#completed) {
            // Trigger session closure if a session is preset in request object
            let session = this.#wrapped_request.session;
            if (typeof session == 'object' && session.ready)
                session._perform_closure(this, this.#master_context);

            // Mark request as completed and end request using uWS.Response.end()
            this.#completed = true;
            this.#raw_response.end(body);
            return true;
        }
        return false;
    }

    /**
     * This method is used to redirect an incoming request to a different url.
     *
     * @param {String} url Redirect URL
     * @returns {Boolean} Boolean (true || false)
     */
    redirect(url) {
        if (!this.#completed)
            return this.status(302).header('location', url).send();

        return false;
    }

    /**
     * This method is an alias of send() method except it accepts an object
     * and automatically stringifies the passed payload object.
     *
     * @param {Object} body JSON body
     * @returns {Boolean} Boolean (true || false)
     */
    json(body) {
        return this.type('json').send(JSON.stringify(body));
    }

    /**
     * This method is an alias of send() method except it automatically sets
     * html as the response content type and sends provided html response body.
     *
     * @param {String} body
     * @returns {Boolean} Boolean (true || false)
     */
    html(body) {
        return this.type('html').send(body);
    }

    /**
     * This method allows you to throw an error which will be caught by the global error handler.
     *
     * @param {Error} error Error Class
     */
    throw_error(error) {
        this.#master_context.error_handler(this.#wrapped_request, this, error);
    }

    /* Response Getters */

    /**
     * Returns the underlying raw uWS.Response object.
     */
    get raw() {
        return this.#raw_response;
    }

    /**
     * Returns current state of current state in regards to whether the source is still connected.
     */
    get aborted() {
        return this.#completed;
    }
}

module.exports = Response;
