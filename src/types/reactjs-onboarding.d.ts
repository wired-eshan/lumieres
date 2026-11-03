/**
 * Minimal typings for `reactjs-onboarding`.
 *
 * The published package ships no declaration file. These cover the API surface
 * used by `ProductTour` so the project can stay on strict TypeScript.
 */
declare module 'reactjs-onboarding' {
  import type { ComponentType, ReactElement, ReactNode } from 'react';

  export interface OnboardingProps {
    /** Unique tour name; also part of the library's localStorage key. */
    name: string;
    children?: ReactNode;
  }

  export interface OnboardingItemProps {
    /** Target element by id or live DOM node. */
    elementID?: string | HTMLElement;
    /** Manual fixed-position box, used when there is no DOM target. */
    elementCoOrdinate?: { l: number; t: number; w: number; h: number };
    message?: string;
    /** Hides the spotlight border while keeping the dimmed backdrop. */
    disableArrow?: boolean;
  }

  export interface OnboardingTagProps {
    message?: string;
    children?: ReactNode;
  }

  export const Onboarding: ComponentType<OnboardingProps> & {
    /** Clears every tour-completion flag and opens the mounted tour. */
    reset(): void;
  };

  export const OnboardingItem: ComponentType<OnboardingItemProps>;
  export const OnboardingTag: (props: OnboardingTagProps) => ReactElement;
}
