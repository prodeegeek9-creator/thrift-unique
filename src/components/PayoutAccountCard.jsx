import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useToast } from '../lib/ToastContext.jsx';
import { fetchBanks, fetchPayoutAccount, resolveBankAccount, saveBankAccount } from '../lib/payouts.js';
import { keys, tenantScope } from '../lib/queryKeys.js';

// Where the store's money goes.
//
// Two steps on purpose: the bank says whose account a number is before
// anything is saved, so a mistyped digit shows up as the wrong name rather
// than as a payout to a stranger. Only the owner can change it; the change is
// also sent to the owner's WhatsApp.
export default function PayoutAccountCard({ tenantId, isOwner }) {
  const toast = useToast();
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [bank, setBank] = useState('');
  const [number, setNumber] = useState('');
  const [name, setName] = useState(null);
  const [error, setError] = useState(null);

  const { data: account, isLoading } = useQuery({
    queryKey: keys.payoutAccount(tenantId),
    queryFn: () => fetchPayoutAccount(tenantId),
    enabled: Boolean(tenantId),
  });

  const { data: banks } = useQuery({
    queryKey: keys.banks(tenantId),
    queryFn: () => fetchBanks(tenantId),
    enabled: Boolean(tenantId && isOwner && (editing || (!isLoading && !account))),
    staleTime: 6 * 3600_000,
    retry: false,
  });

  const check = useMutation({
    mutationFn: () => resolveBankAccount(tenantId, bank, number),
    onSuccess: (r) => {
      setName(r.account_name);
      setError(null);
    },
    onError: (e) => {
      setName(null);
      setError(e.message);
    },
  });

  const save = useMutation({
    mutationFn: () => saveBankAccount(tenantId, bank, number),
    onSuccess: (r) => {
      qc.invalidateQueries(tenantScope(tenantId));
      setEditing(false);
      setNumber('');
      setName(null);
      toast(r.sent ? `Saved. ${r.sent} waiting payout${r.sent === 1 ? '' : 's'} sent.` : 'Payout account saved', 'success');
    },
    onError: (e) => setError(e.message),
  });

  const showForm = isOwner && (editing || (!isLoading && !account));

  return (
    <div className="card h-fit p-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-ink">Payout account</h2>
        {account && isOwner && !editing ? (
          <button type="button" onClick={() => setEditing(true)} className="text-xs font-semibold text-green">
            Change
          </button>
        ) : null}
      </div>

      {isLoading ? (
        <div className="mt-3 h-12 animate-pulse rounded-lg bg-surface-2" />
      ) : account && !editing ? (
        <div className="mt-2 text-sm">
          <p className="font-medium text-ink">{account.account_name}</p>
          <p className="text-muted">
            {account.bank_name} ••••{account.account_last4}
          </p>
          <p className="mt-2 text-[11px] text-muted">Payouts are sent here automatically.</p>
        </div>
      ) : !showForm ? (
        <p className="mt-2 text-sm text-muted">
          No bank account yet. The store owner adds it here; payouts wait until they do.
        </p>
      ) : (
        <div className="mt-3 space-y-2">
          {!account ? (
            <p className="text-xs text-amber">Add your bank account to receive payouts. Anything you're owed is sent as soon as you save.</p>
          ) : null}
          <select
            value={bank}
            onChange={(e) => {
              setBank(e.target.value);
              setName(null);
            }}
            className={FIELD}
            aria-label="Bank"
          >
            <option value="">{banks ? 'Choose your bank' : 'Loading banks…'}</option>
            {(banks ?? []).map((b) => (
              <option key={b.code} value={b.code}>
                {b.name}
              </option>
            ))}
          </select>
          <input
            value={number}
            onChange={(e) => {
              setNumber(e.target.value.replace(/\D/g, '').slice(0, 10));
              setName(null);
            }}
            inputMode="numeric"
            placeholder="10-digit account number"
            aria-label="Account number"
            className={FIELD}
          />

          {name ? (
            <p className="rounded-lg bg-green-lt px-3 py-2 text-sm text-green">
              Account name: <span className="font-semibold">{name}</span>
            </p>
          ) : null}
          {error ? <p className="text-xs text-red">{error}</p> : null}

          {name ? (
            <button
              type="button"
              disabled={save.isPending}
              onClick={() => save.mutate()}
              className="w-full rounded-pill bg-green py-2 text-sm font-semibold text-white disabled:opacity-50"
            >
              {save.isPending ? 'Saving…' : 'Yes, pay me here'}
            </button>
          ) : (
            <button
              type="button"
              disabled={!bank || number.length !== 10 || check.isPending}
              onClick={() => check.mutate()}
              className="w-full rounded-pill bg-green py-2 text-sm font-semibold text-white disabled:opacity-40"
            >
              {check.isPending ? 'Checking…' : 'Check account'}
            </button>
          )}
          {editing ? (
            <button type="button" onClick={() => setEditing(false)} className="w-full text-center text-xs text-muted">
              Cancel
            </button>
          ) : null}
        </div>
      )}
    </div>
  );
}

const FIELD =
  'w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink outline-none focus:border-green/40';
