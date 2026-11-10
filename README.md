# FatSecret Menu

A Pebble Time 2 watchapp that shows today's meals from a FatSecret food diary: lunch, snacks, dinner and breakfast, one page each.

Up and Down scroll a page; at the end of a page the next press turns to the next one. An arrow shows that a page has more lines in that direction. Select refreshes.

## Set up

1. Register an API key at [platform.fatsecret.com](https://platform.fatsecret.com).
2. Copy `credentials.example.js` to `src/pkjs/credentials.js` and fill in `consumerKey` and `consumerSecret`. This file is not committed.
3. Link your FatSecret account:
   - `node tools/authorize.js start` prints a page to open. Sign in there and allow access.
   - `node tools/authorize.js finish <code>` with the code from that page stores the token in `src/pkjs/credentials.js`.
4. Build and install.

## Troubleshooting

| On the watch | Meaning | What to check |
|---|---|---|
| `Нет сети` | The request failed | The phone's internet connection, and network access for the app in the Pebble phone app |
| `Нет телефона` | No reply from the phone | Bluetooth, and that the Pebble phone app is running |
| `Ошибка FatSecret N` | FatSecret rejected the request | Codes 2 to 9 and 13 usually mean the key or token is wrong: run `tools/authorize.js` again |
| `Ошибка данных` | The response has missing or unexpected values | The phone log |
