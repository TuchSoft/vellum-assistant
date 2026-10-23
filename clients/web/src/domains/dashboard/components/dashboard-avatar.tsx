import { ChatAvatar } from "@/components/avatar/chat-avatar";
import type { CharacterComponents, CharacterTraits } from "@/types/avatar";

export interface DashboardAvatarProps {
  components: CharacterComponents | null;
  traits: CharacterTraits | null;
  customImageUrl: string | null;
  size?: number;
}

/**
 * The assistant's circular portrait, anchored to the central column's bottom
 * edge so the tile clips the chin. Decorative: the tile's content owns every
 * interaction, so the portrait takes no pointer events.
 */
export function DashboardAvatar({
  components,
  traits,
  customImageUrl,
  size = 220,
}: DashboardAvatarProps) {
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute -bottom-12 right-3 z-0 overflow-hidden rounded-full opacity-90"
      style={{ width: size, height: size }}
    >
      <ChatAvatar
        components={components}
        traits={traits}
        customImageUrl={customImageUrl}
        size={size}
      />
    </div>
  );
}
