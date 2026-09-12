import { useEffect, useRef, useState } from 'react';
import { ArrowUp } from 'lucide-react';
import { TRIP_LIMITS, type ListMessagesResponse, type SnapshotResponse } from '@trip/contracts';
import { api } from '../lib/api';
import { initials, timeAgo } from './format';

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
        <div className="flex min-h-full flex-col justify-end space-y-3">
          {loading && rows.length === 0 && (
            <p className="py-8 text-center text-sm text-stone-400">Loading the conversation…</p>
          )}
          {!loading && rows.length === 0 && unsent.length === 0 && (
            <div className="py-10 text-center">
              <p className="text-sm font-medium text-stone-700">Nothing said yet</p>
              <p className="mt-1 text-sm text-stone-500">
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

            if (message.kind !== 'user') {
              return (
                <div key={message.id} className="px-6 py-1">
                  <p
                    className={`rounded-xl px-3 py-2 text-center text-xs ${
                      message.kind === 'bot'
                        ? 'bg-stone-100 text-stone-700'
                        : 'text-stone-400 italic'
                    }`}
                  >
                    {message.body}
                  </p>
                </div>
              );
            }

            return (
              <div
                key={message.id}
                className={`flex items-end gap-2 ${mine ? 'flex-row-reverse' : ''}`}
              >
                <span
                  aria-hidden
                  className={`grid size-7 shrink-0 place-items-center rounded-full text-[10px] font-semibold text-white ${grouped ? 'invisible' : ''}`}
                  style={{ backgroundColor: person?.color ?? '#a8a29e' }}
                >
                  {initials(person?.display_name ?? '?')}
                </span>
                <div className={`max-w-[78%] ${mine ? 'text-right' : ''}`}>
                  {!grouped && (
                    <p className="mb-0.5 px-1 text-[11px] text-stone-500">
                      {mine ? 'You' : (person?.display_name ?? 'Someone')} ·{' '}
                      {timeAgo(message.created_at)}
                    </p>
                  )}
                  <p
                    className={`inline-block rounded-2xl px-3.5 py-2 text-left text-sm leading-snug ${
                      mine
                        ? 'rounded-br-md bg-stone-800 text-white'
                        : 'rounded-bl-md bg-stone-100 text-stone-800'
                    }`}
                  >
                    {message.body}
                  </p>
                </div>
              </div>
            );
          })}

          {unsent.map((row) => (
            <div key={row.nonce} className="flex flex-row-reverse items-end gap-2">
              <span aria-hidden className="size-7 shrink-0" />
              <div className="max-w-[78%] text-right">
                <p className="inline-block rounded-2xl rounded-br-md bg-stone-800/60 px-3.5 py-2 text-left text-sm text-white">
                  {row.body}
                </p>
                <p className="px-1 text-[11px]">
                  {row.failed ? (
                    <span className="text-red-700">
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
                    <span className="text-stone-400">sending…</span>
                  )}
                </p>
              </div>
            </div>
          ))}
          <div ref={bottom} />
        </div>
      </div>

      <form onSubmit={submit} className="flex items-end gap-2 pt-2">
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
          className="max-h-32 min-h-11 flex-1 resize-none rounded-2xl border border-stone-300 bg-white px-4 py-2.5 text-sm text-stone-800 placeholder:text-stone-400 focus:border-stone-500 focus:outline-none"
        />
        <button
          type="submit"
          disabled={draft.trim().length === 0}
          aria-label="Send"
          className="grid size-11 shrink-0 place-items-center rounded-full bg-stone-800 text-white transition disabled:bg-stone-300"
        >
          <ArrowUp aria-hidden className="size-5" />
        </button>
      </form>
    </section>
  );
}
