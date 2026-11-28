import { describe, expect, it, vi } from 'vitest';

vi.mock('../../src/db/db', () => ({ db: {} }));
vi.mock('../../src/queries/chat.queries', () => ({
	getQueryResultByQueryId: vi.fn(async () => null),
}));
vi.mock('../../src/utils/map-boundary-cache', () => ({
	getCachedBoundary: vi.fn(() => null),
	setCachedBoundary: vi.fn(),
}));
vi.mock('../../src/utils/safe-fetch', () => ({
	safeFetch: vi.fn(async () => {
		throw new Error('not mocked');
	}),
	parseAndValidateGeoJson: vi.fn(),
}));

import { MAX_MAP_LINES } from '@nao/shared';
import type { displayMap } from '@nao/shared/tools';

import { createDisplayMapTool } from '../../src/agents/tools/display-map';
import * as chatQueries from '../../src/queries/chat.queries';
import type { QueryResult } from '../../src/types/tools';
import * as safeFetchModule from '../../src/utils/safe-fetch';
import { createToolContext, executeTool } from '../helpers/tool-context';

type MapOutput = displayMap.Output;

const input = {
	query_id: 'q1',
	map_type: 'points' as const,
	latitude_key: 'lat',
	longitude_key: 'lng',
	title: 'Test map',
};

const rows = [{ lat: 48.85, lng: 2.35 }];

function execute(overrides: Record<string, unknown>, queryResults = new Map<string, QueryResult>()) {
	return executeDisplayMap({ ...input, ...overrides }, queryResults);
}

describe('display_map execute', () => {
	it('rejects identical latitude and longitude keys', async () => {
		const output = await execute({ longitude_key: 'lat' }, queryResultsOf(['lat', 'lng'], rows));
		expect(output).toMatchObject({ success: false });
		expect(output.error).toContain('different columns');
	});

	it('rejects a query id that is neither in the run context nor in the chat history', async () => {
		const output = await execute({});
		expect(output).toMatchObject({ success: false });
		expect(output.error).toContain('q1');
	});

	it('resolves query results from the persisted chat history', async () => {
		vi.mocked(chatQueries.getQueryResultByQueryId).mockResolvedValueOnce({
			columns: ['lat', 'lng'],
			data: rows,
		});
		const output = await execute({});
		expect(output).toMatchObject({ success: true });
	});

	it('succeeds when the keys match the query columns case-insensitively', async () => {
		const output = await execute({}, queryResultsOf(['LAT', 'LNG'], [{ LAT: 48.85, LNG: 2.35 }]));
		expect(output).toMatchObject({ success: true });
	});

	it('rejects a key missing from the query columns and lists the available ones', async () => {
		const output = await execute({}, queryResultsOf(['lat', 'city'], rows));
		expect(output).toMatchObject({ success: false });
		expect(output.error).toContain('lng');
		expect(output.error).toContain('lat, city');
	});

	it('rejects case variants that resolve to the same column', async () => {
		const output = await execute(
			{ latitude_key: 'lat', longitude_key: 'LAT' },
			queryResultsOf(['LAT'], [{ LAT: 48.85 }]),
		);
		expect(output).toMatchObject({ success: false });
	});

	it('accepts genuinely distinct case-variant columns via exact matches', async () => {
		const output = await execute(
			{ latitude_key: 'lat', longitude_key: 'LAT' },
			queryResultsOf(['lat', 'LAT'], [{ lat: 48.85, LAT: 2.35 }]),
		);
		expect(output).toMatchObject({ success: true });
	});

	it('reports plotted and dropped counts on success', async () => {
		const output = await execute({}, queryResultsOf(['lat', 'lng'], [...rows, { lat: null, lng: null }]));
		expect(output).toMatchObject({ success: true, point_count: 1, dropped_row_count: 1 });
	});

	it('warns about popup keys missing from the query columns without failing', async () => {
		const output = await execute(
			{ label_key: 'cty', tooltip_keys: ['city', 'missing'] },
			queryResultsOf(['lat', 'lng', 'city'], rows),
		);
		expect(output).toMatchObject({ success: true });
		expect(output.warning).toContain('"cty"');
		expect(output.warning).toContain('"missing"');
		expect(output.warning).not.toContain('"city"');
	});

	it('warns when the result exceeds the rendered point cap', async () => {
		const manyRows = Array.from({ length: 5001 }, (_, i) => ({
			lat: 40 + (i % 100) / 100,
			lng: 2 + (i % 100) / 100,
		}));
		const output = await execute({}, queryResultsOf(['lat', 'lng'], manyRows));
		expect(output).toMatchObject({ success: true, point_count: 5001 });
		expect(output.warning).toContain('first 5000 points');
	});

	it('omits the warning when popup keys resolve', async () => {
		const output = await execute({ label_key: 'city' }, queryResultsOf(['lat', 'lng', 'CITY'], rows));
		expect(output).toMatchObject({ success: true });
		expect(output.warning).toBeUndefined();
	});

	it('rejects a query result with no plottable coordinates', async () => {
		const output = await execute({}, queryResultsOf(['lat', 'lng'], [{ lat: null, lng: null }]));
		expect(output).toMatchObject({ success: false });
		expect(output.error).toContain('no rows with valid');
	});

	it('rejects an empty query result', async () => {
		const output = await execute({}, queryResultsOf(['lat', 'lng'], []));
		expect(output).toMatchObject({ success: false });
	});
});

