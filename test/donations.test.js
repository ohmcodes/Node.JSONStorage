const { test } = require('node:test');
const assert = require('node:assert/strict');

test('configures both copies of each valid donation link and leaves invalid links disabled', async t => {
  const original = { fetch: global.fetch, document: global.document, window: global.window };
  t.after(() => Object.assign(global, original));
  const links = ['patreon', 'buyMeACoffee', 'paypal'].flatMap(key =>
    Array.from({ length: 2 }, () => ({
      dataset: { donation: key },
      attributes: { 'aria-disabled': 'true', title: 'Not configured' },
      removeAttribute(name) { delete this.attributes[name]; }
    }))
  );
  global.document = { querySelectorAll: () => links };
  global.window = { location: { origin: 'https://example.com' } };
  global.fetch = async () => ({
    ok: true,
    json: async () => ({ donations: {
      patreon: 'https://example.com/patreon',
      buyMeACoffee: 'http://example.com/coffee',
      paypal: 'YOUR_PAYPAL_URL'
    } })
  });
  const { configureDonationLinks } = await import('../public/donations.js');
  await configureDonationLinks();
  for (const link of links.filter(link => link.dataset.donation === 'patreon')) {
    assert.equal(link.href, 'https://example.com/patreon');
    assert.equal(link.target, '_blank');
    assert.equal(link.rel, 'noopener noreferrer');
    assert.equal(link.attributes['aria-disabled'], undefined);
  }
  for (const link of links.filter(link => link.dataset.donation !== 'patreon')) {
    assert.equal(link.href, undefined);
    assert.equal(link.attributes['aria-disabled'], 'true');
  }
});
