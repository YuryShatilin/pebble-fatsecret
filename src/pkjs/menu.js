// Pure logic: turns a FatSecret food diary response into the per-meal lists for the watch.
var ERROR_BAD_DATA = 3;
var ERROR_API = 5;

// The watch inbox holds all meals in one message, so each list is capped.
var MAX_TEXT_LENGTH = 700;

function MenuError(code, message, apiCode) {
  this.code = code;
  this.message = message;
  this.apiCode = apiCode;
}

// FatSecret counts diary days from 1970-01-01. The day is the phone's local calendar date.
function diaryDay(date) {
  return Math.floor(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / 86400000);
}

function entriesOf(data) {
  if (!Object.prototype.hasOwnProperty.call(data, 'food_entries')) {
    throw new MenuError(ERROR_BAD_DATA, 'Response has no food_entries');
  }
  var container = data.food_entries;
  // An empty day comes back without a food_entry list.
  if (container === null || container === '' || container.food_entry === undefined) {
    return [];
  }
  if (!Array.isArray(container.food_entry)) {
    throw new MenuError(ERROR_BAD_DATA, 'food_entry is not a list');
  }
  return container.food_entry;
}

// FatSecret meal names; the app shows "other" as Snacks.
var MEALS = { breakfast: 'breakfast', lunch: 'lunch', dinner: 'dinner', other: 'snack' };

var WEIGHT_UNITS = { 'г': 'g', 'g': 'g', 'мл': 'ml', 'ml': 'ml' };
// Units that already are a weight or volume, as FatSecret spells them in descriptions.
var METRIC_UNITS = { 'g': 'g', 'gs': 'g', 'г': 'g', 'гs': 'g', 'ml': 'ml', 'mls': 'ml', 'мл': 'ml', 'млs': 'ml' };
var SERVING_UNIT = /^servings?$/;
// Any leftover "serving"/"servings" is shown as the Russian abbreviation.
var SERVING_WORD = /\bservings?\b/gi;
var SERVING_SHORT = 'порц.';
// Household units keep their count and get a Russian abbreviation; unknown units stay as they are.
var UNIT_NAMES = {
  'large': 'шт', 'medium': 'шт', 'small': 'шт', 'extra large': 'шт', 'jumbo': 'шт',
  'piece': 'шт', 'pieces': 'шт',
  'tbsp': 'ст. л.', 'tsp': 'ч. л.',
  'mug': 'круж.', 'mugs': 'круж.', 'cup': 'стак.', 'cups': 'стак.',
  'slice': 'ломт.', 'slices': 'ломт.'
};

function oneLine(text) {
  return text.replace(/\s*\n\s*/g, ' ');
}

// Splits "<quantity> [unit] <name>" using the entry's own name; null when it does not have that shape.
function splitDescription(entry) {
  var text = oneLine(entry.food_entry_description);
  var name = entry.food_entry_name;
  if (typeof name !== 'string' || name === '' || text.length <= name.length ||
      text.slice(text.length - name.length) !== name) {
    return null;
  }
  var head = text.slice(0, text.length - name.length).trim().split(/\s+/);
  return { quantity: head[0], unit: head.slice(1).join(' '), name: name };
}

// Whole-serving weights by serving_id, from a foods.get_recently_eaten.v2 response. Regional
// foods cannot be looked up with food.get on this API edition, so the weight is taken from the
// last segment of the food URL, which holds the serving description, such as "100г".
function parseServingWeights(responseText) {
  var weights = {};
  var data = JSON.parse(responseText);
  if (data === null || typeof data !== 'object' || data.error !== undefined || !data.foods) {
    throw new MenuError(ERROR_BAD_DATA, 'Unexpected recently eaten response: ' + responseText.slice(0, 200));
  }
  [].concat(data.foods.food || []).forEach(function (food) {
    if (typeof food.food_url !== 'string' || food.serving_id === undefined) {
      return;
    }
    var tail = decodeURIComponent(food.food_url.split('/').pop());
    var match = /^(\d+(?:[.,]\d+)?)\s*(г|g|мл|ml)$/i.exec(tail);
    if (match !== null) {
      weights[food.serving_id] = {
        amount: Number(match[1].replace(',', '.')),
        unit: WEIGHT_UNITS[match[2].toLowerCase()]
      };
    }
  });
  return weights;
}

