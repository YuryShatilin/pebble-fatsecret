// Run with: node --test test/
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const oauth = require('../src/pkjs/oauth.js');
const { diaryDay, parseMenu, parseServingWeights, ERROR_BAD_DATA, ERROR_API, MAX_TEXT_LENGTH } = require('../src/pkjs/menu.js');

test('sha1 and hmacSha1 match node crypto, including multi-block and non-ASCII input', () => {
  const samples = ['', 'abc', 'a'.repeat(55), 'a'.repeat(56), 'a'.repeat(64), 'a'.repeat(1000), 'обед и перекус'];
  for (const text of samples) {
    const bytes = oauth.utf8Bytes(text);
    assert.strictEqual(Buffer.from(oauth.sha1(bytes)).toString('hex'),
      crypto.createHash('sha1').update(text).digest('hex'), `sha1 of ${text.length} chars`);
    for (const key of ['key', 'k'.repeat(100)]) {
      assert.strictEqual(Buffer.from(oauth.hmacSha1(oauth.utf8Bytes(key), bytes)).toString('base64'),
        crypto.createHmac('sha1', key).update(text).digest('base64'), `hmac, key length ${key.length}`);
    }
  }
});

test('base64 handles every padding case', () => {
  for (const text of ['', 'f', 'fo', 'foo', 'foob', 'fooba', 'foobar']) {
    assert.strictEqual(oauth.base64(oauth.utf8Bytes(text)), Buffer.from(text).toString('base64'));
  }
});

test('percentEncode follows RFC 3986', () => {
  assert.strictEqual(oauth.percentEncode("a b!'()*~-._"), 'a%20b%21%27%28%29%2A~-._');
  assert.strictEqual(oauth.percentEncode('обед'), '%D0%BE%D0%B1%D0%B5%D0%B4');
});

test('signature matches the HMAC-SHA1 example in RFC 5849 section 1.2', () => {
  const signed = oauth.signParams('GET', 'http://photos.example.net/photos', { file: 'vacation.jpg', size: 'original' }, {
    consumerKey: 'dpf43f3p2l4k3l03',
    consumerSecret: 'kd94hf93k423kf44',
    token: 'nnch734d00sl2jdk',
    tokenSecret: 'pfkkdhi9sl3r4s00'
  }, 1191242096, 'kllo9940pd9333jh');
  assert.strictEqual(signed.oauth_signature, 'tR3+Ty81lMeYAr/Fid0kMTYa/WM=');
});

test('signParams leaves out oauth_token when there is no token yet', () => {
  const signed = oauth.signParams('POST', 'https://example.com/x', { oauth_callback: 'oob' },
    { consumerKey: 'key', consumerSecret: 'secret', token: '', tokenSecret: '' }, 1, 'n');
  assert.strictEqual(signed.oauth_token, undefined);
  assert.strictEqual(signed.oauth_callback, 'oob');
});

test('diaryDay counts local calendar days since 1970-01-01', () => {
  assert.strictEqual(diaryDay(new Date(1970, 0, 1, 23, 59)), 0);
  assert.strictEqual(diaryDay(new Date(2009, 1, 14, 0, 1)), 14289);
  // 2026-01-01 is day 20454 (56 * 365 + 14 leap days); 10 November is 313 days later.
  assert.strictEqual(diaryDay(new Date(2026, 10, 10, 23, 30)), 20767);
});

function entry(meal, description, calories) {
  return { meal, food_entry_description: description, food_entry_name: 'x', calories: String(calories) };
}

test('parseMenu splits entries by meal, one item per line', () => {
  const text = JSON.stringify({ food_entries: { food_entry: [
    entry('Breakfast', 'eggs', 200),
    entry('Lunch', '150 g chicken breast', 247.5),
    entry('Lunch', '100 g rice', 130),
    entry('Dinner', 'soup', 90),
    entry('Other', '1 apple', 95),
  ] } });
  assert.deepStrictEqual(parseMenu(text, {}), {
    lunch: '150 g chicken breast\n100 g rice',
    snack: '1 apple',
    dinner: 'soup',
    breakfast: 'eggs',
  });
});

