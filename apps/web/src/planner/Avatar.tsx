import { initials } from './format';

/**
 * A person, as a coloured disc with their initials.
 *
 * This is the product's recurring motif: the same disc identifies someone in
 * the header, in the conversation, on an event and on the map, so colour alone
 * is never the only cue.
 */
export function Avatar({
  name,
  color,
  size = 24,
  ring,
}: {
  name: string;
  color: string;
  size?: number;
  /** Background to ring against when discs overlap. */
  ring?: string;
}): React.ReactElement {
  return (
    <span
      aria-hidden
      title={name}
      className="grid shrink-0 place-items-center rounded-full font-bold text-white"
      style={{
        width: size,
        height: size,
        backgroundColor: color,
        fontSize: Math.round(size * 0.42),
        boxShadow: ring === undefined ? undefined : `0 0 0 2.5px ${ring}`,
      }}
    >
      {initials(name)}
    </span>
  );
}

/**
 * Overlapping discs, for a roster.
 *
 * A list, because that is what it is: the people going. Screen readers get
 * the names from each item, which the discs themselves never expose.
 */
export function AvatarRow({
  people,
  size = 24,
  ring,
  label = 'People',
}: {
  people: { id: string; display_name: string; color: string }[];
  size?: number;
  ring?: string;
  label?: string;
}): React.ReactElement {
  return (
    <ul aria-label={label} className="flex">
      {people.map((person, index) => (
        <li
          key={person.id}
          title={person.display_name}
          style={{ marginLeft: index === 0 ? 0 : -Math.round(size * 0.3) }}
        >
          <Avatar name={person.display_name} color={person.color} size={size} ring={ring} />
          <span className="sr-only">{person.display_name}</span>
        </li>
      ))}
    </ul>
  );
}
