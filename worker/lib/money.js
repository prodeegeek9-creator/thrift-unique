// Kobo becomes naira here, and nowhere else.
//
// Paystack speaks kobo; this application speaks naira; the conversion happens
// exactly once, at the edge where a Paystack number enters the system. Nothing
// in src/ divides by 100, and nothing else in worker/ should either — a second
// conversion site is how a row ends up 100× or 1/100× and nobody notices until
// a payout.

export function koboToNaira(kobo) {
  const n = Number(kobo);
  if (!Number.isFinite(n) || n < 0) {
    throw new RangeError(`Not a kobo amount: ${kobo}`);
  }
  // Paystack amounts are integers. A fractional kobo means something upstream
  // is wrong, and rounding it away would hide that.
  if (!Number.isInteger(n)) {
    throw new RangeError(`Fractional kobo: ${kobo}`);
  }
  return n / 100;
}

export function nairaToKobo(naira) {
  const n = Number(naira);
  if (!Number.isFinite(n) || n < 0) {
    throw new RangeError(`Not a naira amount: ${naira}`);
  }
  return Math.round(n * 100);
}

// What the platform keeps and what the seller gets.
//
// Two rules, and the second one was found by a test rather than by thinking:
//
// The seller's share is the remainder, never computed separately, so
// commission + net is exactly the gross and a rounding fraction can neither go
// missing nor be paid twice.
//
// And the commission is floored, not rounded to nearest. Gross amounts are not
// always whole naira — kobo/100 gives ₦3500.50 readily enough — and rounding
// 100% of ₦1234.56 to nearest yields ₦1235, which is more than the sale. That
// produced a negative payout. Flooring keeps the commission at or below the
// gross for any rate up to 100%, so net can never go below zero, and it puts
// the sub-naira remainder on the seller's side of the line, which is the right
// direction for a fee to round.
export function split(amountNaira, commissionPct) {
  const gross = Number(amountNaira);
  const pct = Number(commissionPct) || 0;

  if (!Number.isFinite(gross) || gross < 0) {
    throw new RangeError(`Not an amount: ${amountNaira}`);
  }
  if (pct < 0 || pct > 100) {
    throw new RangeError(`Commission out of range: ${commissionPct}`);
  }

  const commission = Math.floor((gross * pct) / 100);
  return { gross, commission, net: gross - commission };
}
