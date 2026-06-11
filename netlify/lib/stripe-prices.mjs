// netlify/functions/stripe-prices.js
// Stripe price IDs — not secrets, safe to commit
// Generated: June 2026
// To update: replace the price_... values below and redeploy

const PRICES = {
  xpscore360: {
    essentials: {
      monthly: 'price_1ThEWmH77crKP0SoeSJwaBBJ',
      annual:  'price_1ThEWmH77crKP0SoEzezy9G7',
    },
    pro: {
      monthly: 'price_1ThEWmH77crKP0SoikrfTEOl',
      annual:  'price_1ThEWmH77crKP0SoI7EA5CFn',
    },
    multisite: {
      monthly: 'price_1ThEWmH77crKP0SoxQ4zNx7R',
      annual:  'price_1ThEWmH77crKP0SoF0QC8aqM',
    },
  },
  tapee360: {
    starter: {
      monthly: 'price_1ThEMHH77crKP0SoDbtPkUQZ',
      annual:  'price_1ThEOlH77crKP0SozxknuTLI',
    },
    growth: {
      monthly: 'price_1ThEOlH77crKP0SobNJTI48Q',
      annual:  'price_1ThEOlH77crKP0SoP8vB2T7X',
    },
    enterprise: {
      monthly: 'price_1ThEOlH77crKP0SoYS0rHeGM',
      annual:  'price_1ThEOlH77crKP0SoLSaRtsyY',
    },
  },
  smflow: {
    grow: {
      monthly: 'price_1ThEelH77crKP0SoA8wWLEdk',
      annual:  'price_1ThEelH77crKP0SosWb1ZEd8',
    },
    scale: {
      monthly: 'price_1ThEelH77crKP0So4FC5Qjza',
      annual:  'price_1ThEelH77crKP0SooHgUUX0e',
    },
    dominate: {
      monthly: 'price_1ThEelH77crKP0Sonkw4cLg7',
      annual:  'price_1ThEelH77crKP0SoE09SxiV5',
    },
  },
  aiflow360: {
    basic: {
      monthly: 'price_1ThDS1H77crKP0Soj2Ce7ztc',
      annual:  'price_1ThDS1H77crKP0Sorlu5QJDc',
    },
    business: {
      monthly: 'price_1ThDS1H77crKP0SotudMvdLB',
      annual:  'price_1ThDS1H77crKP0So5gS7bkTt',
    },
    team: {
      monthly: 'price_1ThDS1H77crKP0SoneeaHluH',
      annual:  'price_1ThDS1H77crKP0Sobz5wyCtg',
    },
  },
};

/**
 * Resolve a price ID from product + tier + interval
 * @param {string} product  e.g. 'smflow'
 * @param {string} tier     e.g. 'scale'
 * @param {string} interval 'monthly' | 'annual'
 * @returns {string|null}
 */
function resolvePriceId(product, tier, interval) {
  const iv = interval === 'annual' ? 'annual' : 'monthly';
  return PRICES[product]?.[tier]?.[iv] || null;
}

/**
 * Build reverse map: priceId → { product, tier, interval }
 * Used by webhook to identify what was purchased
 */
function buildPriceIndex() {
  const index = {};
  for (const [product, tiers] of Object.entries(PRICES)) {
    for (const [tier, intervals] of Object.entries(tiers)) {
      for (const [interval, priceId] of Object.entries(intervals)) {
        index[priceId] = { product, tier, interval };
      }
    }
  }
  return index;
}

export { PRICES, resolvePriceId, buildPriceIndex };
