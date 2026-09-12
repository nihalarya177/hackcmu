import type {
  AttendanceResource,
  BotActionResource,
  DeletedEventResource,
  EventResource,
  MessageResource,
  PersonResource,
  PlaceResource,
  ProcessingStatusResource,
  TripResource,
} from '@trip/contracts';

/**
 * The simulated trip, in base form.
 *
 * Only facts are stored. Budgets, warnings, unknown coverage and day paths are
 * derived on every read, so an edit cannot leave one view agreeing and another
 * stale.
 */
export type DemoState = {
  /** Storage schema version. A mismatch discards the stored state. */
  schema: number;
  calendar_version: string;
  /** Which simulated participant the UI is currently speaking as. */
  active_person_id: string;
  trip: TripResource;
  members: PersonResource[];
  events: EventResource[];
  attendance: AttendanceResource[];
  places: PlaceResource[];
  messages: MessageResource[];
  deletions: DeletedEventResource[];
  actions: BotActionResource[];
  /** Scripted scenarios already committed. Each one applies at most once. */
  applied_scenarios: string[];
  next_message_id: string;
  processing: ProcessingStatusResource;
};
