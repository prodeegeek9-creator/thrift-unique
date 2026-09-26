import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import PageHeader from '../../components/ui/PageHeader.jsx';
import { LoadingRows } from '../../components/ui/EmptyState.jsx';
import { useToast } from '../../lib/ToastContext.jsx';
import { fetchTeam, addToTeam, setTeamLevel, removeFromTeam, newTeamLink } from '../../lib/admin.js';
import { dateOnly } from '../../lib/time.js';

// Who can open the platform console. Owners add and remove people here; support
// sees the list. The Worker holds the same line (worker/routes/adminTeam.js),
// and also refuses anybody changing their own access, so the platform can
// never lose its last owner.

const LEVEL_HELP = {
  support: 'Can see every store and resolve disputes.',
  owner: 'Can also move money, change plans and fees, and manage this team.',
};

export default function AdminTeam({ operator }) {
  const isOwner = operator?.level === 'owner';
  const { data, isLoading } = useQuery({ queryKey: ['admin', 'team'], queryFn: fetchTeam });
  const [link, setLink] = useState(null);

  return (
    <>
      <PageHeader title="Admin team" subtitle="The people who can sign in to this console." />

      {link ? <LinkCard link={link} onClose={() => setLink(null)} /> : null}

      {isOwner ? <AddForm onLink={setLink} /> : null}

      <div className="card overflow-hidden">
        {isLoading ? (
          <LoadingRows rows={3} className="p-4" />
        ) : (
          <ul className="divide-y divide-line">
            {(data?.team ?? []).map((m) => (
              <Member key={m.user_id} member={m} canEdit={isOwner && !m.you} onLink={setLink} />
            ))}
          </ul>
        )}
      </div>

      <dl className="mt-4 space-y-1 text-xs text-muted">
        {Object.entries(LEVEL_HELP).map(([level, text]) => (
          <div key={level} className="flex gap-1">
            <dt className="font-semibold capitalize text-text">{level}:</dt>
            <dd>{text}</dd>
          </div>
        ))}
      </dl>
    </>
  );
}

function AddForm({ onLink }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [email, setEmail] = useState('');
  const [level, setLevel] = useState('support');

  const add = useMutation({
    mutationFn: () => addToTeam(email, level),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ['admin', 'team'] });
      qc.invalidateQueries({ queryKey: ['admin', 'audit'] });
      setEmail('');
      if (r.link) {
        onLink({ email: r.email, url: r.link, kind: 'invite' });
      } else {
        toast(`${r.email} is on the team. They sign in with the password they already have.`, 'success');
      }
    },
    onError: (e) => toast(e.message, 'error'),
  });

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        add.mutate();
      }}
      className="card mb-4 flex flex-wrap items-end gap-3 p-4"
    >
      <label className="min-w-[220px] flex-1">
        <span className="mb-1 block text-xs font-medium text-muted">Email</span>
        <input
          type="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="colleague@example.com"
          className="w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm outline-none focus:border-green/40"
        />
      </label>
      <label>
        <span className="mb-1 block text-xs font-medium text-muted">Level</span>
        <select
          value={level}
          onChange={(e) => setLevel(e.target.value)}
          className="rounded-lg border border-line bg-surface px-3 py-2 text-sm"
        >
          <option value="support">Support</option>
          <option value="owner">Owner</option>
        </select>
      </label>
      <button
        type="submit"
        disabled={add.isPending}
        className="rounded-pill bg-ink px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
      >
        {add.isPending ? 'Adding…' : 'Add to team'}
      </button>
    </form>
  );
}