test('parseMenu keeps an item with a line break on one line', () => {
  const result = parseMenu(JSON.stringify({ food_entries: { food_entry: [entry('Lunch', 'rice\n boiled', 130)] } }), {});
  assert.strictEqual(result.lunch, 'rice boiled');
});

test('parseMenu accepts lowercase meal names', () => {
  const result = parseMenu(JSON.stringify({ food_entries: { food_entry: [entry('lunch', 'rice', 130)] } }), {});
  assert.strictEqual(result.lunch, 'rice');
});

test('parseMenu treats a day without entries as empty, not as an error', () => {
  for (const body of [{ food_entries: null }, { food_entries: {} }, { food_entries: '' }]) {
    assert.deepStrictEqual(parseMenu(JSON.stringify(body), {}), { lunch: '', snack: '', dinner: '', breakfast: '' }, JSON.stringify(body));
  }
});

test('parseMenu reports FatSecret errors with their code', () => {
  const text = JSON.stringify({ error: { code: 8, message: 'Invalid signature' } });
  assert.throws(() => parseMenu(text, {}), (e) => e.code === ERROR_API && e.apiCode === 8);
});

test('parseMenu rejects malformed responses', () => {
  const bad = [
    'not json',
    'null',
    JSON.stringify({}),
    JSON.stringify({ food_entries: { food_entry: 'x' } }),
    JSON.stringify({ food_entries: { food_entry: [{ meal: 'Lunch', calories: '1' }] } }),
    JSON.stringify({ food_entries: { food_entry: [{ meal: 'Lunch', food_entry_description: '' }] } }),
  ];
  for (const text of bad) {
    assert.throws(() => parseMenu(text, {}), (e) => e.code === ERROR_BAD_DATA, text);
  }
});

test('parseMenu drops whole items from the end to fit the watch message', () => {
  const entries = [];
  for (let i = 0; i < 50; i++) {
    entries.push(entry('Lunch', 'a fairly long food description number ' + i, 10));
  }
  const lines = parseMenu(JSON.stringify({ food_entries: { food_entry: entries } }), {}).lunch.split('\n');
  assert.ok(lines.join('\n').length <= MAX_TEXT_LENGTH);
  assert.ok(lines.length > 10 && lines.length < 50, `${lines.length} lines`);
  lines.forEach((line, i) => assert.strictEqual(line, 'a fairly long food description number ' + i));
});

function recentFood(servingId, urlTail) {
  return { food_id: '1', serving_id: servingId, food_url: 'https://foods.fatsecret.com/calories-nutrition/kz/brand/food/' + encodeURIComponent(urlTail) };
}

test('parseServingWeights reads the serving size from the food URL, as seen in the real response', () => {
  const text = JSON.stringify({ foods: { food: [
    recentFood('44109317', '100г'),
    recentFood('2', '250мл'),
    recentFood('3', '1,5 g'),
    recentFood('4', '1-шт'),
    { food_id: '5', serving_id: '5' },
  ] } });
  assert.deepStrictEqual(parseServingWeights(text), {
    44109317: { amount: 100, unit: 'g' },
    2: { amount: 250, unit: 'ml' },
    3: { amount: 1.5, unit: 'g' },
  });
});

test('parseServingWeights rejects an error or unexpected response', () => {
  for (const text of [JSON.stringify({ error: { code: 13 } }), JSON.stringify({}), 'null']) {
    assert.throws(() => parseServingWeights(text), (e) => e.code === ERROR_BAD_DATA, text);
  }
});

// Entries as the real diary returns them: "<quantity> [unit] <name>" plus the name and unit count.
function realEntry(meal, quantity, unit, name, units, servingId, foodId) {
  const head = unit === '' ? quantity : quantity + ' ' + unit;
  return {
    meal, food_entry_description: head + ' ' + name, food_entry_name: name,
    number_of_units: units, serving_id: servingId, food_id: foodId, calories: '1',
  };
}

