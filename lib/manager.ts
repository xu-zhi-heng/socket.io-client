import * as eio from "engine.io-client";
import { Socket, SocketOptions } from "./socket";
import * as Emitter from "component-emitter";
import * as parser from "socket.io-parser";
import { Decoder, Encoder } from "socket.io-parser";
import { on } from "./on";
import * as bind from "component-bind";
import * as indexOf from "indexof";
import * as Backoff from "backo2";

const debug = require("debug")("socket.io-client:manager");

interface EngineOptions {
  /**
   * The host that we're connecting to. Set from the URI passed when connecting
   */
  host: string;

  /**
   * The hostname for our connection. Set from the URI passed when connecting
   */
  hostname: string;

  /**
   * If this is a secure connection. Set from the URI passed when connecting
   */
  secure: boolean;

  /**
   * The port for our connection. Set from the URI passed when connecting
   */
  port: string;

  /**
   * Any query parameters in our uri. Set from the URI passed when connecting
   */
  query: Object;

  /**
   * `http.Agent` to use, defaults to `false` (NodeJS only)
   */
  agent: string | boolean;

  /**
   * Whether the client should try to upgrade the transport from
   * long-polling to something better.
   * @default true
   */
  upgrade: boolean;

  /**
   * Forces JSONP for polling transport.
   */
  forceJSONP: boolean;

  /**
   * Determines whether to use JSONP when necessary for polling. If
   * disabled (by settings to false) an error will be emitted (saying
   * "No transports available") if no other transports are available.
   * If another transport is available for opening a connection (e.g.
   * WebSocket) that transport will be used instead.
   * @default true
   */
  jsonp: boolean;

  /**
   * Forces base 64 encoding for polling transport even when XHR2
   * responseType is available and WebSocket even if the used standard
   * supports binary.
   */
  forceBase64: boolean;

  /**
   * Enables XDomainRequest for IE8 to avoid loading bar flashing with
   * click sound. default to `false` because XDomainRequest has a flaw
   * of not sending cookie.
   * @default false
   */
  enablesXDR: boolean;

  /**
   * The param name to use as our timestamp key
   * @default 't'
   */
  timestampParam: string;

  /**
   * Whether to add the timestamp with each transport request. Note: this
   * is ignored if the browser is IE or Android, in which case requests
   * are always stamped
   * @default false
   */
  timestampRequests: boolean;

  /**
   * A list of transports to try (in order). Engine.io always attempts to
   * connect directly with the first one, provided the feature detection test
   * for it passes.
   * @default ['polling','websocket']
   */
  transports: string[];

  /**
   * The port the policy server listens on
   * @default 843
   */
  policyPost: number;

  /**
   * If true and if the previous websocket connection to the server succeeded,
   * the connection attempt will bypass the normal upgrade process and will
   * initially try websocket. A connection attempt following a transport error
   * will use the normal upgrade process. It is recommended you turn this on
   * only when using SSL/TLS connections, or if you know that your network does
   * not block websockets.
   * @default false
   */
  rememberUpgrade: boolean;

  /**
   * Are we only interested in transports that support binary?
   */
  onlyBinaryUpgrades: boolean;

  /**
   * Transport options for Node.js client (headers etc)
   */
  transportOptions: Object;

  /**
   * (SSL) Certificate, Private key and CA certificates to use for SSL.
   * Can be used in Node.js client environment to manually specify
   * certificate information.
   */
  pfx: string;

  /**
   * (SSL) Private key to use for SSL. Can be used in Node.js client
   * environment to manually specify certificate information.
   */
  key: string;

  /**
   * (SSL) A string or passphrase for the private key or pfx. Can be
   * used in Node.js client environment to manually specify certificate
   * information.
   */
  passphrase: string;

  /**
   * (SSL) Public x509 certificate to use. Can be used in Node.js client
   * environment to manually specify certificate information.
   */
  cert: string;

  /**
   * (SSL) An authority certificate or array of authority certificates to
   * check the remote host against.. Can be used in Node.js client
   * environment to manually specify certificate information.
   */
  ca: string | string[];

  /**
   * (SSL) A string describing the ciphers to use or exclude. Consult the
   * [cipher format list]
   * (http://www.openssl.org/docs/apps/ciphers.html#CIPHER_LIST_FORMAT) for
   * details on the format.. Can be used in Node.js client environment to
   * manually specify certificate information.
   */
  ciphers: string;

