'use strict';

Object.defineProperty(exports, "__esModule", {
  value: true
});

var _fs;

function _load_fs() {
  return _fs = _interopRequireDefault(require('fs'));
}

var _http;

function _load_http() {
  return _http = _interopRequireDefault(require('http'));
}

var _url;

function _load_url() {
  return _url = _interopRequireDefault(require('url'));
}

var _dnscache;

function _load_dnscache() {
  return _dnscache = _interopRequireDefault(require('dnscache'));
}

var _invariant;

function _load_invariant() {
  return _invariant = _interopRequireDefault(require('invariant'));
}

var _requestCaptureHar;

function _load_requestCaptureHar() {
  return _requestCaptureHar = _interopRequireDefault(require('request-capture-har'));
}

var _errors;

function _load_errors() {
  return _errors = require('../errors.js');
}

var _blockingQueue;

function _load_blockingQueue() {
  return _blockingQueue = _interopRequireDefault(require('./blocking-queue.js'));
}

var _constants;

function _load_constants() {
  return _constants = _interopRequireWildcard(require('../constants.js'));
}

var _network;

function _load_network() {
  return _network = _interopRequireWildcard(require('./network.js'));
}

var _map;

function _load_map() {
  return _map = _interopRequireDefault(require('../util/map.js'));
}

function _interopRequireWildcard(obj) { if (obj && obj.__esModule) { return obj; } else { var newObj = {}; if (obj != null) { for (var key in obj) { if (Object.prototype.hasOwnProperty.call(obj, key)) newObj[key] = obj[key]; } } newObj.default = obj; return newObj; } }

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }

// Initialize DNS cache so we don't look up the same
// domains like registry.yarnpkg.com over and over again
// for each request.
(0, (_dnscache || _load_dnscache()).default)({
  enable: true,
  ttl: 300,
  cachesize: 10
});

const successHosts = (0, (_map || _load_map()).default)();
const controlOffline = (_network || _load_network()).isOffline();

class RequestManager {
  constructor(reporter) {
    this.offlineNoRequests = false;
    this._requestCaptureHar = null;
    this._requestModule = null;
    this.offlineQueue = [];
    this.captureHar = false;
    this.httpsProxy = '';
    this.ca = null;
    this.httpProxy = '';
    this.strictSSL = true;
    this.userAgent = '';
    this.reporter = reporter;
    this.running = 0;
    this.queue = [];
    this.cache = {};
    this.max = (_constants || _load_constants()).NETWORK_CONCURRENCY;
    this.maxRetryAttempts = 5;
  }

  setOptions(opts) {
    if (opts.userAgent != null) {
      this.userAgent = opts.userAgent;
    }

    if (opts.offline != null) {
      this.offlineNoRequests = opts.offline;
    }

    if (opts.captureHar != null) {
      this.captureHar = opts.captureHar;
    }

    if (opts.httpProxy != null) {
      this.httpProxy = opts.httpProxy || '';
    }

    if (opts.httpsProxy === '') {
      this.httpsProxy = opts.httpProxy || '';
    } else if (opts.httpsProxy === false) {
      this.httpsProxy = false;
    } else {
      this.httpsProxy = opts.httpsProxy || '';
    }

    if (opts.strictSSL !== null && typeof opts.strictSSL !== 'undefined') {
      this.strictSSL = opts.strictSSL;
    }

    if (opts.ca != null && opts.ca.length > 0) {
      this.ca = opts.ca;
    }

    if (opts.networkConcurrency != null) {
      this.max = opts.networkConcurrency;
    }

    if (opts.networkTimeout != null) {
      this.timeout = opts.networkTimeout;
    }

    if (opts.maxRetryAttempts != null) {
      this.maxRetryAttempts = opts.maxRetryAttempts;
    }

    if (opts.cafile != null && opts.cafile != '') {
      // The CA bundle file can contain one or more certificates with comments/text between each PEM block.
      // tls.connect wants an array of certificates without any comments/text, so we need to split the string
      // and strip out any text in between the certificates
      try {
        const bundle = (_fs || _load_fs()).default.readFileSync(opts.cafile).toString();
        const hasPemPrefix = block => block.startsWith('-----BEGIN ');
        // opts.cafile overrides opts.ca, this matches with npm behavior
        this.ca = bundle.split(/(-----BEGIN .*\r?\n[^-]+\r?\n--.*)/).filter(hasPemPrefix);
      } catch (err) {
        this.reporter.error(`Could not open cafile: ${err.message}`);
      }
    }

    if (opts.cert != null) {
      this.cert = opts.cert;
    }

    if (opts.key != null) {
      this.key = opts.key;
    }
  }

  /**
   * Lazy load `request` since it is exceptionally expensive to load and is
   * often not needed at all.
   */

