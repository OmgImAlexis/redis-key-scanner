#!/usr/bin/env node
const
  defaults = {
    debug: false,
    db: 0,
    pattern: '*',
    redisPort: 6379,
    sentinelPort: 26379,
    scanBatch: 1000,
    scanLimit: Infinity,
    limit: Infinity,
  };

const supportedOptions = [
  'host', 'port', 'redisMaster', 'db', 'scanBatch', 'scanLimit', 'limit',
  'maxIdle', 'maxTTL', 'minIdle', 'minTTL', 'noExpiry', 'pattern', 'debug',
];

const usage = [
  'Usage:',
  '  node redis-key-scanner <host>[:<port>] [<master_name>] [options]',
  '',
  '   Synopsis:',
  '    Scan a redis server for keys matching specified criteria, including',
  '    key patterns, TTL and IDLETIME.  Selected/matched keys are output in',
  '    a JSON log format.  The scan is non-destructive, and doesn\'t even',
  '    read any actual key values, so it won\'t affect IDLETIME either.',
  '',
  '   Options:',
  '    <host>              (Required) Hostname or IP of the redis server or',
  '                        sentinel to scan',
  '    <port>              Port number if non-standard.  Default redis port',
  `                        is ${defaults.redisPort}, and default sentinel`,
  `                        port is ${defaults.sentinelPort}.`,
  '    <master_name>       Inclusion of this argument inidicates the use of',
  '                        redis sentinel.  When <master_name> is specified,',
  '                        the <host> and <port> options are understood to',
  '                        refer to a sentinel as opposed to a regular redis',
  '                        server.  However, a connection will be attempted to',
  '                        the corresponding *slave*.',
  '',
  '    --scan-batch=N      Batch/count size to use with the redis SCAN',
  `                        operation.  Default is ${defaults.scanBatch}.`,
  '    --scan-limit=N      Limit total number of keys to scan.  Scanning will',
  '                        cease once scan-limit is reached, regardless of',
  '                        whether any matching keys have been selected.  By',
  '                        default there is no limit.',
  '    --limit=N           Limit total number of keys to select (output)',
  '    --debug             Debug mode',
  '',
  '   Select keys that:',
  '    --db=N              reside in logical db <N> (defaults to 0)',
  '    --max-idle=<T>      have been inactive for no more than <T>',
  '    --max-ttl=<T>       have a TTL of no more than <T>',
  '    --min-idle=<T>      have been inactive for at least <T>',
  '    --min-ttl=<T>       have a TTL of at least <T>',
  '    --no-expiry         have TTL of -1 (ie. no expiry)',
  `    --pattern=<p>       match key pattern (default: ${defaults.pattern})`,
  '',
  '   Timeframes <T> are of the form "<number><unit>" where unit may be any',
  "   of 's' (seconds), 'm' (minutes), 'h' (hours), 'd' (days), or 'w' weeks.",
].join('\n');

const _ = require('lodash');

const EventEmitter = require('events').EventEmitter;

const Redis = require('ioredis');

const timeframeToSeconds = require('timeframe-to-seconds');

const util = require('util');

// Fix for stdout truncation bug in Node 6.x
// (https://github.com/nodejs/node/issues/6456)
[process.stdout, process.stderr].forEach((s) => {
  s && s.isTTY && s._handle && s._handle.setBlocking
    && s._handle.setBlocking(true);
});