// The diary of 2026-11-10, where "serving", "servings", "1/2 serving" and "large" showed up.
const REAL_DIARY = JSON.stringify({ food_entries: { food_entry: [
  realEntry('Breakfast', '1/2', 'serving', 'Bauer Вишня без Косточки', '0.500', '17299348', '18349827'),
  realEntry('Breakfast', '100', 'гs', 'Овсяные Хлопья', '100.000', '5935862', '6121492'),
  realEntry('Breakfast', '2', 'mugs', 'Кофе с Молоком', '2.000', '2423065', '2479602'),
  realEntry('Breakfast', '1/2', 'tbsp', 'Мёд', '0.500', '40062', '39536'),
  realEntry('Breakfast', '4', 'large', 'Яйцо (Целое)', '4.000', '29441', '33792'),
  realEntry('Lunch', '25', 'g', 'Золотой Изюм (без Косточек)', '25.000', '58692', '35961'),
  realEntry('Lunch', '1', 'serving', 'Соленыч Капуста Квашеная с Клюквой', '1.000', '44109317', '52143226'),
  realEntry('Lunch', '0.7', '', 'Огурец (с Кожурой)', '0.700', '34152', '36376'),
  realEntry('Lunch', '0.7', 'serving', 'Макфа Макароны', '0.700', '45811318', '54445962'),
  realEntry('Dinner', '2', 'servings', 'President Творог 0,1%', '2.000', '28926126', '31917504'),
  realEntry('Dinner', '1.2', 'servings', 'Food Master Кефир 2,5%', '1.200', '12436904', '13118946'),
  realEntry('Other', '0.35', 'serving', 'Едим с Пользой Изолят Соевый', '0.350', '71085929', '88416164'),
  realEntry('Other', '1', 'яблоко', 'Яблоко Желтое', '1.000', '7183159', '7449714'),
] } });

// Whole-serving weights read from the recently eaten food URLs ("100г", "100мл").
const SERVING_WEIGHTS = {
  17299348: { amount: 100, unit: 'g' },
  44109317: { amount: 100, unit: 'g' },
  45811318: { amount: 100, unit: 'g' },
  28926126: { amount: 100, unit: 'g' },
  12436904: { amount: 100, unit: 'ml' },
  71085929: { amount: 100, unit: 'g' },
};

test('parseMenu turns servings into grams and keeps counted units, matching the real diary', () => {
  assert.deepStrictEqual(parseMenu(REAL_DIARY, SERVING_WEIGHTS), {
    breakfast: '50 g Bauer Вишня без Косточки\n100 g Овсяные Хлопья\n2 круж. Кофе с Молоком\n1/2 ст. л. Мёд\n4 шт Яйцо (Целое)',
    lunch: '25 g Золотой Изюм (без Косточек)\n100 g Соленыч Капуста Квашеная с Клюквой\n0.7 Огурец (с Кожурой)\n70 g Макфа Макароны',
    dinner: '200 g President Творог 0,1%\n120 ml Food Master Кефир 2,5%',
    snack: '35 g Едим с Пользой Изолят Соевый\n1 яблоко Яблоко Желтое',
  });
});

test('parseMenu keeps FatSecret text for a serving without a known weight', () => {
  assert.strictEqual(parseMenu(REAL_DIARY, {}).dinner,
    '2 servings President Творог 0,1%\n1.2 servings Food Master Кефир 2,5%');
});

test('parseMenu leaves a unit it does not know unchanged', () => {
  const text = JSON.stringify({ food_entries: { food_entry: [
    realEntry('Lunch', '2', 'oz', 'Сыр', '2.000', '1', '1'),
  ] } });
  assert.strictEqual(parseMenu(text, {}).lunch, '2 oz Сыр');
});

test('parseMenu rejects a meal it does not know instead of dropping it', () => {
  const text = JSON.stringify({ food_entries: { food_entry: [entry('Brunch', 'toast', 1)] } });
  assert.throws(() => parseMenu(text, {}), (e) => e.code === ERROR_BAD_DATA);
});
