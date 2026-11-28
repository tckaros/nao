import { describe, expect, it } from 'vitest';

import { displayMap } from '../src/tools';

const baseInput = { query_id: 'query_1', title: 'Stores' };
const segmentKeys = {
	origin_latitude_key: 'from_lat',
	origin_longitude_key: 'from_lng',
	destination_latitude_key: 'to_lat',
	destination_longitude_key: 'to_lng',
};
const linesSourceAttributes =
	'origin_latitude_key, origin_longitude_key, destination_latitude_key and destination_longitude_key, or geometry_key';
const customBoundaryChoropleth = {
	map_type: 'choropleth' as const,
	region_key: 'department',
	region_boundaries: 'custom_departments',
};

describe('getMissingMapAttributes', () => {
	it.each<{ variant: string; input: Omit<displayMap.Input, 'query_id' | 'title'>; missing: string[] }>([
		{
			variant: 'a scatter_bubble without coordinates or size',
			input: { map_type: 'scatter_bubble' },
			missing: ['latitude_key', 'longitude_key', 'size_key'],
		},
		{
			variant: 'a complete points map',
			input: { map_type: 'points', latitude_key: 'lat', longitude_key: 'lng' },
			missing: [],
		},
		{
			variant: 'a choropleth without a value column',
			input: { map_type: 'choropleth' },
			missing: ['value_key'],
		},
		{
			variant: 'a choropleth without boundaries',
			input: { map_type: 'choropleth', value_key: 'sales' },
			missing: ['region_key with region_boundaries or boundaries_url, or geometry_key'],
		},
		{
			variant: 'a complete choropleth on a custom boundary set',
			input: { ...customBoundaryChoropleth, value_key: 'sales' },
			missing: [],
		},
		{
			variant: 'a choropleth on a custom boundary set without a value column',
			input: customBoundaryChoropleth,
			missing: ['value_key'],
		},
		{
			variant: 'a lines map without a line source',
			input: { map_type: 'lines', width_key: 'trips' },
			missing: [linesSourceAttributes],
		},
		{
			variant: 'a lines map without its destination columns',
			input: { map_type: 'lines', origin_latitude_key: 'from_lat', origin_longitude_key: 'from_lng' },
			missing: [linesSourceAttributes],
		},
		{
			variant: 'a lines map with origin and destination columns',
			input: { map_type: 'lines', ...segmentKeys },
			missing: [],
		},
		{
			variant: 'a lines map with a geometry column',
			input: { map_type: 'lines', geometry_key: 'route' },
			missing: [],
		},
	])('lists the columns missing from $variant', ({ input, missing }) => {
		expect(displayMap.getMissingMapAttributes({ ...baseInput, ...input })).toEqual(missing);
	});
});

describe('InputSchema line sources', () => {
	it.each<{ variant: string; input: Partial<displayMap.Input>; error: string | null }>([
		{ variant: 'origin and destination columns', input: segmentKeys, error: null },
		{ variant: 'a geometry column', input: { geometry_key: 'route' }, error: null },
		{
			variant: 'both origin/destination columns and a geometry column',
			input: { ...segmentKeys, geometry_key: 'route' },
			error: 'A lines map takes either the origin/destination columns or geometry_key, not both.',
		},
	])('validates a lines map with $variant', ({ input, error }) => {
		const result = displayMap.InputSchema.safeParse({ ...baseInput, map_type: 'lines', ...input });

		expect(result.error?.issues.map((issue) => issue.message) ?? null).toEqual(error && [error]);
	});
});
