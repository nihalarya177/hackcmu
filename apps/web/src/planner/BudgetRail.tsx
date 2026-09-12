import { useState } from 'react';
import type { SnapshotResponse } from '@trip/contracts';
import { api } from '../lib/api';
import { Avatar } from './Avatar';
import { commandKey, money } from './format';

/**
 * Who is on the trip and what each of them has committed.
 *
 * A row of people rather than a stack of cards: the colour and the initials
 * are the same ones used in the conversation and on the calendar, so this
 * reads as the same three people, not a separate widget.
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
    <ul className="flex min-w-0 gap-6 overflow-x-auto">
      {snapshot.members.map((person) => {
        const budget = snapshot.budgets.find((row) => row.person_id === person.id);
        if (budget === undefined) return null;
        const isSelf = person.id === snapshot.self_person_id;
        const over = budget.status === 'over';

        return (
          <li key={person.id} className="flex shrink-0 items-center gap-2.5">
            <Avatar name={person.display_name} color={person.color} size={34} />
            <div className="leading-tight">
              <p className="text-xs font-bold text-ink">{isSelf ? 'You' : person.display_name}</p>
              {isSelf ? (
                <SelfBudget
                  key={budget.budget_cents}
                  snapshot={snapshot}
                  current={budget.budget_cents}
                  spent={budget.known_spend_cents}
                  over={over}
                  onChanged={onChanged}
                  onError={onError}
                />
              ) : (
                <p className={`text-xs tnum ${over ? 'font-semibold text-alarm' : 'text-muted'}`}>
                  {money(budget.known_spend_cents)} of {money(budget.budget_cents)}
                </p>
              )}
              {budget.unknown_price_event_count > 0 && (
                <p className="text-[10px] text-faint">
                  {budget.unknown_price_event_count} unpriced
                </p>
              )}
            </div>
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
    <p className={`flex items-baseline gap-0.5 text-xs tnum ${over ? 'text-alarm' : 'text-muted'}`}>
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
        className="w-11 border-b border-dashed border-faint bg-transparent focus:outline-none disabled:opacity-50"
      />
    </p>
  );
}