describe('display_map execute — choropleth with boundaries_url', () => {
	const geometry = {
		type: 'Polygon',
		coordinates: [
			[
				[0, 0],
				[1, 0],
				[1, 1],
				[0, 0],
			],
		],
	};
	const geojson = {
		type: 'FeatureCollection',
		features: [
			{ type: 'Feature', geometry, properties: { iso: 'FR' } },
			{ type: 'Feature', geometry, properties: { iso: 'DE' } },
		],
	};

	const choroplethInput = {
		query_id: 'q1',
		map_type: 'choropleth' as const,
		title: 'Test choropleth',
		value_key: 'value',
		region_key: 'country',
		boundaries_url: 'https://example.com/regions.geojson',
	};

	function executeChoropleth(overrides: Record<string, unknown> = {}, queryResults = new Map<string, QueryResult>()) {
		return executeDisplayMap({ ...choroplethInput, ...overrides }, queryResults);
	}

	function serveBoundaries(): void {
		vi.mocked(safeFetchModule.safeFetch).mockResolvedValueOnce('');
		vi.mocked(safeFetchModule.parseAndValidateGeoJson).mockReturnValueOnce({
			geojson,
			propertyKeys: ['iso'],
			featureCount: 2,
		});
	}

	it('returns region_count and dropped_row_count when all rows match', async () => {
		serveBoundaries();
		const queryResults = queryResultsOf(
			['country', 'value'],
			[
				{ country: 'FR', value: 10 },
				{ country: 'DE', value: 20 },
			],
		);
		const output = await executeChoropleth({}, queryResults);
		expect(output).toMatchObject({ success: true, region_count: 2, dropped_row_count: 0 });
	});

	it('reports dropped rows when region_key does not match any feature', async () => {
		serveBoundaries();
		const queryResults = queryResultsOf(
			['country', 'value'],
			[
				{ country: 'FR', value: 10 },
				{ country: 'XX', value: 5 },
			],
		);
		const output = await executeChoropleth({}, queryResults);
		expect(output).toMatchObject({ success: true, region_count: 1, dropped_row_count: 1 });
		expect(output.warning).toContain('1 row');
	});

	it('fails when no rows match any feature', async () => {
		serveBoundaries();
		const output = await executeChoropleth({}, queryResultsOf(['country', 'value'], [{ country: 'XX', value: 5 }]));
		expect(output).toMatchObject({ success: false });
		expect(output.error).toContain('No rows matched');
	});

	it('fails when safeFetch throws', async () => {
		vi.mocked(safeFetchModule.safeFetch).mockRejectedValueOnce(new Error('Only HTTPS URLs are allowed.'));
		const output = await executeChoropleth(
			{},
			queryResultsOf(['country', 'value'], [{ country: 'FR', value: 10 }]),
		);
		expect(output).toMatchObject({ success: false });
		expect(output.error).toContain('Only HTTPS');
	});

	it('fails when region_key is missing from query columns', async () => {
		const output = await executeChoropleth({ region_key: 'missing_key' }, queryResultsOf(['country', 'value'], []));
		expect(output).toMatchObject({ success: false });
		expect(output.error).toContain('missing_key');
	});

	describe('color_scale', () => {
		const skewedResults = () =>
			queryResultsOf(
				['country', 'value'],
				[
					{ country: 'FR', value: 0 },
					{ country: 'DE', value: 5000 },
				],
			);

		it('warns without failing when a log scale meets values ≤ 0', async () => {
			serveBoundaries();
			const output = await executeChoropleth({ color_scale: 'log' }, skewedResults());
			expect(output).toMatchObject({ success: true, region_count: 2 });
			expect(output.warning).toContain('1 row(s) have a value ≤ 0');
			expect(output.warning).toContain('"quantile"');
		});

		it('says the log scale fell back to linear when no value is positive', async () => {
			serveBoundaries();
			const queryResults = queryResultsOf(
				['country', 'value'],
				[
					{ country: 'FR', value: 0 },
					{ country: 'DE', value: -3 },
				],
			);
			const output = await executeChoropleth({ color_scale: 'log' }, queryResults);
			expect(output).toMatchObject({ success: true });
			expect(output.warning).toContain('fell back to a linear scale');
		});

		it('stays linear by default and does not warn about values ≤ 0', async () => {
			serveBoundaries();
			const output = await executeChoropleth({}, skewedResults());
			expect(output).toMatchObject({ success: true });
			expect(output.warning).toBeUndefined();
		});

		it('rejects an unknown color scale', () => {
			const schema = createDisplayMapTool().inputSchema as {
				safeParse: (value: unknown) => { success: boolean };
			};
			expect(schema.safeParse({ ...choroplethInput, color_scale: 'sqrt' }).success).toBe(false);
		});
	});
});

