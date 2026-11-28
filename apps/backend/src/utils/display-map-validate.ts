import {
	buildChoroplethEntries,
	buildMapLines,
	buildMapPoints,
	countDroppedLineRows,
	indexBoundaries,
	type LineDropCounts,
	MAX_MAP_LINES,
	MAX_MAP_POINTS,
	normalizeRegionId,
	parseNumericValue,
	resolveColumnName,
} from '@nao/shared';
import { displayMap } from '@nao/shared/tools';

import { getCachedBoundary, setCachedBoundary } from './map-boundary-cache';
import { parseAndValidateGeoJson, safeFetch } from './safe-fetch';

type QueryResult = { columns: string[]; data: Record<string, unknown>[] };

export async function validateMapConfig(input: displayMap.Input, queryResult: QueryResult): Promise<displayMap.Output> {
	if (input.map_type === 'choropleth') {
		const result = await buildChoroplethResult(input, queryResult);
		return result.success ? withWarning(result, logScaleWarning(input, queryResult)) : result;
	}
	if (input.map_type === 'lines') {
		return buildLinesResult(input, queryResult);
	}
	return buildPointResult(input, queryResult);
}

/** A log scale cannot place zero or negative values: they get the lightest shade, or the scale falls back to linear when no value is positive. */
function logScaleWarning(input: displayMap.Input, queryResult: QueryResult): string | null {
	if (input.color_scale !== 'log' || !input.value_key) {
		return null;
	}
	const valueColumn = resolveColumnName(queryResult.columns, input.value_key);
	const values = queryResult.data
		.map((row) => parseNumericValue(row[valueColumn]))
		.filter((value): value is number => value !== null);
	const nonPositiveCount = values.filter((value) => value <= 0).length;
	if (nonPositiveCount === 0) {
		return null;
	}
	if (nonPositiveCount === values.length) {
		return 'No value is positive, so the log scale fell back to a linear scale. Use color_scale "linear" or "quantile" instead.';
	}
	return `${nonPositiveCount} row(s) have a value ≤ 0, which a log scale cannot place, so they get the lightest shade. Use color_scale "quantile" instead if these rows matter.`;
}

function withWarning(result: displayMap.Output, warning: string | null): displayMap.Output {
	if (!warning) {
		return result;
	}
	return { ...result, warning: result.warning ? `${result.warning} ${warning}` : warning };
}

function buildPointResult(input: displayMap.Input, queryResult: QueryResult): displayMap.Output {
	if (!input.latitude_key || !input.longitude_key) {
		return {
			_version: '1',
			success: false,
			error: `latitude_key and longitude_key are required for "${input.map_type}" maps.`,
		};
	}

	const latitudeColumn = resolveColumnName(queryResult.columns, input.latitude_key);
	const longitudeColumn = resolveColumnName(queryResult.columns, input.longitude_key);
	const missingColumn = [latitudeColumn, longitudeColumn].find((column) => !queryResult.columns.includes(column));
	if (missingColumn) {
		return { _version: '1', success: false, error: columnNotFound(missingColumn, queryResult.columns) };
	}
	if (latitudeColumn === longitudeColumn) {
		return {
			_version: '1',
			success: false,
			error: 'latitude_key and longitude_key must reference different columns.',
		};
	}

	if (input.map_type === 'scatter_bubble' && !input.size_key) {
		return { _version: '1', success: false, error: 'size_key is required for "scatter_bubble" maps.' };
	}

	const points = buildMapPoints(queryResult.data, {
		...input,
		latitude_key: latitudeColumn,
		longitude_key: longitudeColumn,
	});
	if (points.length === 0) {
		return {
			_version: '1',
			success: false,
			error: 'The query result contains no rows with valid decimal-degree coordinates, so there is nothing to plot.',
		};
	}

	const warnings: string[] = [];
	const missingPopupKeys = [input.label_key, input.size_key, ...(input.tooltip_keys ?? [])]
		.filter((key): key is string => !!key)
		.filter((key) => !queryResult.columns.includes(resolveColumnName(queryResult.columns, key)));
	if (missingPopupKeys.length > 0) {
		warnings.push(
			`Column(s) ${quoteList(missingPopupKeys)} not found in the query result. Available columns: ${queryResult.columns.join(', ')}.`,
		);
	}
	if (points.length > MAX_MAP_POINTS) {
		warnings.push(
			`The map only renders the first ${MAX_MAP_POINTS} points — mention this to the user, or aggregate in SQL to stay under the limit.`,
		);
	}

	return {
		_version: '1',
		success: true,
		point_count: points.length,
		dropped_row_count: queryResult.data.length - points.length,
		...(warnings.length > 0 && { warning: warnings.join(' ') }),
	};
}

const LINE_SEGMENT_KEYS = [
	'origin_latitude_key',
	'origin_longitude_key',
	'destination_latitude_key',
	'destination_longitude_key',
] as const;

