import { APP_NAME as SHARED_APP_NAME } from '@klass/shared';

/**
 * Visible product name. VITE_APP_NAME (apps/web/.env*) overrides it at build
 * time; otherwise the single shared constant. The brand is not translated —
 * all three dictionaries carry the same value.
 */
export const APP_NAME: string = (import.meta.env.VITE_APP_NAME as string | undefined) ?? SHARED_APP_NAME;
