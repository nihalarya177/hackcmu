import type {
  AttendanceMutationResponse,
  CreateEventRequest,
  CreateInviteResponse,
  CreateMessageRequest,
  CreateMessageResponse,
  CreateTripRequest,
  CreateTripResponse,
  DeleteEventResponse,
  EventMutationResponse,
  InvitePreviewResponse,
  JoinTripRequest,
  JoinTripResponse,
  ListMessagesQuery,
  ListMessagesResponse,
  PatchEventRequest,
  PatchSelfPersonRequest,
  PatchTripRequest,
  PersonMutationResponse,
  PersonResource,
  ProcessingStatusResponse,
  PutSelfAttendanceRequest,
  RequestProcessingResponse,
  ResolveActionRequest,
  ResolveActionResponse,
  SnapshotResponse,
  TripMutationResponse,
} from '@trip/contracts';
import type { Mode } from '../mode';

/**
 * What this mode can actually do today.
 *
 * The UI reads this instead of hardcoding which buttons exist, so an operation
 * with no implementation behind it is visibly unavailable rather than a control
 * that fails when pressed. A capability flips to true only when the operation
 * is genuinely implemented for that mode.
 */
export type Capability =
  | 'chat'
  | 'invite'
  | 'selfProfile'
  | 'tripSettings'
  | 'manualEvents'
  | 'eventRestore'
  | 'selfAttendance'
  | 'places'
  | 'botActions'
  | 'requestProcessing'
  | 'export'
  | 'participantSwitching'
  | 'reset';

export type Capabilities = Readonly<Record<Capability, boolean>>;

/**
 * Demo-only controls. `null` in live mode, which is what keeps simulated state
 * out of a real trip: there is no participant switch or reset to reach.
 */
export type DemoControls = {
  /** The single namespaced trip id every demo read and write is scoped to. */
  readonly tripId: string;
  participants(): PersonResource[];
  activePersonId(): string;
  /** Switches the simulated identity. Never a real authenticated user. */
  switchParticipant(personId: string): void;
  /** Restores the seeded dataset. Touches demo storage only. */
  reset(): void;
  /** The named scripted outcomes, and which have already played. */
  scenarios(): { id: string; title: string; hint: string; applied: boolean }[];
  /** Plays one scenario by name, for rehearsal, bypassing keyword matching. */
  runScenario(id: string): void;
  /** Notifies on any demo state change so callers can invalidate their cache. */
  subscribe(listener: () => void): () => void;
};

/**
 * The one boundary between the planner UI and its data.
 *
 * Both implementations speak the frozen contracts: the live one over HTTP, the
 * demo one over local simulated state. Neither substitutes for the other. A
 * live failure raises; it never quietly returns fixtures.
 */
export type PlannerAdapter = {
  readonly mode: Mode;
  readonly capabilities: Capabilities;

  /**
   * Prepares whatever the mode needs before its first read. Live obtains an
   * anonymous session here; demo does nothing and needs no credentials. This
   * is the only place authentication may start.
   */
  start(): Promise<void>;

  createTrip(body: CreateTripRequest): Promise<CreateTripResponse>;
  previewInvite(token: string): Promise<InvitePreviewResponse>;
  joinTrip(body: JoinTripRequest): Promise<JoinTripResponse>;
  mintInvite(
    tripId: string,
    body: { idempotency_key: string; rotate: boolean },
  ): Promise<CreateInviteResponse>;

  snapshot(tripId: string): Promise<SnapshotResponse>;
  processing(tripId: string): Promise<ProcessingStatusResponse>;
  messages(tripId: string, params?: Partial<ListMessagesQuery>): Promise<ListMessagesResponse>;
  sendMessage(tripId: string, body: CreateMessageRequest): Promise<CreateMessageResponse>;

  patchSelf(tripId: string, body: PatchSelfPersonRequest): Promise<PersonMutationResponse>;
  patchTrip(tripId: string, body: PatchTripRequest): Promise<TripMutationResponse>;

  createEvent(tripId: string, body: CreateEventRequest): Promise<EventMutationResponse>;
  patchEvent(
    tripId: string,
    eventId: string,
    body: PatchEventRequest,
  ): Promise<EventMutationResponse>;
  deleteEvent(
    tripId: string,
    eventId: string,
    body: { idempotency_key: string; expected_calendar_version: string },
  ): Promise<DeleteEventResponse>;
  restoreEvent(
    tripId: string,
    eventId: string,
    body: { idempotency_key: string; expected_calendar_version: string },
  ): Promise<EventMutationResponse>;

  setSelfAttendance(
    tripId: string,
    eventId: string,
    body: PutSelfAttendanceRequest,
  ): Promise<AttendanceMutationResponse>;

  requestProcessing(
    tripId: string,
    body: { idempotency_key: string },
  ): Promise<RequestProcessingResponse>;
  resolveAction(
    tripId: string,
    actionId: string,
    body: ResolveActionRequest,
  ): Promise<ResolveActionResponse>;

  readonly demo: DemoControls | null;
};