function buildLinesResult(input: displayMap.Input, queryResult: QueryResult): displayMap.Output {
	const sourceError = linesSourceError(input);
	if (sourceError) {
		return { _version: '1', success: false, error: sourceError };
	}

	const config = resolveLineColumns(input, queryResult.columns);
	const sourceColumns = config.geometry_key
		? [config.geometry_key]
		: LINE_SEGMENT_KEYS.map((key) => config[key] ?? '');
	const missingColumn = sourceColumns.find((column) => !queryResult.columns.includes(column));
	if (missingColumn) {
		return { _version: '1', success: false, error: columnNotFound(missingColumn, queryResult.columns) };
	}

	const lines = buildMapLines(queryResult.data, config);
	const droppedReasons = countDroppedLineRows(queryResult.data, config);
	if (lines.length === 0) {
		return { _version: '1', success: false, error: noLinesError(config, droppedReasons) };
	}

	const warnings = linesWarnings(input, queryResult.columns, lines.length, droppedReasons);
	return {
		_version: '1',
		success: true,
		line_count: lines.length,
		dropped_row_count: queryResult.data.length - lines.length,
		...(Object.keys(droppedReasons).length > 0 && { dropped_reasons: droppedReasons }),
		...(warnings.length > 0 && { warning: warnings.join(' ') }),
	};
}

function linesSourceError(input: displayMap.Input): string | null {
	const segmentKeyCount = LINE_SEGMENT_KEYS.filter((key) => input[key]).length;
	if (input.geometry_key && segmentKeyCount > 0) {
		return 'A "lines" map takes either the origin/destination columns or geometry_key, not both.';
	}
	if (!input.geometry_key && segmentKeyCount < LINE_SEGMENT_KEYS.length) {
		return `${LINE_SEGMENT_KEYS.join(', ')} are required for "lines" maps, unless geometry_key is set.`;
	}
	return null;
}

function resolveLineColumns(input: displayMap.Input, columns: string[]): displayMap.Input {
	const resolve = (key: string | undefined) => key && resolveColumnName(columns, key);
	return {
		...input,
		origin_latitude_key: resolve(input.origin_latitude_key),
		origin_longitude_key: resolve(input.origin_longitude_key),
		destination_latitude_key: resolve(input.destination_latitude_key),
		destination_longitude_key: resolve(input.destination_longitude_key),
		geometry_key: resolve(input.geometry_key),
		width_key: resolve(input.width_key),
	};
}

function noLinesError(config: displayMap.Input, droppedReasons: LineDropCounts): string {
	if (config.geometry_key) {
		return 'No rows contain a valid GeoJSON LineString or MultiLineString, so there is nothing to draw.';
	}
	const reasons = [
		droppedReasons.invalid_coordinates &&
			`${droppedReasons.invalid_coordinates} with missing or invalid coordinates`,
		droppedReasons.same_origin_destination &&
			`${droppedReasons.same_origin_destination} with the same origin and destination`,
	].filter(Boolean);
	return `No rows contain valid decimal-degree origin and destination coordinates that differ, so there is nothing to draw (rows: ${reasons.join(', ')}).`;
}

function linesWarnings(
	input: displayMap.Input,
	columns: string[],
	lineCount: number,
	droppedReasons: LineDropCounts,
): string[] {
	const warnings: string[] = [];
	const missingPopupKeys = [input.label_key, input.width_key, ...(input.tooltip_keys ?? [])]
		.filter((key): key is string => !!key)
		.filter((key) => !columns.includes(resolveColumnName(columns, key)));
	if (missingPopupKeys.length > 0) {
		warnings.push(
			`Column(s) ${quoteList(missingPopupKeys)} not found in the query result. Available columns: ${columns.join(', ')}.`,
		);
	}
	if (droppedReasons.same_origin_destination) {
		warnings.push(
			`${droppedReasons.same_origin_destination} row(s) have the same origin and destination and are not drawn — mention it to the user, or exclude them in SQL.`,
		);
	}
	if (lineCount > MAX_MAP_LINES) {
		warnings.push(
			`The map only draws the ${MAX_MAP_LINES} heaviest of ${lineCount} lines — mention this to the user, or aggregate in SQL and keep the top flows (ORDER BY the width column DESC LIMIT ${MAX_MAP_LINES}).`,
		);
	}
	if (input.curved && input.geometry_key) {
		warnings.push(
			'curved only applies to the origin/destination columns, so the geometry_key lines are drawn as given.',
		);
	}
	return warnings;
}