describe('display_map execute — lines', () => {
	const segmentKeys = {
		origin_latitude_key: 'from_lat',
		origin_longitude_key: 'from_lng',
		destination_latitude_key: 'to_lat',
		destination_longitude_key: 'to_lng',
	};
	const flowColumns = ['from_lat', 'from_lng', 'to_lat', 'to_lng', 'trips'];
	const flow = { from_lat: 45.76, from_lng: 4.84, to_lat: 45.19, to_lng: 5.72, trips: 12 };
	const linesInput = { query_id: 'q1', map_type: 'lines' as const, title: 'Flows' };

	function executeLines(overrides: Record<string, unknown>, data: Record<string, unknown>[], columns = flowColumns) {
		return executeDisplayMap({ ...linesInput, ...overrides }, queryResultsOf(columns, data));
	}

	it('draws lines without any warning', async () => {
		const output = await executeLines({ ...segmentKeys, width_key: 'trips' }, [flow]);

		expect(output).toMatchObject({ success: true, line_count: 1, dropped_row_count: 0 });
		expect(output.dropped_reasons).toBeUndefined();
		expect(output.warning).toBeUndefined();
	});

	it('reports why each dropped row is not drawn, and warns about the rows that start where they end', async () => {
		const output = await executeLines(segmentKeys, [
			flow,
			{ ...flow, to_lat: flow.from_lat, to_lng: flow.from_lng },
			{ ...flow, to_lat: flow.from_lat, to_lng: flow.from_lng },
			{ ...flow, from_lat: null },
		]);

		expect(output).toMatchObject({
			success: true,
			line_count: 1,
			dropped_row_count: 3,
			dropped_reasons: { same_origin_destination: 2, invalid_coordinates: 1 },
		});
		expect(output.warning).toContain('2 row(s) have the same origin and destination and are not drawn');
	});

	it('reads a LineString column', async () => {
		const route = JSON.stringify({
			type: 'LineString',
			coordinates: [
				[2.35, 48.85],
				[3.06, 50.63],
			],
		});

		const output = await executeLines({ geometry_key: 'route' }, [{ route }], ['route']);

		expect(output).toMatchObject({ success: true, line_count: 1 });
	});

	it.each([
		{
			variant: 'no line source',
			overrides: { width_key: 'trips' },
			error: 'are required for "lines" maps, unless geometry_key is set',
		},
		{
			variant: 'only the origin columns',
			overrides: { origin_latitude_key: 'from_lat', origin_longitude_key: 'from_lng' },
			error: 'are required for "lines" maps, unless geometry_key is set',
		},
		{
			variant: 'both line sources',
			overrides: { ...segmentKeys, geometry_key: 'route' },
			error: 'either the origin/destination columns or geometry_key, not both',
		},
		{
			variant: 'a destination column missing from the query',
			overrides: { ...segmentKeys, destination_longitude_key: 'to_lon' },
			error: 'Column "to_lon" not found',
		},
	])('rejects $variant', async ({ overrides, error }) => {
		const output = await executeLines(overrides, [flow]);

		expect(output).toMatchObject({ success: false });
		expect(output.error).toContain(error);
	});

	it('rejects a result without a drawable line, naming why the rows were dropped', async () => {
		const output = await executeLines(segmentKeys, [
			{ ...flow, to_lat: null },
			{ ...flow, to_lat: flow.from_lat, to_lng: flow.from_lng },
		]);

		expect(output).toMatchObject({ success: false });
		expect(output.error).toContain(
			'(rows: 1 with missing or invalid coordinates, 1 with the same origin and destination)',
		);
	});

	it('warns when the result exceeds the drawn line cap', async () => {
		const manyFlows = Array.from({ length: MAX_MAP_LINES + 1 }, (_, index) => ({ ...flow, trips: index + 1 }));

		const output = await executeLines(segmentKeys, manyFlows);

		expect(output).toMatchObject({ success: true, line_count: MAX_MAP_LINES + 1 });
		expect(output.warning).toContain(`only draws the ${MAX_MAP_LINES} heaviest`);
	});

	it('warns that curved does not apply to a geometry column', async () => {
		const route = {
			type: 'LineString',
			coordinates: [
				[2.35, 48.85],
				[3.06, 50.63],
			],
		};

		const output = await executeLines({ geometry_key: 'route', curved: true }, [{ route }], ['route']);

		expect(output).toMatchObject({ success: true });
		expect(output.warning).toContain('curved only applies to the origin/destination columns');
	});
});

async function executeDisplayMap(mapInput: object, queryResults: Map<string, QueryResult>): Promise<MapOutput> {
	const tool = createDisplayMapTool();
	const output = await executeTool(tool, mapInput as never, createToolContext({ queryResults }));
	return output as MapOutput;
}

function queryResultsOf(columns: string[], data: Record<string, unknown>[]): Map<string, QueryResult> {
	return new Map([['q1', { columns, data }]]);
}
