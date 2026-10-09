/** Confirmed external destinations, not health checks or shared-account integrations.
 * Game routes: mecky-roebel edition router; product boundaries reviewed 9 October 2026.
 * Keep this list explicit: a civic snapshot city is not necessarily a game edition.
 */
export const CITY_GAME_EDITIONS = [
  { kind: 'edition', cityId: 'strausberg', cityName: 'Strausberg', href: 'https://spiel.stadtstack.eu/strausberg', status: 'Strausberg edition · external browser game' },
] as const;

const GAME_EDITION_CHOOSER = {
  kind: 'chooser',
  href: 'https://spiel.stadtstack.eu/',
  status: 'No confirmed edition for this city · choose an edition',
} as const;

/** Unknown, uncovered and unselected cities never silently open another city's game. */
export function cityGameDestination(cityId: string | null | undefined) {
  return CITY_GAME_EDITIONS.find((edition) => edition.cityId === cityId) ?? GAME_EDITION_CHOOSER;
}
