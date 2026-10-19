import { createContext, useContext, type ReactNode } from "react";

export interface ProfileQuickAddContextValue {
  openProfileQuickAdd: (options: {
    existingNames?: string[];
    onCreated?: (name: string, label?: string) => void;
  }) => void;
}

const ProfileQuickAddContext = createContext<ProfileQuickAddContextValue>({
  openProfileQuickAdd: () => {},
});

/**
 * Kept as a stable provider seam. Model aliases come from the gateway
 * catalog, so there is no profile quick-add flow to open.
 */
export function ProfileQuickAddProvider({ children }: { children: ReactNode }) {
  return (
    <ProfileQuickAddContext.Provider value={{ openProfileQuickAdd: () => {} }}>
      {children}
    </ProfileQuickAddContext.Provider>
  );
}

export function useProfileQuickAdd(): ProfileQuickAddContextValue {
  return useContext(ProfileQuickAddContext);
}
