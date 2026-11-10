// OAuth 1.0 HMAC-SHA1 request signing (RFC 5849). PebbleKit JS has no crypto API, so SHA-1,
// HMAC and Base64 are implemented here on plain byte arrays.

function utf8Bytes(text) {
  var binary = unescape(encodeURIComponent(text));
  var bytes = [];
  for (var i = 0; i < binary.length; i++) {
    bytes.push(binary.charCodeAt(i));
  }
  return bytes;
}

function rotl(value, bits) {
  return (value << bits) | (value >>> (32 - bits));
}

function sha1(bytes) {
  var h = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0];
  var message = bytes.slice();
  var bitLength = bytes.length * 8;
  message.push(0x80);
  while (message.length % 64 !== 56) {
    message.push(0);
  }
  var high = Math.floor(bitLength / 0x100000000);
  var low = bitLength >>> 0;
  message.push((high >>> 24) & 255, (high >>> 16) & 255, (high >>> 8) & 255, high & 255,
    (low >>> 24) & 255, (low >>> 16) & 255, (low >>> 8) & 255, low & 255);

  var w = new Array(80);
  for (var offset = 0; offset < message.length; offset += 64) {
    var i;
    for (i = 0; i < 16; i++) {
      var p = offset + i * 4;
      w[i] = (message[p] << 24) | (message[p + 1] << 16) | (message[p + 2] << 8) | message[p + 3];
    }
    for (i = 16; i < 80; i++) {
      w[i] = rotl(w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16], 1);
    }
    var a = h[0], b = h[1], c = h[2], d = h[3], e = h[4];
    for (i = 0; i < 80; i++) {
      var f;
      var k;
      if (i < 20) {
        f = (b & c) | (~b & d);
        k = 0x5a827999;
      } else if (i < 40) {
        f = b ^ c ^ d;
        k = 0x6ed9eba1;
      } else if (i < 60) {
        f = (b & c) | (b & d) | (c & d);
        k = 0x8f1bbcdc;
      } else {
        f = b ^ c ^ d;
        k = 0xca62c1d6;
      }
      var temp = (rotl(a, 5) + f + e + k + w[i]) | 0;
      e = d;
      d = c;
      c = rotl(b, 30);
      b = a;
      a = temp;
    }
    h[0] = (h[0] + a) | 0;
    h[1] = (h[1] + b) | 0;
    h[2] = (h[2] + c) | 0;
    h[3] = (h[3] + d) | 0;
    h[4] = (h[4] + e) | 0;
  }

  var digest = [];
  for (var j = 0; j < 5; j++) {
    digest.push((h[j] >>> 24) & 255, (h[j] >>> 16) & 255, (h[j] >>> 8) & 255, h[j] & 255);
  }
  return digest;
}

function hmacSha1(keyBytes, messageBytes) {
  var key = keyBytes.length > 64 ? sha1(keyBytes) : keyBytes.slice();
  while (key.length < 64) {
    key.push(0);
  }
  var inner = [];
  var outer = [];
  for (var i = 0; i < 64; i++) {
    inner.push(key[i] ^ 0x36);
    outer.push(key[i] ^ 0x5c);
  }
  return sha1(outer.concat(sha1(inner.concat(messageBytes))));
}

var BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function base64(bytes) {
  var out = '';
  for (var i = 0; i < bytes.length; i += 3) {
    var b0 = bytes[i];
    var b1 = i + 1 < bytes.length ? bytes[i + 1] : 0;
    var b2 = i + 2 < bytes.length ? bytes[i + 2] : 0;
    out += BASE64.charAt(b0 >> 2);
    out += BASE64.charAt(((b0 & 3) << 4) | (b1 >> 4));
    out += i + 1 < bytes.length ? BASE64.charAt(((b1 & 15) << 2) | (b2 >> 6)) : '=';
    out += i + 2 < bytes.length ? BASE64.charAt(b2 & 63) : '=';
  }
  return out;
}

// RFC 3986 encoding: encodeURIComponent leaves !'()* unescaped.
function percentEncode(value) {
  return encodeURIComponent(String(value)).replace(/[!'()*]/g, function (ch) {
    return '%' + ch.charCodeAt(0).toString(16).toUpperCase();
  });
}

function normalizedPairs(params) {
  return Object.keys(params).map(function (name) {
    return [percentEncode(name), percentEncode(params[name])];
  }).sort(function (x, y) {
    if (x[0] !== y[0]) {
      return x[0] < y[0] ? -1 : 1;
    }
    return x[1] < y[1] ? -1 : (x[1] > y[1] ? 1 : 0);
  });
}

function signature(method, url, params, consumerSecret, tokenSecret) {
  var normalized = normalizedPairs(params).map(function (pair) {
    return pair[0] + '=' + pair[1];
  }).join('&');
  var baseString = method.toUpperCase() + '&' + percentEncode(url) + '&' + percentEncode(normalized);
  var key = percentEncode(consumerSecret) + '&' + percentEncode(tokenSecret);
  return base64(hmacSha1(utf8Bytes(key), utf8Bytes(baseString)));
}

// Returns the full parameter set, including oauth_signature, ready to send.
// token and tokenSecret are empty strings for requests made before a token exists.
function signParams(method, url, params, credentials, timestamp, nonce) {
  var all = {};
  Object.keys(params).forEach(function (name) {
    all[name] = params[name];
  });
  all.oauth_consumer_key = credentials.consumerKey;
  all.oauth_signature_method = 'HMAC-SHA1';
  all.oauth_timestamp = String(timestamp);
  all.oauth_nonce = nonce;
  all.oauth_version = '1.0';
  if (credentials.token !== '') {
    all.oauth_token = credentials.token;
  }
  all.oauth_signature = signature(method, url, all, credentials.consumerSecret, credentials.tokenSecret);
  return all;
}

function queryString(params) {
  return normalizedPairs(params).map(function (pair) {
    return pair[0] + '=' + pair[1];
  }).join('&');
}

module.exports = {
  sha1: sha1,
  hmacSha1: hmacSha1,
  base64: base64,
  utf8Bytes: utf8Bytes,
  percentEncode: percentEncode,
  signature: signature,
  signParams: signParams,
  queryString: queryString
};
