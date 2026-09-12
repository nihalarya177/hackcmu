import { useState } from 'react';
import type { SnapshotResponse } from '@trip/contracts';
import { useAdapter } from '../adapter/context';
import { commandKey, money } from './format';

/**
 * Fixed left panel: who is on the trip, what each of them has committed, and
 * what the planner does not know. Only your own budget is editable.
 */
export function BudgetPanel({
  snapshot,
  onChanged,
  onError,
}: {
  snapshot: SnapshotResponse;
  onChanged: () => void;
  onError: (error: unknown) => void;
}): React.ReactElement {
  const adapter = useAdapter();
  const self = snapshot.self_person_id;

  return (
    <aside className="flex w-full shrink-0 flex-col gap-3 border-slate-200 md:gap-4 md:border-r md:pr-5">
      <div>
        <h2 className="text-xs font-semibold tracking-wide text-slate-500 uppercase">Budgets</h2>
        {/* A row that scrolls sideways on a phone, where a full-height column
            would leave no room for the conversation; a column on a wide screen. */}
        <ul className="mt-2 flex gap-2 overflow-x-auto pb-1 md:grid md:overflow-visible md:pb-0">
          {snapshot.members.map((person) => {
            const budget = snapshot.budgets.find((row) => row.person_id === person.id);
            if (budget === undefined) return null;
            const isSelf = person.id === self;
            return (
              <li
                key={person.id}
                className={`w-52 shrink-0 rounded-lg border p-3 md:w-auto ${
                  isSelf ? 'border-slate-400 bg-white' : 'border-slate-200 bg-white/60'
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="flex items-center gap-2 text-sm font-medium text-slate-800">
                    <span
                      aria-hidden
                      className="inline-block size-2.5 rounded-full"
                      style={{ backgroundColor: person.color }}
                    />
                    {person.display_name}
                    {isSelf && <span className="text-xs text-slate-500">(you)</span>}
                  </span>
                  <StatusPill status={budget.status} />
                </div>

                <p className="mt-1 text-sm text-slate-600">
                  <span
                    className={budget.status === 'over' ? 'font-semibold text-red-700' : undefined}
                  >
                    {money(budget.known_spend_cents)}
                  </span>{' '}
                  of {money(budget.budget_cents)}
                </p>

                {budget.estimate_subtotal_cents > 0 && (
                  <p className="text-xs text-slate-500">
                    includes {money(budget.estimate_subtotal_cents)} in estimates
                  </p>
                )}
                {budget.unknown_price_event_count > 0 && (
                  <p className="text-xs text-slate-500">
                    {budget.unknown_price_event_count} event
                    {budget.unknown_price_event_count === 1 ? '' : 's'} with no known price
                  </p>
                )}

                {isSelf && adapter.capabilities.selfProfile && (
                  // Keyed on the stored value, so a change made elsewhere (or by
                  // a scenario) remounts the field instead of being overwritten.
                  <SelfBudgetField
                    key={budget.budget_cents}
                    snapshot={snapshot}
                    current={budget.budget_cents}
                    onChanged={onChanged}
                    onError={onError}
                  />
                )}
              </li>
            );
          })}
        </ul>
      </div>

      <WarningList snapshot={snapshot} />
    </aside>
  );
}

function StatusPill({ status }: { status: 'within' | 'over' | 'unknown' }): React.ReactElement {
  const style =
    status === 'over'
      ? 'bg-red-100 text-red-800'
      : status === 'unknown'
        ? 'bg-slate-100 text-slate-600'
        : 'bg-emerald-100 text-emerald-800';
  return <span className={`rounded-full px-2 py-0.5 text-xs ${style}`}>{status}</span>;
}

function SelfBudgetField({
  snapshot,
  current,
  onChanged,
  onError,
}: {
  snapshot: SnapshotResponse;
  current: number;
  onChanged: () => void;
  onError: (error: unknown) => void;
}): React.ReactElement {
  const adapter = useAdapter();
  const [value, setValue] = useState(String(current / 100));
  const [saving, setSaving] = useState(false);

  const save = (): void => {
    const dollars = Number(value);
    if (!Number.isFinite(dollars) || dollars < 0) {
      setValue(String(current / 100));
      return;
    }
    const cents = Math.round(dollars * 100);
    if (cents === current) return;

    setSaving(true);
    void adapter
      .patchSelf(snapshot.trip.id, {
        idempotency_key: commandKey('budget'),
        expected_calendar_version: snapshot.calendar_version,
        budget_cents: cents,
      })
      .then(onChanged, onError)
      .finally(() => setSaving(false));
  };

  return (
    <label className="mt-2 flex items-center gap-2 text-xs text-slate-600">
      My budget
      <span className="text-slate-400">$</span>
      <input
        type="number"
        min={0}
        step={10}
        value={value}
        disabled={saving}
        onChange={(event) => setValue(event.target.value)}
        onBlur={save}
        onKeyDown={(event) => {
          if (event.key === 'Enter') event.currentTarget.blur();
        }}
        className="w-20 rounded border border-slate-300 px-2 py-1 text-slate-800 disabled:opacity-50"
      />
    </label>
  );
}

function WarningList({ snapshot }: { snapshot: SnapshotResponse }): React.ReactElement | null {
  const active = snapshot.warnings.filter((warning) => warning.active);
  const names = new Map(snapshot.members.map((person) => [person.id, person.display_name]));
  const events = new Map(snapshot.events.map((event) => [event.id, event.label]));
  if (active.length === 0) return null;

  return (
    <div>
      <h2 className="text-xs font-semibold tracking-wide text-slate-500 uppercase">Watch out</h2>
      <ul className="mt-2 grid max-h-28 gap-2 overflow-y-auto md:max-h-none">
        {active.map((warning) => (
          <li
            key={warning.key}
            className="rounded-lg border border-amber-200 bg-amber-50 p-2 text-xs text-amber-900"
          >
            <span className="font-medium">
              {warning.person_id === null
                ? 'This trip'
                : (names.get(warning.person_id) ?? 'Someone')}
            </span>{' '}
            {describe(warning, events)}
          </li>
        ))}
      </ul>
    </div>
  );
}

function describe(
  warning: SnapshotResponse['warnings'][number],
  events: Map<string, string>,
): string {
  const named = warning.event_ids.map((id) => events.get(id) ?? 'a deleted event');
  switch (warning.kind) {
    case 'double_booking':
      return `is booked twice at once: ${named.join(' and ')} overlap by ${warning.details.overlap_minutes} minutes.`;
    case 'budget_exceeded':
      return `is over budget: ${money(warning.details.known_spend_cents)} committed against ${money(warning.details.budget_cents)}.`;
    case 'insufficient_travel_time':
      return `has ${warning.details.available_minutes} minutes between ${named.join(' and ')}, and the straight-line estimate needs ${warning.details.required_minutes ?? '?'}.`;
    case 'venue_closed':
      return `has ${named.join(' and ')} at a venue recorded as closed that day.`;
    case 'outside_opening_hours':
      return `has ${named.join(' and ')} outside the venue's recorded hours.`;
  }
}