  _getRequestModule() {
    if (!this._requestModule) {
      const request = require('request');
      if (this.captureHar) {
        this._requestCaptureHar = new (_requestCaptureHar || _load_requestCaptureHar()).default(request);
        this._requestModule = this._requestCaptureHar.request.bind(this._requestCaptureHar);
      } else {
        this._requestModule = request;
      }
    }
    return this._requestModule;
  }

  /**
   * Queue up a request.
   */

  request(params) {
    if (this.offlineNoRequests) {
      return Promise.reject(new (_errors || _load_errors()).MessageError(this.reporter.lang('cantRequestOffline', params.url)));
    }

    const cached = this.cache[params.url];
    if (cached) {
      return cached;
    }

    params.method = params.method || 'GET';
    params.forever = true;
    params.retryAttempts = 0;
    params.strictSSL = this.strictSSL;
    params.headers = Object.assign({
      'User-Agent': this.userAgent
    }, params.headers);

    const promise = new Promise((resolve, reject) => {
      this.queue.push({ params, reject, resolve });
      this.shiftQueue();
    });

    // we can't cache a request with a processor
    if (!params.process) {
      this.cache[params.url] = promise;
    }

    return promise;
  }

  /**
   * Clear the request cache. This is important as we cache all HTTP requests so you'll
   * want to do this as soon as you can.
   */

  clearCache() {
    this.cache = {};
    if (this._requestCaptureHar != null) {
      this._requestCaptureHar.clear();
    }
  }

  /**
   * Check if an error is possibly due to lost or poor network connectivity.
   */

  isPossibleOfflineError(err) {
    const code = err.code,
          hostname = err.hostname;

    if (!code) {
      return false;
    }

    // network was previously online but now we're offline
    const possibleOfflineChange = !controlOffline && !(_network || _load_network()).isOffline();
    if (code === 'ENOTFOUND' && possibleOfflineChange) {
      // can't resolve a domain
      return true;
    }

    // used to be able to resolve this domain! something is wrong
    if (code === 'ENOTFOUND' && hostname && successHosts[hostname]) {
      // can't resolve this domain but we've successfully resolved it before
      return true;
    }

    // network was previously offline and we can't resolve the domain
    if (code === 'ENOTFOUND' && controlOffline) {
      return true;
    }

    // connection was reset or dropped
    if (code === 'ECONNRESET') {
      return true;
    }

    // TCP timeout
    if (code === 'ESOCKETTIMEDOUT' || code === 'ETIMEDOUT') {
      return true;
    }

    return false;
  }

  /**
   * Queue up request arguments to be retried. Start a network connectivity timer if there
   * isn't already one.
   */

  queueForRetry(opts) {
    if (opts.retryReason) {
      let containsReason = false;

      for (var _iterator = this.offlineQueue, _isArray = Array.isArray(_iterator), _i = 0, _iterator = _isArray ? _iterator : _iterator[Symbol.iterator]();;) {
        var _ref;

        if (_isArray) {
          if (_i >= _iterator.length) break;
          _ref = _iterator[_i++];
        } else {
          _i = _iterator.next();
          if (_i.done) break;
          _ref = _i.value;
        }

        const queuedOpts = _ref;

        if (queuedOpts.retryReason === opts.retryReason) {
          containsReason = true;
          break;
        }
      }

      if (!containsReason) {
        this.reporter.info(opts.retryReason);
      }
    }

    if (!this.offlineQueue.length) {
      this.initOfflineRetry();
    }

    this.offlineQueue.push(opts);
  }

  /**
   * Begin timers to retry failed requests when we possibly establish network connectivity
   * again.
   */

  initOfflineRetry() {
    setTimeout(() => {
      const queue = this.offlineQueue;
      this.offlineQueue = [];
      for (var _iterator2 = queue, _isArray2 = Array.isArray(_iterator2), _i2 = 0, _iterator2 = _isArray2 ? _iterator2 : _iterator2[Symbol.iterator]();;) {
        var _ref2;

        if (_isArray2) {
          if (_i2 >= _iterator2.length) break;
          _ref2 = _iterator2[_i2++];
        } else {
          _i2 = _iterator2.next();
          if (_i2.done) break;
          _ref2 = _i2.value;
        }

        const opts = _ref2;

        this.execute(opts);
      }
    }, 3000);
  }

  /**
   * Execute a request.
   */

