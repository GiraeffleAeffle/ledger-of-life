import type { FeatureCollection, Polygon } from 'geojson';
import type { TestCityInvestment } from '../data/local-investments';

export type ProjectSystems = { solar: boolean; heat: boolean; validator: boolean; gpu: boolean };
export const DEFAULT_PROJECT_SYSTEMS: ProjectSystems = { solar: true, heat: true, validator: false, gpu: false };
export type ProjectModelProperties = { system: 'building' | 'solar' | 'heat' | 'equipment'; height: number; base: number; color: string };

/** Local metre offsets on a tangent plane; accurate for these small illustrative footprints. */
export function projectFootprint(center: readonly [number, number], width: number, depth: number, rotationDegrees: number, offset: readonly [number, number] = [0, 0]): Polygon {
  const radians = rotationDegrees * Math.PI / 180;
  const metresPerLatitudeDegree = 6378137 * Math.PI / 180;
  const metresPerLongitudeDegree = metresPerLatitudeDegree * Math.cos(center[1] * Math.PI / 180);
  const corners = [[-width / 2, -depth / 2], [width / 2, -depth / 2], [width / 2, depth / 2], [-width / 2, depth / 2]];
  const ring = corners.map(([x, y]) => {
    const east = (x + offset[0]) * Math.cos(radians) - (y + offset[1]) * Math.sin(radians);
    const north = (x + offset[0]) * Math.sin(radians) + (y + offset[1]) * Math.cos(radians);
    return [center[0] + east / metresPerLongitudeDegree, center[1] + north / metresPerLatitudeDegree];
  });
  ring.push([...ring[0]]);
  return { type: 'Polygon', coordinates: [ring] };
}

export function projectMapModel(project: TestCityInvestment, systems: ProjectSystems): FeatureCollection<Polygon, ProjectModelProperties> {
  const { footprintMetres: [width, depth], rotationDegrees, storeys, storeyHeightMetres } = project.model;
  const height = storeys * storeyHeightMetres;
  const features: FeatureCollection<Polygon, ProjectModelProperties>['features'] = [{
    type: 'Feature', id: 'building', geometry: projectFootprint(project.location.coordinates, width, depth, rotationDegrees),
    properties: { system: 'building', height, base: 0, color: project.kind === 'housing' ? '#b16c3e' : '#3f857c' },
  }];
  if (systems.solar) features.push({
    type: 'Feature', id: 'solar', geometry: projectFootprint(project.location.coordinates, width * 0.78, depth * 0.65, rotationDegrees),
    properties: { system: 'solar', base: height + 0.05, height: height + 0.35, color: '#263e52' },
  });
  if (systems.heat) features.push({
    type: 'Feature', id: 'heat', geometry: projectFootprint(project.location.coordinates, 2, 2, rotationDegrees, [-width / 2 - 2, 0]),
    properties: { system: 'heat', base: 0, height: 1.8, color: '#d3ddc8' },
  });
  if (systems.validator || systems.gpu) features.push({
    type: 'Feature', id: 'equipment', geometry: projectFootprint(project.location.coordinates, 5, 3, rotationDegrees, [0, -depth / 2 - 1.5]),
    properties: { system: 'equipment', base: 0, height: 3, color: '#576c81' },
  });
  return { type: 'FeatureCollection', features };
}
