import BrandMark from '../../components/ui/BrandMark.jsx';

// How escrow actually releases.
//
// The spec says funds are held "until the buyer confirms receipt" but never
// says how. Doing it purely in the bot — "reply CONFIRM" — is fragile in the
// ways that matter most at the moment money moves: WhatsApp sessions drop, the
// message scrolls away under newer ones, and a buyer is being asked to release
// tens of thousands of naira by typing a word, with no record either side can
// point at when it is disputed later.
//
// So: one signed link, one order, one button. The item, the amount, the
// seller, and what confirming means.
//
// The link is signed and verified in the Worker under the service key rather
// than read here through RLS, because the buyer has no account — there is
// nobody for a policy to identify. That makes the signature the only thing
// standing between a guessed URL and somebody else's money, so it carries an
// expiry and is single-use.
//
// Growth and Business only. Starter pays out instantly and has nothing to
// confirm. Phase 3, with the rest of escrow.
export default function ConfirmReceipt() {
  return (
    <div className="min-h-dvh bg-bg px-4 py-6">
      <div className="mx-auto max-w-sm">
        <div className="mb-4 flex justify-center">
          <BrandMark className="h-8 w-8" />
        </div>
        <div className="card p-5 text-center text-sm text-muted">
          Not built yet.
        </div>
      </div>
    </div>
  );
}
