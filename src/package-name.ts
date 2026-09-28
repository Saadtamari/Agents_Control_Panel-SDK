/** The only place to change the published package name. Keep package.json in sync. */
export const PACKAGE_NAME = "agent-control-panel" as const;

/**
 * Flip to true in the release that first publishes PACKAGE_NAME to npm. While false, onboarding and the
 * integration generator do not tell customers to `npm install` a package that does not exist yet.
 */
export const SDK_PUBLISHED = false as boolean;
