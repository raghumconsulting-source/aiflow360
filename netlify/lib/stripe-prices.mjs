// netlify/functions/stripe-prices.js
// Stripe price IDs — not secrets, safe to commit
// Generated: June 2026 — LIVE MODE
// To update: replace the price_... values below and redeploy

const PRICES = {
  xpscore360: {
    essentials: {
      monthly: 'price_1Tju8EHF6eR3tvYN5GneroIr',
      annual:  'price_1Tju8EHF6eR3tvYNJvOKh3nI',
    },
    pro: {
      monthly: 'price_1Tju8EHF6eR3tvYNFBVlcb72',
      annual:  'price_1Tju8EHF6eR3tvYNJqLhjN5H',
    },
    multisite: {
      monthly: 'price_1Tju8EHF6eR3tvYN650WXUcb',
      annual:  'price_1Tju8EHF6eR3tvYNKC6WsRGq',
    },
  },
  tapee360: {
    starter: {
      monthly: 'price_1Tju8LHF6eR3tvYNxDe9oDgL',
      annual:  'price_1Tju8KHF6eR3tvYNPkhK47eB',
    },
    growth: {
      monthly: 'price_1Tju8KHF6eR3tvYNNVVKrI32',
      annual:  'price_1Tju8LHF6eR3tvYNMjTkBWv9',
    },
    enterprise: {
      monthly: 'price_1Tju8KHF6eR3tvYN26BnvePw',
      annual:  'price_1Tju8KHF6eR3tvYNNbPjGEQt',
    },
  },
  smflow: {
    grow: {
      monthly: 'price_1Tju8mHF6eR3tvYNoHNkGxjf',
      annual:  'price_1Tju8mHF6eR3tvYNtJU0LnJk',
    },
    scale: {
      monthly: 'price_1Tju8mHF6eR3tvYNwWDFK2E9',
      annual:  'price_1Tju8mHF6eR3tvYN8lMPJ3AY',
    },
    dominate: {
      monthly: 'price_1Tju8mHF6eR3tvYNKSEKwgJT',
      annual:  'price_1Tju8mHF6eR3tvYN9nuh3kl5',
    },
  },
  aiflow360: {
    basic: {
      monthly: 'price_1Tju8PHF6eR3tvYNRkdJjSG4',
      annual:  'price_1Tju8PHF6eR3tvYNePJ96HWB',
    },
    business: {
      monthly: 'price_1Tju8PHF6eR3tvYNYAgJtafx',
      annual:  'price_1Tju8OHF6eR3tvYNXBa6ezwx',
    },
    team: {
      monthly: 'price_1Tju8PHF6eR3tvYNIlhC4tDp',
      annual:  'price_1Tju8PHF6eR3tvYN5cl5i6yq',
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
