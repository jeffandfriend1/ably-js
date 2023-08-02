import * as Utils from '../util/utils';
import Logger, { LoggerOptions } from '../util/logger';
import Defaults from '../util/defaults';
import Auth from './auth';
import Push from './push';
import PaginatedResource, { HttpPaginatedResponse, PaginatedResult } from './paginatedresource';
import Channel from './channel';
import ErrorInfo from '../types/errorinfo';
import Stats from '../types/stats';
import HttpMethods from '../../constants/HttpMethods';
import { ChannelOptions } from '../../types/channel';
import { PaginatedResultCallback, StandardCallback } from '../../types/utils';
import { ErrnoException, IHttp, RequestParams } from '../../types/http';
import ClientOptions, { NormalisedClientOptions } from '../../types/ClientOptions';

import Platform from '../../platform';
import Message from '../types/message';
import PresenceMessage from '../types/presencemessage';
import { ModulesMap } from './modulesmap';

const noop = function () {};

/**
 `BaseClient` acts as the base class for all of the client classes exported by the SDK. It is an implementation detail and this class is not advertised publicly.
 */
class BaseClient {
  options: NormalisedClientOptions;
  _currentFallback: null | {
    host: string;
    validUntil: number;
  };
  serverTimeOffset: number | null;
  http: IHttp;
  auth: Auth;
  channels: Channels;
  push: Push;

  constructor(
    options: ClientOptions | string,
    // eslint-disable-next-line no-unused-vars, @typescript-eslint/no-unused-vars
    modules: ModulesMap
  ) {
    if (!options) {
      const msg = 'no options provided';
      Logger.logAction(Logger.LOG_ERROR, 'BaseClient()', msg);
      throw new Error(msg);
    }
    const optionsObj = Defaults.objectifyOptions(options);

    Logger.setLog(optionsObj.logLevel, optionsObj.logHandler);
    Logger.logAction(
      Logger.LOG_MICRO,
      'BaseClient()',
      'initialized with clientOptions ' + Platform.Config.inspect(options)
    );

    const normalOptions = (this.options = Defaults.normaliseOptions(optionsObj));

    /* process options */
    if (normalOptions.key) {
      const keyMatch = normalOptions.key.match(/^([^:\s]+):([^:.\s]+)$/);
      if (!keyMatch) {
        const msg = 'invalid key parameter';
        Logger.logAction(Logger.LOG_ERROR, 'BaseClient()', msg);
        throw new ErrorInfo(msg, 40400, 404);
      }
      normalOptions.keyName = keyMatch[1];
      normalOptions.keySecret = keyMatch[2];
    }

    if ('clientId' in normalOptions) {
      if (!(typeof normalOptions.clientId === 'string' || normalOptions.clientId === null))
        throw new ErrorInfo('clientId must be either a string or null', 40012, 400);
      else if (normalOptions.clientId === '*')
        throw new ErrorInfo(
          'Can’t use "*" as a clientId as that string is reserved. (To change the default token request behaviour to use a wildcard clientId, use {defaultTokenParams: {clientId: "*"}})',
          40012,
          400
        );
    }

    Logger.logAction(Logger.LOG_MINOR, 'BaseClient()', 'started; version = ' + Defaults.version);

    this._currentFallback = null;

    this.serverTimeOffset = null;
    this.http = new Platform.Http(normalOptions);
    this.auth = new Auth(this, normalOptions);
    this.channels = new Channels(this);
    this.push = new Push(this);
  }

  baseUri(host: string) {
    return Defaults.getHttpScheme(this.options) + host + ':' + Defaults.getPort(this.options, false);
  }

  stats(
    params: RequestParams,
    callback: StandardCallback<PaginatedResult<Stats>>
  ): Promise<PaginatedResult<Stats>> | void {
    /* params and callback are optional; see if params contains the callback */
    if (callback === undefined) {
      if (typeof params == 'function') {
        callback = params;
        params = null;
      } else {
        return Utils.promisify(this, 'stats', [params]) as Promise<PaginatedResult<Stats>>;
      }
    }
    const headers = Utils.defaultGetHeaders(this.options),
      format = this.options.useBinaryProtocol ? Utils.Format.msgpack : Utils.Format.json,
      envelope = this.http.supportsLinkHeaders ? undefined : format;

    Utils.mixin(headers, this.options.headers);

    new PaginatedResource(this, '/stats', headers, envelope, function (
      body: unknown,
      headers: Record<string, string>,
      unpacked?: boolean
    ) {
      const statsValues = unpacked ? body : JSON.parse(body as string);
      for (let i = 0; i < statsValues.length; i++) statsValues[i] = Stats.fromValues(statsValues[i]);
      return statsValues;
    }).get(params as Record<string, string>, callback);
  }

