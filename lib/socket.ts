import { Packet, PacketType } from "socket.io-parser";
import * as Emitter from "component-emitter";
import { on } from "./on";
import * as bind from "component-bind";
import * as hasBin from "has-binary2";
import { Manager } from "./manager";

const debug = require("debug")("socket.io-client:socket");

export interface SocketOptions {
  /**
   * the authentication payload sent when connecting to the Namespace
   */
  auth: object | ((cb: (data: object) => void) => void);
}

/**
 * Internal events.
 * These events can't be emitted by the user.
 *
 * @api private
 */

const RESERVED_EVENTS = {
  connect: 1,
  disconnect: 1,
  disconnecting: 1,
  error: 1,
  // EventEmitter reserved events: https://nodejs.org/api/events.html#events_event_newlistener
  newListener: 1,
  removeListener: 1,
};

export class Socket extends Emitter {
  public readonly io: Manager;

  public id: string;
  public connected: boolean;
  public disconnected: boolean;

  private readonly nsp: string;
  private readonly auth: object | ((cb: (data: object) => void) => void);

  private ids: number = 0;
  private acks: object = {};
  private receiveBuffer: Array<any> = [];
  private sendBuffer: Array<any> = [];
  private flags: any = {};
  private subs: Array<any>;

  /**
   * `Socket` constructor.
   *
   * @api public
   */
  constructor(io: Manager, nsp: string, opts?: Partial<SocketOptions>) {
    super();
    this.io = io;
    this.nsp = nsp;
    this.ids = 0;
    this.acks = {};
    this.receiveBuffer = [];
    this.sendBuffer = [];
    this.connected = false;
    this.disconnected = true;
    this.flags = {};
    if (opts && opts.auth) {
      this.auth = opts.auth;
    }
    if (this.io._autoConnect) this.open();
  }

  /**
   * Subscribe to open, close and packet events
   *
   * @private
   */
  private subEvents() {
    if (this.subs) return;

    const io = this.io;
    this.subs = [
      on(io, "open", bind(this, "onopen")),
      on(io, "packet", bind(this, "onpacket")),
      on(io, "close", bind(this, "onclose")),
    ];
  }

  /**
   * "Opens" the socket.
   *
   * @public
   */
  public connect(): Socket {
    if (this.connected) return this;

    this.subEvents();
    if (!this.io._reconnecting) this.io.open(); // ensure open
    if ("open" === this.io._readyState) this.onopen();
    return this;
  }

  /**
   * Alias for connect()
   */
  public open(): Socket {
    return this.connect();
  }

  /**
   * Sends a `message` event.
   *
   * @return {Socket} self
   * @public
   */
  public send(...args: any[]) {
    args.unshift("message");
    this.emit.apply(this, args);
    return this;
  }

  /**
   * Override `emit`.
   * If the event is in `events`, it's emitted normally.
   *
   * @param {String} ev - event name
   * @return {Socket} self
   * @public
   */
  public emit(ev: string, ...args: any[]) {
    if (RESERVED_EVENTS.hasOwnProperty(ev)) {
      throw new Error('"' + ev + '" is a reserved event name');
    }

    args.unshift(ev);
    const packet: any = {
      type: (this.flags.binary !== undefined ? this.flags.binary : hasBin(args))
        ? PacketType.BINARY_EVENT
        : PacketType.EVENT,
      data: args,
    };

    packet.options = {};
    packet.options.compress = !this.flags || false !== this.flags.compress;

    // event ack callback
    if ("function" === typeof args[args.length - 1]) {
      debug("emitting packet with ack id %d", this.ids);
      this.acks[this.ids] = args.pop();
      packet.id = this.ids++;
    }

    if (this.connected) {
      this.packet(packet);
    } else {
      this.sendBuffer.push(packet);
    }

    this.flags = {};

    return this;
  }

  /**
   * Sends a packet.
   *
   * @param {Object} packet
   * @private
   */
  private packet(packet: Partial<Packet>) {
    packet.nsp = this.nsp;
    this.io._packet(packet);
  }

  /**
   * Called upon engine `open`.
   *
   * @private
   */
  private onopen() {
    debug("transport is open - connecting");
    if (typeof this.auth == "function") {
      this.auth((data) => {
        this.packet({ type: PacketType.CONNECT, data });
      });
    } else {
      this.packet({ type: PacketType.CONNECT, data: this.auth });
    }
  }

  /**
   * Called upon engine `close`.
   *
   * @param {String} reason
   * @private
   */
  private onclose(reason) {
    debug("close (%s)", reason);
    this.connected = false;
    this.disconnected = true;
    delete this.id;
    super.emit("disconnect", reason);
  }

