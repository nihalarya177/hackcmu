import { useEffect, useRef, useState } from 'react';
import { Send } from 'lucide-react';
import { TRIP_LIMITS, type ListMessagesResponse, type SnapshotResponse } from '@trip/contracts';
import { useAdapter } from '../adapter/context';

/** A send that has not been acknowledged yet. Never shown as saved. */
type Pending = { nonce: string; body: string; state: 'sending' | 'failed' };

/**
 * The transcript plus the composer, following `design/references/chat-sample`:
 * your own lines on the right, everyone else's on the left behind their colour,
 * and the planner's own notices set apart from both.
 */
export function ChatPanel({
  snapshot,
  messages,
  loading,
  draft,
  onDraftChange,
  onChanged,
  onError,
}: {
  snapshot: SnapshotResponse;
  messages: ListMessagesResponse | undefined;
  loading: boolean;
  draft: string;
  onDraftChange: (value: string) => void;
  onChanged: () => void;
  onError: (error: unknown) => void;
}): React.ReactElement {
  const adapter = useAdapter();
  const [pending, setPending] = useState<Pending[]>([]);
  const bottom = useRef<HTMLDivElement>(null);
  const people = new Map(snapshot.members.map((person) => [person.id, person]));

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: 'end' });
  }, [messages?.newest_id, pending.length]);

  const send = (body: string, nonce: string): void => {
    setPending((rows) => [
      ...rows.filter((row) => row.nonce !== nonce),
      { nonce, body, state: 'sending' },
    ]);
    void adapter.sendMessage(snapshot.trip.id, { body, client_nonce: nonce }).then(
      () => onChanged(),
      (error: unknown) => {
        // Disconnected never means saved: keep the text and offer a retry.
        setPending((rows) =>
          rows.map((row) => (row.nonce === nonce ? { ...row, state: 'failed' } : row)),
        );
        onError(error);
      },
    );
  };

  const submit = (event: React.FormEvent): void => {
    event.preventDefault();
    const body = draft.trim();
    if (body.length === 0) return;
    onDraftChange('');
    send(body, crypto.randomUUID());
  };

  const rows = messages?.messages ?? [];

  // An acknowledged row comes back carrying the nonce we sent, so the optimistic
  // copy is dropped at render time rather than shown twice.
  const acknowledged = new Set(rows.map((row) => row.client_nonce).filter((n) => n !== null));
  const unacknowledged = pending.filter((row) => !acknowledged.has(row.nonce));

  return (
    <section className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto pr-1">
        {loading && rows.length === 0 && (
          <p className="p-4 text-sm text-slate-500">Loading chat…</p>
        )}
        {!loading && rows.length === 0 && unacknowledged.length === 0 && (
          <p className="p-4 text-sm text-slate-500">
            No messages yet. Say what you want to do and press Update plan.
          </p>
        )}

        <ol className="grid gap-2 py-2">
          {rows.map((message) => {
            const author = message.author_person_id;
            const person = author === null ? undefined : people.get(author);
            const mine = author === snapshot.self_person_id;

            if (message.kind !== 'user') {
              return (
                <li key={message.id} className="px-2">
                  <p
                    className={`mx-auto max-w-prose rounded-lg px-3 py-2 text-center text-xs ${
                      message.kind === 'bot'
                        ? 'bg-slate-900/5 text-slate-700'
                        : 'text-slate-500 italic'
                    }`}
                  >
                    {message.body}
                  </p>
                </li>
              );
            }

            return (
              <li
                key={message.id}
                className={`flex px-2 ${mine ? 'justify-end' : 'justify-start'}`}
              >
                <div className="max-w-[75%]">
                  {!mine && (
                    <span
                      className="mb-0.5 flex items-center gap-1.5 text-xs font-medium"
                      style={{ color: person?.color }}
                    >
                      <span
                        aria-hidden
                        className="inline-block size-2 rounded-full"
                        style={{ backgroundColor: person?.color }}
                      />
                      {person?.display_name ?? 'Someone'}
                    </span>
                  )}
                  <p
                    className={`rounded-2xl px-3 py-2 text-sm ${
                      mine ? 'bg-slate-900 text-white' : 'bg-slate-100 text-slate-800'
                    }`}
                  >
                    {message.body}
                  </p>
                </div>
              </li>
            );
          })}

          {unacknowledged.map((row) => (
            <li key={row.nonce} className="flex justify-end px-2">
              <div className="max-w-[75%] text-right">
                <p className="rounded-2xl bg-slate-900/70 px-3 py-2 text-sm text-white">
                  {row.body}
                </p>
                {row.state === 'sending' ? (
                  <span className="text-xs text-slate-500">sending…</span>
                ) : (
                  <span className="text-xs text-red-700">
                    not sent
                    <button
                      type="button"
                      onClick={() => send(row.body, row.nonce)}
                      className="ml-2 underline"
                    >
                      retry
                    </button>
                  </span>
                )}
              </div>
            </li>
          ))}
        </ol>
        <div ref={bottom} />
      </div>

      <form onSubmit={submit} className="mt-2 flex items-end gap-2 border-t border-slate-200 pt-3">
        <textarea
          value={draft}
          onChange={(event) => onDraftChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              submit(event);
            }
          }}
          rows={2}
          maxLength={TRIP_LIMITS.maxMessageChars}
          placeholder="Say what you would like to do…"
          aria-label="Message"
          className="min-h-11 flex-1 resize-none rounded-lg border border-slate-300 px-3 py-2 text-sm"
        />
        <button
          type="submit"
          disabled={draft.trim().length === 0}
          className="flex h-11 items-center gap-2 rounded-lg bg-slate-900 px-4 text-sm text-white disabled:opacity-40"
        >
          <Send aria-hidden className="size-4" />
          Send
        </button>
      </form>
    </section>
  );
}