function Member({ member, canEdit, onLink }) {
  const qc = useQueryClient();
  const toast = useToast();
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['admin', 'team'] });
    qc.invalidateQueries({ queryKey: ['admin', 'audit'] });
  };

  const level = useMutation({
    mutationFn: (next) => setTeamLevel(member.user_id, next),
    onSuccess: refresh,
    onError: (e) => toast(e.message, 'error'),
  });
  const remove = useMutation({
    mutationFn: () => removeFromTeam(member.user_id),
    onSuccess: () => {
      refresh();
      toast(`${member.email ?? 'They'} can no longer open the console.`, 'success');
    },
    onError: (e) => toast(e.message, 'error'),
  });
  const link = useMutation({
    mutationFn: () => newTeamLink(member.user_id),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ['admin', 'audit'] });
      onLink({ email: member.email, url: r.link, kind: 'reset' });
    },
    onError: (e) => toast(e.message, 'error'),
  });

  const busy = level.isPending || remove.isPending || link.isPending;

  return (
    <li className="flex flex-wrap items-center gap-3 p-4">
      <div className="min-w-[200px] flex-1">
        <p className="truncate text-sm font-medium text-ink">
          {member.email ?? member.user_id}
          {member.you ? <span className="ml-2 text-xs font-normal text-muted">(you)</span> : null}
        </p>
        <p className="text-xs text-muted">Added {dateOnly(member.created_at)}</p>
      </div>

      {canEdit ? (
        <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
          <select
            aria-label="Level"
            value={member.level}
            disabled={busy}
            onChange={(e) => level.mutate(e.target.value)}
            className="rounded-lg border border-line bg-surface px-2 py-1.5 text-xs capitalize"
          >
            <option value="support">Support</option>
            <option value="owner">Owner</option>
          </select>
          <button
            type="button"
            disabled={busy}
            onClick={() => link.mutate()}
            className="rounded-pill border border-line px-3 py-1.5 text-xs text-text hover:bg-bg disabled:opacity-60"
          >
            New sign-in link
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              if (window.confirm(`Remove ${member.email ?? 'this person'} from the admin team?`)) remove.mutate();
            }}
            className="rounded-pill border border-red/30 px-3 py-1.5 text-xs text-red hover:bg-red-lt disabled:opacity-60"
          >
            Remove
          </button>
        </div>
      ) : (
        <span className="rounded-pill bg-bg px-2.5 py-1 text-xs font-medium capitalize text-text">
          {member.level}
        </span>
      )}
    </li>
  );
}

// A sign-in link is shown once and never stored, so it is copied or shared from
// here. It opens /admin/login, where they choose a password.
function LinkCard({ link, onClose }) {
  const toast = useToast();
  const message =
    link.kind === 'invite'
      ? `You've been added to the Unique Thrift admin team. Open this link to choose your password: ${link.url}`
      : `Here's a link to set a new password for the Unique Thrift admin console: ${link.url}`;

  return (
    <div className="card mb-4 space-y-3 border-gold/40 p-4">
      <div>
        <p className="text-sm font-semibold text-ink">
          {link.kind === 'invite' ? `Send ${link.email} their sign-in link` : `New sign-in link for ${link.email}`}
        </p>
        <p className="mt-0.5 text-xs text-muted">
          It works once and is shown only now. Send it to them privately.
        </p>
      </div>
      <p className="break-all rounded-lg bg-bg px-3 py-2 font-mono text-[11px] text-text">{link.url}</p>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() =>
            navigator.clipboard
              ?.writeText(link.url)
              .then(() => toast('Link copied', 'success'))
              .catch(() => toast('Copy it by hand', 'error'))
          }
          className="rounded-pill bg-ink px-4 py-1.5 text-xs font-semibold text-white"
        >
          Copy link
        </button>
        <a
          href={`https://wa.me/?text=${encodeURIComponent(message)}`}
          target="_blank"
          rel="noreferrer"
          className="rounded-pill bg-green px-4 py-1.5 text-xs font-semibold text-white"
        >
          Send on WhatsApp
        </a>
        <button type="button" onClick={onClose} className="px-2 text-xs text-muted hover:text-text">
          Done
        </button>
      </div>
    </div>
  );
}
