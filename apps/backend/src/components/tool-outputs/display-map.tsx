import type { displayMap } from '@nao/shared/tools';

import { Block } from '../../lib/markdown';

type DroppedReasons = NonNullable<displayMap.Output['dropped_reasons']>;

const DROPPED_REASON_LABELS: Record<keyof DroppedReasons, string> = {
	same_origin_destination: 'the same origin and destination',
	invalid_coordinates: 'missing or invalid coordinates',
	invalid_geometry: 'no valid line geometry',
};

export function DisplayMapOutput({ output }: { output: displayMap.Output }) {
	if (output.error) {
		return <Block>Could not display the map: {output.error}</Block>;
	}
	const warning = output.warning ? ` Warning: ${output.warning}` : '';
	return (
		<Block>
			Map displayed successfully{describeDrawnCount(output)}.{describeDroppedRows(output)}
			{warning}
		</Block>
	);
}

function describeDrawnCount(output: displayMap.Output): string {
	if (output.point_count != null) {
		return ` with ${output.point_count} point(s)`;
	}
	if (output.region_count != null) {
		return ` with ${output.region_count} region(s)`;
	}
	if (output.line_count != null) {
		return ` with ${output.line_count} line(s)`;
	}
	return '';
}

function describeDroppedRows(output: displayMap.Output): string {
	if (!output.dropped_row_count) {
		return '';
	}
	const reasons = Object.entries(output.dropped_reasons ?? {})
		.filter(([, count]) => count)
		.map(([reason, count]) => `${count} with ${DROPPED_REASON_LABELS[reason as keyof DroppedReasons]}`);
	const cause = reasons.length > 0 ? reasons.join(', ') : 'missing or invalid data';
	return ` ${output.dropped_row_count} row(s) were dropped and are not on the map (${cause}) — adjust the SQL if they should appear.`;
}
