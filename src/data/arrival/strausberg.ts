import type { ArrivalGuide } from './types.ts';
import { strausbergContacts } from './strausberg-contacts.ts';
import { strausbergGroups } from './strausberg-groups.ts';
import { strausbergSteps } from './strausberg-steps.ts';

export const strausbergGuide: ArrivalGuide = {
  cityId: 'strausberg',
  cityName: 'Strausberg',
  preparedOn: '2026-09-29',
  contacts: strausbergContacts,
  steps: strausbergSteps,
  groups: strausbergGroups,
};
