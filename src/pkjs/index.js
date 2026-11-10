// Phone side: reads today's FatSecret food diary and sends each meal to the watch.
var oauth = require('./oauth');
var menu = require('./menu');
var credentials = require('./credentials');

var API_URL = 'https://platform.fatsecret.com/rest/server.api';
var REQUEST_TIMEOUT_MS = 15000;
var ERROR_NETWORK = 1;

function send(message) {
  Pebble.sendAppMessage(message, null, function (e) {
    console.log('Could not deliver message to the watch: ' + JSON.stringify(e));
  });
}

function sendError(code, reason, apiCode) {
  console.log('Menu failed: ' + reason);
  var message = { ErrorCode: code };
  if (apiCode !== undefined && isFinite(apiCode)) {
    message.ApiErrorCode = apiCode;
  }
  send(message);
}

function nonce() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

// Calls a profile method; onResult gets { text } or { failed, reason }.
function callApi(params, onResult) {
  params.format = 'json';
  var signed = oauth.signParams('GET', API_URL, params, credentials, Math.floor(Date.now() / 1000), nonce());
  var request = new XMLHttpRequest();
  request.timeout = REQUEST_TIMEOUT_MS;
  request.onload = function () {
    // FatSecret reports its own errors in the body, so the body is parsed for any status.
    if (request.status === 200 || request.responseText) {
      onResult({ failed: false, text: request.responseText });
    } else {
      onResult({ failed: true, reason: 'HTTP ' + request.status });
    }
  };
  request.onerror = function () {
    onResult({ failed: true, reason: 'Request error' });
  };
  request.ontimeout = function () {
    onResult({ failed: true, reason: 'Request timeout' });
  };
  request.open('GET', API_URL + '?' + oauth.queryString(signed));
  request.send();
}

// Weights only turn units such as "serving" into grams, so without them the menu is still shown.
function servingWeights(recent) {
  if (recent.failed) {
    console.log('Serving weights unavailable: ' + recent.reason);
    return {};
  }
  try {
    return menu.parseServingWeights(recent.text);
  } catch (e) {
    console.log('Serving weights unavailable: ' + (e.message || String(e)));
    return {};
  }
}

function deliver(diaryText, perServing) {
  var result;
  try {
    result = menu.parseMenu(diaryText, perServing);
  } catch (e) {
    if (e instanceof menu.MenuError) {
      sendError(e.code, e.message, e.apiCode);
    } else {
      sendError(menu.ERROR_BAD_DATA, String(e));
    }
    return;
  }
  send({
    LunchText: result.lunch,
    SnackText: result.snack,
    DinnerText: result.dinner,
    BreakfastText: result.breakfast
  });
}

// Calls each request in parallel and passes the results, in order, once all have answered.
function callAll(requests, onDone) {
  var results = [];
  var remaining = requests.length;
  if (remaining === 0) {
    onDone(results);
    return;
  }
  requests.forEach(function (params, index) {
    callApi(params, function (result) {
      results[index] = result;
      remaining--;
      if (remaining === 0) {
        onDone(results);
      }
    });
  });
}

// The diary, and recently eaten foods for the serving weights.
function fetchMenu() {
  callAll([
    { method: 'food_entries.get.v2', date: String(menu.diaryDay(new Date())) },
    { method: 'foods.get_recently_eaten.v2' }
  ], function (results) {
    var diary = results[0];
    if (diary.failed) {
      sendError(ERROR_NETWORK, diary.reason);
      return;
    }
    deliver(diary.text, servingWeights(results[1]));
  });
}

// The watch keeps today's menu, so it decides whether to fetch: it answers with RequestRefresh.
Pebble.addEventListener('ready', function () {
  send({ PhoneReady: 1 });
});

Pebble.addEventListener('appmessage', function (e) {
  if (e.payload.RequestRefresh !== undefined) {
    fetchMenu();
  }
});