  time(params?: RequestParams | StandardCallback<number>, callback?: StandardCallback<number>): Promise<number> | void {
    /* params and callback are optional; see if params contains the callback */
    if (callback === undefined) {
      if (typeof params == 'function') {
        callback = params;
        params = null;
      } else {
        return Utils.promisify(this, 'time', [params]) as Promise<number>;
      }
    }

    const _callback = callback || noop;

    const headers = Utils.defaultGetHeaders(this.options);
    if (this.options.headers) Utils.mixin(headers, this.options.headers);
    const timeUri = (host: string) => {
      return this.baseUri(host) + '/time';
    };
    this.http.do(
      HttpMethods.Get,
      this,
      timeUri,
      headers,
      null,
      params as RequestParams,
      (
        err?: ErrorInfo | ErrnoException | null,
        res?: unknown,
        headers?: Record<string, string>,
        unpacked?: boolean
      ) => {
        if (err) {
          _callback(err);
          return;
        }
        if (!unpacked) res = JSON.parse(res as string);
        const time = (res as number[])[0];
        if (!time) {
          _callback(new ErrorInfo('Internal error (unexpected result type from GET /time)', 50000, 500));
          return;
        }
        /* calculate time offset only once for this device by adding to the prototype */
        this.serverTimeOffset = time - Utils.now();
        _callback(null, time);
      }
    );
  }

  request(
    method: string,
    path: string,
    version: number,
    params: RequestParams,
    body: unknown,
    customHeaders: Record<string, string>,
    callback: StandardCallback<HttpPaginatedResponse<unknown>>
  ): Promise<HttpPaginatedResponse<unknown>> | void {
    const useBinary = this.options.useBinaryProtocol,
      encoder = useBinary ? Platform.Config.msgpack.encode : JSON.stringify,
      decoder = useBinary ? Platform.Config.msgpack.decode : JSON.parse,
      format = useBinary ? Utils.Format.msgpack : Utils.Format.json,
      envelope = this.http.supportsLinkHeaders ? undefined : format;
    params = params || {};
    const _method = method.toLowerCase() as HttpMethods;
    const headers =
      _method == 'get'
        ? Utils.defaultGetHeaders(this.options, { format, protocolVersion: version })
        : Utils.defaultPostHeaders(this.options, { format, protocolVersion: version });

    if (callback === undefined) {
      return Utils.promisify(this, 'request', [method, path, version, params, body, customHeaders]) as Promise<
        HttpPaginatedResponse<unknown>
      >;
    }

    if (typeof body !== 'string') {
      body = encoder(body);
    }
    Utils.mixin(headers, this.options.headers);
    if (customHeaders) {
      Utils.mixin(headers, customHeaders);
    }
    const paginatedResource = new PaginatedResource(
      this,
      path,
      headers,
      envelope,
      async function (resbody: unknown, headers: Record<string, string>, unpacked?: boolean) {
        return Utils.ensureArray(unpacked ? resbody : decoder(resbody as string & Buffer));
      },
      /* useHttpPaginatedResponse: */ true
    );

    if (!Utils.arrIn(Platform.Http.methods, _method)) {
      throw new ErrorInfo('Unsupported method ' + _method, 40500, 405);
    }

    if (Utils.arrIn(Platform.Http.methodsWithBody, _method)) {
      paginatedResource[_method as HttpMethods.Post](params, body, callback as PaginatedResultCallback<unknown>);
    } else {
      paginatedResource[_method as HttpMethods.Get | HttpMethods.Delete](
        params,
        callback as PaginatedResultCallback<unknown>
      );
    }
  }

  setLog(logOptions: LoggerOptions): void {
    Logger.setLog(logOptions.level, logOptions.handler);
  }

  static Platform = Platform;
  static Crypto?: typeof Platform.Crypto;
  static Message = Message;
  static PresenceMessage = PresenceMessage;
}

class Channels {
  client: BaseClient;
  all: Record<string, Channel>;

  constructor(client: BaseClient) {
    this.client = client;
    this.all = Object.create(null);
  }

  get(name: string, channelOptions?: ChannelOptions) {
    name = String(name);
    let channel = this.all[name];
    if (!channel) {
      this.all[name] = channel = new Channel(this.client, name, channelOptions);
    } else if (channelOptions) {
      channel.setOptions(channelOptions);
    }

    return channel;
  }

  /* Included to support certain niche use-cases; most users should ignore this.
   * Please do not use this unless you know what you're doing */
  release(name: string) {
    delete this.all[String(name)];
  }
}

export default BaseClient;
