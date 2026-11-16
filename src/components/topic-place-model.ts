import { PLACE_LANDMARKS, type PlaceCoordinate, type PlaceLandmarkId } from '../data/topic-place.ts';

export type PlaceView = 'raised' | 'flat';
export type PlaceFeatureKind = 'railway' | 'road' | 'path' | 'forest' | 'water' | 'boundary' | 'residential' | 'farmland' | 'building' | 'farmyard' | 'industrial' | 'meadow';
export interface PlaceFeature {
  id: number;
  kind: PlaceFeatureKind;
  coordinates: readonly PlaceCoordinate[];
  name?: string;
  muessenBoundary?: boolean;
}
export interface PlacePoint { x: number; y: number }
export const PLACE_VIEWBOX = { width: 660, height: 470 } as const;
const CENTER: PlaceCoordinate = [10.577, 53.49475];
const METRES_PER_DEGREE = 111_320;
const LONGITUDE_SCALE = Math.cos(CENTER[1] * Math.PI / 180);
const PIXELS_PER_METRE = 0.208;
const ROTATION = -9 * Math.PI / 180;

/** Local equirectangular map in metres; tilt is illustrative, not terrain elevation. */
export function projectPlace(coordinate: PlaceCoordinate, view: PlaceView): PlacePoint {
  const east = (coordinate[0] - CENTER[0]) * METRES_PER_DEGREE * LONGITUDE_SCALE * PIXELS_PER_METRE;
  const south = (CENTER[1] - coordinate[1]) * METRES_PER_DEGREE * PIXELS_PER_METRE;
  if (view === 'flat') return { x: PLACE_VIEWBOX.width / 2 + east, y: PLACE_VIEWBOX.height / 2 + south };
  return {
    x: PLACE_VIEWBOX.width / 2 + east * Math.cos(ROTATION) - south * Math.sin(ROTATION),
    y: PLACE_VIEWBOX.height / 2 + (east * Math.sin(ROTATION) + south * Math.cos(ROTATION)) * 0.76,
  };
}

export function placePath(coordinates: readonly PlaceCoordinate[], view: PlaceView, closed: boolean, elevation = 0): string {
  return coordinates.map((coordinate, index) => {
    const point = projectPlace(coordinate, view);
    return `${index ? 'L' : 'M'}${point.x.toFixed(2)},${(point.y - elevation).toFixed(2)}`;
  }).join(' ') + (closed && coordinates.length ? ' Z' : '');
}

/** Every wall follows an actual OSM footprint edge; the uniform 4px height is not measured. */
export function buildingWalls(coordinates: readonly PlaceCoordinate[], view: PlaceView): string {
  if (view === 'flat') return '';
  return coordinates.slice(1).map((coordinate, index) => {
    const a = projectPlace(coordinates[index]!, view);
    const b = projectPlace(coordinate, view);
    return `M${a.x.toFixed(2)},${a.y.toFixed(2)} L${b.x.toFixed(2)},${b.y.toFixed(2)} L${b.x.toFixed(2)},${(b.y - 4).toFixed(2)} L${a.x.toFixed(2)},${(a.y - 4).toFixed(2)} Z`;
  }).join(' ');
}

const LAYERS: Record<PlaceFeatureKind, number> = { farmland: 0, meadow: 1, residential: 2, farmyard: 3, industrial: 3, forest: 4, water: 5, boundary: 6, path: 7, road: 8, railway: 9, building: 10 };
export function orderPlaceFeatures(features: readonly PlaceFeature[]): PlaceFeature[] {
  return [...features].sort((a, b) => LAYERS[a.kind] - LAYERS[b.kind] || b.coordinates[0]![1] - a.coordinates[0]![1]);
}
export function isPlaceArea(kind: PlaceFeatureKind): boolean {
  return ['farmland', 'meadow', 'residential', 'farmyard', 'industrial', 'forest', 'building'].includes(kind);
}
export function selectPlaceLandmark(id: string): PlaceLandmarkId {
  return PLACE_LANDMARKS.find((landmark) => landmark.id === id)?.id ?? 'plan';
}
export function togglePlaceView(view: PlaceView): PlaceView { return view === 'raised' ? 'flat' : 'raised'; }