function RedisKeyScanner(options) {
  const self = this;

  function hasOption(opt) {
    return _.has(options, opt);
  }

  // Validate options
  if (!options.host) {
    throw new TypeError('Host is required');
  }
  options.port = Number(options.port);
  if (!options.port) {
    throw new TypeError('Port number is required');
  }
  options.pattern = options.pattern || defaults.pattern;
  _.each(['maxIdle', 'maxTTL', 'minIdle', 'minTTL'], (opt) => {
    if (hasOption(opt)) {
      options[opt] = timeframeToSeconds(options[opt]);
      if (isNaN(options[opt])) {
        throw new TypeError(`Expected ${opt} to be a timeframe.`);
      }
    }
  });
  _.each(['scanBatch', 'scanLimit', 'limit'], (opt) => {
    if (!hasOption(opt)) {
      options[opt] = defaults[opt];
    }
    if (isNaN(options[opt])) {
      throw new TypeError(`Must be a number: ${opt}`);
    }
  });
  const unsupportedOptions = _.keys(_.omit(options, supportedOptions));
  if (unsupportedOptions.length) {
    throw new TypeError(`Unsupported option(s): ${unsupportedOptions}`);
  }
  this.options = options;

  // Connect to redis server / sentinel
  const server = _.pick(options, ['host', 'port']);

  let redisDescription;
  if (options.redisMaster) {
    this.redisOptions = {
      sentinels: [server],
      name: options.redisMaster,
      role: 'master',
    };
    redisDescription = options.redisMaster;
  } else {
    this.redisOptions = server;
    redisDescription = _.values(server).join(':');
  }
  this.redisOptions.db = options.db || 0;
  if (this.options.debug) {
    console.log('options:', JSON.stringify(this.options));
    console.log('redisOptions:', JSON.stringify(this.redisOptions));
  }
  const redis = new Redis(this.redisOptions);
  if (this.options.debug) {
    console.log('Waiting to connect...');
    redis.on('connect', () => {
      console.log('Redis connected');
    });
    redis.on('ready', () => {
      console.log('Redis ready');
    });
  }
  redis.on('error', _.once((err) => {
    self.emit('error', err);
  }));

  // Initiate scan
  let atSelectLimit = false;

  const checkTTL = _.some(['noExpiry', 'maxTTL', 'minTTL'], hasOption);

  const pipelinePromises = [];

  const scanStream = redis.scanStream({
    match: options.pattern,
    count: options.scanBatch,
  });

  let streamKeysScanned = 0;

  let streamKeysSelected = 0;

  const endScan = _.once(() => {
    Promise.all(pipelinePromises).then(() => {
      self.write(_.extend({
        keysScanned: streamKeysScanned,
        keysSelected: streamKeysSelected,
      }, options));
      self.end();
    });
  });

  scanStream.on('data', (batchKeys) => {
    const pipeline = redis.pipeline();
    streamKeysScanned += batchKeys.length;
    if (options.debug) {
      console.log(`scanned ${batchKeys.length} keys`);
    }
    _.each(batchKeys, (key) => {
      pipeline.object('IDLETIME', key);
      if (checkTTL) { pipeline.ttl(key); }
    });

    pipelinePromises.push(pipeline.exec().then((results) => {
      _.each(batchKeys, (key, i) => {
        // Since we are sometimes pipelining 2 redis operations per key, the
        // `results` array may have two items per key.  Hence the funky array
        // indexing here:
        let entry;

        const idleIdx = checkTTL ? i * 2 : i;

        const idletime = results[idleIdx][1];

        const ttl = checkTTL && results[idleIdx + 1][1];

        if (!atSelectLimit
          && (isNaN(options.maxIdle) || idletime <= options.maxIdle)
          && (isNaN(options.maxTTL) || ttl <= options.maxTTL)
          && (isNaN(options.minIdle) || idletime >= options.minIdle)
          && (isNaN(options.minTTL) || ttl >= options.minTTL)
          && (!hasOption('noExpiry') || (options.noExpiry && ttl === -1))) {
          streamKeysSelected++;
          atSelectLimit = streamKeysSelected >= options.limit;
          entry = {
            name: redisDescription,
            key,
            idletime,
          };
          if (checkTTL) { entry.ttl = ttl; }
          self.write(entry);
        }
      });
    }));

    if (atSelectLimit || streamKeysScanned >= options.scanLimit) {
      scanStream.pause();
      endScan();
    }
  });

  scanStream.on('end', endScan);

  EventEmitter.call(this);
}
util.inherits(RedisKeyScanner, EventEmitter);

RedisKeyScanner.prototype.write = function (data) {
  this.emit('data', data);
};

RedisKeyScanner.prototype.end = function () {
  this.emit('end');
};

function parseCommandLineAndScanKeys() {
  const args = require('minimist')(process.argv.slice(2));

  const hostPort = args._.length && args._[0].split(':');

  const redisMaster = args._.length > 1 && args._[1];

  const usingSentinel = !!redisMaster;

  const defaultPort = defaults[usingSentinel ? 'sentinelPort' : 'redisPort'];

  const options = _.pickBy({
    debug: !!args.debug,
    host: hostPort.length && hostPort[0],
    port: hostPort.length > 1 ? hostPort[1] : defaultPort,
    redisMaster: redisMaster || false,
    db: args.db || defaults.db,
    scanBatch: args['scan-batch'] || defaults.scanBatch,
    scanLimit: args['scan-limit'] || defaults.scanLimit,
    limit: args.limit || defaults.limit,
    maxIdle: args['max-idle'],
    maxTTL: args['max-ttl'],
    minIdle: args['min-idle'],
    minTTL: args['min-ttl'],
    noExpiry: args.expiry === false,
    pattern: args.pattern || '*',
  }, v => !_.isNaN(v) && !_.isUndefined(v) && v !== false);

  let redisKeyScanner;

  const supportedArgs = [
    '_', 'expiry', 'limit', 'max-idle', 'max-ttl', 'min-idle', 'min-ttl',
    'pattern', 'scan-batch', 'scan-limit', 'db', 'debug',
  ];

  const unsupportedArgs = _.keys(_.omit(args, supportedArgs));

  try {
    if (unsupportedArgs.length) {
      throw new TypeError(`Unsupported arg(s): ${unsupportedArgs}`);
    }
    redisKeyScanner = new RedisKeyScanner(options);
    redisKeyScanner.on('data', (data) => {
      console.log(JSON.stringify(data));
    });
    redisKeyScanner.on('end', () => {
      process.exit(0);
    });
    redisKeyScanner.on('error', (err) => {
      console.error(err);
      process.exit(2);
    });
  } catch (ex) {
    console.error(String(ex));
    console.log(usage);
    process.exit(1);
  }
}

if (require.main === module) {
  parseCommandLineAndScanKeys();
}

module.exports = RedisKeyScanner;