  /**
   * (SSL) If true, the server certificate is verified against the list of
   * supplied CAs. An 'error' event is emitted if verification fails.
   * Verification happens at the connection level, before the HTTP request
   * is sent. Can be used in Node.js client environment to manually specify
   * certificate information.
   */
  rejectUnauthorized: boolean;
}

export interface ManagerOptions extends EngineOptions {
  /**
   * Should we force a new Manager for this connection?
   * @default false
   */
  forceNew: boolean;

  /**
   * Should we multiplex our connection (reuse existing Manager) ?
   * @default true
   */
  multiplex: boolean;

  /**
   * The path to get our client file from, in the case of the server
   * serving it
   * @default '/socket.io'
   */
  path: string;

  /**
   * Should we allow reconnections?
   * @default true
   */
  reconnection: boolean;

  /**
   * How many reconnection attempts should we try?
   * @default Infinity
   */
  reconnectionAttempts: number;

  /**
   * The time delay in milliseconds between reconnection attempts
   * @default 1000
   */
  reconnectionDelay: number;

  /**
   * The max time delay in milliseconds between reconnection attempts
   * @default 5000
   */
  reconnectionDelayMax: number;

  /**
   * Used in the exponential backoff jitter when _reconnecting
   * @default 0.5
   */
  randomizationFactor: number;

  /**
   * The timeout in milliseconds for our connection attempt
   * @default 20000
   */
  timeout: number;

  /**
   * Should we automatically connect?
   * @default true
   */
  autoConnect: boolean;

  /**
   * the parser to use. Defaults to an instance of the Parser that ships with socket.io.
   */
  parser: any;
}

export class Manager extends Emitter {
  /**
   * @package
   */
  public _autoConnect: boolean;
  /**
   * @package
   */
  public _readyState: "opening" | "open" | "closed";
  /**
   * @package
   */
  public _reconnecting: boolean;

  private readonly uri: string;
  private readonly opts: object;

  private nsps: object = {};
  private subs: Array<any> = [];
  private backoff: any;
  private _reconnection: boolean;
  private _reconnectionAttempts: number;
  private _reconnectionDelay: number;
  private _randomizationFactor: number;
  private _reconnectionDelayMax: number;
  private _timeout: any;

  private connecting: Array<Socket> = [];
  private encoder: Encoder;
  private decoder: Decoder;
  public engine: any;
  private skipReconnect: boolean;

  /**
   * `Manager` constructor.
   *
   * @param {String} uri - engine instance or engine uri/opts
   * @param {Object} opts - options
   * @public
   */
  constructor(opts: Partial<ManagerOptions>);
  constructor(uri?: string, opts?: Partial<ManagerOptions>);
  constructor(uri?: any, opts?: any) {
    super();
    if (uri && "object" === typeof uri) {
      opts = uri;
      uri = undefined;
    }
    opts = opts || {};

    opts.path = opts.path || "/socket.io";
    this.opts = opts;
    this.reconnection(opts.reconnection !== false);
    this.reconnectionAttempts(opts.reconnectionAttempts || Infinity);
    this.reconnectionDelay(opts.reconnectionDelay || 1000);
    this.reconnectionDelayMax(opts.reconnectionDelayMax || 5000);
    this.randomizationFactor(opts.randomizationFactor || 0.5);
    this.backoff = new Backoff({
      min: this.reconnectionDelay(),
      max: this.reconnectionDelayMax(),
      jitter: this.randomizationFactor(),
    });
    this.timeout(null == opts.timeout ? 20000 : opts.timeout);
    this._readyState = "closed";
    this.uri = uri;
    const _parser = opts.parser || parser;
    this.encoder = new _parser.Encoder();
    this.decoder = new _parser.Decoder();
    this._autoConnect = opts.autoConnect !== false;
    if (this._autoConnect) this.open();
  }

  /**
   * Sets the `reconnection` config.
   *
   * @param {Boolean} v - true/false if it should automatically reconnect
   * @return {Manager} self or value
   * @public
   */
  public reconnection(v: boolean): Manager;
  public reconnection(): boolean;
  public reconnection(v?: boolean): Manager | boolean {
    if (!arguments.length) return this._reconnection;
    this._reconnection = !!v;
    return this;
  }

  /**
   * Sets the reconnection attempts config.
   *
   * @param {Number} v - max reconnection attempts before giving up
   * @return {Manager} self or value
   * @public
   */
  public reconnectionAttempts(v: number): Manager;
  public reconnectionAttempts(): number;
  public reconnectionAttempts(v?: number): Manager | number {
    if (v === undefined) return this._reconnectionAttempts;
    this._reconnectionAttempts = v;
    return this;
  }

