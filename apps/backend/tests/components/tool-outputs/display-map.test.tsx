import React from 'react';
import { describe, expect, it } from 'vitest';

import { DisplayMapOutput } from '../../../src/components/tool-outputs';
import { renderToMarkdown } from '../../../src/lib/markdown';

describe('DisplayMapOutput', () => {
	it.each([
		{
			variant: 'names the reason of each dropped line',
			output: {
				success: true,
				line_count: 4,
				dropped_row_count: 3,
				dropped_reasons: { same_origin_destination: 2, invalid_coordinates: 1 },
			},
			text: '3 row(s) were dropped and are not on the map (2 with the same origin and destination, 1 with missing or invalid coordinates)',
		},
		{
			variant: 'falls back to a generic cause for maps without reasons',
			output: { success: true, point_count: 4, dropped_row_count: 1 },
			text: '1 row(s) were dropped and are not on the map (missing or invalid data)',
		},
	])('$variant', ({ output, text }) => {
		expect(renderToMarkdown(<DisplayMapOutput output={output} />)).toContain(text);
	});
});
