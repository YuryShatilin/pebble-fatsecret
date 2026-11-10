// One-time link of a FatSecret account (OAuth 1.0 three-legged, out-of-band).
//   node tools/authorize.js start          prints the page where you approve access
//   node tools/authorize.js finish <code>  stores the access token in src/pkjs/credentials.js
// The temporary request token is kept in tools/.request-token.json until finish.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const oauth = require('../src/pkjs/oauth.js');

const CREDENTIALS_FILE = path.join(__dirname, '..', 'src', 'pkjs', 'credentials.js');
const REQUEST_TOKEN_FILE = path.join(__dirname, '.request-token.json');
const REQUEST_TOKEN_URL = 'https://authentication.fatsecret.com/oauth/request_token';
const AUTHORIZE_URL = 'https://authentication.fatsecret.com/oauth/authorize';
const ACCESS_TOKEN_URL = 'https://authentication.fatsecret.com/oauth/access_token';

function loadCredentials() {
  if (!fs.existsSync(CREDENTIALS_FILE)) {
    throw new Error('Missing ' + CREDENTIALS_FILE + '. Copy credentials.example.js there and fill in the API key.');
  }
  delete require.cache[require.resolve(CREDENTIALS_FILE)];
  const credentials = require(CREDENTIALS_FILE);
  if (!credentials.consumerKey || !credentials.consumerSecret) {
    throw new Error('consumerKey and consumerSecret must be set in ' + CREDENTIALS_FILE);
  }
  return credentials;
}

async function call(method, url, params, credentials) {
  const signed = oauth.signParams(method, url, params, credentials,
    Math.floor(Date.now() / 1000), crypto.randomBytes(12).toString('hex'));
  const body = oauth.queryString(signed);
  const response = method === 'POST'
    ? await fetch(url, { method, body, headers: { 'Content-Type': 'application/x-www-form-urlencoded' } })
    : await fetch(url + '?' + body);
  const text = await response.text();
  if (!response.ok) {
    throw new Error(method + ' ' + url + ' failed: HTTP ' + response.status + ' ' + text);
  }
  const values = new URLSearchParams(text);
  if (!values.get('oauth_token') || !values.get('oauth_token_secret')) {
    throw new Error('Unexpected response from ' + url + ': ' + text);
  }
  return values;
}

async function start() {
  const credentials = loadCredentials();
  const values = await call('POST', REQUEST_TOKEN_URL, { oauth_callback: 'oob' },
    { consumerKey: credentials.consumerKey, consumerSecret: credentials.consumerSecret, token: '', tokenSecret: '' });
  fs.writeFileSync(REQUEST_TOKEN_FILE, JSON.stringify({
    token: values.get('oauth_token'),
    tokenSecret: values.get('oauth_token_secret')
  }));
  console.log('Open this page, sign in to FatSecret and allow access:');
  console.log(AUTHORIZE_URL + '?oauth_token=' + oauth.percentEncode(values.get('oauth_token')));
  console.log('Then run: node tools/authorize.js finish <code shown on the page>');
}

async function finish(verifier) {
  if (!verifier) {
    throw new Error('Pass the code shown on the FatSecret page: node tools/authorize.js finish <code>');
  }
  if (!fs.existsSync(REQUEST_TOKEN_FILE)) {
    throw new Error('Run "node tools/authorize.js start" first.');
  }
  const credentials = loadCredentials();
  const requestToken = JSON.parse(fs.readFileSync(REQUEST_TOKEN_FILE, 'utf8'));
  const values = await call('GET', ACCESS_TOKEN_URL, { oauth_verifier: verifier }, {
    consumerKey: credentials.consumerKey,
    consumerSecret: credentials.consumerSecret,
    token: requestToken.token,
    tokenSecret: requestToken.tokenSecret
  });
  const updated = {
    consumerKey: credentials.consumerKey,
    consumerSecret: credentials.consumerSecret,
    token: values.get('oauth_token'),
    tokenSecret: values.get('oauth_token_secret')
  };
  fs.writeFileSync(CREDENTIALS_FILE,
    '// Local FatSecret credentials. This file is not committed; see credentials.example.js.\n' +
    'module.exports = ' + JSON.stringify(updated, null, 2) + ';\n');
  fs.unlinkSync(REQUEST_TOKEN_FILE);
  console.log('Account linked. The token is saved in src/pkjs/credentials.js; rebuild and install the app.');
}

const [command, argument] = process.argv.slice(2);
const actions = { start: () => start(), finish: () => finish(argument) };
if (!actions[command]) {
  console.error('Usage: node tools/authorize.js start | finish <code>');
  process.exit(2);
}
actions[command]().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
