import { useState } from 'react';
import type { SnapshotResponse } from '@trip/contracts';
import { api } from '../lib/api';
import { commandKey, initials, money } from './format';

/**
 * Who is on the trip and what each of them has committed.
 *
 * Compact by design: this is context for the conversation, not the subject of
 * the screen. Only your own budget is editable, because only your own is yours.
 */
export function BudgetRail({
  snapshot,
  onChanged,
  onError,
}: {
  snapshot: SnapshotResponse;
  onChanged: () => void;
  onError: (error: unknown) => void;
}): React.ReactElement {
  return (
    <ul className="flex gap-2 overflow-x-auto pb-1">
      {snapshot.members.map((person) => {
        const budget = snapshot.budgets.find((row) => row.person_id === person.id);
        if (budget === undefined) return null;
        const isSelf = person.id === snapshot.self_person_id;

        return (
          <li
            key={person.id}
            className={`flex w-40 shrink-0 items-center gap-2 rounded-xl border px-2.5 py-2 ${
              budget.status === 'over' ? 'border-red-200 bg-red-50' : 'border-stone-200 bg-white'
            }`}
          >
            <span
              aria-hidden
              className="grid size-7 shrink-0 place-items-center rounded-full text-[10px] font-semibold text-white"
              style={{ backgroundColor: person.color }}
            >
              {initials(person.display_name)}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-xs font-medium text-stone-800">
                {person.display_name}
                {isSelf && <span className="ml-1 text-stone-400">you</span>}
              </span>
              {isSelf ? (
                <SelfBudget
                  key={budget.budget_cents}
                  snapshot={snapshot}
                  current={budget.budget_cents}
                  spent={budget.known_spend_cents}
                  over={budget.status === 'over'}
                  onChanged={onChanged}
                  onError={onError}
                />
              ) : (
                <span
                  className={`block text-[11px] ${budget.status === 'over' ? 'font-semibold text-red-700' : 'text-stone-500'}`}
                >
                  {money(budget.known_spend_cents)} of {money(budget.budget_cents)}
                </span>
              )}
              {budget.unknown_price_event_count > 0 && (
                <span className="block text-[10px] text-stone-400">
                  +{budget.unknown_price_event_count} unpriced
                </span>
              )}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

function SelfBudget({
  snapshot,
  current,
  spent,
  over,
  onChanged,
  onError,
}: {
  snapshot: SnapshotResponse;
  current: number;
  spent: number;
  over: boolean;
  onChanged: () => void;
  onError: (error: unknown) => void;
}): React.ReactElement {
  const [value, setValue] = useState(String(current / 100));
  const [busy, setBusy] = useState(false);

  const save = (): void => {
    const dollars = Number(value);
    if (!Number.isFinite(dollars) || dollars < 0) return setValue(String(current / 100));
    const cents = Math.round(dollars * 100);
    if (cents === current) return;

    setBusy(true);
    void api
      .patchSelf(snapshot.trip.id, {
        idempotency_key: commandKey('budget'),
        expected_calendar_version: snapshot.calendar_version,
        budget_cents: cents,
      })
      .then(onChanged, onError)
      .finally(() => setBusy(false));
  };

  return (
    <span
      className={`flex items-baseline gap-0.5 text-[11px] ${over ? 'text-red-700' : 'text-stone-500'}`}
    >
      <span className={over ? 'font-semibold' : undefined}>{money(spent)}</span>
      <span>of $</span>
      <input
        type="number"
        min={0}
        step={10}
        value={value}
        disabled={busy}
        aria-label="My budget"
        onChange={(event) => setValue(event.target.value)}
        onBlur={save}
        onKeyDown={(event) => {
          if (event.key === 'Enter') event.currentTarget.blur();
        }}
        className="w-12 border-b border-dashed border-stone-400 bg-transparent text-[11px] focus:outline-none disabled:opacity-50"
      />
    </span>
  );
}
