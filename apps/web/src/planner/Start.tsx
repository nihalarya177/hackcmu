import { useEffect, useState } from 'react';
import { DateTime } from 'luxon';
import { TRIP_LIMITS, type InvitePreviewResponse } from '@trip/contracts';
import { api, ApiRequestError } from '../lib/api';
import { commandKey, dayLabel } from './format';

/**
 * Starting or joining a trip.
 *
 * An invite link lands here with its token, so the first thing someone sees is
 * the trip they were invited to, not a form asking what they want.
 */
export function Start({ onTrip }: { onTrip: (tripId: string) => void }): React.ReactElement {
  const token = new URLSearchParams(window.location.search).get('invite');
  return token === null ? (
    <CreateTrip onTrip={onTrip} />
  ) : (
    <JoinTrip token={token} onTrip={onTrip} />
  );
}

function Shell({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <main className="grid min-h-screen place-items-center bg-stone-50 p-6">
      <div className="w-full max-w-sm">
        <h1 className="text-xl font-semibold text-stone-900">{title}</h1>
        <p className="mt-1 mb-5 text-sm text-stone-500">{subtitle}</p>
        {children}
      </div>
    </main>
  );
}

function CreateTrip({ onTrip }: { onTrip: (tripId: string) => void }): React.ReactElement {
  const today = DateTime.now();
  const [tripName, setTripName] = useState('');
  const [groupName, setGroupName] = useState('');
  const [destination, setDestination] = useState('Pittsburgh, Pennsylvania');
  const [name, setName] = useState('');
  const [budget, setBudget] = useState('300');
  const [start, setStart] = useState(today.plus({ days: 7 }).toISODate() ?? '');
  const [end, setEnd] = useState(today.plus({ days: 9 }).toISODate() ?? '');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const submit = (event: React.FormEvent): void => {
    event.preventDefault();
    setProblem(null);
    setBusy(true);
    void api
      .createTrip({
        idempotency_key: commandKey('trip'),
        trip_name: tripName.trim(),
        group_name: groupName.trim(),
        destination: {
          kind: 'manual',
          label: destination.trim(),
          // Place search is not enabled, so the centre is supplied directly.
          center: { lat: 40.4406, lon: -79.9959 },
          timezone: DateTime.local().zoneName ?? 'America/New_York',
        },
        start_date: start,
        end_date: end,
        expected_headcount: 4,
        self_display_name: name.trim(),
        self_budget_cents: Math.round(Number(budget) * 100),
      })
      .then(
        (result) => onTrip(result.trip.id),
        (error: unknown) => setProblem(describe(error)),
      )
      .finally(() => setBusy(false));
  };

  const ready =
    tripName.trim() !== '' &&
    groupName.trim() !== '' &&
    name.trim() !== '' &&
    start !== '' &&
    end !== '';

  return (
    <Shell title="Plan a trip together" subtitle="Everyone talks it through; the plan keeps up.">
      <form onSubmit={submit} className="grid gap-3">
        <Field
          label="Trip"
          value={tripName}
          onChange={setTripName}
          placeholder="Pittsburgh weekend"
        />
        <Field
          label="Who's going"
          value={groupName}
          onChange={setGroupName}
          placeholder="Robotics club"
        />
        <Field label="Where" value={destination} onChange={setDestination} />
        <div className="grid grid-cols-2 gap-3">
          <Field label="From" type="date" value={start} onChange={setStart} />
          <Field label="To" type="date" value={end} onChange={setEnd} />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Your name" value={name} onChange={setName} placeholder="Ada" />
          <Field label="Your budget ($)" type="number" value={budget} onChange={setBudget} />
        </div>
        <p className="text-[11px] text-stone-400">
          One destination, USD, up to {TRIP_LIMITS.maxTripDays} days and {TRIP_LIMITS.maxMembers}{' '}
          people.
        </p>
        {problem !== null && <Problem>{problem}</Problem>}
        <button
          type="submit"
          disabled={busy || !ready}
          className="rounded-lg bg-stone-800 px-4 py-2.5 text-sm font-medium text-white disabled:opacity-40"
        >
          {busy ? 'Starting…' : 'Start planning'}
        </button>
      </form>
    </Shell>
  );
}

function JoinTrip({
  token,
  onTrip,
}: {
  token: string;
  onTrip: (tripId: string) => void;
}): React.ReactElement {
  const [preview, setPreview] = useState<InvitePreviewResponse | null>(null);
  const [name, setName] = useState('');
  const [budget, setBudget] = useState('300');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    void api.previewInvite(token).then(setPreview, (error: unknown) => setProblem(describe(error)));
  }, [token]);

  const submit = (event: React.FormEvent): void => {
    event.preventDefault();
    setProblem(null);
    setBusy(true);
    void api
      .joinTrip({
        token,
        display_name: name.trim(),
        budget_cents: Math.round(Number(budget) * 100),
      })
      .then(
        (result) => onTrip(result.trip.id),
        (error: unknown) => setProblem(describe(error)),
      )
      .finally(() => setBusy(false));
  };

  if (problem !== null && preview === null) {
    return (
      <Shell title="That invite did not work" subtitle="Ask whoever sent it for a fresh link.">
        <Problem>{problem}</Problem>
      </Shell>
    );
  }
  if (preview === null) {
    return <Shell title="Checking the invite…" subtitle="One moment." children={null} />;
  }
  if (!preview.join_available) {
    return (
      <Shell
        title={preview.trip_name}
        subtitle={`This invite cannot be used${preview.unavailable_reason === null ? '' : `: ${preview.unavailable_reason.replace('_', ' ')}`}.`}
      >
        <Problem>Ask whoever sent it for a fresh link.</Problem>
      </Shell>
    );
  }

  return (
    <Shell
      title={preview.trip_name}
      subtitle={`${preview.group_name} · ${preview.destination_label} · ${dayLabel(preview.start_date)} – ${dayLabel(preview.end_date)}`}
    >
      <form onSubmit={submit} className="grid gap-3">
        <Field label="Your name" value={name} onChange={setName} placeholder="Grace" />
        <Field label="Your budget ($)" type="number" value={budget} onChange={setBudget} />
        {problem !== null && <Problem>{problem}</Problem>}
        <button
          type="submit"
          disabled={busy || name.trim() === ''}
          className="rounded-lg bg-stone-800 px-4 py-2.5 text-sm font-medium text-white disabled:opacity-40"
        >
          {busy ? 'Joining…' : 'Join the trip'}
        </button>
      </form>
    </Shell>
  );
}

function describe(error: unknown): string {
  if (error instanceof ApiRequestError) {
    if (error.code === 'TRIP_FULL') return 'That trip is already full.';
    if (error.code === 'INVITE_INVALID') return 'That invite link is not valid.';
    if (error.code === 'NETWORK') return 'Could not reach the server. Check it is running.';
    return error.message;
  }
  return error instanceof Error ? error.message : 'Something went wrong.';
}

function Problem({ children }: { children: React.ReactNode }): React.ReactElement {
  return (
    <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
      {children}
    </p>
  );
}

function Field({
  label,
  value,
  onChange,
  type = 'text',
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: string;
  placeholder?: string;
}): React.ReactElement {
  return (
    <label className="grid gap-1 text-[11px] font-medium tracking-wide text-stone-500 uppercase">
      {label}
      <input
        type={type}
        value={value}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
        className="rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm text-stone-900 placeholder:text-stone-300 focus:border-stone-500 focus:outline-none"
      />
    </label>
  );
}
