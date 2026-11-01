import { Icon } from './Icon';

/** Centered placeholder for a panel with nothing to show yet. */
export function EmptyState({ icon, title, hint }: { icon: string; title: string; hint?: string }) {
  return (
    <div className="empty-state">
      <Icon name={icon} size={28} />
      <strong>{title}</strong>
      {hint && <span>{hint}</span>}
    </div>
  );
}
