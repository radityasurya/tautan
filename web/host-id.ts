const slug = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

/** A new Host's id: its label, else the first label of the address, as a slug. */
export const hostId = (label: string | undefined, target: string) =>
  slug(label ?? '') || slug(target.split('@').pop()!.split(':')[0]!.split('.')[0]!) || 'host';

/** Why a Host entry cannot be saved beside the others: its id is another Host's (the list
 *  would drop that one for it), or its target already is a Host. `editing` names the entry
 *  being changed, which may keep its own id and target. Ids compare without case. */
export function hostClash(
  entry: { id: string; target: string },
  others: { id: string; label?: string; target?: string }[],
  editing?: string,
): { kind: 'label' | 'target'; label: string } | null {
  const rest = others.filter((other) => other.id !== editing);
  if (!editing && rest.some((other) => other.id.toLowerCase() === entry.id.toLowerCase())) return { kind: 'label', label: entry.id };
  const same = rest.find((other) => other.target && other.target === entry.target);
  return same ? { kind: 'target', label: same.label ?? same.id } : null;
}
