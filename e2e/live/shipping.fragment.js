
test("shippingCents is added after the discount, and defaults to zero", () => {
  assert.deepEqual(quote([{ unitCents: 199, quantity: 2 }, { unitCents: 349, quantity: 1 }], { discountBps: 1000, shippingCents: 125 }), { subtotalCents: 747, discountCents: 74, totalCents: 798 });
  assert.deepEqual(quote([], { shippingCents: 250 }), { subtotalCents: 0, discountCents: 0, totalCents: 250 });
});

test("rejects invalid shipping and overflowing final totals", () => {
  assert.throws(() => quote([], { shippingCents: -1 }), RangeError);
  assert.throws(() => quote([], { shippingCents: 0.5 }), RangeError);
  assert.throws(() => quote([{ unitCents: Number.MAX_SAFE_INTEGER, quantity: 1 }], { shippingCents: 1 }), RangeError);
});