// "1 Киви", "1 serving Протеиновый Кекс" and "1 яблоко Яблоко Желтое" say nothing beyond the
// name, so they show as just the name. Measures such as "1 tbsp" or "1 oz" keep their count, and a
// serving whose weight is known is shown in grams instead.
function isSingleItem(parts, servingWeight) {
  if (parts.quantity !== '1') {
    return false;
  }
  var unit = parts.unit.toLowerCase();
  if (SERVING_UNIT.test(unit)) {
    return servingWeight === undefined;
  }
  return unit === '' ||
    parts.name.toLowerCase().split(/\s+/).indexOf(unit) !== -1;
}

// Servings become grams or millilitres when their weight is known; other units keep their count.
function describe(entry, servingWeights) {
  var text = entry.food_entry_description;
  if (typeof text !== 'string' || text === '') {
    throw new MenuError(ERROR_BAD_DATA, 'Entry has no description: ' + JSON.stringify(entry));
  }
  text = oneLine(text);

  var parts = splitDescription(entry);
  if (parts === null) {
    return text.replace(SERVING_WORD, SERVING_SHORT);
  }
  if (isSingleItem(parts, servingWeights[entry.serving_id])) {
    return parts.name;
  }
  if (parts.unit === '') {
    return text;
  }
  var metric = METRIC_UNITS[parts.unit];
  if (metric !== undefined) {
    return parts.quantity + ' ' + metric + ' ' + parts.name;
  }
  var unitName = UNIT_NAMES[parts.unit];
  if (unitName !== undefined) {
    return parts.quantity + ' ' + unitName + ' ' + parts.name;
  }
  var units = Number(entry.number_of_units);
  var weight = servingWeights[entry.serving_id];
  if (!SERVING_UNIT.test(parts.unit) || weight === undefined || !isFinite(units)) {
    // Without a known weight the count stays, but "serving" never reaches the watch.
    return parts.quantity + ' ' + parts.unit.replace(SERVING_WORD, SERVING_SHORT) + ' ' + parts.name;
  }
  return Math.round(units * weight.amount) + ' ' + weight.unit + ' ' + parts.name;
}

// Items joined by '\n'. Whole items are dropped from the end when the list is too long.
function summarize(items) {
  var text = '';
  for (var i = 0; i < items.length; i++) {
    var next = text === '' ? items[i] : text + '\n' + items[i];
    if (next.length > MAX_TEXT_LENGTH) {
      break;
    }
    text = next;
  }
  return text;
}

// servingWeights comes from parseServingWeights; pass {} when it is not available.
function parseMenu(responseText, servingWeights) {
  var data;
  try {
    data = JSON.parse(responseText);
  } catch (e) {
    throw new MenuError(ERROR_BAD_DATA, 'Response is not JSON');
  }
  if (data === null || typeof data !== 'object') {
    throw new MenuError(ERROR_BAD_DATA, 'Response is not an object');
  }
  if (data.error !== undefined) {
    throw new MenuError(ERROR_API, 'FatSecret error: ' + JSON.stringify(data.error), Number(data.error.code));
  }

  var items = { lunch: [], snack: [], dinner: [], breakfast: [] };
  entriesOf(data).forEach(function (entry) {
    var name = MEALS[String(entry.meal).toLowerCase()];
    if (name === undefined) {
      throw new MenuError(ERROR_BAD_DATA, 'Unknown meal: ' + entry.meal);
    }
    items[name].push(describe(entry, servingWeights));
  });
  return {
    lunch: summarize(items.lunch),
    snack: summarize(items.snack),
    dinner: summarize(items.dinner),
    breakfast: summarize(items.breakfast)
  };
}

module.exports = {
  diaryDay: diaryDay,
  parseMenu: parseMenu,
  parseServingWeights: parseServingWeights,
  MenuError: MenuError,
  ERROR_BAD_DATA: ERROR_BAD_DATA,
  ERROR_API: ERROR_API,
  MAX_TEXT_LENGTH: MAX_TEXT_LENGTH
};