  /**
   * Sets the delay between reconnections.
   *
   * @param {Number} v - delay
   * @return {Manager} self or value
   * @public
   */
  public reconnectionDelay(v: number): Manager;
  public reconnectionDelay(): number;
  public reconnectionDelay(v?: number): Manager | number {
    if (v === undefined) return this._reconnectionDelay;
    this._reconnectionDelay = v;
    this.backoff && this.backoff.setMin(v);
    return this;
  }

  /**
   * Sets the randomization factor
   *
   * @param {Number} v - the randomization factor
   * @return {Manager} self or value
   * @public
   */
  public randomizationFactor(v: number): Manager;
  public randomizationFactor(): number;
  public randomizationFactor(v?: number): Manager | number {
    if (v === undefined) return this._randomizationFactor;
    this._randomizationFactor = v;
    this.backoff && this.backoff.setJitter(v);
    return this;
  }

  /**
   * Sets the maximum delay between reconnections.
   *
   * @param {Number} v - delay
   * @return {Manager} self or value
   * @public
   */
  public reconnectionDelayMax(v: number): Manager;
  public reconnectionDelayMax(): number;
  public reconnectionDelayMax(v?: number): Manager | number {
    if (v === undefined) return this._reconnectionDelayMax;
    this._reconnectionDelayMax = v;
    this.backoff && this.backoff.setMax(v);
    return this;
  }

  /**
   * Sets the connection timeout. `false` to disable
   *
   * @return {Manager} self or value
   * @public
   */
  public timeout(v: number | boolean): Manager;
  public timeout(): number | boolean;
  public timeout(v?: number | boolean): Manager | number | boolean {
    if (!arguments.length) return this._timeout;
    this._timeout = v;
    return this;
  }

  /**
   * Starts trying to reconnect if reconnection is enabled and we have not
   * started _reconnecting yet
   *
   * @private
   */
  private maybeReconnectOnOpen() {
    // Only try to reconnect if it's the first time we're connecting
    if (
      !this._reconnecting &&
      this._reconnection &&
      this.backoff.attempts === 0
    ) {
      // keeps reconnection from firing twice for the same reconnection loop
      this.reconnect();
    }
  }

  /**
   * Sets the current transport `socket`.
   *
   * @param {Function} fn - optional, callback
   * @return {Manager} self
   * @public
   */
  public open(fn?: (err?: Error) => void): Manager {
    debug("readyState %s", this._readyState);
    if (~this._readyState.indexOf("open")) return this;

    debug("opening %s", this.uri);
    this.engine = eio(this.uri, this.opts);
    const socket = this.engine;
    const self = this;
    this._readyState = "opening";
    this.skipReconnect = false;

    // emit `open`
    const openSub = on(socket, "open", function () {
      self.onopen();
      fn && fn();
    });

    // emit `connect_error`
    const errorSub = on(socket, "error", (err) => {
      debug("connect_error");
      self.cleanup();
      self._readyState = "closed";
      super.emit("connect_error", err);
      if (fn) {
        fn(err);
      } else {
        // Only do this if there is no fn to handle the error
        self.maybeReconnectOnOpen();
      }
    });

    // emit `connect_timeout`
    if (false !== this._timeout) {
      const timeout = this._timeout;
      debug("connect attempt will timeout after %d", timeout);

      if (timeout === 0) {
        openSub.destroy(); // prevents a race condition with the 'open' event
      }

      // set timer
      const timer = setTimeout(() => {
        debug("connect attempt timed out after %d", timeout);
        openSub.destroy();
        socket.close();
        socket.emit("error", "timeout");
        super.emit("connect_error", new Error("timeout"));
      }, timeout);

      this.subs.push({
        destroy: function () {
          clearTimeout(timer);
        },
      });
    }

    this.subs.push(openSub);
    this.subs.push(errorSub);

    return this;
  }

  /**
   * Alias for open()
   *
   * @return {Manager} self
   * @public
   */
  public connect(fn?: (err?: Error) => void): Manager {
    return this.open(fn);
  }

  /**
   * Called upon transport open.
   *
   * @private
   */
  private onopen() {
    debug("open");

    // clear old subs
    this.cleanup();

    // mark as open
    this._readyState = "open";
    super.emit("open");

    // add new subs
    const socket = this.engine;
    this.subs.push(on(socket, "data", bind(this, "ondata")));
    this.subs.push(on(socket, "ping", bind(this, "onping")));
    this.subs.push(on(socket, "error", bind(this, "onerror")));
    this.subs.push(on(socket, "close", bind(this, "onclose")));
    this.subs.push(on(this.decoder, "decoded", bind(this, "ondecoded")));
  }

