redis-key-scanner
=================

Scan a redis server for keys matching specified criteria, including key
patterns, TTL and IDLETIME.  Selected/matched keys are output in a JSON log
format.  The scan is non-destructive, and doesn't even read any actual key
values, so it won't affect IDLETIME either.

Example command-line usage, querying a locally running redis server for keys
that start with the prefix "mykeys:" and have been idle for at least one week:
```
> node redis-key-scanner localhost --pattern=mykeys:* --min-idle=1w
```

Output will be one JSON line per selected key, followed by a "summary" line with
total stats:
```
{"name":"localhost:6379","key":"mykeys:larry","ttl":-1,"idletime":604800}
{"name":"localhost:6379","key":"mykeys:curly","ttl":-1,"idletime":900000}
{"name":"localhost:6379","key":"mykeys:moe","ttl":-1,"idletime":1000000}
{"keysScanned":17,"keysSelected":3,"host":"localhost","port":6379,"scanBatch":1000,"scanLimit":null,"limit":null,"pattern":"mykeys:*"}
```

You can alternatively require `redis-key-scanner` as a Node.js module, in which
case it implements a stream interface and each record will be emitted as a
separate 'data' event.
```
var RedisKeyScanner = require('redis-key-scanner');
var scanner = new RedisKeyScanner({
  host: 'localhost',
  pattern: 'mykeys:*',
  minIdle: '1w'
});
scanner.on('data', function(data) {
  console.log(data);
});
scanner.on('end', function() {
  // clean up
});
```

Run `node redis-key-scanner` to see the full list of available options.