async function buildChoroplethResult(input: displayMap.Input, queryResult: QueryResult): Promise<displayMap.Output> {
	if (!input.value_key) {
		return { _version: '1', success: false, error: 'value_key is required for "choropleth" maps.' };
	}
	if (!input.geometry_key && !input.boundaries_url && !(input.region_boundaries && input.region_key)) {
		return {
			_version: '1',
			success: false,
			error: 'A choropleth needs one of: geometry_key, boundaries_url with region_key, or both region_boundaries and region_key.',
		};
	}

	if (input.boundaries_url) {
		return buildBoundariesUrlResult(input, queryResult);
	}

	const requiredKeys = [
		input.value_key,
		input.region_key,
		input.geometry_key,
		input.label_key,
		...(input.tooltip_keys ?? []),
	].filter((key): key is string => !!key);
	const missingKeys = requiredKeys.filter(
		(key) => !queryResult.columns.includes(resolveColumnName(queryResult.columns, key)),
	);
	const criticalMissing = missingKeys.find(
		(key) => key === input.value_key || key === input.region_key || key === input.geometry_key,
	);
	if (criticalMissing) {
		return { _version: '1', success: false, error: columnNotFound(criticalMissing, queryResult.columns) };
	}

	const entries = buildChoroplethEntries(queryResult.data, {
		...input,
		value_key: resolveColumnName(queryResult.columns, input.value_key),
		region_key: input.region_key && resolveColumnName(queryResult.columns, input.region_key),
		geometry_key: input.geometry_key && resolveColumnName(queryResult.columns, input.geometry_key),
	});
	const usable = entries.filter(
		(entry) => entry.value !== null && (entry.geometry !== null || entry.region !== null),
	);
	if (usable.length === 0) {
		return {
			_version: '1',
			success: false,
			error: input.geometry_key
				? 'No rows contain both a numeric value and a valid GeoJSON geometry, so there is nothing to shade.'
				: 'No rows contain both a numeric value and a region that could be matched, so there is nothing to shade.',
		};
	}

	const warnings: string[] = [];
	if (missingKeys.length > 0) {
		warnings.push(
			`Column(s) ${quoteList(missingKeys)} not found in the query result. Available columns: ${queryResult.columns.join(', ')}.`,
		);
	}

	return {
		_version: '1',
		success: true,
		region_count: usable.length,
		dropped_row_count: queryResult.data.length - usable.length,
		...(warnings.length > 0 && { warning: warnings.join(' ') }),
	};
}

async function buildBoundariesUrlResult(input: displayMap.Input, queryResult: QueryResult): Promise<displayMap.Output> {
	const boundariesUrl = input.boundaries_url!;
	const regionKeyColumn = input.region_key && resolveColumnName(queryResult.columns, input.region_key);
	if (!regionKeyColumn || !queryResult.columns.includes(regionKeyColumn)) {
		return {
			_version: '1',
			success: false,
			error: `region_key "${input.region_key}" not found in the query result. Available columns: ${queryResult.columns.join(', ')}.`,
		};
	}

	let geojson;
	try {
		const cached = getCachedBoundary(boundariesUrl);
		if (cached) {
			geojson = cached;
		} else {
			const text = await safeFetch(boundariesUrl);
			const result = parseAndValidateGeoJson(text);
			setCachedBoundary(boundariesUrl, result.geojson);
			geojson = result.geojson;
		}
	} catch (err) {
		return {
			_version: '1',
			success: false,
			error: `Failed to fetch boundaries from "${boundariesUrl}": ${err instanceof Error ? err.message : String(err)}`,
		};
	}

	const joinProps = input.boundaries_join_property ? [input.boundaries_join_property] : undefined;
	const index = indexBoundaries(geojson, joinProps);

	const valueKeyColumn = resolveColumnName(queryResult.columns, input.value_key!);
	let matched = 0;
	let dropped = 0;
	for (const row of queryResult.data) {
		const regionId = normalizeRegionId(row[regionKeyColumn]);
		const hasValue = row[valueKeyColumn] !== null && row[valueKeyColumn] !== undefined;
		if (regionId && hasValue && index.has(regionId)) {
			matched++;
		} else {
			dropped++;
		}
	}

	if (matched === 0) {
		return {
			_version: '1',
			success: false,
			error: `No rows matched any boundary feature. Check that region_key values correspond to a property in the GeoJSON. Available feature properties: ${[...new Set([...geojson.features].flatMap((f) => Object.keys(f.properties ?? {})))].slice(0, 10).join(', ')}.`,
		};
	}

	const warnings: string[] = [];
	if (dropped > 0) {
		warnings.push(`${dropped} row(s) could not be matched to a boundary feature and will not be shaded.`);
	}

	return {
		_version: '1',
		success: true,
		region_count: matched,
		dropped_row_count: dropped,
		...(warnings.length > 0 && { warning: warnings.join(' ') }),
	};
}

function columnNotFound(column: string, columns: string[]): string {
	return `Column "${column}" not found in the query result. Available columns: ${columns.join(', ')}.`;
}

function quoteList(keys: string[]): string {
	return keys.map((key) => `"${key}"`).join(', ');
}