  /**
   * Called upon a ping.
   *
   * @private
   */
  private onping() {
    super.emit("ping");
  }

  /**
   * Called with data.
   *
   * @private
   */
  private ondata(data) {
    this.decoder.add(data);
  }

  /**
   * Called when parser fully decodes a packet.
   *
   * @private
   */
  private ondecoded(packet) {
    super.emit("packet", packet);
  }

  /**
   * Called upon socket error.
   *
   * @private
   */
  private onerror(err) {
    debug("error", err);
    super.emit("error", err);
  }

  /**
   * Creates a new socket for the given `nsp`.
   *
   * @return {Socket}
   * @public
   */
  public socket(nsp: string, opts?: SocketOptions): Socket {
    let socket = this.nsps[nsp];
    if (!socket) {
      socket = new Socket(this, nsp, opts);
      this.nsps[nsp] = socket;
      var self = this;
      socket.on("connecting", onConnecting);

      if (this._autoConnect) {
        // manually call here since connecting event is fired before listening
        onConnecting();
      }
    }

    function onConnecting() {
      if (!~indexOf(self.connecting, socket)) {
        self.connecting.push(socket);
      }
    }

    return socket;
  }

  /**
   * Called upon a socket close.
   *
   * @param {Socket} socket
   * @package
   */
  _destroy(socket) {
    const index = indexOf(this.connecting, socket);
    if (~index) this.connecting.splice(index, 1);
    if (this.connecting.length) return;

    this._close();
  }

  /**
   * Writes a packet.
   *
   * @param {Object} packet
   * @package
   */
  _packet(packet) {
    debug("writing packet %j", packet);
    if (packet.query && packet.type === 0) packet.nsp += "?" + packet.query;

    const encodedPackets = this.encoder.encode(packet);
    for (let i = 0; i < encodedPackets.length; i++) {
      this.engine.write(encodedPackets[i], packet.options);
    }
  }

  /**
   * Clean up transport subscriptions and packet buffer.
   *
   * @private
   */
  private cleanup() {
    debug("cleanup");

    const subsLength = this.subs.length;
    for (let i = 0; i < subsLength; i++) {
      const sub = this.subs.shift();
      sub.destroy();
    }

    this.decoder.destroy();
  }

  /**
   * Close the current socket.
   *
   * @package
   */
  _close() {
    debug("disconnect");
    this.skipReconnect = true;
    this._reconnecting = false;
    if ("opening" === this._readyState) {
      // `onclose` will not fire because
      // an open event never happened
      this.cleanup();
    }
    this.backoff.reset();
    this._readyState = "closed";
    if (this.engine) this.engine.close();
  }

  /**
   * Alias for close()
   *
   * @private
   */
  private disconnect() {
    return this._close();
  }

  /**
   * Called upon engine close.
   *
   * @private
   */
  private onclose(reason) {
    debug("onclose");

    this.cleanup();
    this.backoff.reset();
    this._readyState = "closed";
    super.emit("close", reason);

    if (this._reconnection && !this.skipReconnect) {
      this.reconnect();
    }
  }

  /**
   * Attempt a reconnection.
   *
   * @private
   */
  private reconnect() {
    if (this._reconnecting || this.skipReconnect) return this;

    const self = this;

    if (this.backoff.attempts >= this._reconnectionAttempts) {
      debug("reconnect failed");
      this.backoff.reset();
      super.emit("reconnect_failed");
      this._reconnecting = false;
    } else {
      const delay = this.backoff.duration();
      debug("will wait %dms before reconnect attempt", delay);

      this._reconnecting = true;
      const timer = setTimeout(() => {
        if (self.skipReconnect) return;

        debug("attempting reconnect");
        super.emit("reconnect_attempt", self.backoff.attempts);
        super.emit("reconnecting", self.backoff.attempts);

        // check again for the case socket closed in above events
        if (self.skipReconnect) return;

        self.open((err) => {
          if (err) {
            debug("reconnect attempt error");
            self._reconnecting = false;
            self.reconnect();
            super.emit("reconnect_error", err);
          } else {
            debug("reconnect success");
            self.onreconnect();
          }
        });
      }, delay);

      this.subs.push({
        destroy: function () {
          clearTimeout(timer);
        },
      });
    }
  }

  /**
   * Called upon successful reconnect.
   *
   * @private
   */
  private onreconnect() {
    const attempt = this.backoff.attempts;
    this._reconnecting = false;
    this.backoff.reset();
    super.emit("reconnect", attempt);
  }
}
