'use strict';

var deepEqual = require('deep-equal')
var pull = require('pull-stream')
var contpara = require('cont').para
// make a validation stream?
// read the latest record in the database
// check it against the incoming data,
// and then read through

function clone (obj) {
  var o = {}
  for(var k in obj) o[k] = obj[k];
  return o
}

function get (db, key) {
  return function (cb) {
    return db.get(key, cb)
  }
}

function isString (s) {
  return 'string' === typeof s
}

module.exports = function (ssb, opts) {

  var lastDB = ssb.sublevel('lst')
  var hash = opts.hash
  var zeros = undefined
      //opts.hash(new Buffer(0))
      //zeros.fill(0)

  var verify = opts.keys.verify
  var encode = opts.codec.encode

  var validators = {}

  function validateSync (msg, prev, pub) {
    var type = msg.content.type
    if(!isString(type)) {
      validateSync.reason = 'type property must be string'
      return false
    }

    if(52 < type.length || type.length < 3) {
      validateSync.reason = 'type must be 3 < length <= 52, but was:' + type.length
      return false
    }

    if(prev) {
      if(!deepEqual(msg.previous, hash(encode(prev)))) {

        validateSync.reason = 'expected previous: '
          + hash(encode(prev)).toString('base64')

        return false
      }
      if(msg.sequence === prev.sequence + 1 
        && msg.timestamp < prev.timestamp) {

          validateSync.reason = 'out of order'

          return false
      }
    }
    else {
      if(!(msg.previous == null
        && msg.sequence === 1 && msg.timestamp > 0)) {

          validateSync.reason = 'expected initial message'

          return false
      }
    }

    if(!deepEqual(msg.author, hash(pub.public || pub))) {

      validateSync.reason = 'expected different author:'+
        hash(pub.public || pub).toString('base64') +
        'but found:' +
        msg.author.toString('base64')

      return false
    }

    var _msg = clone(msg)
    delete _msg.signature
    if(!verify(pub, msg.signature, hash(encode(_msg)))) {

      validateSync.reason = 'signature was invalid'

      return false
    }
    validateSync.reason = ''
    return true
  }

  function createValidator (id) {

    var queue = [], batch = [], prev, pub, cbs = []

    return function (msg, cb) {

      // INIT: retrive the latest message for the given id.
      // when not in INIT state, queue any new messages.
      // DRAIN: validate all queued messages.
      // writes all valid message.
      // after writing, if there are more queued queued messages
      // goto DRAIN

      var msghash = hash(encode(msg))
      if(!queue.length && !batch.length) {

        queue.push({hash: msghash, msg: msg, cb: cb})
        contpara(
          get(ssb, msg.previous),
          ssb.getPublicKey(msg.author),
          get(lastDB, msg.author)
        )(function (err, results) {
          prev = err ? null : results[0]
          //get PUBLIC KEY out of FIRST MESSAGE.
          pub = err ? msg.content.public : results[1]
          var expected = err ? 1 : results[2] + 1

          if(expected != msg.sequence) {
            queue.shift()
            return cb(
              new Error('sequence out of order, expected:'
                + expected + ' got: ' + msg.sequence)
            )
          }

          drain()
        })

      }
      else
        queue.push({hash: msghash, msg: msg, cb: cb})
    }

    function drain () {
      while(queue.length) {
        var e = queue.shift()
        if(validateSync(e.msg, prev, pub)) {
          cbs.push(e)
          batch.push({
            key: e.hash, value: e.msg, type: 'put'
          })
          prev = e.msg
        }
        else {
          e.cb(new Error(validateSync.reason
            + ' when attempting to validate: '
            + JSON.stringify(e.msg, null, 2)
          ))
        }
      }

      ssb.batch(batch, function (err) {
        while(cbs.length) {
          var e = cbs.shift()
          e.cb(err, e.msg, e.hash)
        }
        batch = [];
        if(queue.length) drain()
        else delete validators[id.toString('base64')]
      })
    }
  }

  var v
  return v = {
    validateSync: validateSync,
    validate: function (msg, cb) {

      var id = msg.author
      var ids = id.toString('base64')
      var validator = validators[ids] =
        validators[ids] || createValidator(id)

      return validator(msg, cb)
    }
  }
}
