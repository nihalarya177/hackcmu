import { useState } from 'react';
import { TRIP_LIMITS } from '@trip/contracts';
import { useAdapter } from '../adapter/context';
import { commandKey } from './format';

/**
 * Live onboarding: start a trip, or join one from an invite link.
 *
 * Demo mode never reaches this — its trip already exists and `createTrip` is
 * not implemented there, which is exactly what `capabilities` reports.
 */
export function Onboarding({ onTrip }: { onTrip: (tripId: string) => void }): React.ReactElement {
  const adapter = useAdapter();
  const [tab, setTab] = useState<'create' | 'join'>(
    new URLSearchParams(window.location.search).get('invite') === null ? 'create' : 'join',
  );
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const guard = (work: Promise<{ trip: { id: string } }>): void => {
    setBusy(true);
    setProblem(null);
    void work
      .then(
        (result) => onTrip(result.trip.id),
        (error: unknown) => {
          setProblem(error instanceof Error ? error.message : 'That did not work.');
        },
      )
      .finally(() => setBusy(false));
  };

  return (
    <div className="mx-auto grid w-full max-w-md gap-4 py-8">
      <div className="flex rounded-lg border border-slate-300 p-0.5">
        {(['create', 'join'] as const).map((name) => (
          <button
            key={name}
            type="button"
            onClick={() => setTab(name)}
            aria-pressed={tab === name}
            className={`flex-1 rounded-md px-3 py-1.5 text-sm capitalize ${
              tab === name ? 'bg-slate-900 text-white' : 'text-slate-700'
            }`}
          >
            {name === 'create' ? 'Start a trip' : 'Join a trip'}
          </button>
        ))}
      </div>

      {problem !== null && (
        <p className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">
          {problem}
        </p>
      )}

      {tab === 'create' ? (
        <CreateForm busy={busy} onSubmit={guard} />
      ) : (
        <JoinForm busy={busy} onSubmit={guard} />
      )}

      {!adapter.capabilities.invite && (
        <p className="text-xs text-slate-500">Invites are not available in {adapter.mode} mode.</p>
      )}
    </div>
  );
}

function CreateForm({
  busy,
  onSubmit,
}: {
  busy: boolean;
  onSubmit: (work: Promise<{ trip: { id: string } }>) => void;
}): React.ReactElement {
  const adapter = useAdapter();
  const [tripName, setTripName] = useState('Pittsburgh weekend');
  const [groupName, setGroupName] = useState('The crew');
  const [name, setName] = useState('');
  const [budget, setBudget] = useState('300');
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');

  return (
    <form
      className="grid gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit(
          adapter.createTrip({
            idempotency_key: commandKey('trip'),
            trip_name: tripName.trim(),
            group_name: groupName.trim(),
            destination: {
              kind: 'manual',
              label: 'Pittsburgh, Pennsylvania',
              timezone: 'America/New_York',
              center: { lat: 40.4406, lon: -79.9959 },
            },
            start_date: start,
            end_date: end,
            expected_headcount: 4,
            self_display_name: name.trim(),
            self_budget_cents: Math.round(Number(budget) * 100),
          }),
        );
      }}
    >
      <Field label="Trip name" value={tripName} onChange={setTripName} />
      <Field label="Group name" value={groupName} onChange={setGroupName} />
      <Field label="Your name" value={name} onChange={setName} />
      <div className="grid grid-cols-2 gap-2">
        <Field label="First day" type="date" value={start} onChange={setStart} />
        <Field label="Last day" type="date" value={end} onChange={setEnd} />
      </div>
      <Field label="Your budget ($)" type="number" value={budget} onChange={setBudget} />
      <p className="text-xs text-slate-500">
        One destination, USD, {TRIP_LIMITS.minTripDays}–{TRIP_LIMITS.maxTripDays} days, up to{' '}
        {TRIP_LIMITS.maxMembers} people.
      </p>
      <button
        type="submit"
        disabled={busy || name.trim() === '' || start === '' || end === ''}
        className="rounded-lg bg-slate-900 px-4 py-2 text-sm text-white disabled:opacity-50"
      >
        {busy ? 'Starting…' : 'Start the trip'}
      </button>
    </form>
  );
}

function JoinForm({
  busy,
  onSubmit,
}: {
  busy: boolean;
  onSubmit: (work: Promise<{ trip: { id: string } }>) => void;
}): React.ReactElement {
  const adapter = useAdapter();
  const [token, setToken] = useState(
    new URLSearchParams(window.location.search).get('invite') ?? '',
  );
  const [name, setName] = useState('');
  const [budget, setBudget] = useState('300');

  return (
    <form
      className="grid gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit(
          adapter.joinTrip({
            token: token.trim(),
            display_name: name.trim(),
            budget_cents: Math.round(Number(budget) * 100),
          }),
        );
      }}
    >
      <Field label="Invite code" value={token} onChange={setToken} />
      <Field label="Your name" value={name} onChange={setName} />
      <Field label="Your budget ($)" type="number" value={budget} onChange={setBudget} />
      <button
        type="submit"
        disabled={busy || token.trim() === '' || name.trim() === ''}
        className="rounded-lg bg-slate-900 px-4 py-2 text-sm text-white disabled:opacity-50"
      >
        {busy ? 'Joining…' : 'Join'}
      </button>
    </form>
  );
}

function Field({
  label,
  value,
  onChange,
  type = 'text',
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: string;
}): React.ReactElement {
  return (
    <label className="grid gap-1 text-xs text-slate-600">
      {label}
      <input
        type={type}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="rounded border border-slate-300 px-2 py-1.5 text-sm text-slate-900"
      />
    </label>
  );
}
