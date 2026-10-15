import assert from "node:assert/strict";
import test from "node:test";
import { quote } from "./quote.js";

test("sums quantities using integer cents", () => {
  assert.deepEqual(quote([{ unitCents: 199, quantity: 2 }, { unitCents: 349, quantity: 1 }]), { subtotalCents: 747, discountCents: 0, totalCents: 747 });
});

test("empty carts have zero totals", () => {
  assert.deepEqual(quote([]), { subtotalCents: 0, discountCents: 0, totalCents: 0 });
});

test("discounts round down in integer cents", () => {
  assert.deepEqual(quote([{ unitCents: 199, quantity: 1 }], { discountBps: 5000 }), { subtotalCents: 199, discountCents: 99, totalCents: 100 });
  assert.deepEqual(quote([{ unitCents: 199, quantity: 2 }, { unitCents: 349, quantity: 1 }], { discountBps: 1000 }), { subtotalCents: 747, discountCents: 74, totalCents: 673 });
});

test("rejects negative prices, fractional quantities and out-of-range discounts", () => {
  assert.throws(() => quote([{ unitCents: -1, quantity: 1 }]), RangeError);
  assert.throws(() => quote([{ unitCents: 100, quantity: 1.5 }]), RangeError);
  assert.throws(() => quote([], { discountBps: 10001 }), RangeError);
  assert.throws(() => quote([], { discountBps: -1 }), RangeError);
});

test("rejects invalid input and unsafe integer totals", () => {
  assert.throws(() => quote(null), TypeError);
  assert.throws(() => quote([{ unitCents: Number.MAX_SAFE_INTEGER, quantity: 2 }]), RangeError);
});
