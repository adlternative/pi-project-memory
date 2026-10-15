export function quote(items, { discountBps = 0 } = {}) {
  if (!Array.isArray(items)) throw new TypeError("items must be an array");
  if (!Number.isSafeInteger(discountBps) || discountBps < 0 || discountBps > 10000) throw new RangeError("invalid discountBps");
  let subtotal = 0n;
  for (const item of items) {
    if (!item || !Number.isSafeInteger(item.unitCents) || item.unitCents < 0 || !Number.isSafeInteger(item.quantity) || item.quantity < 1) throw new RangeError("invalid line item");
    subtotal += BigInt(item.unitCents) * BigInt(item.quantity);
  }
  if (subtotal > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError("quote exceeds safe integer cents");
  const discount = subtotal * BigInt(discountBps) / 10000n;
  return { subtotalCents: Number(subtotal), discountCents: Number(discount), totalCents: Number(subtotal - discount) };
}
