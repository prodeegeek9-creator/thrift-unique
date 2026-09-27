// "Payment in progress", where Buy now or Pay would be, while somebody else is
// on Paystack's page paying for a one-off item (worker/lib/reservations.js). The
// buyer who did can carry on: the same details take them back to the same
// payment.
export default function PaymentInProgress({ minutes, onCheck, onMine, askLink }) {
  return (
    <div className="mt-6 rounded-card border border-line bg-bg p-4 text-center">
      <p className="text-sm font-semibold text-ink">Payment in progress</p>
      <p className="mt-1 text-sm text-muted">
        Someone is paying for this item right now. If their payment doesn't go through, it'll be available again in
        about {minutes} minute{minutes === 1 ? '' : 's'}.
      </p>
      <button
        type="button"
        onClick={onCheck}
        className="mt-3 block w-full rounded-pill border border-line py-3 text-center text-sm font-semibold text-ink"
      >
        Check again
      </button>
      {askLink ? (
        <a href={askLink} className="mt-2 block text-xs font-semibold text-green">
          Ask the store on WhatsApp
        </a>
      ) : null}
      <button type="button" onClick={onMine} className="mt-2 text-xs text-muted underline">
        Started this payment yourself? Continue it
      </button>
    </div>
  );
}