  /**
   * Called with socket packet.
   *
   * @param {Object} packet
   * @private
   */
  private onpacket(packet) {
    const sameNamespace = packet.nsp === this.nsp;
    const rootNamespaceError =
      packet.type === PacketType.ERROR && packet.nsp === "/";

    if (!sameNamespace && !rootNamespaceError) return;

    switch (packet.type) {
      case PacketType.CONNECT:
        const id = packet.data.sid;
        this.onconnect(id);
        break;

      case PacketType.EVENT:
        this.onevent(packet);
        break;

      case PacketType.BINARY_EVENT:
        this.onevent(packet);
        break;

      case PacketType.ACK:
        this.onack(packet);
        break;

      case PacketType.BINARY_ACK:
        this.onack(packet);
        break;

      case PacketType.DISCONNECT:
        this.ondisconnect();
        break;

      case PacketType.ERROR:
        super.emit("error", packet.data);
        break;
    }
  }

  /**
   * Called upon a server event.
   *
   * @param {Object} packet
   * @private
   */
  private onevent(packet) {
    const args = packet.data || [];
    debug("emitting event %j", args);

    if (null != packet.id) {
      debug("attaching ack callback to event");
      args.push(this.ack(packet.id));
    }

    if (this.connected) {
      super.emit.apply(this, args);
    } else {
      this.receiveBuffer.push(args);
    }
  }

  /**
   * Produces an ack callback to emit with an event.
   *
   * @private
   */
  private ack(id) {
    const self = this;
    let sent = false;
    return function (...args: any[]) {
      // prevent double callbacks
      if (sent) return;
      sent = true;
      debug("sending ack %j", args);

      self.packet({
        type: hasBin(args) ? PacketType.BINARY_ACK : PacketType.ACK,
        id: id,
        data: args,
      });
    };
  }

  /**
   * Called upon a server acknowlegement.
   *
   * @param {Object} packet
   * @private
   */
  private onack(packet) {
    const ack = this.acks[packet.id];
    if ("function" === typeof ack) {
      debug("calling ack %s with %j", packet.id, packet.data);
      ack.apply(this, packet.data);
      delete this.acks[packet.id];
    } else {
      debug("bad ack %s", packet.id);
    }
  }

  /**
   * Called upon server connect.
   *
   * @private
   */
  private onconnect(id: string) {
    this.id = id;
    this.connected = true;
    this.disconnected = false;
    super.emit("connect");
    this.emitBuffered();
  }

  /**
   * Emit buffered events (received and emitted).
   *
   * @private
   */
  private emitBuffered() {
    for (let i = 0; i < this.receiveBuffer.length; i++) {
      super.emit.apply(this, this.receiveBuffer[i]);
    }
    this.receiveBuffer = [];

    for (let i = 0; i < this.sendBuffer.length; i++) {
      this.packet(this.sendBuffer[i]);
    }
    this.sendBuffer = [];
  }

  /**
   * Called upon server disconnect.
   *
   * @private
   */
  private ondisconnect() {
    debug("server disconnect (%s)", this.nsp);
    this.destroy();
    this.onclose("io server disconnect");
  }

  /**
   * Called upon forced client/server side disconnections,
   * this method ensures the manager stops tracking us and
   * that reconnections don't get triggered for this.
   *
   * @private
   */
  private destroy() {
    if (this.subs) {
      // clean subscriptions to avoid reconnections
      for (let i = 0; i < this.subs.length; i++) {
        this.subs[i].destroy();
      }
      this.subs = null;
    }

    this.io._destroy(this);
  }

  /**
   * Disconnects the socket manually.
   *
   * @return {Socket} self
   * @public
   */
  public disconnect(): Socket {
    if (this.connected) {
      debug("performing disconnect (%s)", this.nsp);
      this.packet({ type: PacketType.DISCONNECT });
    }

    // remove socket from pool
    this.destroy();

    if (this.connected) {
      // fire events
      this.onclose("io client disconnect");
    }
    return this;
  }

  /**
   * Alias for disconnect()
   *
   * @return {Socket} self
   * @public
   */
  public close(): Socket {
    return this.disconnect();
  }

  /**
   * Sets the compress flag.
   *
   * @param {Boolean} compress - if `true`, compresses the sending data
   * @return {Socket} self
   * @public
   */
  public compress(compress: boolean) {
    this.flags.compress = compress;
    return this;
  }

  /**
   * Sets the binary flag
   *
   * @param {Boolean} binary - whether the emitted data contains binary
   * @return {Socket} self
   * @public
   */
  public binary(binary: boolean): Socket {
    this.flags.binary = binary;
    return this;
  }
}
