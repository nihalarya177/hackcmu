import { useEffect, useRef, useState } from 'react';
import { ArrowUp } from 'lucide-react';
import { TRIP_LIMITS, type ListMessagesResponse, type SnapshotResponse } from '@trip/contracts';
import { api } from '../lib/api';
import { Avatar } from './Avatar';
import { bubble } from './palette';
import { timeAgo } from './format';

/** A send that has not been acknowledged. Never drawn as though it had been. */
type Pending = { nonce: string; body: string; failed: boolean };

/**
 * The conversation is the primary surface: this is where the plan is decided,
 * and the calendar beside it is the consequence.
 *
 * Layout follows `design/references/chat-sample`: your own lines on the right,
 * everyone else's on the left behind their own colour, and a composer pinned
 * to the bottom.
 */
export function Conversation({
  snapshot,
  messages,
  loading,
  draft,
  onDraft,
  onChanged,
  onError,
}: {
  snapshot: SnapshotResponse;
  messages: ListMessagesResponse | undefined;
  loading: boolean;
  draft: string;
  onDraft: (value: string) => void;
  onChanged: () => void;
  onError: (error: unknown) => void;
}): React.ReactElement {
  const [pending, setPending] = useState<Pending[]>([]);
  const bottom = useRef<HTMLDivElement>(null);
  const people = new Map(snapshot.members.map((person) => [person.id, person]));
  const rows = messages?.messages ?? [];
  const selfColor = people.get(snapshot.self_person_id)?.color ?? '#2563eb';

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: 'end' });
  }, [messages?.newest_id, pending.length]);

  // A committed row comes back carrying the nonce we sent, so the optimistic
  // copy retires at render time rather than being shown twice.
  const acknowledged = new Set(rows.map((row) => row.client_nonce).filter((n) => n !== null));
  const unsent = pending.filter((row) => !acknowledged.has(row.nonce));

  const send = (body: string, nonce: string): void => {
    setPending((rows) => [
      ...rows.filter((r) => r.nonce !== nonce),
      { nonce, body, failed: false },
    ]);
    void api.sendMessage(snapshot.trip.id, { body, client_nonce: nonce }).then(
      () => onChanged(),
      (error: unknown) => {
        // Disconnected never means saved: the text stays, with a way to retry.
        setPending((rows) => rows.map((r) => (r.nonce === nonce ? { ...r, failed: true } : r)));
        onError(error);
      },
    );
  };

  const submit = (event: React.FormEvent): void => {
    event.preventDefault();
    const body = draft.trim();
    if (body.length === 0) return;
    onDraft('');
    send(body, crypto.randomUUID());
  };

  return (
    <section className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto px-1 py-2">
        {/* A short conversation sits at the bottom, the way a conversation
            does, and still scrolls normally once it outgrows the column. */}
        <div className="flex min-h-full flex-col justify-end space-y-4">
          {loading && rows.length === 0 && (
            <p className="py-8 text-center text-sm text-faint">Loading the conversation…</p>
          )}
          {!loading && rows.length === 0 && unsent.length === 0 && (
            <div className="py-10 text-center">
              <p className="text-sm font-bold text-ink">Nothing said yet</p>
              <p className="mt-1 text-sm text-muted">
                Talk about what you want to do. Anything you agree on can go straight onto the
                calendar.
              </p>
            </div>
          )}

          {rows.map((message, index) => {
            const author = message.author_person_id;
            const person = author === null ? undefined : people.get(author);
            const mine = author === snapshot.self_person_id;
            const previous = rows[index - 1];
            const grouped = previous?.author_person_id === author && previous.kind === message.kind;

            // The planner reports what it did, so its line is shown as the
            // thing it produced rather than as another voice in the room.
            if (message.kind !== 'user') {
              return message.kind === 'bot' ? (
                <div key={message.id} className="pl-11">
                  <p className="rounded-[18px] bg-ink px-4 py-3 text-[13px] leading-snug text-white/85">
                    {message.body}
                  </p>
                </div>
              ) : (
                <p key={message.id} className="px-6 py-1 text-center text-xs text-faint italic">
                  {message.body}
                </p>
              );
            }

            // Everyone reads down one column. Your own lines are indented and
            // filled in your colour rather than flipped to the other side, so
            // the thread stays one conversation instead of two.
            if (mine) {
              return (
                <div key={message.id} className="pl-11">
                  {!grouped && (
                    <p className="mb-1.5 text-[11px] font-bold" style={{ color: selfColor }}>
                      You
                      <span className="ml-1.5 font-medium text-faint">
                        {timeAgo(message.created_at)}
                      </span>
                    </p>
                  )}
                  <p
                    className="rounded-[18px] rounded-bl-[7px] px-4 py-2.5 text-sm leading-relaxed text-ink"
                    style={{ backgroundColor: bubble(selfColor) }}
                  >
                    {message.body}
                  </p>
                </div>
              );
            }

            return (
              <div key={message.id} className="flex items-end gap-2.5">
                <span className={grouped ? 'invisible' : undefined}>
                  <Avatar
                    name={person?.display_name ?? '?'}
                    color={person?.color ?? '#9b98a5'}
                    size={30}
                  />
                </span>
                <div className="min-w-0">
                  {!grouped && (
                    <p
                      className="mb-1.5 text-[11px] font-bold"
                      style={{ color: person?.color ?? undefined }}
                    >
                      {person?.display_name ?? 'Someone'}
                      <span className="ml-1.5 font-medium text-faint">
                        {timeAgo(message.created_at)}
                      </span>
                    </p>
                  )}
                  <p className="rounded-[18px] rounded-bl-[7px] bg-sunken px-4 py-2.5 text-sm leading-relaxed text-ink">
                    {message.body}
                  </p>
                </div>
              </div>
            );
          })}

          {unsent.map((row) => (
            <div key={row.nonce} className="pl-11">
              <p
                className="rounded-[18px] rounded-bl-[7px] px-4 py-2.5 text-sm leading-relaxed text-ink opacity-55"
                style={{ backgroundColor: bubble(selfColor) }}
              >
                {row.body}
              </p>
              <p className="mt-1 px-1 text-[11px]">
                {row.failed ? (
                  <span className="text-alarm">
                    not sent
                    <button
                      type="button"
                      onClick={() => send(row.body, row.nonce)}
                      className="ml-1.5 underline"
                    >
                      retry
                    </button>
                  </span>
                ) : (
                  <span className="text-faint">sending…</span>
                )}
              </p>
            </div>
          ))}
          <div ref={bottom} />
        </div>
      </div>

      <form onSubmit={submit} className="flex items-end gap-2.5 pt-3">
        <textarea
          value={draft}
          onChange={(event) => onDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              submit(event);
            }
          }}
          rows={1}
          maxLength={TRIP_LIMITS.maxMessageChars}
          placeholder="What should we do?"
          aria-label="Message"
          className="max-h-32 min-h-11 flex-1 resize-none rounded-full bg-ground px-5 py-3 text-sm text-ink placeholder:text-faint focus:outline-none"
        />
        <button
          type="submit"
          disabled={draft.trim().length === 0}
          aria-label="Send"
          className="grid size-11 shrink-0 place-items-center rounded-full bg-ink text-white transition disabled:bg-faint"
        >
          <ArrowUp aria-hidden className="size-5" />
        </button>
      </form>
    </section>
  );
}
