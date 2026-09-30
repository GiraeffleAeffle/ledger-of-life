/**
 * The interests a person can choose. One vocabulary for the whole app: Places ranks council items and
 * map places with it, and the welcome guide highlights steps, groups and events with it. The choices are
 * kept only on the person's device.
 */
export const interestOptions = ['sport', 'kids', 'shops', 'health', 'culture', 'nature', 'volunteering'] as const;
export type Interest = (typeof interestOptions)[number];