  execute(opts) {
    const params = opts.params;
    const reporter = this.reporter;


    const buildNext = fn => data => {
      fn(data);
      this.running--;
      this.shiftQueue();
    };

    const resolve = buildNext(opts.resolve);

    const rejectNext = buildNext(opts.reject);
    const reject = function reject(err) {
      err.message = `${params.url}: ${err.message}`;
      rejectNext(err);
    };

    const rejectWithoutUrl = function rejectWithoutUrl(err) {
      err.message = err.message;
      rejectNext(err);
    };

    const queueForRetry = reason => {
      const attempts = params.retryAttempts || 0;
      if (attempts >= this.maxRetryAttempts - 1) {
        return false;
      }
      if (opts.params.method && opts.params.method.toUpperCase() !== 'GET') {
        return false;
      }
      params.retryAttempts = attempts + 1;
      if (typeof params.cleanup === 'function') {
        params.cleanup();
      }
      opts.retryReason = reason;
      this.queueForRetry(opts);
      return true;
    };

    let calledOnError = false;
    const onError = err => {
      if (calledOnError) {
        return;
      }
      calledOnError = true;

      if (this.isPossibleOfflineError(err)) {
        if (!queueForRetry(this.reporter.lang('offlineRetrying'))) {
          reject(err);
        }
      } else {
        reject(err);
      }
    };

    if (!params.process) {
      const parts = (_url || _load_url()).default.parse(params.url);

      params.callback = (err, res, body) => {
        if (err) {
          onError(err);
          return;
        }

        successHosts[parts.hostname] = true;

        this.reporter.verbose(this.reporter.lang('verboseRequestFinish', params.url, res.statusCode));

        if (res.statusCode === 408 || res.statusCode >= 500) {
          const description = `${res.statusCode} ${(_http || _load_http()).default.STATUS_CODES[res.statusCode]}`;
          if (!queueForRetry(this.reporter.lang('internalServerErrorRetrying', description))) {
            throw new (_errors || _load_errors()).ResponseError(this.reporter.lang('requestFailed', description), res.statusCode);
          } else {
            return;
          }
        }

        if (res.statusCode === 401 && res.caseless && res.caseless.get('server') === 'GitHub.com') {
          const message = `${res.body.message}. If using GITHUB_TOKEN in your env, check that it is valid.`;
          rejectWithoutUrl(new Error(this.reporter.lang('unauthorizedResponse', res.caseless.get('server'), message)));
        }

        if (res.statusCode === 401 && res.headers['www-authenticate']) {
          const authMethods = res.headers['www-authenticate'].split(/,\s*/).map(s => s.toLowerCase());

          if (authMethods.indexOf('otp') !== -1) {
            reject(new (_errors || _load_errors()).OneTimePasswordError());
            return;
          }
        }

        if (body && typeof body.error === 'string') {
          reject(new Error(body.error));
          return;
        }

        if ([400, 401, 404].concat(params.rejectStatusCode || []).indexOf(res.statusCode) !== -1) {
          // So this is actually a rejection ... the hosted git resolver uses this to know whether http is supported
          resolve(false);
        } else if (res.statusCode >= 400) {
          const errMsg = body && body.message || reporter.lang('requestError', params.url, res.statusCode);
          reject(new Error(errMsg));
        } else {
          resolve(body);
        }
      };
    }

    if (params.buffer) {
      params.encoding = null;
    }

    let proxy = this.httpProxy;
    if (params.url.startsWith('https:')) {
      proxy = this.httpsProxy;
    }

    if (proxy) {
      // if no proxy is set, do not pass a proxy down to request.
      // the request library will internally check the HTTP_PROXY and HTTPS_PROXY env vars.
      params.proxy = String(proxy);
    } else if (proxy === false) {
      // passing empty string prevents the underlying library from falling back to the env vars.
      // an explicit false in the yarn config should override the env var. See #4546.
      params.proxy = '';
    }

    if (this.ca != null) {
      params.ca = this.ca;
    }

    if (this.cert != null) {
      params.cert = this.cert;
    }

    if (this.key != null) {
      params.key = this.key;
    }

    if (this.timeout != null) {
      params.timeout = this.timeout;
    }

    const request = this._getRequestModule();
    const req = request(params);
    this.reporter.verbose(this.reporter.lang('verboseRequestStart', params.method, params.url));

    req.on('error', onError);

    const queue = params.queue;
    if (queue) {
      req.on('data', queue.stillActive.bind(queue));
    }

    const process = params.process;
    if (process) {
      req.on('response', res => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          return;
        }

        const description = `${res.statusCode} ${(_http || _load_http()).default.STATUS_CODES[res.statusCode]}`;
        reject(new (_errors || _load_errors()).ResponseError(this.reporter.lang('requestFailed', description), res.statusCode));

        req.abort();
      });
      process(req, resolve, reject);
    }
  }

  /**
   * Remove an item from the queue. Create it's request options and execute it.
   */

  shiftQueue() {
    if (this.running >= this.max || !this.queue.length) {
      return;
    }

    const opts = this.queue.shift();

    this.running++;
    this.execute(opts);
  }

  saveHar(filename) {
    if (!this.captureHar) {
      throw new Error(this.reporter.lang('requestManagerNotSetupHAR'));
    }
    // No request may have occurred at all.
    this._getRequestModule();
    (0, (_invariant || _load_invariant()).default)(this._requestCaptureHar != null, 'request-capture-har not setup');
    this._requestCaptureHar.saveHar(filename);
  }
}
exports.default = RequestManager;